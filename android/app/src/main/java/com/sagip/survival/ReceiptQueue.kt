package com.sagip.survival

import android.content.ContentValues
import java.security.MessageDigest
import java.util.UUID
import net.zetetic.database.sqlcipher.SQLiteDatabase

enum class ObjectKind(val wireCode: Int) {
  SOS(1),
  RESPONDER_RECEIPT(2),
  REQUESTER_RECEIPT(3),
}

enum class CustodyResultKind {
  COMMITTED,
  DUPLICATE,
  PENDING_VERIFICATION,
  CAPACITY_FULL,
  REJECTED,
}

data class CustodyResult(
  val kind: CustodyResultKind,
  val objectId: String? = null,
  val digest: ByteArray? = null,
  val reason: String? = null,
  // Local projection acceptance is independent from a promise to forward.
  val localApplication: ReceiptApplication? = null,
)

data class StoredObject(
  val objectKind: ObjectKind,
  val objectId: String,
  val digest: ByteArray,
  val bytes: ByteArray,
  val reportId: String,
  val revision: Int,
  val signedIssuedAtMs: Long?,
  val signedExpiresAtMs: Long?,
  val custodyAcceptedAtMs: Long,
  val custodyExpiresAtMs: Long,
  val verificationClass: String,
  val transportState: String,
)

data class ExpiryResult(
  val expiredObjects: Int,
  val purgedTombstones: Int,
  val timeAvailable: Boolean,
)

data class InventoryEntry(
  val objectKind: ObjectKind,
  val objectId: String,
  val digest: ByteArray,
  val reportId: String,
  val revision: Int,
  val custodyAcceptedAtMs: Long,
  val reportProtocolVersion: Int = 1,
  val forwardingExpiresAtMs: Long = 0L,
)

data class InventoryPage(
  val entries: List<InventoryEntry>,
  val nextCursor: String?,
  val snapshotId: String? = null,
  val pageIndex: Int = 0,
  val totalCount: Int = entries.size,
  val nextPage: Int? = null,
)

data class TransferLease(
  val leaseId: String,
  val objectKind: ObjectKind,
  val objectId: String,
  val digest: ByteArray,
  val bytes: ByteArray,
  val reportId: String,
  val leaseUntilMs: Long,
  val attemptNumber: Int,
)

enum class TransferOutcome {
  PEER_CUSTODY,
  ALREADY_HAVE_VERIFIED,
  PENDING_VERIFICATION,
  RETRYABLE,
  PERMANENT_REJECTION,
}

data class ReceiptQueueLimits(
  val activeObjects: Int = 10_000,
  val activeBytes: Long = 64L * 1024L * 1024L,
  val quarantineObjects: Int = 128,
  val quarantineBytes: Long = 1L * 1024L * 1024L,
  val tombstoneObjects: Int = 100_000,
  val tombstoneBytes: Long = 8L * 1024L * 1024L,
) {
  init {
    require(activeObjects >= 0 && activeBytes >= 0)
    require(quarantineObjects >= 0 && quarantineBytes >= 0)
    require(tombstoneObjects >= 0 && tombstoneBytes >= 0)
  }

  companion object {
    const val RELAY_RETENTION_MS = 7L * 24L * 60L * 60L * 1000L
    const val REPLAY_RETENTION_MS = 7L * 24L * 60L * 60L * 1000L
  }
}

class ReceiptQueue(
  private val database: SagipDatabase,
  private val limits: ReceiptQueueLimits = ReceiptQueueLimits(),
) {
  private data class Candidate(
    val kind: ObjectKind,
    val objectId: String,
    val digest: ByteArray,
    val bytes: ByteArray,
    val reportId: String,
    val revision: Int,
    val signedIssuedAtMs: Long?,
    val signedExpiresAtMs: Long?,
    val verificationClass: String,
    val verifiedEnvelope: VerifiedTransportEnvelope? = null,
  )

  fun admitObject(
    bytes: ByteArray,
    kind: ObjectKind,
    context: VerificationContext,
  ): CustodyResult {
    if (bytes.isEmpty() || bytes.size > ReceiptV2Codec.MAX_RECEIPT_BYTES) {
      return CustodyResult(CustodyResultKind.REJECTED, reason = "OBJECT_SIZE")
    }

    val parsed = parseCandidate(bytes, kind, context)
    if (parsed.result != null) return parsed.result
    val candidate = requireNotNull(parsed.candidate)

    val db = database.writableDatabase
    if (hasExactKnownObject(db, candidate.kind, candidate.objectId, candidate.digest)) {
      return CustodyResult(
        CustodyResultKind.DUPLICATE,
        candidate.objectId,
        candidate.digest.copyOf(),
      )
    }
    if (candidate.signedExpiresAtMs != null &&
      knownExpiredFromHighWater(db, candidate.signedExpiresAtMs)) {
      quarantine(db, candidate, "SIGNED_OBJECT_EXPIRED")
      return CustodyResult(
        CustodyResultKind.REJECTED,
        candidate.objectId,
        candidate.digest.copyOf(),
        "SIGNED_OBJECT_EXPIRED",
      )
    }
    val trustedTime = acceptableTrustedTime(db, context)
    if (trustedTime == null) {
      quarantine(db, candidate, "TRUSTED_TIME_UNAVAILABLE")
      return CustodyResult(
        CustodyResultKind.PENDING_VERIFICATION,
        candidate.objectId,
        candidate.digest.copyOf(),
        "TRUSTED_TIME_UNAVAILABLE",
      )
    }

    if (candidate.signedExpiresAtMs != null && trustedTime.latestMs >= candidate.signedExpiresAtMs) {
      quarantine(db, candidate, "SIGNED_OBJECT_EXPIRED")
      return CustodyResult(
        CustodyResultKind.REJECTED,
        candidate.objectId,
        candidate.digest.copyOf(),
        "SIGNED_OBJECT_EXPIRED",
      )
    }

    val localDeadline = safeAdd(trustedTime.earliestMs, ReceiptQueueLimits.RELAY_RETENTION_MS)
    val custodyExpiresAt = candidate.signedExpiresAtMs?.let { minOf(it, localDeadline) } ?: localDeadline
    val protectedUntil = safeAdd(
      candidate.signedExpiresAtMs ?: custodyExpiresAt,
      ReceiptQueueLimits.REPLAY_RETENTION_MS,
    )
    val activeBytes = activeAccountedBytes(candidate)
    val tombstoneBytes = tombstoneAccountedBytes(candidate)

    var localApplication: ReceiptApplication? = null
    db.beginTransaction()
    try {
      if (!timeStillAcceptableLocked(db, trustedTime)) {
        insertQuarantineLocked(db, candidate, "TRUSTED_TIME_ROLLBACK")
        trimQuarantineLocked(db)
        db.setTransactionSuccessful()
        return CustodyResult(
          CustodyResultKind.PENDING_VERIFICATION,
          candidate.objectId,
          candidate.digest.copyOf(),
          "TRUSTED_TIME_ROLLBACK",
        )
      }
      when (val identity = identityStateLocked(db, candidate)) {
        IdentityState.DUPLICATE -> {
          updateTimeHighWaterLocked(db, trustedTime.earliestMs)
          db.setTransactionSuccessful()
          return CustodyResult(
            CustodyResultKind.DUPLICATE,
            candidate.objectId,
            candidate.digest.copyOf(),
          )
        }
        IdentityState.CONFLICT -> {
          insertQuarantineLocked(db, candidate, "AUTHENTICATED_ID_EQUIVOCATION")
          trimQuarantineLocked(db)
          db.setTransactionSuccessful()
          return CustodyResult(
            CustodyResultKind.REJECTED,
            candidate.objectId,
            candidate.digest.copyOf(),
            "AUTHENTICATED_ID_EQUIVOCATION",
          )
        }
        IdentityState.ABSENT -> Unit
      }

    if (kind != ObjectKind.SOS) {
      when (ReceiptRepository(database).applyToReport(bytes, context).also { localApplication = it }) {
        ReceiptApplication.APPLIED,
        ReceiptApplication.HISTORICAL,
        ReceiptApplication.DUPLICATE -> Unit
        ReceiptApplication.PENDING_AUTHORITY -> {
          insertQuarantineLocked(db, candidate, "RECEIPT_APPLICATION_PENDING")
          trimQuarantineLocked(db)
          db.setTransactionSuccessful()
          return CustodyResult(
            CustodyResultKind.PENDING_VERIFICATION,
            candidate.objectId,
            candidate.digest.copyOf(),
            "RECEIPT_APPLICATION_PENDING",
          )
        }
        ReceiptApplication.REJECTED -> {
          insertQuarantineLocked(db, candidate, "RECEIPT_APPLICATION_REJECTED")
          trimQuarantineLocked(db)
          db.setTransactionSuccessful()
          return CustodyResult(
            CustodyResultKind.REJECTED,
            candidate.objectId,
            candidate.digest.copyOf(),
            "RECEIPT_APPLICATION_REJECTED",
          )
        }
      }
    }

      if (!hasActiveCapacityLocked(db, activeBytes) || !hasTombstoneCapacityLocked(db, tombstoneBytes)) {
        db.setTransactionSuccessful()
        return CustodyResult(
          CustodyResultKind.CAPACITY_FULL,
          candidate.objectId,
          candidate.digest.copyOf(),
          "CUSTODY_CAPACITY_FULL",
          localApplication = localApplication,
        )
      }

      if (candidate.kind == ObjectKind.SOS) {
        // Legacy upload dedupe may suppress equal payloads across distinct signed revisions.
        // Typed custody still binds every exact verified envelope identity atomically.
        ReceiptRepository.persistReportIdentity(db, candidate.bytes, trustedTime.earliestMs)
        EmergencyRepository(database).persistVerifiedInboundEnvelope(
          db,
          candidate.bytes,
          requireNotNull(candidate.verifiedEnvelope),
          trustedTime.earliestMs,
        )
      }

      db.insertOrThrow(
        "relay_object_tombstones",
        null,
        ContentValues().apply {
          put("object_kind", candidate.kind.wireCode)
          put("object_id", candidate.objectId)
          put("object_digest", candidate.digest)
          candidate.signedExpiresAtMs?.let { put("signed_expires_at_ms", it) }
          put("protected_until_ms", protectedUntil)
          put("accounted_bytes", tombstoneBytes)
        },
      )
      db.insertOrThrow(
        "relay_objects",
        null,
        ContentValues().apply {
          put("object_kind", candidate.kind.wireCode)
          put("object_id", candidate.objectId)
          put("object_digest", candidate.digest)
          put("object_bytes", candidate.bytes)
          put("report_id", candidate.reportId)
          put("revision", candidate.revision)
          candidate.signedIssuedAtMs?.let { put("signed_issued_at_ms", it) }
          candidate.signedExpiresAtMs?.let { put("signed_expires_at_ms", it) }
          put("custody_accepted_at_ms", trustedTime.earliestMs)
          put("custody_expires_at_ms", custodyExpiresAt)
          put("verification_class", candidate.verificationClass)
          put("transport_state", TRANSPORT_READY)
          put("accounted_bytes", activeBytes)
        },
      )
      db.delete("receipt_quarantine", "lower(hex(object_digest))=?", arrayOf(hex(candidate.digest)))
      updateTimeHighWaterLocked(db, trustedTime.earliestMs)
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }

    return CustodyResult(
      CustodyResultKind.COMMITTED,
      candidate.objectId,
      candidate.digest.copyOf(),
      localApplication = localApplication,
    )
  }

  fun getObject(id: String, digest: ByteArray): StoredObject? {
    UUID.fromString(id)
    require(digest.size == SHA256_BYTES)
    return database.readableDatabase.rawQuery(
      """
        SELECT object_kind,object_id,object_digest,object_bytes,report_id,revision,
               signed_issued_at_ms,signed_expires_at_ms,custody_accepted_at_ms,custody_expires_at_ms,
               verification_class,transport_state
        FROM relay_objects
        WHERE object_id=? AND lower(hex(object_digest))=?
        LIMIT 1
      """.trimIndent(),
      arrayOf(id, hex(digest)),
    ).use { cursor ->
      if (!cursor.moveToFirst()) null else StoredObject(
        objectKind = objectKind(cursor.getInt(0)),
        objectId = cursor.getString(1),
        digest = cursor.getBlob(2).copyOf(),
        bytes = cursor.getBlob(3).copyOf(),
        reportId = cursor.getString(4),
        revision = cursor.getInt(5),
        signedIssuedAtMs = if (cursor.isNull(6)) null else cursor.getLong(6),
        signedExpiresAtMs = if (cursor.isNull(7)) null else cursor.getLong(7),
        custodyAcceptedAtMs = cursor.getLong(8),
        custodyExpiresAtMs = cursor.getLong(9),
        verificationClass = cursor.getString(10),
        transportState = cursor.getString(11),
      )
    }
  }

  fun inventoryEntry(id: String, digest: ByteArray): InventoryEntry? {
    val stored = getObject(id, digest) ?: return null
    return InventoryEntry(
      objectKind = stored.objectKind,
      objectId = stored.objectId,
      digest = stored.digest.copyOf(),
      reportId = stored.reportId,
      revision = stored.revision,
      custodyAcceptedAtMs = stored.custodyAcceptedAtMs,
      reportProtocolVersion = inventoryProtocolVersion(stored.objectKind, stored.bytes),
      forwardingExpiresAtMs = if (stored.objectKind == ObjectKind.SOS) {
        0L
      } else {
        requireNotNull(stored.signedExpiresAtMs) { "receipt inventory expiry missing" }
      },
    )
  }

  fun expireRelayObjects(context: VerificationContext): ExpiryResult {
    val db = database.writableDatabase
    val trustedTime = acceptableTrustedTime(db, context)
      ?: return ExpiryResult(0, 0, timeAvailable = false)

    db.beginTransaction()
    try {
      if (!timeStillAcceptableLocked(db, trustedTime)) {
        return ExpiryResult(0, 0, timeAvailable = false)
      }
      val expired = db.delete(
        "relay_objects",
        "custody_expires_at_ms<=?",
        arrayOf(trustedTime.earliestMs.toString()),
      )
      val purged = db.delete(
        "relay_object_tombstones",
        "protected_until_ms<=?",
        arrayOf(trustedTime.earliestMs.toString()),
      )
      updateTimeHighWaterLocked(db, trustedTime.earliestMs)
      db.setTransactionSuccessful()
      return ExpiryResult(expired, purged, timeAvailable = true)
    } finally {
      db.endTransaction()
    }
  }

  fun inventory(cursor: String?, limit: Int = MAX_INVENTORY_ENTRIES): InventoryPage {
    require(limit in 1..MAX_INVENTORY_ENTRIES) {
      "limit must be between 1 and $MAX_INVENTORY_ENTRIES"
    }
    val decodedCursor = cursor?.let(::decodeInventoryCursor)
    val args = ArrayList<String>()
    val where = if (decodedCursor == null) {
      "transport_state=?"
    } else {
      args += decodedCursor.custodyAcceptedAtMs.toString()
      args += decodedCursor.custodyAcceptedAtMs.toString()
      args += decodedCursor.objectKind.wireCode.toString()
      args += decodedCursor.custodyAcceptedAtMs.toString()
      args += decodedCursor.objectKind.wireCode.toString()
      args += decodedCursor.objectId
      """
        transport_state=? AND (
          custody_accepted_at_ms>? OR
          (custody_accepted_at_ms=? AND object_kind>?) OR
          (custody_accepted_at_ms=? AND object_kind=? AND object_id>?)
        )
      """.trimIndent()
    }
    args.add(0, TRANSPORT_READY)
    args += (limit + 1).toString()
    val rows = database.readableDatabase.rawQuery(
      """
        SELECT object_kind,object_id,object_digest,report_id,revision,custody_accepted_at_ms,object_bytes,signed_expires_at_ms
        FROM relay_objects
        WHERE $where
        ORDER BY custody_accepted_at_ms ASC,object_kind ASC,object_id ASC
        LIMIT ?
      """.trimIndent(),
      args.toTypedArray(),
    ).use { cursorResult ->
      buildList {
        while (cursorResult.moveToNext()) {
          add(
            InventoryEntry(
              objectKind = objectKind(cursorResult.getInt(0)),
              objectId = cursorResult.getString(1),
              digest = cursorResult.getBlob(2).copyOf(),
              reportId = cursorResult.getString(3),
              revision = cursorResult.getInt(4),
              custodyAcceptedAtMs = cursorResult.getLong(5),
              reportProtocolVersion = inventoryProtocolVersion(
                objectKind(cursorResult.getInt(0)),
                cursorResult.getBlob(6),
              ),
              forwardingExpiresAtMs = if (objectKind(cursorResult.getInt(0)) == ObjectKind.SOS) {
                0L
              } else {
                require(!cursorResult.isNull(7)) { "receipt inventory expiry missing" }
                cursorResult.getLong(7)
              },
            ),
          )
        }
      }
    }
    val pageEntries = rows.take(limit)
    val nextCursor = if (rows.size > limit) pageEntries.lastOrNull()?.let(::encodeInventoryCursor) else null
    return InventoryPage(pageEntries, nextCursor)
  }

  fun contactInventory(limit: Int = MAX_INVENTORY_ENTRIES,
    eligible: ((ObjectKind, ByteArray) -> Boolean)? = null,
  ): List<InventoryEntry> {
    require(limit in 1..MAX_INVENTORY_ENTRIES) { "limit must be between 1 and $MAX_INVENTORY_ENTRIES" }
    val after = if (eligible != null) scanCursor("inventory_row_id") else 0L
    var scanned = after
    data class Candidate(val scheduling: SchedulingCandidate, val entry: InventoryEntry)
    val candidates = database.readableDatabase.rawQuery(
      """
        SELECT object_kind,object_id,object_digest,object_bytes,report_id,revision,
               custody_accepted_at_ms,signed_expires_at_ms,rowid
        FROM relay_objects
        WHERE transport_state=?
        ORDER BY CASE WHEN rowid>? THEN 0 ELSE 1 END,rowid
        LIMIT ?
      """.trimIndent(),
      arrayOf(TRANSPORT_READY, after.toString(), minOf(limits.activeObjects, if (eligible == null) limits.activeObjects else MAX_TRUST_SCAN).toString()),
    ).use { cursor ->
      buildList {
        while (cursor.moveToNext()) {
          scanned = cursor.getLong(8)
          val kind = objectKind(cursor.getInt(0))
          val bytes = cursor.getBlob(3).copyOf()
          if (eligible != null && !runCatching { eligible(kind, bytes) }.getOrDefault(false)) continue
          add(
            Candidate(
              scheduling = SchedulingCandidate(
                reportId = cursor.getString(4),
                objectKind = kind,
                objectId = cursor.getString(1),
                custodyAcceptedAtMs = cursor.getLong(6),
                initialResponderAck = isInitialResponderAck(kind, bytes),
              ),
              entry = InventoryEntry(
                objectKind = kind,
                objectId = cursor.getString(1),
                digest = cursor.getBlob(2).copyOf(),
                reportId = cursor.getString(4),
                revision = cursor.getInt(5),
                custodyAcceptedAtMs = cursor.getLong(6),
                reportProtocolVersion = inventoryProtocolVersion(kind, bytes),
                forwardingExpiresAtMs = if (kind == ObjectKind.SOS) {
                  0L
                } else {
                  require(!cursor.isNull(7)) { "receipt inventory expiry missing" }
                  cursor.getLong(7)
                },
              ),
            ),
          )
        }
      }
    }
    if (eligible != null) saveScanCursor("inventory_row_id", scanned)
    val byIdentity = candidates.associateBy { it.scheduling.objectKind to it.scheduling.objectId }
    return ReceiptTransferScheduler().order(candidates.map { it.scheduling })
      .take(limit)
      .map { scheduling ->
        requireNotNull(byIdentity[scheduling.objectKind to scheduling.objectId]).entry.copy(
          digest = requireNotNull(byIdentity[scheduling.objectKind to scheduling.objectId]).entry.digest.copyOf(),
        )
      }
  }

  fun knownVerifiedDigest(kind: ObjectKind, id: String): ByteArray? {
    UUID.fromString(id)
    val db = database.readableDatabase
    fun read(table: String): ByteArray? = db.rawQuery(
      "SELECT object_digest FROM $table WHERE object_kind=? AND object_id=? LIMIT 1",
      arrayOf(kind.wireCode.toString(), id),
    ).use { cursor -> if (cursor.moveToFirst()) cursor.getBlob(0).copyOf() else null }
    return read("relay_objects") ?: read("relay_object_tombstones")
  }

  fun touchContact(peerId: String, nowMs: Long) {
    require(peerId.isNotBlank()) { "peerId must not be blank" }
    require(nowMs >= 0L) { "nowMs must not be negative" }
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      contactAllowanceLocked(db, peerId, nowMs)
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  fun claimContactTransfer(peerId: String, nowMs: Long): Boolean {
    require(peerId.isNotBlank()) { "peerId must not be blank" }
    require(nowMs >= 0L) { "nowMs must not be negative" }
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      val allowance = contactAllowanceLocked(db, peerId, nowMs)
      if (allowance <= 0) {
        db.setTransactionSuccessful()
        return false
      }
      recordContactAttemptsLocked(db, peerId, 1, nowMs)
      db.setTransactionSuccessful()
      return true
    } finally {
      db.endTransaction()
    }
  }

  fun leaseContactWork(
    peerId: String,
    nowMs: Long,
    maxObjects: Int = ReceiptTransferScheduler.MAX_CONTACT_OBJECTS,
    eligible: ((ObjectKind, ByteArray) -> Boolean)? = null,
    custodyTimeMs: Long = nowMs,
  ): List<TransferLease> {
    require(peerId.isNotBlank()) { "peerId must not be blank" }
    require(nowMs >= 0L) { "nowMs must not be negative" }
    require(maxObjects in 1..ReceiptTransferScheduler.MAX_CONTACT_OBJECTS) {
      "maxObjects must be between 1 and ${ReceiptTransferScheduler.MAX_CONTACT_OBJECTS}"
    }

    val db = database.writableDatabase
    db.beginTransaction()
    try {
      db.execSQL(
        "UPDATE relay_transfer_leases SET state='EXPIRED' WHERE state='ACTIVE' AND lease_until_ms<=?",
        arrayOf<Any?>(nowMs),
      )
      val contactAllowance = contactAllowanceLocked(db, peerId, nowMs)
      if (contactAllowance <= 0) {
        db.setTransactionSuccessful()
        return emptyList()
      }
      val after = if (eligible != null) scanCursor("lease_row_id") else 0L
      var scanned = after
      val stored = db.rawQuery(
        """
          SELECT ro.object_kind,ro.object_id,ro.object_digest,ro.object_bytes,ro.report_id,
                 ro.custody_accepted_at_ms,COALESCE(ps.attempt_count,0),ro.rowid
          FROM relay_objects ro
          LEFT JOIN relay_peer_object_state ps
            ON ps.peer_id=? AND ps.object_kind=ro.object_kind AND ps.object_id=ro.object_id
          WHERE ro.transport_state=?
            AND ro.custody_expires_at_ms>?
            AND ps.terminal_outcome IS NULL
            AND COALESCE(ps.next_attempt_at_ms,0)<=?
            AND NOT EXISTS (
              SELECT 1 FROM relay_transfer_leases active
              WHERE active.object_kind=ro.object_kind
                AND active.object_id=ro.object_id
                AND active.state='ACTIVE'
            )
          ORDER BY CASE WHEN ro.rowid>? THEN 0 ELSE 1 END,ro.rowid
          LIMIT ?
        """.trimIndent(),
        arrayOf(peerId, TRANSPORT_READY, custodyTimeMs.toString(), nowMs.toString(), after.toString(),
          minOf(limits.activeObjects, if (eligible == null) limits.activeObjects else MAX_TRUST_SCAN).toString()),
      ).use { cursorResult ->
        buildList {
          while (cursorResult.moveToNext()) {
            scanned = cursorResult.getLong(7)
            val kind = objectKind(cursorResult.getInt(0))
            val bytes = cursorResult.getBlob(3).copyOf()
            if (eligible != null && !runCatching { eligible(kind, bytes) }.getOrDefault(false)) continue
            add(
              LeaseCandidate(
                scheduling = SchedulingCandidate(
                  reportId = cursorResult.getString(4),
                  objectKind = kind,
                  objectId = cursorResult.getString(1),
                  custodyAcceptedAtMs = cursorResult.getLong(5),
                  initialResponderAck = isInitialResponderAck(kind, bytes),
                ),
                digest = cursorResult.getBlob(2).copyOf(),
                bytes = bytes,
                attemptNumber = cursorResult.getInt(6) + 1,
              ),
            )
          }
        }
      }
      if (eligible != null) saveScanCursor("lease_row_id", scanned)
      val selected = ReceiptTransferScheduler().select(
        stored.map { it.scheduling },
        minOf(maxObjects, contactAllowance),
      )
      val byIdentity = stored.associateBy { it.scheduling.objectKind to it.scheduling.objectId }
      val leaseUntilMs = safeAdd(nowMs, TRANSFER_LEASE_MS)
      val leases = selected.map { scheduling ->
        val candidate = requireNotNull(byIdentity[scheduling.objectKind to scheduling.objectId])
        val leaseId = UUID.randomUUID().toString()
        db.insertOrThrow(
          "relay_transfer_leases",
          null,
          ContentValues().apply {
            put("lease_id", leaseId)
            put("object_kind", scheduling.objectKind.wireCode)
            put("object_id", scheduling.objectId)
            put("object_digest", candidate.digest)
            put("peer_id", peerId)
            put("lease_until_ms", leaseUntilMs)
            put("attempt_number", candidate.attemptNumber)
            put("state", LEASE_ACTIVE)
            put("created_at_ms", nowMs)
          },
        )
        TransferLease(
          leaseId = leaseId,
          objectKind = scheduling.objectKind,
          objectId = scheduling.objectId,
          digest = candidate.digest.copyOf(),
          bytes = candidate.bytes.copyOf(),
          reportId = scheduling.reportId,
          leaseUntilMs = leaseUntilMs,
          attemptNumber = candidate.attemptNumber,
        )
      }
      db.setTransactionSuccessful()
      return leases
    } finally {
      db.endTransaction()
    }
  }

  fun releaseTransferLease(leaseId: String, nowMs: Long) {
    UUID.fromString(leaseId)
    require(nowMs >= 0L) { "nowMs must not be negative" }
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      val state = db.rawQuery(
        "SELECT state,outcome FROM relay_transfer_leases WHERE lease_id=?",
        arrayOf(leaseId),
      ).use { cursor ->
        if (!cursor.moveToFirst()) null else cursor.getString(0) to (if (cursor.isNull(1)) null else cursor.getString(1))
      } ?: throw IllegalArgumentException("unknown transfer lease")
      if (state.first == LEASE_ACTIVE) {
        db.execSQL(
          "UPDATE relay_transfer_leases SET state='EXPIRED',outcome='NOT_ATTEMPTED',completed_at_ms=? WHERE lease_id=? AND state='ACTIVE'",
          arrayOf<Any?>(nowMs, leaseId),
        )
      } else if (state.first != "EXPIRED" || (state.second != null && state.second != "NOT_ATTEMPTED")) {
        throw IllegalStateException("transfer lease cannot be released")
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  fun finishTransfer(leaseId: String, outcome: TransferOutcome, nowMs: Long) {
    UUID.fromString(leaseId)
    require(nowMs >= 0L) { "nowMs must not be negative" }
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      val lease = db.rawQuery(
        """
          SELECT object_kind,object_id,peer_id,lease_until_ms,attempt_number,state,outcome
          FROM relay_transfer_leases WHERE lease_id=?
        """.trimIndent(),
        arrayOf(leaseId),
      ).use { cursorResult ->
        if (!cursorResult.moveToFirst()) null else StoredTransferLease(
          objectKind = objectKind(cursorResult.getInt(0)),
          objectId = cursorResult.getString(1),
          peerId = cursorResult.getString(2),
          leaseUntilMs = cursorResult.getLong(3),
          attemptNumber = cursorResult.getInt(4),
          state = cursorResult.getString(5),
          outcome = if (cursorResult.isNull(6)) null else cursorResult.getString(6),
        )
      } ?: throw IllegalArgumentException("unknown transfer lease")
      if (lease.state == LEASE_COMPLETED) {
        if (lease.outcome == outcome.name) {
          db.setTransactionSuccessful()
          return
        }
        throw IllegalStateException("completed transfer lease has a different outcome")
      }
      if (lease.state != LEASE_ACTIVE) throw IllegalStateException("transfer lease is not active")
      if (nowMs >= lease.leaseUntilMs) {
        db.execSQL(
          "UPDATE relay_transfer_leases SET state='EXPIRED' WHERE lease_id=? AND state='ACTIVE'",
          arrayOf<Any?>(leaseId),
        )
        db.setTransactionSuccessful()
        throw IllegalStateException("transfer lease expired before completion")
      }
      db.execSQL(
        "UPDATE relay_transfer_leases SET state='COMPLETED',outcome=?,completed_at_ms=? WHERE lease_id=? AND state='ACTIVE'",
        arrayOf<Any?>(outcome.name, nowMs, leaseId),
      )
      val terminalOutcome = when (outcome) {
        TransferOutcome.RETRYABLE -> null
        TransferOutcome.PEER_CUSTODY,
        TransferOutcome.ALREADY_HAVE_VERIFIED,
        TransferOutcome.PENDING_VERIFICATION,
        TransferOutcome.PERMANENT_REJECTION -> outcome.name
      }
      val nextAttemptAt = if (outcome == TransferOutcome.RETRYABLE) {
        safeAdd(
          nowMs,
          ReceiptTransferScheduler.retryDelayMs(
            lease.attemptNumber,
            kotlin.random.Random.Default.nextDouble(),
          ),
        )
      } else {
        nowMs
      }
      db.execSQL(
        """
          INSERT INTO relay_peer_object_state(
            peer_id,object_kind,object_id,attempt_count,next_attempt_at_ms,terminal_outcome,updated_at_ms
          ) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(peer_id,object_kind,object_id) DO UPDATE SET
            attempt_count=excluded.attempt_count,
            next_attempt_at_ms=excluded.next_attempt_at_ms,
            terminal_outcome=excluded.terminal_outcome,
            updated_at_ms=excluded.updated_at_ms
        """.trimIndent(),
        arrayOf<Any?>(
          lease.peerId,
          lease.objectKind.wireCode,
          lease.objectId,
          lease.attemptNumber,
          nextAttemptAt,
          terminalOutcome,
          nowMs,
        ),
      )
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  private fun contactAllowanceLocked(
    db: SQLiteDatabase,
    peerId: String,
    nowMs: Long,
  ): Int {
    if (nowMs >= CONTACT_INACTIVITY_MS) {
      db.delete(
        "relay_peer_contacts",
        "last_activity_at_ms<=?",
        arrayOf((nowMs - CONTACT_INACTIVITY_MS).toString()),
      )
    }
    val current = db.rawQuery(
      "SELECT last_activity_at_ms,attempted_transfers FROM relay_peer_contacts WHERE peer_id=?",
      arrayOf(peerId),
    ).use { cursor ->
      if (!cursor.moveToFirst()) null else cursor.getLong(0) to cursor.getInt(1)
    }
    if (current == null || (nowMs >= current.first && nowMs - current.first >= CONTACT_INACTIVITY_MS)) {
      if (current == null) {
        val peerCount = db.rawQuery("SELECT COUNT(*) FROM relay_peer_contacts", null).use { cursor ->
          cursor.moveToFirst()
          cursor.getInt(0)
        }
        if (peerCount >= MAX_CONTACT_PEERS) return 0
      }
      db.execSQL(
        """
          INSERT INTO relay_peer_contacts(peer_id,contact_started_at_ms,last_activity_at_ms,attempted_transfers)
          VALUES(?,?,?,0)
          ON CONFLICT(peer_id) DO UPDATE SET
            contact_started_at_ms=excluded.contact_started_at_ms,
            last_activity_at_ms=excluded.last_activity_at_ms,
            attempted_transfers=0
        """.trimIndent(),
        arrayOf<Any?>(peerId, nowMs, nowMs),
      )
      return ReceiptTransferScheduler.MAX_CONTACT_OBJECTS
    }
    db.execSQL(
      "UPDATE relay_peer_contacts SET last_activity_at_ms=MAX(last_activity_at_ms,?) WHERE peer_id=?",
      arrayOf<Any?>(nowMs, peerId),
    )
    return (ReceiptTransferScheduler.MAX_CONTACT_OBJECTS - current.second).coerceAtLeast(0)
  }

  private fun recordContactAttemptsLocked(
    db: SQLiteDatabase,
    peerId: String,
    count: Int,
    nowMs: Long,
  ) {
    require(count >= 0)
    if (count == 0) return
    db.execSQL(
      """
        UPDATE relay_peer_contacts
        SET attempted_transfers=attempted_transfers+?,last_activity_at_ms=MAX(last_activity_at_ms,?)
        WHERE peer_id=? AND attempted_transfers+?<=?
      """.trimIndent(),
      arrayOf<Any?>(count, nowMs, peerId, count, ReceiptTransferScheduler.MAX_CONTACT_OBJECTS),
    )
  }

  private data class LeaseCandidate(
    val scheduling: SchedulingCandidate,
    val digest: ByteArray,
    val bytes: ByteArray,
    val attemptNumber: Int,
  )

  private data class StoredTransferLease(
    val objectKind: ObjectKind,
    val objectId: String,
    val peerId: String,
    val leaseUntilMs: Long,
    val attemptNumber: Int,
    val state: String,
    val outcome: String?,
  )

  private data class ParsedInventoryCursor(
    val custodyAcceptedAtMs: Long,
    val objectKind: ObjectKind,
    val objectId: String,
  )

  private fun encodeInventoryCursor(entry: InventoryEntry): String =
    "${entry.custodyAcceptedAtMs}:${entry.objectKind.wireCode}:${entry.objectId}"

  private fun decodeInventoryCursor(cursor: String): ParsedInventoryCursor {
    val parts = cursor.split(':', limit = 3)
    require(parts.size == 3) { "invalid inventory cursor" }
    val acceptedAt = parts[0].toLongOrNull() ?: throw IllegalArgumentException("invalid inventory cursor")
    val kindCode = parts[1].toIntOrNull() ?: throw IllegalArgumentException("invalid inventory cursor")
    val kind = ObjectKind.entries.firstOrNull { it.wireCode == kindCode }
      ?: throw IllegalArgumentException("invalid inventory cursor")
    UUID.fromString(parts[2])
    return ParsedInventoryCursor(acceptedAt, kind, parts[2])
  }

  private fun inventoryProtocolVersion(kind: ObjectKind, bytes: ByteArray): Int = when (kind) {
    ObjectKind.SOS -> TransportEnvelope.decodeAndVerify(bytes).protocolVersion
    ObjectKind.RESPONDER_RECEIPT,
    ObjectKind.REQUESTER_RECEIPT -> when (val fields = ReceiptV2Codec.decode(bytes).fields) {
      is ReceiptFields.Responder -> fields.reportProtocolVersion
      is ReceiptFields.Requester -> fields.reportProtocolVersion
      else -> throw IllegalStateException("relay receipt inventory contains non-relay receipt")
    }
  }

  private fun isInitialResponderAck(kind: ObjectKind, bytes: ByteArray): Boolean {
    if (kind != ObjectKind.RESPONDER_RECEIPT) return false
    val fields = runCatching { ReceiptV2Codec.decode(bytes).fields }.getOrNull()
    return fields is ReceiptFields.Responder && fields.sequence == 1L
  }

  private data class ParseResult(
    val candidate: Candidate? = null,
    val result: CustodyResult? = null,
  )

  private fun parseCandidate(
    bytes: ByteArray,
    kind: ObjectKind,
    context: VerificationContext,
  ): ParseResult {
    return when (kind) {
      ObjectKind.SOS -> parseSos(bytes)
      ObjectKind.RESPONDER_RECEIPT,
      ObjectKind.REQUESTER_RECEIPT -> parseReceipt(bytes, kind, context)
    }
  }

  private fun parseSos(bytes: ByteArray): ParseResult {
    val verified = try {
      TransportEnvelope.decodeAndVerify(bytes)
    } catch (_: Exception) {
      quarantineRaw(bytes, ObjectKind.SOS, null, null, null, "INVALID_SOS_ENVELOPE")
      return ParseResult(result = CustodyResult(CustodyResultKind.REJECTED, reason = "INVALID_SOS_ENVELOPE"))
    }
    val (issuedAt, expiresAt) = try {
      when (verified.protocolVersion) {
        1 -> TransportEnvelopeV1.decode(bytes).let { it.createdAt to it.expiresAt }
        2 -> TransportEnvelopeV2.decode(bytes).let { it.createdAt to it.expiresAt }
        else -> throw IllegalArgumentException("unsupported envelope version")
      }
    } catch (_: Exception) {
      return ParseResult(result = CustodyResult(CustodyResultKind.REJECTED, reason = "INVALID_SOS_ENVELOPE"))
    }
    return ParseResult(
      candidate = Candidate(
        kind = ObjectKind.SOS,
        objectId = verified.messageId,
        digest = sha256(bytes),
        bytes = bytes.copyOf(),
        reportId = verified.reportId,
        revision = verified.revision,
        signedIssuedAtMs = issuedAt,
        signedExpiresAtMs = expiresAt,
        verificationClass = "VERIFIED_SOS_ENVELOPE",
        verifiedEnvelope = verified,
      ),
    )
  }

  private fun parseReceipt(
    bytes: ByteArray,
    kind: ObjectKind,
    context: VerificationContext,
  ): ParseResult {
    val decoded = try {
      ReceiptV2Codec.decode(bytes)
    } catch (_: Exception) {
      quarantineRaw(bytes, kind, null, null, null, "MALFORMED_RECEIPT")
      return ParseResult(result = CustodyResult(CustodyResultKind.REJECTED, reason = "MALFORMED_RECEIPT"))
    }
    val identity = when (val fields = decoded.fields) {
      is ReceiptFields.Responder -> {
        if (kind != ObjectKind.RESPONDER_RECEIPT) return wrongReceiptKind(bytes, kind, fields.actionId, fields.reportId, fields.revision)
        ReceiptIdentity(fields.actionId, fields.reportId, fields.revision, fields.issuedAtMs, fields.forwardingExpiresAtMs)
      }
      is ReceiptFields.Requester -> {
        if (kind != ObjectKind.REQUESTER_RECEIPT) return wrongReceiptKind(bytes, kind, fields.eventId, fields.reportId, fields.revision)
        ReceiptIdentity(fields.eventId, fields.reportId, fields.revision, fields.receivedAtMs, fields.forwardingExpiresAtMs)
      }
      else -> {
        quarantineRaw(bytes, kind, null, null, null, "NOT_RELAY_RECEIPT")
        return ParseResult(result = CustodyResult(CustodyResultKind.REJECTED, reason = "NOT_RELAY_RECEIPT"))
      }
    }

    val digest = sha256(bytes)
    val db = database.readableDatabase
    if (hasExactKnownObject(db, kind, identity.eventId, digest)) {
      return ParseResult(
        result = CustodyResult(
          CustodyResultKind.DUPLICATE,
          identity.eventId,
          digest.copyOf(),
        ),
      )
    }
    val trustedTime = acceptableTrustedTime(db, context)
    val verificationContext = if (trustedTime == null) context.copy(trustedTime = null) else context
    return when (val verification = ReceiptAuthority.verifyReceipt(bytes, verificationContext)) {
      is ReceiptVerification.Rejected -> {
        quarantineRaw(bytes, kind, identity.eventId, identity.reportId, identity.revision, verification.reason)
        ParseResult(
          result = CustodyResult(
            CustodyResultKind.REJECTED,
            identity.eventId,
            sha256(bytes),
            verification.reason,
          ),
        )
      }
      is ReceiptVerification.Unverified -> {
        if ((trustedTime != null && trustedTime.latestMs >= identity.expiresAtMs) ||
          knownExpiredFromHighWater(db, identity.expiresAtMs)) {
          quarantineRaw(bytes, kind, identity.eventId, identity.reportId, identity.revision, "SIGNED_OBJECT_EXPIRED")
          ParseResult(
            result = CustodyResult(
              CustodyResultKind.REJECTED,
              identity.eventId,
              sha256(bytes),
              "SIGNED_OBJECT_EXPIRED",
            ),
          )
        } else {
          quarantineRaw(bytes, kind, identity.eventId, identity.reportId, identity.revision, verification.reason)
          ParseResult(
            result = CustodyResult(
              CustodyResultKind.PENDING_VERIFICATION,
              identity.eventId,
              sha256(bytes),
              verification.reason,
            ),
          )
        }
      }
      is ReceiptVerification.Verified -> ParseResult(
        candidate = Candidate(
          kind = kind,
          objectId = identity.eventId,
          digest = sha256(bytes),
          bytes = bytes.copyOf(),
          reportId = identity.reportId,
          revision = identity.revision,
          signedIssuedAtMs = identity.issuedAtMs,
          signedExpiresAtMs = identity.expiresAtMs,
          verificationClass = verification.kind,
        ),
      )
    }
  }

  private data class ReceiptIdentity(
    val eventId: String,
    val reportId: String,
    val revision: Int,
    val issuedAtMs: Long,
    val expiresAtMs: Long,
  )

  private fun wrongReceiptKind(
    bytes: ByteArray,
    kind: ObjectKind,
    eventId: String,
    reportId: String,
    revision: Int,
  ): ParseResult {
    quarantineRaw(bytes, kind, eventId, reportId, revision, "OBJECT_KIND_MISMATCH")
    return ParseResult(
      result = CustodyResult(
        CustodyResultKind.REJECTED,
        eventId,
        sha256(bytes),
        "OBJECT_KIND_MISMATCH",
      ),
    )
  }

  private fun hasExactKnownObject(
    db: SQLiteDatabase,
    kind: ObjectKind,
    objectId: String,
    digest: ByteArray,
  ): Boolean {
    val active = db.rawQuery(
      "SELECT object_digest FROM relay_objects WHERE object_kind=? AND object_id=?",
      arrayOf(kind.wireCode.toString(), objectId),
    ).use { cursor -> if (cursor.moveToFirst()) cursor.getBlob(0) else null }
    if (active != null && MessageDigest.isEqual(active, digest)) return true
    val tombstone = db.rawQuery(
      "SELECT object_digest FROM relay_object_tombstones WHERE object_kind=? AND object_id=?",
      arrayOf(kind.wireCode.toString(), objectId),
    ).use { cursor -> if (cursor.moveToFirst()) cursor.getBlob(0) else null }
    return tombstone != null && MessageDigest.isEqual(tombstone, digest)
  }

  private fun scanCursor(column: String): Long = database.readableDatabase.rawQuery(
    "SELECT " + column + " FROM receipt_return_replay_state WHERE singleton=1", null,
  ).use { if (it.moveToFirst()) it.getLong(0) else 0L }

  private fun saveScanCursor(column: String, rowId: Long) {
    database.writableDatabase.execSQL(
      "INSERT INTO receipt_return_replay_state(singleton," + column + ") VALUES(1,?) " +
        "ON CONFLICT(singleton) DO UPDATE SET " + column + "=excluded." + column, arrayOf(rowId),
    )
  }

  private enum class IdentityState { ABSENT, DUPLICATE, CONFLICT }

  private fun identityStateLocked(db: SQLiteDatabase, candidate: Candidate): IdentityState {
    val active = db.rawQuery(
      "SELECT object_digest FROM relay_objects WHERE object_kind=? AND object_id=?",
      arrayOf(candidate.kind.wireCode.toString(), candidate.objectId),
    ).use { cursor -> if (cursor.moveToFirst()) cursor.getBlob(0) else null }
    if (active != null) return if (MessageDigest.isEqual(active, candidate.digest)) IdentityState.DUPLICATE else IdentityState.CONFLICT

    val tombstone = db.rawQuery(
      "SELECT object_digest FROM relay_object_tombstones WHERE object_kind=? AND object_id=?",
      arrayOf(candidate.kind.wireCode.toString(), candidate.objectId),
    ).use { cursor -> if (cursor.moveToFirst()) cursor.getBlob(0) else null }
    if (tombstone != null) return if (MessageDigest.isEqual(tombstone, candidate.digest)) IdentityState.DUPLICATE else IdentityState.CONFLICT

    if (candidate.kind != ObjectKind.SOS) {
      val evidenceDigest = db.rawQuery(
        "SELECT event_digest FROM receipt_records WHERE event_id=?",
        arrayOf(candidate.objectId),
      ).use { cursor -> if (cursor.moveToFirst()) cursor.getBlob(0) else null }
      if (evidenceDigest != null && !MessageDigest.isEqual(evidenceDigest, candidate.digest)) return IdentityState.CONFLICT
    }
    return IdentityState.ABSENT
  }

  private fun hasActiveCapacityLocked(db: SQLiteDatabase, newBytes: Long): Boolean {
    val usage = db.rawQuery(
      "SELECT COUNT(*),COALESCE(SUM(accounted_bytes),0) FROM relay_objects",
      null,
    ).use { cursor ->
      cursor.moveToFirst()
      cursor.getLong(0) to cursor.getLong(1)
    }
    return usage.first < limits.activeObjects && usage.second + newBytes <= limits.activeBytes
  }

  private fun hasTombstoneCapacityLocked(db: SQLiteDatabase, newBytes: Long): Boolean {
    val usage = db.rawQuery(
      "SELECT COUNT(*),COALESCE(SUM(accounted_bytes),0) FROM relay_object_tombstones",
      null,
    ).use { cursor ->
      cursor.moveToFirst()
      cursor.getLong(0) to cursor.getLong(1)
    }
    return usage.first < limits.tombstoneObjects && usage.second + newBytes <= limits.tombstoneBytes
  }

  private fun acceptableTrustedTime(db: SQLiteDatabase, context: VerificationContext): TimeInterval? {
    val time = context.trustedTime ?: return null
    if (time.earliestMs < 0 || time.latestMs < time.earliestMs || time.latestMs > MAX_PROTOCOL_TIME) return null
    return if (timeStillAcceptableLocked(db, time)) time else null
  }

  private fun timeStillAcceptableLocked(db: SQLiteDatabase, time: TimeInterval): Boolean {
    val highWater = persistedTimeHighWater(db)
    return highWater == null || time.earliestMs >= highWater
  }

  private fun knownExpiredFromHighWater(db: SQLiteDatabase, signedExpiresAtMs: Long): Boolean {
    val highWater = persistedTimeHighWater(db) ?: return false
    return highWater >= signedExpiresAtMs
  }

  private fun persistedTimeHighWater(db: SQLiteDatabase): Long? = db.rawQuery(
    "SELECT high_water_earliest_ms FROM relay_time_state WHERE state_id=1",
    null,
  ).use { cursor -> if (cursor.moveToFirst()) cursor.getLong(0) else null }

  private fun updateTimeHighWaterLocked(db: SQLiteDatabase, earliestMs: Long) {
    db.execSQL(
      """
        INSERT INTO relay_time_state(state_id,high_water_earliest_ms) VALUES(1,?)
        ON CONFLICT(state_id) DO UPDATE SET
          high_water_earliest_ms=MAX(high_water_earliest_ms,excluded.high_water_earliest_ms)
      """.trimIndent(),
      arrayOf<Any?>(earliestMs),
    )
  }

  private fun quarantine(db: SQLiteDatabase, candidate: Candidate, reason: String) {
    db.beginTransaction()
    try {
      insertQuarantineLocked(db, candidate, reason)
      trimQuarantineLocked(db)
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  private fun quarantineRaw(
    bytes: ByteArray,
    kind: ObjectKind,
    objectId: String?,
    reportId: String?,
    revision: Int?,
    reason: String,
  ) {
    val digest = sha256(bytes)
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      insertQuarantineValuesLocked(db, bytes, kind, objectId, reportId, revision, digest, reason)
      trimQuarantineLocked(db)
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  private fun insertQuarantineLocked(db: SQLiteDatabase, candidate: Candidate, reason: String) {
    insertQuarantineValuesLocked(
      db,
      candidate.bytes,
      candidate.kind,
      candidate.objectId,
      candidate.reportId,
      candidate.revision,
      candidate.digest,
      reason,
    )
  }

  private fun insertQuarantineValuesLocked(
    db: SQLiteDatabase,
    bytes: ByteArray,
    kind: ObjectKind,
    objectId: String?,
    reportId: String?,
    revision: Int?,
    digest: ByteArray,
    reason: String,
  ) {
    db.insertWithOnConflict(
      "receipt_quarantine",
      null,
      ContentValues().apply {
        put("object_digest", digest)
        objectId?.let { put("claimed_event_id", it) }
        put("claimed_object_kind", kind.wireCode)
        put("object_bytes", bytes)
        reportId?.let { put("report_id", it) }
        revision?.let { put("revision", it) }
        put("reason", reason)
        put("received_at_ms", System.currentTimeMillis())
      },
      SQLiteDatabase.CONFLICT_IGNORE,
    )
  }

  private fun trimQuarantineLocked(db: SQLiteDatabase) {
    while (true) {
      val usage = db.rawQuery(
        """
          SELECT COUNT(*),COALESCE(SUM(
            length(object_digest)+length(object_bytes)+
            COALESCE(length(CAST(claimed_event_id AS BLOB)),0)+
            COALESCE(length(CAST(report_id AS BLOB)),0)+
            CASE WHEN revision IS NULL THEN 0 ELSE 4 END+
            CASE WHEN claimed_object_kind IS NULL THEN 0 ELSE 1 END+
            length(CAST(reason AS BLOB))+8
          ),0)
          FROM receipt_quarantine
        """.trimIndent(),
        null,
      ).use { cursor ->
        cursor.moveToFirst()
        cursor.getLong(0) to cursor.getLong(1)
      }
      if (usage.first <= limits.quarantineObjects && usage.second <= limits.quarantineBytes) return
      val oldest = db.rawQuery(
        "SELECT lower(hex(object_digest)) FROM receipt_quarantine ORDER BY received_at_ms ASC,rowid ASC LIMIT 1",
        null,
      ).use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null } ?: return
      db.delete("receipt_quarantine", "lower(hex(object_digest))=?", arrayOf(oldest))
    }
  }

  private fun activeAccountedBytes(candidate: Candidate): Long {
    return candidate.bytes.size.toLong() +
      1L +
      candidate.objectId.toByteArray(Charsets.UTF_8).size +
      SHA256_BYTES +
      candidate.reportId.toByteArray(Charsets.UTF_8).size +
      4L +
      (if (candidate.signedIssuedAtMs == null) 0L else 8L) +
      (if (candidate.signedExpiresAtMs == null) 0L else 8L) +
      8L +
      8L +
      candidate.verificationClass.toByteArray(Charsets.UTF_8).size +
      TRANSPORT_READY.toByteArray(Charsets.UTF_8).size +
      8L
  }

  private fun tombstoneAccountedBytes(candidate: Candidate): Long {
    return 1L +
      candidate.objectId.toByteArray(Charsets.UTF_8).size +
      SHA256_BYTES +
      (if (candidate.signedExpiresAtMs == null) 0L else 8L) +
      8L +
      8L
  }

  private fun objectKind(wireCode: Int): ObjectKind =
    ObjectKind.entries.firstOrNull { it.wireCode == wireCode }
      ?: throw IllegalStateException("unknown stored object kind")

  private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
  private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
  private fun safeAdd(value: Long, delta: Long): Long =
    if (value > Long.MAX_VALUE - delta) Long.MAX_VALUE else value + delta

  companion object {
    private const val MAX_TRUST_SCAN = 32
    private const val SHA256_BYTES = 32
    private const val MAX_PROTOCOL_TIME = 9_007_199_254_740_991L
    private const val MAX_INVENTORY_ENTRIES = 32
    private const val TRANSFER_LEASE_MS = 60_000L
    private const val CONTACT_INACTIVITY_MS = 60_000L
    private const val MAX_CONTACT_PEERS = 1_024
    private const val TRANSPORT_READY = "READY"
    private const val LEASE_ACTIVE = "ACTIVE"
    private const val LEASE_COMPLETED = "COMPLETED"
  }
}
