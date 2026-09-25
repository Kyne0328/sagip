package com.sagip.survival

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class EmergencyRepositoryInstrumentedTest {
  private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
  private lateinit var database: SagipDatabase
  private lateinit var repository: EmergencyRepository

  @Before
  fun setUp() {
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
    database = SagipDatabase(context)
    repository = EmergencyRepository(database)
  }

  @After
  fun tearDown() {
    database.close()
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
  }

  @Test
  fun createsAtomicPendingReportWithoutLocationAndRestoresAfterReopen() {
    val created = repository.createReport(
      CreateEmergencyReportInput(EmergencyType.MEDICAL, Urgency.IMMEDIATE_DANGER),
      location = null,
      now = 1234L,
    )

    assertEquals("LOCALLY_COMMITTED", created.lifecycleState)
    assertEquals("DELIVERY_PENDING", created.deliveryState)
    assertNull(created.location)
    assertTableCount("reports", 1)
    assertTableCount("report_revisions", 1)
    assertTableCount("locations", 0)
    assertTableCount("outbound_envelopes", 1)
    assertTableCount("delivery_events", 1)
    assertTableCount("delivery_attempts", 0)
    assertTrue(repository.listDueOutbound(now = 1234L).isEmpty())

    val preparation = repository.listEnvelopePreparationSources().single()
    assertEquals(created.reportId, preparation.reportId)
    assertEquals(EmergencyType.MEDICAL, preparation.emergencyType)
    assertEquals(Urgency.IMMEDIATE_DANGER, preparation.urgency)
    assertNull(preparation.location)

    database.close()
    database = SagipDatabase(context)
    repository = EmergencyRepository(database)

    val restored = repository.listReports()
    assertEquals(1, restored.size)
    assertEquals(created.reportId, restored.single().reportId)
    assertEquals("DELIVERY_PENDING", restored.single().deliveryState)
  }

  @Test
  fun activeRelayWorkComesFromPersistedEmergencyState() {
    assertFalse(repository.hasActiveRelayWork())
    assertEquals(0L, repository.newestActiveRelayTimestamp())

    repository.createReport(
      CreateEmergencyReportInput(EmergencyType.MEDICAL, Urgency.IMMEDIATE_DANGER),
      location = null,
      now = 1_500L,
    )
    assertTrue(repository.hasActiveRelayWork())
    assertEquals(1_500L, repository.newestActiveRelayTimestamp())

    val messageId = repository.listEnvelopePreparationSources().single().messageId
    repository.markDeliveryFailed(
      messageId = messageId,
      reason = "TEST_PERMANENT_FAILURE",
      now = 1_600L,
    )

    assertFalse(repository.hasActiveRelayWork())
    assertEquals(0L, repository.newestActiveRelayTimestamp())
  }

  @Test
  fun persistsLocationWithReportAndPreparationSource() {
    val location = LocationSnapshot(14.5995, 120.9842, 8.0, 1200L, "GPS", "FRESH")
    val created = repository.createReport(
      CreateEmergencyReportInput(EmergencyType.FLOOD, Urgency.NEED_ASSISTANCE),
      location,
      now = 1234L,
    )

    assertTrue(created.location != null)
    assertTableCount("locations", 1)
    assertEquals(location, repository.listEnvelopePreparationSources().single().location)
  }

  @Test
  fun readyEnvelopeIsTransportEligibleImmutableAndPersistent() {
    repository.createReport(
      CreateEmergencyReportInput(EmergencyType.FIRE, Urgency.IMMEDIATE_DANGER),
      location = null,
      now = 2_000L,
    )
    val source = repository.listEnvelopePreparationSources().single()
    val envelopeBytes = byteArrayOf(0x53, 0x47, 0x50, 0x31, 0x01)

    repository.markEnvelopeReady(source.messageId, envelopeBytes, now = 2_050L)
    repository.markEnvelopeReady(source.messageId, envelopeBytes.copyOf(), now = 2_060L)

    val due = repository.listDueOutbound(now = 2_060L).single()
    assertEquals(source.messageId, due.messageId)
    assertArrayEquals(envelopeBytes, due.envelopeBytes)
    assertTableCount("delivery_events", 2)
    assertTrue(repository.listEnvelopePreparationSources().isEmpty())

    assertThrows(IllegalArgumentException::class.java) {
      repository.markEnvelopeReady(source.messageId, byteArrayOf(9, 9, 9), now = 2_070L)
    }

    database.close()
    database = SagipDatabase(context)
    repository = EmergencyRepository(database)

    val restoredDue = repository.listDueOutbound(now = 2_100L).single()
    assertEquals(source.messageId, restoredDue.messageId)
    assertArrayEquals(envelopeBytes, restoredDue.envelopeBytes)
  }

  @Test
  fun abandonedAttemptBecomesDueAgainAfterLease() {
    repository.createReport(
      CreateEmergencyReportInput(EmergencyType.FIRE, Urgency.IMMEDIATE_DANGER),
      location = null,
      now = 2_000L,
    )
    val source = repository.listEnvelopePreparationSources().single()
    repository.markEnvelopeReady(source.messageId, byteArrayOf(1), now = 2_000L)
    val initial = repository.listDueOutbound(now = 2_000L).single()

    repository.recordAttemptStarted(
      messageId = initial.messageId,
      transport = "BLE",
      now = 2_100L,
    )

    assertTrue(repository.listDueOutbound(now = 62_099L).isEmpty())
    val dueAfterLease = repository.listDueOutbound(now = 62_100L).single()
    assertEquals(initial.messageId, dueAfterLease.messageId)
    assertEquals(1, dueAfterLease.attemptCount)
    assertArrayEquals(byteArrayOf(1), dueAfterLease.envelopeBytes)
  }

  @Test
  fun retrySchedulePersistsAcrossDatabaseReopenWithoutChangingMessageIdentity() {
    repository.createReport(
      CreateEmergencyReportInput(EmergencyType.MEDICAL, Urgency.IMMEDIATE_DANGER),
      location = null,
      now = 1_000L,
    )
    val source = repository.listEnvelopePreparationSources().single()
    repository.markEnvelopeReady(source.messageId, byteArrayOf(2), now = 1_000L)
    val initial = repository.listDueOutbound(now = 1_000L).single()
    val attemptId = repository.recordAttemptStarted(
      messageId = initial.messageId,
      transport = "INTERNET",
      now = 1_100L,
    )
    repository.recordAttemptCompleted(
      attemptId = attemptId,
      outcome = "RETRYABLE_FAILURE",
      retryClassification = "NETWORK_UNREACHABLE",
      now = 1_200L,
    )
    val nextAttemptAt = repository.scheduleRetry(
      messageId = initial.messageId,
      now = 1_200L,
      jitterUnit = 0.5,
    )

    assertEquals(6_200L, nextAttemptAt)
    assertTrue(repository.listDueOutbound(now = 6_199L).isEmpty())

    database.close()
    database = SagipDatabase(context)
    repository = EmergencyRepository(database)

    val dueAfterReopen = repository.listDueOutbound(now = 6_200L).single()
    assertEquals(initial.messageId, dueAfterReopen.messageId)
    assertEquals(1, dueAfterReopen.attemptCount)
    assertArrayEquals(byteArrayOf(2), dueAfterReopen.envelopeBytes)
    assertTableCount("delivery_attempts", 1)
    assertTableCount("delivery_events", 4)
  }

  @Test
  fun duplicateRelayReceiptIsIdempotentAndDoesNotDuplicateDeliveryEvidence() {
    repository.createReport(
      CreateEmergencyReportInput(EmergencyType.TRAPPED, Urgency.IMMEDIATE_DANGER),
      location = null,
      now = 2_000L,
    )
    val messageId = repository.listEnvelopePreparationSources().single().messageId

    assertTrue(
      repository.recordRelayReceipt(
        receiptId = "relay-receipt-1",
        messageId = messageId,
        peerIdentifier = "peer-a",
        acknowledgedAt = 2_500L,
      ),
    )
    assertTrue(
      repository.recordRelayReceipt(
        receiptId = "relay-receipt-1",
        messageId = messageId,
        peerIdentifier = "peer-a",
        acknowledgedAt = 2_500L,
      ),
    )

    assertTableCount("relay_receipts", 1)
    assertTableCount("delivery_events", 2)
    assertEquals("RELAYED_TO_PEER", repository.listReports().single().deliveryState)
  }

  @Test
  fun duplicateSemanticResponderAckIsIdempotentAcrossDifferentTransportAckIds() {
    val report = repository.createReport(
      CreateEmergencyReportInput(EmergencyType.MEDICAL, Urgency.NEED_ASSISTANCE),
      location = null,
      now = 3_000L,
    )
    val first = ResponderAck(
      ackId = "server-ack-1",
      reportId = report.reportId,
      responderId = "server",
      callsign = "RESCUE-1",
      status = "EN_ROUTE",
      note = "Team dispatched",
      acknowledgedAt = 4_000L,
    )
    val replayedOverBle = first.copy(
      ackId = "ble-generated-ack-id",
      responderId = "BLE_RELAY",
      note = "Received via BLE relay",
    )

    assertTrue(repository.recordResponderAck(first, now = 4_000L))
    assertTrue(repository.recordResponderAck(replayedOverBle, now = 4_100L))

    assertTableCount("responder_acks", 1)
    assertTableCount("delivery_events", 2)
    val restored = repository.listReports().single()
    assertEquals("RESPONDER_ACKNOWLEDGED", restored.deliveryState)
    assertEquals("server-ack-1", restored.responderAck?.ackId)
  }

  @Test
  fun migratesV2OutboundEnvelopeToNeedsPreparationWithoutChangingIdentity() {
    database.close()
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
    val path = context.getDatabasePath(SagipDatabase.DATABASE_NAME)
    path.parentFile?.mkdirs()

    SQLiteDatabase.openOrCreateDatabase(path, null).use { raw ->
      raw.execSQL(
        """
          CREATE TABLE outbound_envelopes (
            message_id TEXT PRIMARY KEY NOT NULL,
            report_id TEXT NOT NULL UNIQUE,
            revision INTEGER NOT NULL,
            envelope_bytes BLOB,
            priority INTEGER NOT NULL DEFAULT 100,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            next_attempt_at INTEGER NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            delivery_state TEXT NOT NULL
          )
        """.trimIndent(),
      )
      raw.insertOrThrow(
        "outbound_envelopes",
        null,
        ContentValues().apply {
          put("message_id", "legacy-message")
          put("report_id", "legacy-report")
          put("revision", 1)
          put("priority", 10)
          put("created_at", 100L)
          put("next_attempt_at", 100L)
          put("attempt_count", 0)
          put("delivery_state", "DELIVERY_PENDING")
        },
      )
      raw.version = 2
    }

    database = SagipDatabase(context)
    database.writableDatabase.rawQuery(
      "SELECT message_id, preparation_state FROM outbound_envelopes",
      null,
    ).use { cursor ->
      assertTrue(cursor.moveToFirst())
      assertEquals("legacy-message", cursor.getString(0))
      assertEquals("NEEDS_PREPARATION", cursor.getString(1))
    }
  }

  @Test
  fun migratesV6HeldRelayEnvelopeToV7WithoutLosingCustodyBytes() {
    database.close()
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
    val path = context.getDatabasePath(SagipDatabase.DATABASE_NAME)
    path.parentFile?.mkdirs()
    val heldEnvelope = byteArrayOf(0x53, 0x47, 0x50, 0x31, 0x01, 0x02)

    SQLiteDatabase.openOrCreateDatabase(path, null).use { raw ->
      raw.execSQL(
        """
          CREATE TABLE inbound_envelopes (
            inbound_id TEXT PRIMARY KEY NOT NULL,
            message_id TEXT NOT NULL UNIQUE,
            envelope_bytes BLOB NOT NULL,
            received_at INTEGER NOT NULL,
            origin_key_id BLOB NOT NULL,
            priority INTEGER NOT NULL DEFAULT 100,
            delivery_state TEXT NOT NULL DEFAULT 'DELIVERY_PENDING',
            next_attempt_at INTEGER NOT NULL DEFAULT 0,
            attempt_count INTEGER NOT NULL DEFAULT 0
          )
        """.trimIndent(),
      )
      raw.insertOrThrow(
        "inbound_envelopes",
        null,
        ContentValues().apply {
          put("inbound_id", "held-inbound")
          put("message_id", "held-message")
          put("envelope_bytes", heldEnvelope)
          put("received_at", 10_000L)
          put("origin_key_id", ByteArray(32) { 7 })
          put("priority", 1)
          put("delivery_state", "SERVER_ACCEPTED")
          put("next_attempt_at", 10_000L)
          put("attempt_count", 2)
        },
      )
      raw.version = 6
    }

    database = SagipDatabase(context)
    val migrated = database.writableDatabase

    migrated.rawQuery(
      "SELECT message_id, report_id, envelope_bytes, delivery_state, attempt_count FROM inbound_envelopes",
      null,
    ).use { cursor ->
      assertTrue(cursor.moveToFirst())
      assertEquals("held-message", cursor.getString(0))
      assertTrue(cursor.isNull(1))
      assertArrayEquals(heldEnvelope, cursor.getBlob(2))
      assertEquals("SERVER_ACCEPTED", cursor.getString(3))
      assertEquals(2, cursor.getInt(4))
    }

    migrated.rawQuery(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'relay_responder_acks'",
      null,
    ).use { cursor ->
      assertTrue(cursor.moveToFirst())
    }
  }

  private fun assertTableCount(table: String, expected: Int) {
    database.readableDatabase.rawQuery("SELECT COUNT(*) FROM $table", null).use { cursor ->
      cursor.moveToFirst()
      assertEquals(expected, cursor.getInt(0))
    }
  }
}
