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
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.UUID

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
        receiptId = "relay-receipt-2",
        messageId = messageId,
        peerIdentifier = "peer-a",
        acknowledgedAt = 2_600L,
      ),
    )

    assertTableCount("relay_receipts", 1)
    assertTableCount("delivery_events", 2)
    assertEquals("RELAYED_TO_PEER", repository.listReports().single().deliveryState)
  }

  @Test
  fun relayedEnvelopeRemainsEligibleForDirectInternetAndRetryPreservesCustodyState() {
    val report = repository.createReport(
      CreateEmergencyReportInput(EmergencyType.FIRE, Urgency.IMMEDIATE_DANGER),
      location = null,
      now = 5_000L,
    )
    val source = repository.listEnvelopePreparationSources().single()
    repository.markEnvelopeReady(source.messageId, byteArrayOf(1, 2, 3), now = 5_010L)
    assertTrue(
      repository.recordRelayReceipt(
        receiptId = "relay-direct-1",
        messageId = source.messageId,
        peerIdentifier = "peer-a",
        acknowledgedAt = 5_100L,
      ),
    )

    assertEquals("RELAYED_TO_PEER", repository.listReports().single().deliveryState)
    val due = repository.listDueOutbound(now = 5_100L).single()
    assertEquals(source.messageId, due.messageId)

    val attemptId = repository.recordAttemptStarted(
      messageId = due.messageId,
      transport = "INTERNET",
      now = 5_100L,
    )
    repository.recordAttemptCompleted(
      attemptId = attemptId,
      outcome = "RETRYABLE_FAILURE",
      retryClassification = "NETWORK_UNREACHABLE",
      now = 5_200L,
    )
    repository.scheduleRetry(
      messageId = due.messageId,
      now = 5_200L,
      jitterUnit = 0.5,
    )

    assertEquals("RELAYED_TO_PEER", repository.listReports().single().deliveryState)

    repository.markServerAccepted(
      ServerReceipt(
        receiptVersion = 1,
        state = "SERVER_ACCEPTED",
        receiptId = "server-after-relay",
        messageId = due.messageId,
        reportId = report.reportId,
        revision = 1,
        acceptedAt = "2026-09-28T02:00:00Z",
      ),
      now = 6_000L,
    )

    assertEquals("SERVER_ACCEPTED", repository.listReports().single().deliveryState)
  }

  @Test
  fun lateRelayReceiptCannotDowngradeServerAcceptedState() {
    val report = repository.createReport(
      CreateEmergencyReportInput(EmergencyType.MEDICAL, Urgency.NEED_ASSISTANCE),
      location = null,
      now = 6_000L,
    )
    val source = repository.listEnvelopePreparationSources().single()
    repository.markEnvelopeReady(source.messageId, byteArrayOf(4, 5, 6), now = 6_010L)
    repository.markServerAccepted(
      ServerReceipt(
        receiptVersion = 1,
        state = "SERVER_ACCEPTED",
        receiptId = "server-first",
        messageId = source.messageId,
        reportId = report.reportId,
        revision = 1,
        acceptedAt = "2026-09-28T02:01:00Z",
      ),
      now = 6_100L,
    )

    assertTrue(
      repository.recordRelayReceipt(
        receiptId = "late-relay",
        messageId = source.messageId,
        peerIdentifier = "peer-late",
        acknowledgedAt = 6_200L,
      ),
    )

    assertEquals("SERVER_ACCEPTED", repository.listReports().single().deliveryState)
    assertTableCount("relay_receipts", 1)
  }

  @Test
  fun inboundEnvelopeRequiresValidSignatureAndExactDuplicateRemainsDurable() {
    val envelopeBytes = createValidInboundEnvelope()
    val decoded = TransportEnvelopeV1.decode(envelopeBytes)

    val first = repository.persistInboundEnvelope(envelopeBytes, receivedAt = 7_000L)
    assertTrue(first is InboundPersistResult.Stored)
    assertTrue(repository.hasSeenInboundMessage(decoded.messageId, decoded.payloadDigest))

    val duplicate = repository.persistInboundEnvelope(envelopeBytes.copyOf(), receivedAt = 7_100L)
    assertTrue(duplicate is InboundPersistResult.DuplicateIgnored)
    assertTableCount("inbound_envelopes", 1)
    assertTableCount("seen_messages", 1)

    val pendingCustody = repository.relayCustodyStatus()
    assertEquals(1, pendingCustody.heldCount)
    assertEquals(1, pendingCustody.pendingForwardCount)
    repository.markInboundServerAccepted(decoded.messageId, now = 7_150L)
    val forwardedCustody = repository.relayCustodyStatus()
    assertEquals(1, forwardedCustody.heldCount)
    assertEquals(0, forwardedCustody.pendingForwardCount)

    val corruptedSignature = envelopeBytes.copyOf().also { bytes ->
      bytes[bytes.lastIndex] = (bytes.last().toInt() xor 0x01).toByte()
    }
    val rejected = repository.persistInboundEnvelope(corruptedSignature, receivedAt = 7_200L)
    assertTrue(rejected is InboundPersistResult.ValidationFailed)
    assertTableCount("inbound_envelopes", 1)
  }

  @Test
  fun inboundDeliveryLeaseSurvivesReopenAndRetryCannotDowngradeServerAcceptance() {
    val envelopeBytes = createValidInboundEnvelope()
    val stored = repository.persistInboundEnvelope(envelopeBytes, receivedAt = 8_000L)
    assertTrue(stored is InboundPersistResult.Stored)

    val firstClaim = repository.listDueInbound(now = 8_000L).single()
    assertEquals(1, firstClaim.attemptCount)
    assertTrue(repository.listDueInbound(now = 67_999L).isEmpty())

    database.close()
    database = SagipDatabase(context)
    repository = EmergencyRepository(database)

    val recoveredClaim = repository.listDueInbound(now = 68_000L).single()
    assertEquals(firstClaim.messageId, recoveredClaim.messageId)
    assertEquals(2, recoveredClaim.attemptCount)

    repository.markInboundServerAccepted(recoveredClaim.messageId, now = 68_100L)
    repository.scheduleInboundRetry(
      messageId = recoveredClaim.messageId,
      now = 68_200L,
      jitterUnit = 0.5,
    )

    database.readableDatabase.rawQuery(
      "SELECT delivery_state FROM inbound_envelopes WHERE message_id = ?",
      arrayOf(recoveredClaim.messageId),
    ).use { cursor ->
      assertTrue(cursor.moveToFirst())
      assertEquals("SERVER_ACCEPTED", cursor.getString(0))
    }
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
  fun responderStatusPollingContinuesUntilResolvedAndCannotRegress() {
    val report = repository.createReport(
      CreateEmergencyReportInput(EmergencyType.MEDICAL, Urgency.IMMEDIATE_DANGER),
      location = null,
      now = 5_000L,
    )
    val source = repository.listEnvelopePreparationSources().single()
    repository.markEnvelopeReady(source.messageId, byteArrayOf(1, 2, 3), now = 5_010L)
    repository.markServerAccepted(
      ServerReceipt(
        receiptVersion = 1,
        state = "SERVER_ACCEPTED",
        receiptId = "receipt-status-sync",
        messageId = source.messageId,
        reportId = report.reportId,
        revision = 1,
        acceptedAt = "2026-09-30T07:00:00.000Z",
      ),
      now = 5_100L,
    )

    assertEquals(listOf(report.reportId), repository.listReportsAwaitingAck(now = 5_100L))
    assertEquals(35_100L, repository.scheduleResponderAckPoll(report.reportId, now = 5_100L))
    assertTrue(repository.listReportsAwaitingAck(now = 35_099L).isEmpty())

    assertTrue(
      repository.recordResponderAck(
        ResponderAck(
          ackId = "ack-first",
          reportId = report.reportId,
          responderId = "responder-1",
          callsign = "RESCUE-1",
          status = "ACKNOWLEDGED",
          note = null,
          acknowledgedAt = 6_000L,
        ),
        now = 6_000L,
      ),
    )
    assertEquals(listOf(report.reportId), repository.listReportsAwaitingAck(now = 35_100L))

    assertTrue(
      repository.recordResponderAck(
        ResponderAck(
          ackId = "ack-resolved",
          reportId = report.reportId,
          responderId = "responder-1",
          callsign = "RESCUE-1",
          status = "RESOLVED",
          note = "Incident resolved",
          acknowledgedAt = 7_000L,
        ),
        now = 7_000L,
      ),
    )
    assertTrue(
      repository.recordResponderAck(
        ResponderAck(
          ackId = "ack-late-low-stage",
          reportId = report.reportId,
          responderId = "responder-2",
          callsign = "RESCUE-2",
          status = "ACKNOWLEDGED",
          note = "Late sync",
          acknowledgedAt = 8_000L,
        ),
        now = 8_000L,
      ),
    )

    assertTrue(repository.listReportsAwaitingAck(now = 100_000L).isEmpty())
    val restored = repository.listReports().single()
    assertEquals("RESOLVED", restored.responderAck?.status)
    assertEquals("ack-resolved", restored.responderAck?.ackId)
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

  private fun createValidInboundEnvelope(): ByteArray {
    return TransportEnvelopeV1.create(
      EnvelopeUnsignedInput(
        messageId = UUID.randomUUID().toString(),
        reportId = UUID.randomUUID().toString(),
        revision = 1,
        createdAt = 7_000L,
        expiresAt = null,
        priority = 0,
        payload = EmergencyPayloadV1.encode(
          emergencyType = EmergencyType.MEDICAL,
          urgency = Urgency.IMMEDIATE_DANGER,
          location = null,
        ),
      ),
      JcaTestSigningIdentity(),
    )
  }

  private class JcaTestSigningIdentity : SigningIdentity {
    private val keyPair: KeyPair = KeyPairGenerator.getInstance("EC").run {
      initialize(ECGenParameterSpec("secp256r1"))
      generateKeyPair()
    }

    override val publicKeyDer: ByteArray = keyPair.public.encoded
    override val keyId: ByteArray = MessageDigest.getInstance("SHA-256").digest(publicKeyDer)

    override fun sign(data: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
      initSign(keyPair.private)
      update(data)
      sign()
    }
  }

  private fun assertTableCount(table: String, expected: Int) {
    database.readableDatabase.rawQuery("SELECT COUNT(*) FROM $table", null).use { cursor ->
      cursor.moveToFirst()
      assertEquals(expected, cursor.getInt(0))
    }
  }
}
