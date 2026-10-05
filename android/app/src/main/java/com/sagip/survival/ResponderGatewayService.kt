package com.sagip.survival

import android.content.ContentValues
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID

data class GrantProvisionResult(val state: String, val reason: String? = null)
data class TimeProofResult(val kind: String, val bytes: ByteArray? = null, val reason: String? = null)
data class GatewayIncident(val identity: ReportIdentity, val observedIncidentVersion: Long,
  val emergencyType: EmergencyType, val urgency: Urgency, val location: LocationSnapshot?,
  val receiptTimeline: List<ByteArray>, val pendingActions: List<ActionIntent>, val message: String? = null)

/** Native human work boundary. Trust configuration is supplied by an operator, never by action JSON. */
class ResponderGatewayService(
  private val database: SagipDatabase,
  private val identityProvider: () -> SigningIdentity,
  roots: Map<String, ByteArray>,
  scopes: Set<String>,
  private val deviceAccess: () -> Boolean,
  private val monotonicClock: () -> MonotonicClock,
  private val wallClock: () -> Long = System::currentTimeMillis,
  private val deploymentQualified: () -> Boolean = { true },
) {
  private val pinnedRoots = roots.mapValues { it.value.copyOf() }
  private val allowedScopes = scopes.toSet()
  private val receipts = ReceiptRepository(database)
  private fun qualified() = runCatching(deploymentQualified).getOrDefault(false)
  private fun access() {
    check(qualified()) { "AUTHORITY_UNAVAILABLE" }
    check(deviceAccess()) { "DEVICE_ACCESS_REQUIRED" }
  }
  private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it.toInt() and 255) }
  private fun hash(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b)
  private fun same(a: ByteArray, b: ByteArray) = MessageDigest.isEqual(a, b)
  private fun trustedTime(): TimeInterval? = runCatching {
    check(qualified()) { "AUTHORITY_UNAVAILABLE" }
    receipts.latestTimeCheckpoint(identityProvider().keyId)?.let {
      ReceiptAuthority.advanceCheckpoint(it, monotonicClock())
    }
  }.getOrNull()

  fun authorityReady(): Boolean {
    access()
    val grant = activeGrant()?.first ?: return false
    val time = trustedTime() ?: return false
    val root = pinnedRoots[hex(grant.rootKeyId)] ?: return false
    val bytes = database.readableDatabase.rawQuery("SELECT object_bytes FROM receipt_grants WHERE grant_id=?", arrayOf(grant.grantId)).use { it.moveToFirst(); it.getBlob(0) }
    return runCatching {
      same(hash(root), grant.rootKeyId) && ReceiptV2Codec.verifySignature(ReceiptV2Codec.decode(bytes), root) &&
        same(identityProvider().keyId, grant.issuerKeyId) && grant.scope in allowedScopes &&
        grant.purposeMask and 1 != 0 && time.earliestMs >= grant.notBeforeMs && time.latestMs < grant.expiresAtMs
    }.getOrDefault(false)
  }

  fun verificationContext(report: ReportIdentity? = null): VerificationContext {
    val revoked = mutableSetOf<String>()
    database.readableDatabase.rawQuery("SELECT grant_id FROM receipt_grants WHERE revoked_at_ms IS NOT NULL", null).use {
      while (it.moveToNext()) revoked.add(it.getString(0))
    }
    return VerificationContext(pinnedRoots.mapValues { it.value.copyOf() }, revoked, allowedScopes,
      trustedTime(), activeGrant()?.second, false, report, null)
  }

  fun beginAuthorityTimeChallenge(): TimeChallenge {
    access()
    val keyId = identityProvider().keyId
    val clock = monotonicClock()
    val id = UUID.randomUUID().toString()
    val nonce = ByteArray(32).also(SecureRandom()::nextBytes)
    check(database.readableDatabase.rawQuery("SELECT count(*) FROM receipt_time_challenges", null).use {
      it.moveToFirst(); it.getInt(0) < 10_000
    }) { "CAPACITY_FULL" }
    receipts.recordTimeChallenge(id, keyId, clock.bootId, nonce, clock.elapsedMs, wallClock())
    return loadChallenge(id) ?: error("STORAGE_UNAVAILABLE")
  }

  private fun loadChallenge(id: String, proofBytes: ByteArray? = null): TimeChallenge? = database.readableDatabase.rawQuery(
    "SELECT verifier_id,verifier_boot_session_id,nonce,sent_elapsed_ms,high_water_earliest_ms,consumed_at_ms FROM receipt_time_challenges WHERE challenge_id=?",
    arrayOf(id),
  ).use { c ->
    if (!c.moveToFirst() || !c.isNull(5)) null else {
      val verifier = c.getBlob(0); val boot = c.getString(1); val nonce = c.getBlob(2)
      TimeChallenge(id, verifier, boot, nonce, c.getLong(3), if (c.isNull(4)) null else c.getLong(4),
        verificationContext(), { checkpoint -> receipts.commitTimeCheckpoint(id, verifier, nonce, checkpoint, proofBytes) })
    }
  }

  fun acceptAuthorityTimeProof(challengeId: String, bytes: ByteArray): TimeAcceptance {
    access()
    val owned = bytes.copyOf()
    val q = loadChallenge(challengeId, owned) ?: return TimeAcceptance("REJECTED", reason = "CHALLENGE_UNAVAILABLE")
    return ReceiptAuthority.acceptTimeProof(owned, q, monotonicClock())
  }

  @Synchronized fun issueTimeProof(challenge: TimeChallenge): TimeProofResult {
    if (!qualified()) return TimeProofResult("TIME_UNAVAILABLE", reason = "AUTHORITY_UNAVAILABLE")
    if (!deviceAccess()) return TimeProofResult("TIME_UNAVAILABLE", reason = "DEVICE_ACCESS_REQUIRED")
    if (challenge.verifierId.size != 32 || challenge.nonce.size != 32 ||
      runCatching { UUID.fromString(challenge.id) }.isFailure ||
      runCatching { UUID.fromString(challenge.verifierBootSessionId) }.isFailure) {
      return TimeProofResult("TIME_UNAVAILABLE", reason = "CHALLENGE_INVALID")
    }
    existingGatewayTimeRequest(challenge)?.let { existing ->
      if (!existing.matches(challenge)) return TimeProofResult("TIME_UNAVAILABLE", reason = "CHALLENGE_CONFLICT")
      existing.bytes?.let { return TimeProofResult("AVAILABLE", it.copyOf()) }
      // A crash can leave an exact reserved request without proof bytes. Resume the same challenge.
    }
    val identity = runCatching(identityProvider).getOrNull()
      ?: return TimeProofResult("TIME_UNAVAILABLE", reason = "SIGNER_UNAVAILABLE")
    val grant = activeGrant()?.first
      ?: return TimeProofResult("TIME_UNAVAILABLE", reason = "AUTHORITY_UNAVAILABLE")
    if (grant.purposeMask and 8 == 0 || !same(grant.issuerKeyId, identity.keyId)) {
      return TimeProofResult("TIME_UNAVAILABLE", reason = "AUTHORITY_UNAVAILABLE")
    }
    val clock = monotonicClock()
    val checkpoint = receipts.latestTimeCheckpoint(identity.keyId)
      ?: return TimeProofResult("TIME_UNAVAILABLE", reason = "TIME_UNAVAILABLE")
    if (clock.bootId != checkpoint.bootId || clock.elapsedMs < checkpoint.receivedElapsedMs) {
      return TimeProofResult("TIME_UNAVAILABLE", reason = "TIME_UNAVAILABLE")
    }
    val parentBytes = receipts.latestTimeProof(identity.keyId)
      ?: return TimeProofResult("TIME_UNAVAILABLE", reason = "TIME_UNAVAILABLE")
    if (hex(hash(parentBytes)) != checkpoint.proofDigest) {
      return TimeProofResult("TIME_UNAVAILABLE", reason = "TIME_PROOF_MISMATCH")
    }
    val parentDecoded = runCatching { ReceiptV2Codec.decode(parentBytes) }.getOrNull()
      ?: return TimeProofResult("TIME_UNAVAILABLE", reason = "TIME_PROOF_INVALID")
    val parent = parentDecoded.fields as? ReceiptFields.Time
      ?: return TimeProofResult("TIME_UNAVAILABLE", reason = "TIME_PROOF_INVALID")
    val root = pinnedRoots[hex(parent.signerKeyId)]
      ?: return TimeProofResult("TIME_UNAVAILABLE", reason = "UNKNOWN_ROOT")
    if (!same(hash(root), parent.signerKeyId) || !ReceiptV2Codec.verifySignature(parentDecoded, root) ||
      parent.grantId != NIL || !same(parent.verifierId, identity.keyId) ||
      parent.verifierBootSessionId != checkpoint.bootId || parent.elapsedSinceCheckpointMs != 0L ||
      parent.parentCheckpointDigest.any { it != 0.toByte() }) {
      return TimeProofResult("TIME_UNAVAILABLE", reason = "TIME_PROOF_INVALID")
    }
    val grantBytes = database.readableDatabase.rawQuery(
      "SELECT object_bytes FROM receipt_grants WHERE grant_id=? AND revoked_at_ms IS NULL",
      arrayOf(grant.grantId),
    ).use { c -> if (c.moveToFirst()) c.getBlob(0) else null }
      ?: return TimeProofResult("TIME_UNAVAILABLE", reason = "AUTHORITY_UNAVAILABLE")
    val elapsed = clock.elapsedMs - checkpoint.receivedElapsedMs
    val drift = (elapsed + 9999L) / 10000L
    val acquisitionUncertainty = maxOf(parent.uncertaintyMs, checkpoint.latestMs - parent.signedTimeMs)
    val uncertainty = runCatching { Math.addExact(acquisitionUncertainty, drift) }.getOrNull()
      ?: return TimeProofResult("TIME_UNAVAILABLE", reason = "TIME_UNAVAILABLE")
    val signedTime = runCatching { Math.addExact(parent.signedTimeMs, elapsed) }.getOrNull()
      ?: return TimeProofResult("TIME_UNAVAILABLE", reason = "TIME_UNAVAILABLE")
    val validUntil = minOf(grant.expiresAtMs, parent.validUntilMs, checkpoint.validUntilMs)
    if (uncertainty !in 0..86400000L || signedTime - uncertainty < grant.notBeforeMs ||
      signedTime + uncertainty >= validUntil) {
      return TimeProofResult("TIME_UNAVAILABLE", reason = "TIME_UNAVAILABLE")
    }
    val proof = ByteBuffer.allocate(1 + 2 + grantBytes.size + 2 + parentBytes.size)
      .put(2).putShort(grantBytes.size.toShort()).put(grantBytes)
      .putShort(parentBytes.size.toShort()).put(parentBytes).array()
    if (proof.size > ReceiptV2Codec.MAX_RECEIPT_BYTES) {
      return TimeProofResult("TIME_UNAVAILABLE", reason = "PROOF_TOO_LARGE")
    }
    val reserve = reserveGatewayTimeRequest(challenge)
    if (reserve != null) return reserve
    val fields = ReceiptFields.Time(
      proofId = challenge.id,
      signerProviderId = grant.issuerProviderId.copyOf(),
      signerKeyId = identity.keyId.copyOf(),
      grantId = grant.grantId,
      signerBootSessionId = clock.bootId,
      verifierId = challenge.verifierId.copyOf(),
      verifierBootSessionId = challenge.verifierBootSessionId,
      nonce = challenge.nonce.copyOf(),
      parentCheckpointDigest = hash(parentBytes),
      signedTimeMs = signedTime,
      elapsedSinceCheckpointMs = elapsed,
      uncertaintyMs = uncertainty,
      validUntilMs = validUntil,
    )
    return try {
      val signed = receipts.encodeFresh(fields, proof, qualifiedIdentity(identity))
      persistGatewayTimeProof(challenge, signed)
    } catch (_: Exception) {
      TimeProofResult("TIME_UNAVAILABLE", reason = "SIGNER_UNAVAILABLE")
    }
  }

  private data class GatewayTimeRequestRow(
    val verifierId: ByteArray, val verifierBootSessionId: String, val nonce: ByteArray, val bytes: ByteArray?,
  ) {
    fun matches(challenge: TimeChallenge) = MessageDigest.isEqual(verifierId, challenge.verifierId) &&
      verifierBootSessionId == challenge.verifierBootSessionId && MessageDigest.isEqual(nonce, challenge.nonce)
  }

  private fun existingGatewayTimeRequest(challenge: TimeChallenge): GatewayTimeRequestRow? =
    database.readableDatabase.rawQuery(
      "SELECT verifier_id,verifier_boot_session_id,nonce,proof_bytes FROM gateway_time_requests WHERE challenge_id=?",
      arrayOf(challenge.id),
    ).use { c ->
      if (!c.moveToFirst()) null else GatewayTimeRequestRow(
        c.getBlob(0), c.getString(1), c.getBlob(2), if (c.isNull(3)) null else c.getBlob(3),
      )
    }

  private fun reserveGatewayTimeRequest(challenge: TimeChallenge): TimeProofResult? {
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      val existing = db.rawQuery(
        "SELECT verifier_id,verifier_boot_session_id,nonce,proof_bytes FROM gateway_time_requests WHERE challenge_id=?",
        arrayOf(challenge.id),
      ).use { c ->
        if (!c.moveToFirst()) null else GatewayTimeRequestRow(
          c.getBlob(0), c.getString(1), c.getBlob(2), if (c.isNull(3)) null else c.getBlob(3),
        )
      }
      if (existing != null) {
        if (!existing.matches(challenge)) {
          db.setTransactionSuccessful()
          return TimeProofResult("TIME_UNAVAILABLE", reason = "CHALLENGE_CONFLICT")
        }
        existing.bytes?.let {
          db.setTransactionSuccessful()
          return TimeProofResult("AVAILABLE", it.copyOf())
        }
        db.setTransactionSuccessful()
        return null
      }
      val count = db.rawQuery("SELECT COUNT(*) FROM gateway_time_requests", null).use { c -> c.moveToFirst(); c.getInt(0) }
      if (count >= MAX_GATEWAY_TIME_REQUESTS) {
        db.setTransactionSuccessful()
        return TimeProofResult("TIME_UNAVAILABLE", reason = "CAPACITY_FULL")
      }
      db.insertOrThrow("gateway_time_requests", null, ContentValues().apply {
        put("challenge_id", challenge.id)
        put("verifier_id", challenge.verifierId)
        put("verifier_boot_session_id", challenge.verifierBootSessionId)
        put("nonce", challenge.nonce)
        put("created_at_ms", wallClock())
      })
      db.setTransactionSuccessful()
      return null
    } finally { db.endTransaction() }
  }

  private fun persistGatewayTimeProof(challenge: TimeChallenge, signed: ByteArray): TimeProofResult {
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      val row = db.rawQuery(
        "SELECT verifier_id,verifier_boot_session_id,nonce,proof_bytes FROM gateway_time_requests WHERE challenge_id=?",
        arrayOf(challenge.id),
      ).use { c ->
        if (!c.moveToFirst()) null else GatewayTimeRequestRow(
          c.getBlob(0), c.getString(1), c.getBlob(2), if (c.isNull(3)) null else c.getBlob(3),
        )
      } ?: return TimeProofResult("TIME_UNAVAILABLE", reason = "STORAGE_UNAVAILABLE")
      if (!row.matches(challenge)) return TimeProofResult("TIME_UNAVAILABLE", reason = "CHALLENGE_CONFLICT")
      row.bytes?.let {
        db.setTransactionSuccessful()
        return TimeProofResult("AVAILABLE", it.copyOf())
      }
      db.execSQL(
        "UPDATE gateway_time_requests SET proof_bytes=?,proof_digest=? WHERE challenge_id=? AND proof_bytes IS NULL",
        arrayOf<Any?>(signed, hash(signed), challenge.id),
      )
      val stored = db.rawQuery("SELECT proof_bytes FROM gateway_time_requests WHERE challenge_id=?", arrayOf(challenge.id)).use { c ->
        if (c.moveToFirst() && !c.isNull(0)) c.getBlob(0) else null
      } ?: return TimeProofResult("TIME_UNAVAILABLE", reason = "STORAGE_UNAVAILABLE")
      db.setTransactionSuccessful()
      return TimeProofResult("AVAILABLE", stored.copyOf())
    } finally { db.endTransaction() }
  }

  @Synchronized fun provisionGrant(bytes: ByteArray): GrantProvisionResult {
    if (!qualified()) return GrantProvisionResult("REJECTED", "AUTHORITY_UNAVAILABLE")
    if (!deviceAccess()) return GrantProvisionResult("REJECTED", "DEVICE_ACCESS_REQUIRED")
    val owned = bytes.copyOf()
    val grant = try {
      val decoded = ReceiptV2Codec.decode(owned)
      val g = decoded.fields as? ReceiptFields.Grant ?: return GrantProvisionResult("REJECTED", "GRANT_PROFILE")
      val root = pinnedRoots[hex(g.rootKeyId)] ?: return GrantProvisionResult("REJECTED", "UNKNOWN_ROOT")
      val identity = identityProvider()
      if (!same(hash(root), g.rootKeyId) || !ReceiptV2Codec.verifySignature(decoded, root) ||
        !same(g.issuerKeyId, identity.keyId) || !same(g.issuerPublicKeyDer, identity.publicKeyDer) ||
        !same(g.issuerProviderId, ReceiptAuthority.issuerProviderId(2, identity.keyId, g.grantId)) ||
        g.scope !in allowedScopes || g.purposeMask and 1 == 0 ||
        g.expiresAtMs <= g.notBeforeMs || g.expiresAtMs - g.notBeforeMs > 604800000L) {
        return GrantProvisionResult("REJECTED", "GRANT_INVALID")
      }
      val time = trustedTime() ?: return GrantProvisionResult("REJECTED", "TIME_UNAVAILABLE")
      if (time.earliestMs < g.notBeforeMs || time.latestMs >= g.expiresAtMs) return GrantProvisionResult("REJECTED", "GRANT_EXPIRED")
      g
    } catch (_: Exception) { return GrantProvisionResult("REJECTED", "GRANT_INVALID") }
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      db.rawQuery("SELECT object_bytes,revoked_at_ms FROM receipt_grants WHERE grant_id=?", arrayOf(grant.grantId)).use {
        if (it.moveToFirst()) {
          if (!same(it.getBlob(0), owned) || !it.isNull(1)) return GrantProvisionResult("REJECTED", "GRANT_CONFLICT")
        } else {
          val capacity = db.rawQuery("SELECT count(*),coalesce(sum(length(object_bytes)),0) FROM receipt_grants", null).use { c -> c.moveToFirst(); c.getInt(0) < 128 && c.getLong(1) + owned.size <= 1048576 }
          if (!capacity) return GrantProvisionResult("REJECTED", "CAPACITY_FULL")
          db.insertOrThrow("receipt_grants", null, ContentValues().apply {
            put("grant_id", grant.grantId); put("issuer_provider_id", grant.issuerProviderId)
            put("issuer_key_id", grant.issuerKeyId); put("object_digest", hash(owned)); put("object_bytes", owned)
            put("received_at_ms", wallClock())
            // Importing a signed grant is not a fresh online revocation check.
          })
        }
      }
      db.execSQL("INSERT OR REPLACE INTO gateway_active_grant(singleton,grant_id) VALUES(1,?)", arrayOf(grant.grantId))
      db.setTransactionSuccessful()
      return GrantProvisionResult("ACCEPTED")
    } finally { db.endTransaction() }
  }

  private fun activeGrant(): Pair<ReceiptFields.Grant, Long?>? = database.readableDatabase.rawQuery(
    "SELECT g.object_bytes,g.authority_checked_at_ms FROM gateway_active_grant a JOIN receipt_grants g ON g.grant_id=a.grant_id WHERE g.revoked_at_ms IS NULL",
    null,
  ).use { c -> if (!c.moveToFirst()) null else Pair(ReceiptV2Codec.decode(c.getBlob(0)).fields as ReceiptFields.Grant, if (c.isNull(1)) null else c.getLong(1)) }

  fun authorizedGrant(): ReceiptFields.Grant? = if (qualified() && deviceAccess() && authorityReady()) activeGrant()?.first else null

  fun sessionAuthority(): GatewaySessionAuthority? = authorizedGrant()?.let { grant ->
    trustedTime()?.let { GatewaySessionAuthority(hex(grant.issuerProviderId), grant.grantId, grant.expiresAtMs, it) }
  }

  fun hasPendingWork(): Boolean = database.readableDatabase.rawQuery(
    "SELECT 1 FROM gateway_work w LEFT JOIN receipt_records r ON r.event_id=w.action_id WHERE r.event_id IS NULL LIMIT 1", null,
  ).use { it.moveToFirst() }

  fun listGatewayIncidents(): List<GatewayIncident> {
    access()
    val db = database.readableDatabase
    val envelopes = linkedMapOf<String, ByteArray>()
    db.rawQuery("SELECT envelope_bytes FROM inbound_envelopes UNION ALL SELECT envelope_bytes FROM outbound_envelopes WHERE envelope_bytes IS NOT NULL AND preparation_state='READY'", null).use { c ->
      while (c.moveToNext()) {
        val bytes = c.getBlob(0)
        val decoded = TransportEnvelopeV1.decode(bytes)
        val previous = envelopes[decoded.reportId]?.let(TransportEnvelopeV1::decode)
        if (previous == null || decoded.revision > previous.revision) envelopes[decoded.reportId] = bytes
        check(envelopes.size <= 10_000) { "CAPACITY_FULL" }
      }
    }
    return envelopes.values.map { bytes ->
      val envelope = TransportEnvelopeV1.decode(bytes)
      val payload = EmergencyPayload.decode(envelope.payload)
      val history = mutableListOf<ByteArray>()
      db.rawQuery("SELECT object_bytes FROM receipt_records WHERE report_id=? ORDER BY received_at_ms,event_id", arrayOf(envelope.reportId)).use { c -> while (c.moveToNext()) history.add(c.getBlob(0)) }
      val pending = mutableListOf<ActionIntent>()
      db.rawQuery("SELECT w.action_id,w.observed_version,w.status,w.note FROM gateway_work w LEFT JOIN receipt_records r ON r.event_id=w.action_id WHERE w.report_id=? AND r.event_id IS NULL ORDER BY w.saved_at_ms,w.action_id", arrayOf(envelope.reportId)).use { c ->
        while (c.moveToNext()) pending.add(ActionIntent(c.getString(0), envelope.reportId, c.getLong(1), c.getInt(2), c.getString(3)))
      }
      GatewayIncident(ReportIdentity(envelope.reportId, 1, envelope.revision, envelope.payloadDigest, envelope.originKeyId, envelope.originPublicKeyDer),
        receipts.currentReceiptVersion(envelope.reportId), payload.emergencyType, payload.urgency, payload.location, history, pending, payload.message)
    }
  }

  @Synchronized fun recordGatewayAction(intent: ActionIntent): ActionCommitResult {
    val saved = saveGatewayAction(intent)
    return if (saved.state == ActionCommitState.PREPARING) prepareGatewayAction(intent) else saved
  }

  @Synchronized internal fun saveGatewayAction(intent: ActionIntent): ActionCommitResult {
    if (!qualified()) return ActionCommitResult(intent.actionId, ActionCommitState.REJECTED, reason = "AUTHORITY_UNAVAILABLE")
    if (!deviceAccess()) return ActionCommitResult(intent.actionId, ActionCommitState.REJECTED, reason = "DEVICE_ACCESS_REQUIRED")
    val valid = runCatching {
      check(UUID.fromString(intent.actionId).toString() == intent.actionId && intent.actionId != NIL)
      check(UUID.fromString(intent.reportId).toString() == intent.reportId && intent.reportId != NIL)
      check(intent.status in 1..4 && intent.observedIncidentVersion in 0..9007199254740991L)
      check(!intent.note.contains('\u0000') && intent.note.toByteArray(Charsets.UTF_8).size <= 1024)
      Charsets.UTF_8.newEncoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT).encode(java.nio.CharBuffer.wrap(intent.note))
    }.isSuccess
    if (!valid) return ActionCommitResult(intent.actionId, ActionCommitState.REJECTED, reason = "INVALID_FIELDS")
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      db.rawQuery("SELECT report_id,observed_version,status,note FROM gateway_work WHERE action_id=?", arrayOf(intent.actionId)).use { c ->
        if (c.moveToFirst()) {
          if (c.getString(0) != intent.reportId || c.getLong(1) != intent.observedIncidentVersion || c.getInt(2) != intent.status || c.getString(3) != intent.note) {
            return ActionCommitResult(intent.actionId, ActionCommitState.CONFLICT, reason = "ACTION_CONFLICT")
          }
        } else {
          if (receipts.currentReceiptVersion(intent.reportId) != intent.observedIncidentVersion) return ActionCommitResult(intent.actionId, ActionCommitState.CONFLICT, reason = "INCIDENT_VERSION_CONFLICT")
          val exists = db.rawQuery("SELECT 1 FROM receipt_report_identities WHERE report_id=?", arrayOf(intent.reportId)).use { it.moveToFirst() }
          if (!exists) return ActionCommitResult(intent.actionId, ActionCommitState.REJECTED, reason = "REPORT_IDENTITY_MISSING")
          val capacity = db.rawQuery("SELECT count(*),coalesce(sum(length(CAST(note AS BLOB))+256),0) FROM gateway_work", null).use { it.moveToFirst(); it.getInt(0) < 10000 && it.getLong(1) + intent.note.toByteArray(Charsets.UTF_8).size + 256 <= 67108864 }
          if (!capacity) return ActionCommitResult(intent.actionId, ActionCommitState.REJECTED, reason = "CAPACITY_FULL")
          db.insertOrThrow("gateway_work", null, ContentValues().apply {
            put("action_id", intent.actionId); put("report_id", intent.reportId); put("observed_version", intent.observedIncidentVersion)
            put("status", intent.status); put("note", intent.note); put("saved_at_ms", wallClock())
            activeGrant()?.first?.grantId?.let { put("bound_grant_id", it) }
          })
        }
      }
      db.setTransactionSuccessful()
    } finally { db.endTransaction() }
    return getGatewayAction(intent.actionId)
  }

  @Synchronized internal fun prepareGatewayAction(intent: ActionIntent): ActionCommitResult {
    if (!qualified()) return ActionCommitResult(intent.actionId, ActionCommitState.REJECTED, reason = "AUTHORITY_UNAVAILABLE")
    if (!deviceAccess()) return ActionCommitResult(intent.actionId, ActionCommitState.REJECTED, reason = "DEVICE_ACCESS_REQUIRED")
    fun pending(reason: String) = ActionCommitResult(intent.actionId, ActionCommitState.PREPARING, reason = reason)
    receipts.getReceipt(intent.actionId)?.let { return ActionCommitResult(intent.actionId, ActionCommitState.SIGNED, it) }
    val allocated = database.readableDatabase.rawQuery("SELECT 1 FROM receipt_actions WHERE action_id=?", arrayOf(intent.actionId)).use { it.moveToFirst() }
    if (!allocated && receipts.currentReceiptVersion(intent.reportId) != intent.observedIncidentVersion) {
      return ActionCommitResult(intent.actionId, ActionCommitState.CONFLICT, reason = "INCIDENT_VERSION_CONFLICT")
    }
    val boundGrant = database.readableDatabase.rawQuery("SELECT bound_grant_id FROM gateway_work WHERE action_id=?", arrayOf(intent.actionId)).use { it.moveToFirst(); if (it.isNull(0)) null else it.getString(0) }
    val grant = activeGrant()?.first ?: return pending("AUTHORITY_UNAVAILABLE")
    // Native unbound work must be explicitly resubmitted after provisioning. Once bound it cannot move issuers.
    if (boundGrant != null && boundGrant != grant.grantId) return pending("ORIGINAL_ISSUER_UNAVAILABLE")
    val context = verificationContext()
    val time = context.trustedTime ?: return pending("TIME_UNAVAILABLE")
    if (time.earliestMs < grant.notBeforeMs || time.latestMs >= grant.expiresAtMs || grant.statusMask and (1 shl (intent.status - 1)) == 0) return pending("AUTHORITY_UNAVAILABLE")
    val identity = runCatching(identityProvider).getOrNull() ?: return pending("SIGNER_UNAVAILABLE")
    if (!same(grant.issuerKeyId, identity.keyId)) return pending("ORIGINAL_ISSUER_UNAVAILABLE")
    val grantBytes = database.readableDatabase.rawQuery("SELECT object_bytes FROM receipt_grants WHERE grant_id=?", arrayOf(grant.grantId)).use { it.moveToFirst(); it.getBlob(0) }
    // Reverify stored authority before signing; no trust is inferred from a cached display name.
    val decodedGrant = ReceiptV2Codec.decode(grantBytes)
    val root = pinnedRoots[hex(grant.rootKeyId)] ?: return pending("UNKNOWN_ROOT")
    if (!same(hash(root), grant.rootKeyId) || !ReceiptV2Codec.verifySignature(decodedGrant, root) || grant.scope !in allowedScopes || grant.purposeMask and 1 == 0) return pending("AUTHORITY_UNAVAILABLE")
    val proof = ByteBuffer.allocate(grantBytes.size + 3).put(1).putShort(grantBytes.size.toShort()).put(grantBytes).array()
    val repo = ReceiptRepository(database, ResponderSignerProfile(qualifiedIdentity(identity), 2, grant.grantId, grant.responderId, grant.callsign, proof),
      verificationContextProvider = { report, _ -> verificationContext(report) }, clock = { trustedTime()?.latestMs ?: error("TIME_UNAVAILABLE") })
    return try {
      val db = database.writableDatabase
      db.beginTransaction()
      try {
        val freshBinding = db.rawQuery("SELECT bound_grant_id FROM gateway_work WHERE action_id=?", arrayOf(intent.actionId)).use { it.moveToFirst(); if (it.isNull(0)) null else it.getString(0) }
        check(freshBinding == null || freshBinding == grant.grantId) { "ORIGINAL_ISSUER_UNAVAILABLE" }
        db.execSQL("UPDATE gateway_work SET bound_grant_id=? WHERE action_id=? AND bound_grant_id IS NULL", arrayOf(grant.grantId, intent.actionId))
        val expected = db.rawQuery("SELECT intent_json FROM gateway_api_actions WHERE action_id=?", arrayOf(intent.actionId)).use { c ->
          if (!c.moveToFirst()) null else org.json.JSONObject(c.getString(0)).let { j ->
            fun bytes(name: String) = j.getString(name).let { s -> ByteArray(32) { s.substring(it*2,it*2+2).toInt(16).toByte() } }
            ReportIdentity(j.getString("reportId"),j.getInt("reportProtocolVersion"),j.getInt("revision"),bytes("payloadDigest"),bytes("originKeyId"),ByteArray(0))
          }
        }
        repo.allocateAction(intent, expected)
        db.setTransactionSuccessful()
      } finally { db.endTransaction() }
      val result = repo.prepareReceipt(intent.actionId)
      if (result.state == ActionCommitState.SIGNED) result else pending(result.reason ?: "SIGNING_PENDING")
    } catch (_: Exception) { pending("ISSUANCE_PENDING") }
  }

  fun getGatewayAction(actionId: String): ActionCommitResult {
    if (!qualified()) return ActionCommitResult(actionId, ActionCommitState.REJECTED, reason = "AUTHORITY_UNAVAILABLE")
    if (!deviceAccess()) return ActionCommitResult(actionId, ActionCommitState.REJECTED, reason = "DEVICE_ACCESS_REQUIRED")
    val exists = database.readableDatabase.rawQuery("SELECT 1 FROM gateway_work WHERE action_id=?", arrayOf(actionId)).use { it.moveToFirst() }
    if (!exists) return ActionCommitResult(actionId, ActionCommitState.REJECTED, reason = "ACTION_NOT_FOUND")
    val bytes = receipts.getReceipt(actionId)
    return ActionCommitResult(actionId, if (bytes == null) ActionCommitState.PREPARING else ActionCommitState.SIGNED, bytes)
  }

  private fun qualifiedIdentity(identity: SigningIdentity) = object : SigningIdentity {
    override val keyId get() = identity.keyId
    override val publicKeyDer get() = identity.publicKeyDer
    override fun sign(data: ByteArray): ByteArray {
      access()
      return identity.sign(data)
    }
  }

  companion object {
    private const val NIL = "00000000-0000-0000-0000-000000000000"
    private const val MAX_GATEWAY_TIME_REQUESTS = 10_000
  }
}
