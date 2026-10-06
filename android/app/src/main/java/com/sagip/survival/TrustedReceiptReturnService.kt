package com.sagip.survival

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID

/** Supplied by reviewed native integration. A feed response is never authority evidence. */
data class ReceiptAuthorityState(val revokedGrants: Set<String> = emptySet(), val lastCheckedAtMs: Long? = null)
/** A live authenticated check for these exact bytes, bound to this installation's current boot. */
data class CurrentReceiptAuthorityEvidence(
  val objectDigest: ByteArray, val bootId: String, val checkedElapsedMs: Long, val checkedAtMs: Long,
)
data class TrustedReceiptReturnConfig(
  val verifierId: ByteArray,
  val roots: Map<String, ByteArray>,
  val scopes: Set<String>,
  val qualified: () -> Boolean,
  val authorityState: () -> ReceiptAuthorityState = { ReceiptAuthorityState() },
  // Operator-approved maximum age for an exact-object online check; zero means this instant only.
  val currentAuthorityMaxAgeMs: Long = 0L,
  // Non-blocking lookup of independently completed exact-object checks. Never perform network I/O here.
  val currentAuthorityCheck: ((ByteArray) -> CurrentReceiptAuthorityEvidence?)? = null,
  val feed: ReceiptReturnFeedConfig? = null,
  val offlineRoot: OfflineRootConfig? = null,
  val timeTransport: ReceiptReturnTimeTransport? = null,
  val maximumClockDriftPpm: Int = 100,
)

/**
 * Explicit trust adapter for receipt return. No signer, roots, endpoint, credentials, or authority
 * are inferred. Clock acquisition uses the existing signed challenge protocol and durable high-water.
 */
class TrustedReceiptReturnService(
  private val database: SagipDatabase,
  private val queue: ReceiptQueue,
  configuration: TrustedReceiptReturnConfig,
  private val monotonicClock: () -> MonotonicClock,
  private val active: () -> Boolean = { true },
) {
  private val config = configuration.copy(
    verifierId = configuration.verifierId.copyOf(),
    roots = configuration.roots.mapValues { it.value.copyOf() },
    scopes = configuration.scopes.toSet(),
    offlineRoot = configuration.offlineRoot?.let { source -> source.copy(
      checkpointSignerKeys = source.checkpointSignerKeys.mapValues { it.value.copyOf() },
      policy = source.policy.copy(signerBindings = source.policy.signerBindings.toList(),
        allowedScopes = source.policy.allowedScopes.toList(), allowedStatuses = source.policy.allowedStatuses.toList(),
        qualifiedTimeSourceIds = source.policy.qualifiedTimeSourceIds.toList()),
    ) },
  )
  private val receipts = ReceiptRepository(database)
  private val offlineSnapshots = config.offlineRoot?.let { OfflineRootSnapshotStore(database, queue, it) }
  init {
    require(config.currentAuthorityMaxAgeMs in 0..60_000L)
    require(config.maximumClockDriftPpm in 100..1000)
    require(config.verifierId.size == 32 && config.roots.isNotEmpty() && config.scopes.isNotEmpty())
    config.roots.forEach { (id, key) ->
      ReceiptV2Codec.validatePublicKey(key)
      require(id == hex(hash(key)))
    }
  }
  private fun qualified() = runCatching { active() && config.qualified() }.getOrDefault(false)

  fun trustedTime(): TimeInterval? = runCatching {
    check(qualified())
    val checkpoint = receipts.latestTimeCheckpoint(config.verifierId) ?: return null
    val proof = receipts.latestTimeProof(config.verifierId) ?: return null
    check(hex(hash(proof)) == checkpoint.proofDigest)
    val decoded = ReceiptV2Codec.decode(proof)
    val fields = decoded.fields as? ReceiptFields.Time ?: return null
    // This adapter deliberately supports root time acquisition only. Delegated clock pairing
    // needs separate approved enrollment; an unpaired BLE peer cannot bootstrap time.
    val root = usableRoots()[hex(fields.signerKeyId)] ?: return null
    check(fields.grantId == NIL && fields.verifierBootSessionId == checkpoint.bootId)
    check(MessageDigest.isEqual(fields.verifierId, config.verifierId))
    check(ReceiptV2Codec.verifySignature(decoded, root))
    val clock = monotonicClock()
    val interval = ReceiptAuthority.advanceCheckpoint(checkpoint, clock, config.maximumClockDriftPpm) ?: return null
    val db = database.writableDatabase
    receiptEligibilityTransaction(db) {
      // Serialize authority use with proof renewal: a stale observer cannot commit against a new checkpoint.
      if(!qualified() || monotonicClock().bootId != clock.bootId) {
        db.setTransactionSuccessful(); return null
      }
      val current = receipts.latestTimeCheckpoint(config.verifierId)
      if(current != checkpoint) { db.setTransactionSuccessful(); return null }
      val highWater = db.rawQuery(
        "SELECT earliest_ms FROM receipt_time_high_water WHERE lower(hex(verifier_id))=?",
        arrayOf(hex(config.verifierId)),
      ).use { if (it.moveToFirst()) it.getLong(0) else null }
      if (highWater != null && interval.earliestMs < highWater) {
        db.setTransactionSuccessful(); return null
      }
      if (highWater == null || interval.earliestMs > highWater) db.execSQL(
        "INSERT INTO receipt_time_high_water(verifier_id,earliest_ms,updated_at_ms) VALUES(?,?,?) " +
          "ON CONFLICT(verifier_id) DO UPDATE SET earliest_ms=MAX(earliest_ms,excluded.earliest_ms),updated_at_ms=excluded.updated_at_ms",
        arrayOf(config.verifierId, interval.earliestMs, interval.earliestMs),
      )
      db.setTransactionSuccessful()
      interval
    }
  }.getOrElse { rethrowReceiptEligibilityFailure(it,database); null }

  fun baseContext(): VerificationContext? {
    if (!qualified()) return null
    val time = trustedTime() ?: return null
    val state = runCatching(config.authorityState).getOrNull() ?: return null
    if (state.lastCheckedAtMs != null && state.lastCheckedAtMs !in 0..time.latestMs) return null
    return VerificationContext(usableRoots().mapValues { it.value.copyOf() }, state.revokedGrants.toSet(),
      config.scopes, time, state.lastCheckedAtMs, false, null, null)
  }

  fun contextFor(kind: ObjectKind, bytes: ByteArray): VerificationContext? {
    if (kind == ObjectKind.OFFLINE_ROOT_BUNDLE) return offlineContext(bytes)
    val context = baseContext() ?: return null
    if (kind == ObjectKind.SOS) return context
    val fields = runCatching { ReceiptV2Codec.decode(bytes).fields }.getOrNull() ?: return context
    val report = when (fields) {
      is ReceiptFields.Responder -> receipts.reportIdentity(fields.reportId, fields.revision)
      is ReceiptFields.Requester -> receipts.reportIdentity(fields.reportId, fields.revision)
      else -> null
    }
    val linked = (fields as? ReceiptFields.Requester)?.let { receipts.getReceipt(it.ackEventId) }
    // Current root verification is exact-object and same-boot; no cached date or feed flag upgrades it.
    val checkedBytes = linked ?: bytes
    val checkedFields = if (linked == null) fields else runCatching { ReceiptV2Codec.decode(linked).fields }.getOrNull()
    val needsCurrentCheck = checkedFields is ReceiptFields.Responder && checkedFields.providerKind == 1
    val evidence = if (needsCurrentCheck) runCatching { config.currentAuthorityCheck?.invoke(checkedBytes.copyOf()) }.getOrNull() else null
    val clock = runCatching(monotonicClock).getOrNull()
    val fresh = evidence != null && clock != null && evidence.bootId == clock.bootId &&
      evidence.checkedElapsedMs >= 0 && clock.elapsedMs >= evidence.checkedElapsedMs &&
      clock.elapsedMs - evidence.checkedElapsedMs <= config.currentAuthorityMaxAgeMs &&
      evidence.checkedAtMs in 0..9_007_199_254_740_991L &&
      evidence.checkedAtMs <= requireNotNull(context.trustedTime).latestMs &&
      evidence.checkedAtMs >= context.trustedTime.earliestMs - config.currentAuthorityMaxAgeMs &&
      MessageDigest.isEqual(evidence.objectDigest, hash(checkedBytes))
    return context.copy(report = report, linkedAck = linked, currentAuthorityChecked = fresh,
      authorityCheckedAtMs = if (fresh) evidence!!.checkedAtMs else context.authorityCheckedAtMs)
  }

  private fun knownRevokedKeys(): Set<String> = database.readableDatabase.rawQuery(
    "SELECT DISTINCT target_id FROM offline_root_revocations WHERE target_kind='KEY'", null,
  ).use { c -> buildSet { while(c.moveToNext()) add(c.getString(0)) } }

  private fun usableRoots() = config.roots.filterKeys { it !in knownRevokedKeys() }

  fun feedActive(): Boolean = qualified()

  /** Called only by the separately reviewed provisioning owner; never from JS, HTTP or BLE. */
  fun enrollOfflineRootDomain(epoch: Long, authorityStateDigest: String): Boolean =
    qualified() && offlineSnapshots?.enroll(epoch, authorityStateDigest) == true

  internal fun ensureOfflineRootDomain(epoch:Long,stateDigest:String):Boolean = qualified() && offlineSnapshots?.ensureEnrolled(epoch,stateDigest)==true

  fun ingestOfflineRootRevocation(bytes: ByteArray): Boolean {
    if(!qualified() || offlineSnapshots?.ingestRevocation(bytes) != true) return false
    // Security knowledge is committed even when dissemination has no capacity.
    config.offlineRoot?.let { queue.cacheOfflineRootRevocation(bytes,it) }
    return true
  }

  fun refreshTime(): Boolean {
    val checkpoint=receipts.latestTimeCheckpoint(config.verifierId)
    val clock=monotonicClock()
    val renew=checkpoint==null || checkpoint.bootId!=clock.bootId ||
      clock.elapsedMs-checkpoint.receivedElapsedMs !in 0 until 300_000L
    return config.timeTransport?.let {
      refreshReceiptReturnTime(it,::feedActive,::trustedTime,::beginTimeChallenge,::acceptTimeProof,renew)
    } ?: (trustedTime()!=null)
  }

  private fun refreshRevocationCache(limit:Int) {
    if(!qualified()) return
    val configuration=config.offlineRoot ?: return
    offlineSnapshots?.revocationsForRelay(limit)?.forEach { queue.cacheOfflineRootRevocation(it,configuration) }
  }

  fun offlineEvidenceState(eventId: String): String =
    offlineSnapshots?.evidenceState(eventId, ::offlineContext) ?: "TIME_UNAVAILABLE"

  private fun offlineContext(bytes: ByteArray): VerificationContext? = runCatching {
    val snapshot = config.offlineRoot ?: return null
    val bundle = OfflineRootSnapshotCodec.decodeBundle(bytes)
    val fields = ReceiptV2Codec.decode(bundle.receipt).fields as ReceiptFields.Responder
    val c = baseContext() ?: return null
    val q = snapshot.clockQualification() ?: return null
    val clock = monotonicClock()
    val checkpoint = receipts.latestTimeCheckpoint(config.verifierId) ?: return null
    val proof = receipts.latestTimeProof(config.verifierId) ?: return null
    val timeFields = ReceiptV2Codec.decode(proof).fields as? ReceiptFields.Time ?: return null
    check(q.sourceId in snapshot.policy.qualifiedTimeSourceIds && q.bootId == clock.bootId &&
      q.timeSignerKeyId == hex(timeFields.signerKeyId) && q.maximumDriftPpm in 0..1000 &&
      q.maximumDriftPpm <= config.maximumClockDriftPpm &&
      q.maximumCheckpointAgeMs in 1..86_400_000L)
    check(checkpoint.bootId == clock.bootId && clock.elapsedMs >= checkpoint.receivedElapsedMs &&
      clock.elapsedMs-checkpoint.receivedElapsedMs < q.maximumCheckpointAgeMs &&
      checkpoint.validUntilMs-checkpoint.earliestMs <= q.maximumCheckpointAgeMs)
    if(snapshot.policy.disseminationAudience == "ORIGIN_ONLY") check(database.readableDatabase.rawQuery(
      "SELECT 1 FROM reports WHERE report_id=?",arrayOf(fields.reportId)).use { it.moveToFirst() })
    val identity = receipts.reportIdentity(fields.reportId, fields.revision) ?: return null
    val latest = receipts.reportIdentity(fields.reportId) ?: return null
    c.copy(report=identity,currentAuthorityChecked=false,offlineRoot=OfflineRootVerificationContext(bundle.proof.copyOf(),
      snapshot,requireNotNull(offlineSnapshots).revoked("KEY"),offlineSnapshots.revoked("PROVIDER"),latest.revision))
  }.getOrElse { rethrowReceiptEligibilityFailure(it,database); null }

  private fun relayPrivacyAllowed(kind: ObjectKind, bytes: ByteArray): Boolean = runCatching {
    if(kind == ObjectKind.SOS || kind == ObjectKind.OFFLINE_ROOT_BUNDLE) return true
    when(val fields = ReceiptV2Codec.decode(bytes).fields) {
      is ReceiptFields.Responder -> fields.note.isEmpty()
      is ReceiptFields.Requester -> {
        val ack = receipts.getReceipt(fields.ackEventId) ?: return false
        (ReceiptV2Codec.decode(ack).fields as? ReceiptFields.Responder)?.note?.isEmpty() == true
      }
      else -> false
    }
  }.getOrElse { rethrowReceiptEligibilityFailure(it,database); false }

  fun admit(kind: ObjectKind, bytes: ByteArray): CustodyResult {
    if(kind==ObjectKind.OFFLINE_ROOT_REVOCATION) {
      if(!qualified() || offlineSnapshots?.ingestRevocation(bytes) != true)
        return CustodyResult(CustodyResultKind.REJECTED,reason="REVOCATION_VERIFICATION_FAILED")
      return queue.cacheOfflineRootRevocation(bytes,requireNotNull(config.offlineRoot))
    }
    if(!relayPrivacyAllowed(kind,bytes)) return CustodyResult(CustodyResultKind.REJECTED,reason="RELAY_NOTES_FORBIDDEN_OR_ACK_MISSING")
    if(kind == ObjectKind.OFFLINE_ROOT_BUNDLE) return offlineSnapshots?.admit(bytes) { offlineContext(bytes) }
      ?: CustodyResult(CustodyResultKind.PENDING_VERIFICATION,reason="OFFLINE_ROOT_DISABLED")
    val context = contextFor(kind, bytes)
      ?: return CustodyResult(CustodyResultKind.PENDING_VERIFICATION, reason = "RETURN_AUTHORITY_UNAVAILABLE")
    return queue.admitObject(bytes, kind, context)
  }

  /** Reverify before inventory, each offer, and each chunk, including objects accepted before reboot. */
  fun canForward(kind: ObjectKind, bytes: ByteArray): Boolean = runCatching {
    if(kind==ObjectKind.OFFLINE_ROOT_REVOCATION) return qualified() && offlineSnapshots?.canForwardRevocation(bytes)==true
    if(!relayPrivacyAllowed(kind,bytes)) return false
    if(kind == ObjectKind.OFFLINE_ROOT_BUNDLE) return offlineSnapshots?.canForward(bytes) { offlineContext(bytes) } == true
    val context = contextFor(kind, bytes) ?: return false
    if (kind == ObjectKind.SOS) {
      val envelope = TransportEnvelope.decodeAndVerify(bytes)
      val expires = when (envelope.protocolVersion) {
        1 -> TransportEnvelopeV1.decode(bytes).expiresAt
        2 -> TransportEnvelopeV2.decode(bytes).expiresAt
        else -> return false
      }
      val held = queue.getObject(envelope.messageId, hash(bytes)) ?: return false
      requireNotNull(context.trustedTime).latestMs < held.custodyExpiresAtMs &&
        (expires == null || context.trustedTime.latestMs < expires)
    } else ReceiptAuthority.verifyReceipt(bytes, context) is ReceiptVerification.Verified
  }.getOrElse { rethrowReceiptEligibilityFailure(it,database); false }

  fun beginTimeChallenge(): TimeChallenge {
    check(qualified()) { "RETURN_AUTHORITY_UNAVAILABLE" }
    val clock = monotonicClock()
    val id = UUID.randomUUID().toString()
    val nonce = ByteArray(32).also(SecureRandom()::nextBytes)
    check(database.readableDatabase.rawQuery("SELECT COUNT(*) FROM receipt_time_challenges", null).use {
      it.moveToFirst(); it.getLong(0) < 10_000L
    }) { "CAPACITY_FULL" }
    receipts.recordTimeChallenge(id, config.verifierId, clock.bootId, nonce, clock.elapsedMs, 0L)
    return requireNotNull(loadChallenge(id))
  }

  fun acceptTimeProof(challengeId: String, bytes: ByteArray): TimeAcceptance {
    if (!qualified()) return TimeAcceptance("REJECTED", reason = "RETURN_AUTHORITY_UNAVAILABLE")
    val owned = bytes.copyOf()
    val fields = runCatching { ReceiptV2Codec.decode(owned).fields as? ReceiptFields.Time }.getOrNull()
    if (fields == null || fields.grantId != NIL) return TimeAcceptance("REJECTED", reason = "UNPAIRED_TIME_PROVIDER")
    // Fetching occurs before this method. Serialize only local signature/state checks with revocations.
    return try {
      val db=database.writableDatabase
      db.beginTransaction()
      try {
        val challenge=loadChallenge(challengeId,owned)
          ?: return TimeAcceptance("REJECTED",reason="CHALLENGE_UNAVAILABLE")
        val result=ReceiptAuthority.acceptTimeProof(owned,challenge,monotonicClock())
        if(result.kind!="ACCEPTED") return result
        val clock=monotonicClock()
        val checkpoint=requireNotNull(result.checkpoint)
        check(qualified() && hex(fields.signerKeyId) in usableRoots() &&
          clock.bootId==checkpoint.bootId && clock.elapsedMs>=checkpoint.receivedElapsedMs)
        db.setTransactionSuccessful()
        result
      } finally { db.endTransaction() }
    } catch(_:Exception) { TimeAcceptance("REJECTED",reason="TIME_ATOMIC_COMMIT_FAILED") }
  }

  private fun loadChallenge(id: String, proof: ByteArray? = null): TimeChallenge? =
    database.readableDatabase.rawQuery(
      "SELECT verifier_id,verifier_boot_session_id,nonce,sent_elapsed_ms,high_water_earliest_ms FROM receipt_time_challenges WHERE challenge_id=? AND consumed_at_ms IS NULL",
      arrayOf(id),
    ).use { c ->
      if (!c.moveToFirst() || !MessageDigest.isEqual(c.getBlob(0), config.verifierId)) null else {
        val state = config.authorityState()
        val verifier = c.getBlob(0); val nonce = c.getBlob(2)
        TimeChallenge(id, verifier, c.getString(1), nonce, c.getLong(3),
          if (c.isNull(4)) null else c.getLong(4),
          VerificationContext(usableRoots(), state.revokedGrants, config.scopes, null,
            state.lastCheckedAtMs, false, null, null),
          { checkpoint -> qualified() && receipts.commitTimeCheckpoint(id, verifier, nonce, checkpoint, proof) })
      }
    }

  /** Recover pending verification and locally signed gateway actions without re-signing original bytes. */
  fun retryPending(limit: Int = 16): Int {
    require(limit in 1..32)
    refreshRevocationCache(limit)
    if (baseContext() == null) return 0
    data class Pending(val rowId: Long, val bytes: ByteArray)
    fun pending(table: String, column: String, extra: String = ""): List<Pending> {
      val after = database.readableDatabase.rawQuery(
        "SELECT " + column + " FROM receipt_return_replay_state WHERE singleton=1", null,
      ).use { if (it.moveToFirst()) it.getLong(0) else 0L }
      return database.readableDatabase.rawQuery(
        "SELECT rowid,object_bytes FROM " + table + " " + extra +
          " ORDER BY CASE WHEN rowid>? THEN 0 ELSE 1 END,rowid LIMIT ?",
        arrayOf(after.toString(), limit.toString()),
      ).use { c -> buildList { while (c.moveToNext()) add(Pending(c.getLong(0), c.getBlob(1))) } }
    }
    var accepted = 0
    // Independent persisted round-robin cursors prevent poison quarantine from starving signed work.
    for ((column, rows) in listOf(
      "quarantine_row_id" to pending("receipt_quarantine", "quarantine_row_id"),
      "signed_row_id" to pending("receipt_records", "signed_row_id",
        "WHERE NOT EXISTS(SELECT 1 FROM relay_object_tombstones t WHERE t.object_id=receipt_records.event_id)"),
    )) {
      for (row in rows) {
        val kind = when (runCatching { ReceiptV2Codec.decode(row.bytes).fields }.getOrNull()) {
          is ReceiptFields.Responder -> ObjectKind.RESPONDER_RECEIPT
          is ReceiptFields.Requester -> ObjectKind.REQUESTER_RECEIPT
          else -> null
        }
        if (kind != null && runCatching { admit(kind, row.bytes).kind }.getOrNull() in
          setOf(CustodyResultKind.COMMITTED, CustodyResultKind.DUPLICATE)) accepted++
        database.writableDatabase.execSQL(
          "INSERT INTO receipt_return_replay_state(singleton," + column + ") VALUES(1,?) " +
            "ON CONFLICT(singleton) DO UPDATE SET " + column + "=excluded." + column, arrayOf(row.rowId),
        )
      }
    }
    baseContext()?.let(queue::expireRelayObjects)
    return accepted
  }

  companion object {
    private const val NIL = "00000000-0000-0000-0000-000000000000"
    internal fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
    internal fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
  }
}
