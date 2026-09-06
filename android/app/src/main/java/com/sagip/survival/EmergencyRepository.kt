package com.sagip.survival

import android.content.ContentValues
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import java.util.UUID

class EmergencyRepository(private val database: SagipDatabase) : OutboundDeliveryStore {

  fun createReport(
    input: CreateEmergencyReportInput,
    location: LocationSnapshot?,
    now: Long = System.currentTimeMillis(),
  ): EmergencyReportSummary {
    val reportId = UUID.randomUUID().toString()
    val messageId = UUID.randomUUID().toString()
    val db = database.writableDatabase

    db.beginTransaction()
    try {
      insertOrThrow(
        db,
        "reports",
        ContentValues().apply {
          put("report_id", reportId)
          put("created_at", now)
          put("emergency_type", input.emergencyType.name)
          put("urgency", input.urgency.name)
          put("lifecycle_state", LIFECYCLE_LOCALLY_COMMITTED)
        },
      )

      insertOrThrow(
        db,
        "report_revisions",
        ContentValues().apply {
          put("report_id", reportId)
          put("revision", 1)
          put("created_at", now)
          put("emergency_type", input.emergencyType.name)
          put("urgency", input.urgency.name)
        },
      )

      if (location != null) {
        insertOrThrow(
          db,
          "locations",
          ContentValues().apply {
            put("report_id", reportId)
            put("latitude", location.latitude)
            put("longitude", location.longitude)
            location.accuracyMeters?.let { put("accuracy_meters", it) }
            put("captured_at", location.capturedAt)
            put("source", location.source)
            put("freshness", location.freshness)
          },
        )
      }

      insertOrThrow(
        db,
        "outbound_envelopes",
        ContentValues().apply {
          put("message_id", messageId)
          put("report_id", reportId)
          put("revision", 1)
          put("priority", priorityFor(input.urgency))
          put("created_at", now)
          put("next_attempt_at", now)
          put("attempt_count", 0)
          put("delivery_state", DELIVERY_PENDING)
          put("preparation_state", PREPARATION_NEEDS)
        },
      )

      insertDeliveryEvent(db, reportId, messageId, EVENT_LOCAL_COMMIT, now)
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }

    return EmergencyReportSummary(
      reportId = reportId,
      createdAt = now,
      emergencyType = input.emergencyType,
      urgency = input.urgency,
      lifecycleState = LIFECYCLE_LOCALLY_COMMITTED,
      deliveryState = DELIVERY_PENDING,
      location = location,
    )
  }

  fun listReports(): List<EmergencyReportSummary> {
    val reports = mutableListOf<EmergencyReportSummary>()
    val sql = """
      SELECT r.report_id, r.created_at, r.emergency_type, r.urgency, r.lifecycle_state,
             o.delivery_state,
             l.latitude, l.longitude, l.accuracy_meters, l.captured_at, l.source, l.freshness
      FROM reports r
      JOIN outbound_envelopes o ON o.report_id = r.report_id
      LEFT JOIN locations l ON l.report_id = r.report_id
      ORDER BY r.created_at DESC, r.report_id DESC
    """.trimIndent()

    database.readableDatabase.rawQuery(sql, null).use { cursor ->
      while (cursor.moveToNext()) {
        reports += EmergencyReportSummary(
          reportId = cursor.getString(cursor.getColumnIndexOrThrow("report_id")),
          createdAt = cursor.getLong(cursor.getColumnIndexOrThrow("created_at")),
          emergencyType = EmergencyType.valueOf(cursor.getString(cursor.getColumnIndexOrThrow("emergency_type"))),
          urgency = Urgency.valueOf(cursor.getString(cursor.getColumnIndexOrThrow("urgency"))),
          lifecycleState = cursor.getString(cursor.getColumnIndexOrThrow("lifecycle_state")),
          deliveryState = cursor.getString(cursor.getColumnIndexOrThrow("delivery_state")),
          location = readLocation(cursor),
        )
      }
    }
    return reports
  }

  fun listEnvelopePreparationSources(limit: Int = 20): List<EnvelopePreparationSource> {
    require(limit in 1..100) { "limit must be between 1 and 100" }
    val sources = mutableListOf<EnvelopePreparationSource>()
    val sql = """
      SELECT o.message_id, o.report_id, o.revision, o.priority, o.created_at, o.expires_at,
             rr.emergency_type, rr.urgency,
             l.latitude, l.longitude, l.accuracy_meters, l.captured_at, l.source, l.freshness
      FROM outbound_envelopes o
      JOIN report_revisions rr ON rr.report_id = o.report_id AND rr.revision = o.revision
      LEFT JOIN locations l ON l.report_id = o.report_id
      WHERE o.preparation_state = ?
      ORDER BY o.priority ASC, o.created_at ASC, o.message_id ASC
      LIMIT ?
    """.trimIndent()

    database.readableDatabase.rawQuery(
      sql,
      arrayOf(PREPARATION_NEEDS, limit.toString()),
    ).use { cursor ->
      while (cursor.moveToNext()) {
        val expiresIndex = cursor.getColumnIndexOrThrow("expires_at")
        sources += EnvelopePreparationSource(
          messageId = cursor.getString(cursor.getColumnIndexOrThrow("message_id")),
          reportId = cursor.getString(cursor.getColumnIndexOrThrow("report_id")),
          revision = cursor.getInt(cursor.getColumnIndexOrThrow("revision")),
          priority = cursor.getInt(cursor.getColumnIndexOrThrow("priority")),
          createdAt = cursor.getLong(cursor.getColumnIndexOrThrow("created_at")),
          expiresAt = if (cursor.isNull(expiresIndex)) null else cursor.getLong(expiresIndex),
          emergencyType = EmergencyType.valueOf(cursor.getString(cursor.getColumnIndexOrThrow("emergency_type"))),
          urgency = Urgency.valueOf(cursor.getString(cursor.getColumnIndexOrThrow("urgency"))),
          location = readLocation(cursor),
        )
      }
    }
    return sources
  }

  fun markEnvelopeReady(
    messageId: String,
    envelopeBytes: ByteArray,
    now: Long = System.currentTimeMillis(),
  ) {
    require(envelopeBytes.size in 1..TransportEnvelopeV1.MAX_ENVELOPE_BYTES) {
      "envelope bytes are empty or too large"
    }
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      val current = db.rawQuery(
        "SELECT report_id, preparation_state, envelope_bytes FROM outbound_envelopes WHERE message_id = ?",
        arrayOf(messageId),
      ).use { cursor ->
        require(cursor.moveToFirst()) { "Unknown outbound message: $messageId" }
        Triple(
          cursor.getString(0),
          cursor.getString(1),
          if (cursor.isNull(2)) null else cursor.getBlob(2),
        )
      }

      when (current.second) {
        PREPARATION_READY -> {
          require(current.third != null && current.third.contentEquals(envelopeBytes)) {
            "READY envelope bytes are immutable"
          }
          db.setTransactionSuccessful()
          return
        }
        PREPARATION_NEEDS -> {
          val updated = db.update(
            "outbound_envelopes",
            ContentValues().apply {
              put("envelope_bytes", envelopeBytes)
              put("preparation_state", PREPARATION_READY)
            },
            "message_id = ? AND preparation_state = ?",
            arrayOf(messageId, PREPARATION_NEEDS),
          )
          check(updated == 1) { "Envelope preparation state changed concurrently" }
          insertDeliveryEvent(db, current.first, messageId, EVENT_ENVELOPE_PREPARED, now)
          db.setTransactionSuccessful()
        }
        else -> throw IllegalStateException("Unknown envelope preparation state: ${current.second}")
      }
    } finally {
      db.endTransaction()
    }
  }

  override fun listDueOutbound(now: Long, limit: Int): List<OutboundEnvelopeWork> {
    require(limit in 1..100) { "limit must be between 1 and 100" }
    val due = mutableListOf<OutboundEnvelopeWork>()
    val sql = """
      SELECT message_id, report_id, revision, priority, created_at, expires_at,
             next_attempt_at, attempt_count, delivery_state, envelope_bytes
      FROM outbound_envelopes
      WHERE preparation_state = ?
        AND envelope_bytes IS NOT NULL
        AND delivery_state = ?
        AND next_attempt_at <= ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY priority ASC, next_attempt_at ASC, created_at ASC
      LIMIT ?
    """.trimIndent()

    database.readableDatabase.rawQuery(
      sql,
      arrayOf(PREPARATION_READY, DELIVERY_PENDING, now.toString(), now.toString(), limit.toString()),
    ).use { cursor ->
      while (cursor.moveToNext()) {
        val expiresIndex = cursor.getColumnIndexOrThrow("expires_at")
        due += OutboundEnvelopeWork(
          messageId = cursor.getString(cursor.getColumnIndexOrThrow("message_id")),
          reportId = cursor.getString(cursor.getColumnIndexOrThrow("report_id")),
          revision = cursor.getInt(cursor.getColumnIndexOrThrow("revision")),
          priority = cursor.getInt(cursor.getColumnIndexOrThrow("priority")),
          createdAt = cursor.getLong(cursor.getColumnIndexOrThrow("created_at")),
          expiresAt = if (cursor.isNull(expiresIndex)) null else cursor.getLong(expiresIndex),
          nextAttemptAt = cursor.getLong(cursor.getColumnIndexOrThrow("next_attempt_at")),
          attemptCount = cursor.getInt(cursor.getColumnIndexOrThrow("attempt_count")),
          deliveryState = cursor.getString(cursor.getColumnIndexOrThrow("delivery_state")),
          envelopeBytes = cursor.getBlob(cursor.getColumnIndexOrThrow("envelope_bytes")),
        )
      }
    }
    return due
  }

  override fun recordAttemptStarted(
    messageId: String,
    transport: String,
    peerIdentifier: String?,
    now: Long,
  ): String {
    require(transport.isNotBlank()) { "transport must not be blank" }
    val db = database.writableDatabase
    val attemptId = UUID.randomUUID().toString()

    db.beginTransaction()
    try {
      val envelope = requireEnvelope(db, messageId)
      requireTransportAttemptable(db, messageId, now)
      insertOrThrow(
        db,
        "delivery_attempts",
        ContentValues().apply {
          put("attempt_id", attemptId)
          put("message_id", messageId)
          put("transport", transport)
          peerIdentifier?.let { put("peer_identifier", it) }
          put("started_at", now)
        },
      )
      db.execSQL(
        "UPDATE outbound_envelopes SET attempt_count = attempt_count + 1, next_attempt_at = ? WHERE message_id = ?",
        arrayOf<Any?>(now + ATTEMPT_LEASE_MS, messageId),
      )
      insertDeliveryEvent(db, envelope.first, messageId, EVENT_ATTEMPT_STARTED, now)
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
    return attemptId
  }

  override fun recordAttemptCompleted(
    attemptId: String,
    outcome: String,
    retryClassification: String?,
    now: Long,
  ) {
    require(outcome.isNotBlank()) { "outcome must not be blank" }
    val values = ContentValues().apply {
      put("completed_at", now)
      put("outcome", outcome)
      retryClassification?.let { put("retry_classification", it) }
    }
    val updated = database.writableDatabase.update(
      "delivery_attempts",
      values,
      "attempt_id = ? AND completed_at IS NULL",
      arrayOf(attemptId),
    )
    require(updated == 1) { "Unknown or already-completed delivery attempt: $attemptId" }
  }

  override fun markServerAccepted(
    receipt: ServerReceipt,
    now: Long,
  ) {
    require(receipt.state == DELIVERY_SERVER_ACCEPTED) { "Unsupported receipt state: ${receipt.state}" }
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      val reportId = db.rawQuery(
        "SELECT report_id FROM outbound_envelopes WHERE message_id = ? AND report_id = ? AND revision = ?",
        arrayOf(receipt.messageId, receipt.reportId, receipt.revision.toString()),
      ).use { cursor ->
        require(cursor.moveToFirst()) { "Receipt does not match local envelope" }
        cursor.getString(0)
      }

      db.insertWithOnConflict(
        "server_receipts",
        null,
        ContentValues().apply {
          put("receipt_id", receipt.receiptId)
          put("message_id", receipt.messageId)
          put("report_id", reportId)
          put("revision", receipt.revision)
          put("accepted_at", receipt.acceptedAt)
        },
        SQLiteDatabase.CONFLICT_IGNORE,
      )

      db.update(
        "outbound_envelopes",
        ContentValues().apply { put("delivery_state", DELIVERY_SERVER_ACCEPTED) },
        "message_id = ? AND delivery_state = ?",
        arrayOf(receipt.messageId, DELIVERY_PENDING),
      )
      insertDeliveryEvent(db, reportId, receipt.messageId, EVENT_SERVER_ACCEPTED, now)
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  override fun markDeliveryFailed(
    messageId: String,
    reason: String?,
    now: Long,
  ) {
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      val envelope = requireEnvelope(db, messageId)
      db.update(
        "outbound_envelopes",
        ContentValues().apply { put("delivery_state", DELIVERY_PERMANENT_FAILURE) },
        "message_id = ? AND delivery_state = ?",
        arrayOf(messageId, DELIVERY_PENDING),
      )
      insertDeliveryEvent(db, envelope.first, messageId, EVENT_DELIVERY_FAILED, now)
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  fun findReceipt(messageId: String): ServerReceipt? {
    val sql = "SELECT receipt_id, message_id, report_id, revision, accepted_at FROM server_receipts WHERE message_id = ?"
    return database.readableDatabase.rawQuery(sql, arrayOf(messageId)).use { cursor ->
      if (!cursor.moveToFirst()) null
      else ServerReceipt(
        receiptVersion = 1,
        state = DELIVERY_SERVER_ACCEPTED,
        receiptId = cursor.getString(0),
        messageId = cursor.getString(1),
        reportId = cursor.getString(2),
        revision = cursor.getInt(3),
        acceptedAt = cursor.getString(4),
      )
    }
  }

  override fun scheduleRetry(
    messageId: String,
    now: Long,
    jitterUnit: Double,
  ): Long {
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      val envelope = requireEnvelope(db, messageId)
      val attemptCount = db.rawQuery(
        "SELECT attempt_count FROM outbound_envelopes WHERE message_id = ?",
        arrayOf(messageId),
      ).use { cursor ->
        check(cursor.moveToFirst()) { "Missing outbound envelope: $messageId" }
        cursor.getInt(0)
      }
      require(attemptCount >= 1) { "Cannot schedule retry before a delivery attempt" }
      val nextAttemptAt = RetryPolicy.nextAttemptAt(now, attemptCount, jitterUnit)
      db.execSQL(
        "UPDATE outbound_envelopes SET next_attempt_at = ?, delivery_state = ? WHERE message_id = ?",
        arrayOf<Any?>(nextAttemptAt, DELIVERY_PENDING, messageId),
      )
      insertDeliveryEvent(db, envelope.first, messageId, EVENT_RETRY_SCHEDULED, now)
      db.setTransactionSuccessful()
      return nextAttemptAt
    } finally {
      db.endTransaction()
    }
  }

  private fun readLocation(cursor: Cursor): LocationSnapshot? {
    val latitudeIndex = cursor.getColumnIndexOrThrow("latitude")
    if (cursor.isNull(latitudeIndex)) return null
    val accuracyIndex = cursor.getColumnIndexOrThrow("accuracy_meters")
    return LocationSnapshot(
      latitude = cursor.getDouble(latitudeIndex),
      longitude = cursor.getDouble(cursor.getColumnIndexOrThrow("longitude")),
      accuracyMeters = if (cursor.isNull(accuracyIndex)) null else cursor.getDouble(accuracyIndex),
      capturedAt = cursor.getLong(cursor.getColumnIndexOrThrow("captured_at")),
      source = cursor.getString(cursor.getColumnIndexOrThrow("source")),
      freshness = cursor.getString(cursor.getColumnIndexOrThrow("freshness")),
    )
  }

  private fun requireEnvelope(db: SQLiteDatabase, messageId: String): Pair<String, Int> =
    db.rawQuery(
      "SELECT report_id, revision FROM outbound_envelopes WHERE message_id = ?",
      arrayOf(messageId),
    ).use { cursor ->
      require(cursor.moveToFirst()) { "Unknown outbound message: $messageId" }
      cursor.getString(0) to cursor.getInt(1)
    }

  private fun requireTransportAttemptable(db: SQLiteDatabase, messageId: String, now: Long) {
    db.rawQuery(
      "SELECT preparation_state, envelope_bytes, delivery_state, next_attempt_at, expires_at FROM outbound_envelopes WHERE message_id = ?",
      arrayOf(messageId),
    ).use { cursor ->
      require(cursor.moveToFirst()) { "Unknown outbound message: $messageId" }
      TransportReadiness.requireAttemptable(
        preparationState = cursor.getString(0),
        envelopeBytes = if (cursor.isNull(1)) null else cursor.getBlob(1),
        deliveryState = cursor.getString(2),
        nextAttemptAt = cursor.getLong(3),
        expiresAt = if (cursor.isNull(4)) null else cursor.getLong(4),
        now = now,
      )
    }
  }

  private fun insertDeliveryEvent(
    db: SQLiteDatabase,
    reportId: String,
    messageId: String,
    eventType: String,
    occurredAt: Long,
  ) {
    insertOrThrow(
      db,
      "delivery_events",
      ContentValues().apply {
        put("event_id", UUID.randomUUID().toString())
        put("report_id", reportId)
        put("message_id", messageId)
        put("event_type", eventType)
        put("occurred_at", occurredAt)
      },
    )
  }

  private fun insertOrThrow(db: SQLiteDatabase, table: String, values: ContentValues) {
    if (db.insertOrThrow(table, null, values) == -1L) {
      throw IllegalStateException("Failed to persist $table")
    }
  }

  private fun priorityFor(urgency: Urgency): Int = when (urgency) {
    Urgency.IMMEDIATE_DANGER -> 0
    Urgency.NEED_ASSISTANCE -> 10
  }

  companion object {
    const val LIFECYCLE_LOCALLY_COMMITTED = "LOCALLY_COMMITTED"
    const val DELIVERY_PENDING = "DELIVERY_PENDING"
    const val DELIVERY_SERVER_ACCEPTED = "SERVER_ACCEPTED"
    const val DELIVERY_PERMANENT_FAILURE = "PERMANENT_FAILURE"
    const val PREPARATION_NEEDS = "NEEDS_PREPARATION"
    const val PREPARATION_READY = "READY"
    const val EVENT_LOCAL_COMMIT = "LOCAL_COMMIT"
    const val EVENT_ENVELOPE_PREPARED = "ENVELOPE_PREPARED"
    const val EVENT_ATTEMPT_STARTED = "TRANSPORT_ATTEMPT_STARTED"
    const val EVENT_RETRY_SCHEDULED = "RETRY_SCHEDULED"
    const val EVENT_SERVER_ACCEPTED = "SERVER_ACCEPTED"
    const val EVENT_DELIVERY_FAILED = "DELIVERY_FAILED"
    const val ATTEMPT_LEASE_MS = 60_000L
  }
}
