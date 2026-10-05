package com.sagip.survival

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase as FrameworkSQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class ReceiptRepositoryTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private var database: SagipDatabase? = null
  private var now = 50_000L

  @Before
  fun setUp() {
    clearDatabaseFiles()
  }

  @After
  fun tearDown() {
    database?.close()
    database = null
    clearDatabaseFiles()
  }

  @Test
  fun everyPreV8UpgradePreservesLegacySosAndOutboundIdentity() {
    val legacyEnvelope = byteArrayOf(0x11, 0x22, 0x33, 0x44)
    for (version in 1..7) {
      database?.close()
      database = null
      clearDatabaseFiles()
      val reportId = UUID.randomUUID().toString()
      val messageId = UUID.randomUUID().toString()
      createLegacyDatabase(version, reportId, messageId, legacyEnvelope)

      database = SagipDatabase(context)
      val db = requireNotNull(database).readableDatabase
      db.rawQuery(
        "SELECT created_at, emergency_type, urgency, lifecycle_state FROM reports WHERE report_id=?",
        arrayOf(reportId),
      ).use { cursor ->
        assertTrue("v$version report missing", cursor.moveToFirst())
        assertEquals(1_000L, cursor.getLong(0))
        assertEquals("MEDICAL", cursor.getString(1))
        assertEquals("NEED_ASSISTANCE", cursor.getString(2))
        assertEquals("LOCALLY_COMMITTED", cursor.getString(3))
      }
      db.rawQuery(
        "SELECT revision, created_at, emergency_type, urgency FROM report_revisions WHERE report_id=?",
        arrayOf(reportId),
      ).use { cursor ->
        assertTrue("v$version revision missing", cursor.moveToFirst())
        assertEquals(1, cursor.getInt(0))
        assertEquals(1_000L, cursor.getLong(1))
        assertEquals("MEDICAL", cursor.getString(2))
        assertEquals("NEED_ASSISTANCE", cursor.getString(3))
      }
      db.rawQuery(
        "SELECT message_id, report_id, revision, envelope_bytes FROM outbound_envelopes WHERE report_id=?",
        arrayOf(reportId),
      ).use { cursor ->
        assertTrue("v$version outbound missing", cursor.moveToFirst())
        assertEquals(messageId, cursor.getString(0))
        assertEquals(reportId, cursor.getString(1))
        assertEquals(1, cursor.getInt(2))
        if (version == 1) {
          assertTrue(cursor.isNull(3))
        } else {
          assertArrayEquals(legacyEnvelope, cursor.getBlob(3))
        }
      }
      assertTableExists("receipt_records")
      assertTableExists("receipt_time_checkpoints")
    }
  }

  @Test
  fun nativeReceiptMigrationAndRecovery() {
    val reportId = UUID.randomUUID().toString()
    val envelopeBytes = createEnvelope(reportId, 1, JcaSigningIdentity())
    createVersion7Database(reportId, envelopeBytes)

    database = SagipDatabase(context)
    val db = requireNotNull(database).writableDatabase

    assertEquals(Schema.VERSION, db.version)
    db.rawQuery(
      "SELECT envelope_bytes FROM outbound_envelopes WHERE message_id = ?",
      arrayOf("receipt-migration-message"),
    ).use { cursor ->
      assertTrue(cursor.moveToFirst())
      assertArrayEquals(envelopeBytes, cursor.getBlob(0))
    }
    assertTableExists("receipt_actions")
    assertTableExists("receipt_records")
    assertTableExists("receipt_projections")
    assertTableExists("receipt_time_checkpoints")
    assertTableExists("relay_objects")
    assertTableExists("relay_object_tombstones")
    assertTableExists("relay_time_state")
    assertTableExists("relay_peer_object_state")
    assertTableExists("relay_transfer_leases")
    assertTableExists("relay_peer_contacts")
    assertEquals(1L, ReceiptRepository(requireNotNull(database)).currentReceiptVersion(reportId))
  }

  @Test
  fun allocatesSignsAndRecoversImmutableResponderReceipt() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val emergency = EmergencyRepository(db)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val report = emergency.createReport(
      CreateEmergencyReportInput(EmergencyType.MEDICAL, Urgency.NEED_ASSISTANCE),
      location = null,
      now = 1_000L,
    )
    assertEquals(
      PreparationBatchResult(prepared = 1, failed = 0),
      EnvelopePreparationService(emergency, origin).preparePending(),
    )
    val repository = receiptRepository(db, responder, origin)

    assertEquals(1L, repository.currentReceiptVersion(report.reportId))
    val actionId = UUID.randomUUID().toString()
    val intent = ActionIntent(
      actionId = actionId,
      reportId = report.reportId,
      observedIncidentVersion = 1L,
      status = 2,
      note = "Team en route",
    )
    val allocated = repository.allocateAction(intent)
    assertEquals(1L, allocated.fields.sequence)
    assertEquals("PREPARING", allocated.preparationState)

    val committed = repository.prepareReceipt(actionId)
    assertEquals(ActionCommitState.SIGNED, committed.state)
    val signedBytes = requireNotNull(committed.bytes)
    assertArrayEquals(signedBytes, repository.getReceipt(actionId))
    assertTrue(ReceiptV2Codec.verifySignature(ReceiptV2Codec.decode(signedBytes), responder.publicKeyDer))
    assertEquals(2L, repository.currentReceiptVersion(report.reportId))
    assertThrows(IllegalStateException::class.java) {
      repository.allocateAction(
        ActionIntent(UUID.randomUUID().toString(), report.reportId, 1L, status = 3, note = "Stale screen action"),
      )
    }

    val replayAllocation = repository.allocateAction(intent)
    assertEquals(allocated.fields.sequence, replayAllocation.fields.sequence)
    assertThrows(IllegalStateException::class.java) {
      repository.allocateAction(intent.copy(note = "Different immutable action"))
    }

    db.close()
    database = SagipDatabase(context)
    val reopened = receiptRepository(requireNotNull(database), responder, origin)
    assertArrayEquals(signedBytes, reopened.getReceipt(actionId))
    assertArrayEquals(signedBytes, reopened.prepareReceipt(actionId).bytes)
  }

  @Test
  fun oldRevisionIsHistoricalAndDuplicateDoesNotCreateNewEvidence() {
    database = SagipDatabase(context)
    val sourceDb = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    insertLocalReport(sourceDb, reportId)
    val source = receiptRepository(sourceDb, responder, origin)
    source.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 1_000L)
    val actionId = UUID.randomUUID().toString()
    source.allocateAction(
      ActionIntent(actionId, reportId, 1L, status = 1, note = "Acknowledged"),
    )
    val ackBytes = requireNotNull(source.prepareReceipt(actionId).bytes)

    sourceDb.close()
    database = null
    clearDatabaseFiles()

    database = SagipDatabase(context)
    val targetDb = requireNotNull(database)
    insertLocalReport(targetDb, reportId)
    val target = ReceiptRepository(targetDb, requesterSigner = origin, clock = { now })
    target.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 2_000L)
    target.recordReportEnvelope(createEnvelope(reportId, 2, origin), now = 3_000L)

    val result = target.applyToReport(ackBytes, rootContext(responder))
    assertEquals(ReceiptApplication.HISTORICAL, result)
    assertEquals(ReceiptApplication.DUPLICATE, target.applyToReport(ackBytes, rootContext(responder)))
    assertEquals(1, countRows(targetDb, "receipt_records"))
    assertEquals(0, countRows(targetDb, "receipt_projections"))
  }

  @Test
  fun currentAckSurvivesRequesterSigningFailureAndRemainsApplied() {
    database = SagipDatabase(context)
    val sourceDb = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    insertLocalReport(sourceDb, reportId)
    val source = receiptRepository(sourceDb, responder, origin)
    source.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 1_000L)
    val actionId = UUID.randomUUID().toString()
    source.allocateAction(ActionIntent(actionId, reportId, 1L, status = 2, note = "En route"))
    val ackBytes = requireNotNull(source.prepareReceipt(actionId).bytes)

    sourceDb.close()
    database = null
    clearDatabaseFiles()

    database = SagipDatabase(context)
    val targetDb = requireNotNull(database)
    insertLocalReport(targetDb, reportId)
    val failingRequester = FailingSigningIdentity(origin)
    val target = ReceiptRepository(targetDb, requesterSigner = failingRequester, clock = { now })
    target.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 2_000L)

    assertEquals(ReceiptApplication.APPLIED, target.applyToReport(ackBytes, rootContext(responder)))
    val projection = requireNotNull(target.projection(reportId))
    assertEquals(actionId, projection.eventId)
    assertTrue(projection.notificationEligible)
    assertEquals("UNKNOWN", projection.requesterDeliveryState)

    val requester = target.prepareRequesterReceipt(actionId)
    assertEquals(ActionCommitState.FAILED, requester.state)
    assertEquals("UNKNOWN", requireNotNull(target.projection(reportId)).requesterDeliveryState)
    assertEquals(1, countRows(targetDb, "receipt_records"))
  }

  @Test
  fun verifiedNotificationClaimIsSingleUseAcrossReopen() {
    database = SagipDatabase(context)
    val sourceDb = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    insertLocalReport(sourceDb, reportId)
    val source = receiptRepository(sourceDb, responder, origin)
    source.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 1_000L)
    val actionId = UUID.randomUUID().toString()
    source.allocateAction(ActionIntent(actionId, reportId, 1L, status = 1, note = "Acknowledged"))
    val ackBytes = requireNotNull(source.prepareReceipt(actionId).bytes)

    sourceDb.close()
    database = null
    clearDatabaseFiles()

    database = SagipDatabase(context)
    val targetDb = requireNotNull(database)
    insertLocalReport(targetDb, reportId)
    val target = ReceiptRepository(targetDb, requesterSigner = origin, clock = { now })
    target.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 2_000L)
    assertEquals(ReceiptApplication.APPLIED, target.applyToReport(ackBytes, rootContext(responder)))
    assertTrue(requireNotNull(target.projection(reportId)).notificationEligible)

    assertTrue(target.claimVerifiedReceiptNotification(reportId, actionId))
    assertFalse(target.claimVerifiedReceiptNotification(reportId, actionId))
    assertFalse(requireNotNull(target.projection(reportId)).notificationEligible)

    targetDb.close()
    database = SagipDatabase(context)
    val reopened = ReceiptRepository(requireNotNull(database), requesterSigner = origin, clock = { now })
    assertFalse(reopened.claimVerifiedReceiptNotification(reportId, actionId))
    assertFalse(requireNotNull(reopened.projection(reportId)).notificationEligible)
  }

  @Test
  fun localSosRemainsDurableWhenReceiptSigningIsUnavailable() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val emergency = EmergencyRepository(db)
    val origin = JcaSigningIdentity()
    val failed = FailingSigningIdentity(origin)

    val created = emergency.createReport(
      CreateEmergencyReportInput(EmergencyType.FLOOD, Urgency.IMMEDIATE_DANGER),
      location = null,
      now = 9_000L,
    )
    assertEquals(
      PreparationBatchResult(prepared = 0, failed = 1),
      EnvelopePreparationService(emergency, failed).preparePending(),
    )

    val restored = emergency.listReports().single { it.reportId == created.reportId }
    assertEquals("LOCALLY_COMMITTED", restored.lifecycleState)
    assertEquals("DELIVERY_PENDING", restored.deliveryState)
    db.readableDatabase.rawQuery(
      "SELECT preparation_state,envelope_bytes FROM outbound_envelopes WHERE report_id = ?",
      arrayOf(created.reportId),
    ).use { cursor ->
      assertTrue(cursor.moveToFirst())
      assertEquals("NEEDS_PREPARATION", cursor.getString(0))
      assertTrue(cursor.isNull(1))
    }
    assertEquals(0L, ReceiptRepository(db).currentReceiptVersion(created.reportId))
  }
  @Test
  fun inboundEnvelopeRegistersReceiptIdentityBeforeResponderAction() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    val envelope = createEnvelope(reportId, 1, origin)

    val stored = EmergencyRepository(db).persistInboundEnvelope(envelope, receivedAt = 2_000L)
    assertTrue(stored is InboundPersistResult.Stored)

    val repository = receiptRepository(db, responder, origin)
    assertEquals(1L, repository.currentReceiptVersion(reportId))
    val allocated = repository.allocateAction(
      ActionIntent(UUID.randomUUID().toString(), reportId, 1L, status = 1, note = "Acknowledged"),
    )
    assertEquals(1L, allocated.fields.sequence)
  }

  @Test
  fun existingActionRetrySurvivesNewerReportIdentity() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    val repository = receiptRepository(db, responder, origin)
    repository.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 1_000L)
    val intent = ActionIntent(UUID.randomUUID().toString(), reportId, 1L, status = 1, note = "Acknowledged")
    val first = repository.allocateAction(intent)

    repository.recordReportEnvelope(createEnvelope(reportId, 2, origin), now = 2_000L)
    assertEquals(2L, repository.currentReceiptVersion(reportId))

    val retry = repository.allocateAction(intent)
    assertEquals(first.fields.actionId, retry.fields.actionId)
    assertEquals(first.fields.revision, retry.fields.revision)
    assertEquals(first.fields.sequence, retry.fields.sequence)
    assertThrows(IllegalStateException::class.java) {
      repository.allocateAction(
        ActionIntent(UUID.randomUUID().toString(), reportId, 1L, status = 2, note = "Stale new action"),
      )
    }
  }

  @Test
  fun responderSigningRequiresInjectedAuthorityVerifier() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    val profile = ResponderSignerProfile(
      identity = responder,
      providerKind = 1,
      grantId = "00000000-0000-0000-0000-000000000000",
      responderId = UUID.fromString("11111111-1111-4111-8111-111111111111").toString(),
      callsign = "TAGUM-1",
      proof = byteArrayOf(),
    )
    val repository = ReceiptRepository(
      database = db,
      responderSigner = profile,
      requesterSigner = origin,
      clock = { now },
    )
    repository.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 1_000L)
    val actionId = UUID.randomUUID().toString()
    repository.allocateAction(ActionIntent(actionId, reportId, 1L, status = 1, note = "Acknowledged"))

    val result = repository.prepareReceipt(actionId)

    assertEquals(ActionCommitState.REJECTED, result.state)
    assertEquals("VERIFIER_UNAVAILABLE", result.reason)
    assertEquals(0, countRows(db, "receipt_records"))
  }

  @Test
  fun signedResponderActionNeverResignsWhenCanonicalBytesAreMissing() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    insertLocalReport(db, reportId)
    val repository = receiptRepository(db, responder, origin)
    repository.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 1_000L)
    val actionId = UUID.randomUUID().toString()
    repository.allocateAction(ActionIntent(actionId, reportId, 1L, status = 2, note = "En route"))
    assertEquals(ActionCommitState.SIGNED, repository.prepareReceipt(actionId).state)

    db.writableDatabase.delete("receipt_records", "event_id = ?", arrayOf(actionId))
    val retry = repository.prepareReceipt(actionId)

    assertEquals(ActionCommitState.REJECTED, retry.state)
    assertEquals("SIGNED_RECEIPT_MISSING", retry.reason)
    assertEquals(0, countRows(db, "receipt_records"))
  }

  @Test
  fun requesterReceiptRetryIsImmutableAndWrongOriginCannotSign() {
    database = SagipDatabase(context)
    val sourceDb = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    insertLocalReport(sourceDb, reportId)
    val source = receiptRepository(sourceDb, responder, origin)
    source.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 1_000L)
    val actionId = UUID.randomUUID().toString()
    source.allocateAction(ActionIntent(actionId, reportId, 1L, status = 1, note = "Acknowledged"))
    val ackBytes = requireNotNull(source.prepareReceipt(actionId).bytes)

    sourceDb.close()
    database = null
    clearDatabaseFiles()

    database = SagipDatabase(context)
    val targetDb = requireNotNull(database)
    insertLocalReport(targetDb, reportId)
    val receiver = ReceiptRepository(targetDb, requesterSigner = origin, clock = { now })
    receiver.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 2_000L)
    assertEquals(ReceiptApplication.APPLIED, receiver.applyToReport(ackBytes, rootContext(responder)))

    val wrong = ReceiptRepository(targetDb, requesterSigner = JcaSigningIdentity(), clock = { now })
      .prepareRequesterReceipt(actionId)
    assertEquals(ActionCommitState.FAILED, wrong.state)
    assertEquals("ORIGIN_SIGNER_MISMATCH", wrong.reason)
    assertEquals(0, countRows(targetDb, "requester_receipt_actions"))

    val first = receiver.prepareRequesterReceipt(actionId)
    assertEquals(ActionCommitState.SIGNED, first.state)
    val firstBytes = requireNotNull(first.bytes)

    targetDb.close()
    database = SagipDatabase(context)
    val reopened = ReceiptRepository(requireNotNull(database), requesterSigner = origin, clock = { now })
    val retry = reopened.prepareRequesterReceipt(actionId)
    assertEquals(first.actionId, retry.actionId)
    assertEquals(ActionCommitState.SIGNED, retry.state)
    assertArrayEquals(firstBytes, retry.bytes)
  }

  @Test
  fun unknownRevisionReceiptIsQuarantinedUntilIdentityArrives() {
    database = SagipDatabase(context)
    val sourceDb = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    val source = receiptRepository(sourceDb, responder, origin)
    source.recordReportEnvelope(createEnvelope(reportId, 2, origin), now = 1_000L)
    val actionId = UUID.randomUUID().toString()
    source.allocateAction(ActionIntent(actionId, reportId, 1L, status = 2, note = "En route"))
    val ackBytes = requireNotNull(source.prepareReceipt(actionId).bytes)

    sourceDb.close()
    database = null
    clearDatabaseFiles()

    database = SagipDatabase(context)
    val target = ReceiptRepository(requireNotNull(database), requesterSigner = origin, clock = { now })
    target.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 2_000L)

    assertEquals(ReceiptApplication.PENDING_AUTHORITY, target.applyToReport(ackBytes, rootContext(responder)))
    assertEquals(0, countRows(requireNotNull(database), "receipt_records"))
    assertEquals(1, countRows(requireNotNull(database), "receipt_quarantine"))

    target.recordReportEnvelope(createEnvelope(reportId, 2, origin), now = 3_000L)
    assertEquals(ReceiptApplication.APPLIED, target.applyToReport(ackBytes, rootContext(responder)))
    assertEquals(1, countRows(requireNotNull(database), "receipt_records"))
    assertEquals(0, countRows(requireNotNull(database), "receipt_quarantine"))
  }

  @Test
  fun expiredResponderAndRequesterPreparationFailClosed() {
    database = SagipDatabase(context)
    val sourceDb = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    val source = receiptRepository(sourceDb, responder, origin)
    source.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 1_000L)
    val expiredActionId = UUID.randomUUID().toString()
    val allocated = source.allocateAction(
      ActionIntent(expiredActionId, reportId, 1L, status = 2, note = "Delayed action"),
    )
    now = allocated.fields.forwardingExpiresAtMs

    val expiredResponder = source.prepareReceipt(expiredActionId)
    assertEquals(ActionCommitState.REJECTED, expiredResponder.state)
    assertEquals("FORWARDING_EXPIRED", expiredResponder.reason)
    assertEquals(0, countRows(sourceDb, "receipt_records"))

    now = 50_000L
    val ackActionId = UUID.randomUUID().toString()
    source.allocateAction(ActionIntent(ackActionId, reportId, 1L, status = 1, note = "Acknowledged"))
    val ackBytes = requireNotNull(source.prepareReceipt(ackActionId).bytes)
    val ack = ReceiptV2Codec.decode(ackBytes).fields as ReceiptFields.Responder

    sourceDb.close()
    database = null
    clearDatabaseFiles()

    database = SagipDatabase(context)
    val targetDb = requireNotNull(database)
    val target = ReceiptRepository(targetDb, requesterSigner = origin, clock = { now })
    target.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 2_000L)
    assertEquals(ReceiptApplication.APPLIED, target.applyToReport(ackBytes, rootContext(responder)))
    now = ack.forwardingExpiresAtMs

    val expiredRequester = target.prepareRequesterReceipt(ackActionId)
    assertEquals(ActionCommitState.REJECTED, expiredRequester.state)
    assertEquals("FORWARDING_EXPIRED", expiredRequester.reason)
    assertEquals("UNKNOWN", requireNotNull(target.projection(reportId)).requesterDeliveryState)
  }

  @Test
  fun wrongAckDigestCannotEstablishRequesterDelivery() {
    database = SagipDatabase(context)
    val sourceDb = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    val source = receiptRepository(sourceDb, responder, origin)
    source.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 1_000L)
    val actionId = UUID.randomUUID().toString()
    source.allocateAction(ActionIntent(actionId, reportId, 1L, status = 1, note = "Acknowledged"))
    val ackBytes = requireNotNull(source.prepareReceipt(actionId).bytes)
    val ack = ReceiptV2Codec.decode(ackBytes).fields as ReceiptFields.Responder

    sourceDb.close()
    database = null
    clearDatabaseFiles()

    database = SagipDatabase(context)
    val targetDb = requireNotNull(database)
    val target = ReceiptRepository(targetDb, requesterSigner = origin, clock = { now })
    target.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 2_000L)
    assertEquals(ReceiptApplication.APPLIED, target.applyToReport(ackBytes, rootContext(responder)))

    val wrongDigestReceipt = signReceipt(
      ReceiptFields.Requester(
        eventId = UUID.randomUUID().toString(),
        reportId = reportId,
        reportProtocolVersion = 1,
        revision = 1,
        originKeyId = origin.keyId,
        originPublicKeyDer = origin.publicKeyDer,
        ackEventId = actionId,
        ackDigest = ByteArray(32) { 0x5a.toByte() },
        receivedAtMs = now,
        forwardingExpiresAtMs = ack.forwardingExpiresAtMs,
      ),
      origin,
    )

    assertEquals(ReceiptApplication.REJECTED, target.applyToReport(wrongDigestReceipt, rootContext(responder)))
    assertEquals("UNKNOWN", requireNotNull(target.projection(reportId)).requesterDeliveryState)
    assertEquals(1, countRows(targetDb, "receipt_records"))
  }

  @Test
  fun concurrentActionsAllocateDistinctMonotonicSequences() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    val repository = receiptRepository(db, responder, origin)
    repository.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 1_000L)
    val start = CountDownLatch(1)
    val executor = Executors.newFixedThreadPool(2)
    try {
      val futures = (1..2).map { index ->
        executor.submit<AllocatedAction> {
          start.await(5, TimeUnit.SECONDS)
          repository.allocateAction(
            ActionIntent(
              UUID.randomUUID().toString(),
              reportId,
              1L,
              status = index,
              note = "Concurrent $index",
            ),
          )
        }
      }
      start.countDown()
      val sequences = futures.map { it.get(10, TimeUnit.SECONDS).fields.sequence }.sorted()
      assertEquals(listOf(1L, 2L), sequences)
      assertEquals(2, countRows(db, "receipt_actions"))
    } finally {
      executor.shutdownNow()
    }
  }

  @Test
  fun fullReceiptStoreRefusesNewSignedEvidenceWithoutDeletingHistory() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    val repository = receiptRepository(db, responder, origin)
    repository.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 1_000L)
    val actionId = UUID.randomUUID().toString()
    repository.allocateAction(ActionIntent(actionId, reportId, 1L, status = 1, note = "Acknowledged"))

    db.writableDatabase.execSQL(
      """
        WITH RECURSIVE seq(x) AS (
          VALUES(1)
          UNION ALL SELECT x + 1 FROM seq WHERE x < 10000
        )
        INSERT INTO receipt_records(
          event_id, object_kind, event_digest, object_bytes, report_id, revision,
          verification_kind, forwarding_expires_at_ms, received_at_ms
        )
        SELECT printf('capacity-%05d', x), 'TEST', randomblob(32), x'01', ?, 1,
               'TEST', 999999999, 0
        FROM seq
      """.trimIndent(),
      arrayOf(reportId),
    )
    assertEquals(10_000, countRows(db, "receipt_records"))

    val result = repository.prepareReceipt(actionId)
    assertEquals(ActionCommitState.REJECTED, result.state)
    assertEquals("CAPACITY_EXCEEDED", result.reason)
    assertEquals(10_000, countRows(db, "receipt_records"))
    db.readableDatabase.rawQuery(
      "SELECT preparation_state FROM receipt_actions WHERE action_id = ?",
      arrayOf(actionId),
    ).use { cursor ->
      assertTrue(cursor.moveToFirst())
      assertEquals("PREPARING", cursor.getString(0))
    }
  }

  @Test
  fun delegatedGatewayForwardingExpiryIsCappedByGrantExpiry() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val root = JcaSigningIdentity()
    val gateway = JcaSigningIdentity()
    val origin = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    val responderId = UUID.randomUUID().toString()
    val grantId = UUID.randomUUID().toString()
    val grantExpiry = 55_000L
    now = 50_000L
    val grantFields = ReceiptFields.Grant(
      rootKeyId = root.keyId,
      grantId = grantId,
      issuerKeyId = gateway.keyId,
      issuerPublicKeyDer = gateway.publicKeyDer,
      issuerProviderId = ReceiptAuthority.issuerProviderId(2, gateway.keyId, grantId),
      responderId = responderId,
      callsign = "TAGUM-GATEWAY",
      statusMask = 0x0f,
      purposeMask = 0x09,
      scope = "TAGUM_PILOT",
      notBeforeMs = 40_000L,
      expiresAtMs = grantExpiry,
    )
    val grantBytes = signReceipt(grantFields, root)
    val profile = ResponderSignerProfile(
      identity = gateway,
      providerKind = 2,
      grantId = grantId,
      responderId = responderId,
      callsign = "TAGUM-GATEWAY",
      proof = oneMemberProof(grantBytes),
    )
    val repository = ReceiptRepository(
      database = db,
      responderSigner = profile,
      requesterSigner = origin,
      verificationContextProvider = { report, linkedAck ->
        VerificationContext(
          roots = mapOf(hex(root.keyId) to root.publicKeyDer),
          revokedGrants = emptySet(),
          allowedScopes = setOf("TAGUM_PILOT"),
          trustedTime = TimeInterval(now, now + 100L),
          authorityCheckedAtMs = now,
          currentAuthorityChecked = true,
          report = report,
          pairedTimeProviderId = null,
          linkedAck = linkedAck,
        )
      },
      clock = { now },
    )
    repository.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 1_000L)

    val allocated = repository.allocateAction(
      ActionIntent(UUID.randomUUID().toString(), reportId, 1L, status = 2, note = "En route"),
    )
    assertEquals(grantExpiry, allocated.fields.forwardingExpiresAtMs)
    assertEquals(ActionCommitState.SIGNED, repository.prepareReceipt(allocated.fields.actionId).state)
  }

  @Test
  fun sameAuthenticatedEventWithDifferentBytesIsRejectedAndOriginalIsPreserved() {
    database = SagipDatabase(context)
    val sourceDb = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    val source = receiptRepository(sourceDb, responder, origin)
    source.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 1_000L)
    val actionId = UUID.randomUUID().toString()
    source.allocateAction(ActionIntent(actionId, reportId, 1L, status = 1, note = "Acknowledged"))
    val original = requireNotNull(source.prepareReceipt(actionId).bytes)
    val originalFields = ReceiptV2Codec.decode(original).fields as ReceiptFields.Responder
    val changedDraft = originalFields.copy(
      actionDigest = ByteArray(32),
      status = 2,
      note = "Different authenticated statement",
    )
    val changedFields = changedDraft.copy(actionDigest = ReceiptAuthority.actionDigest(changedDraft))
    val conflicting = signReceipt(changedFields, responder)

    sourceDb.close()
    database = null
    clearDatabaseFiles()

    database = SagipDatabase(context)
    val targetDb = requireNotNull(database)
    val target = ReceiptRepository(targetDb, requesterSigner = origin, clock = { now })
    target.recordReportEnvelope(createEnvelope(reportId, 1, origin), now = 2_000L)

    assertEquals(ReceiptApplication.APPLIED, target.applyToReport(original, rootContext(responder)))
    assertEquals(ReceiptApplication.REJECTED, target.applyToReport(conflicting, rootContext(responder)))
    assertArrayEquals(original, target.getReceipt(actionId))
    assertEquals(1, countRows(targetDb, "receipt_records"))
    assertEquals(1, countRows(targetDb, "receipt_quarantine"))
  }

  @Test
  fun timeChallengeRequiresExactThirtyTwoByteNonce() {
    database = SagipDatabase(context)
    val repository = ReceiptRepository(requireNotNull(database), clock = { now })

    assertThrows(IllegalArgumentException::class.java) {
      repository.recordTimeChallenge(
        challengeId = UUID.randomUUID().toString(),
        verifierId = ByteArray(32) { 1 },
        verifierBootSessionId = UUID.randomUUID().toString(),
        nonce = ByteArray(31) { 2 },
        sentElapsedMs = 10L,
        createdAtMs = 20L,
      )
    }
    assertEquals(0, countRows(requireNotNull(database), "receipt_time_challenges"))
  }

  @Test
  fun timeCheckpointCommitIsChallengeBoundDurableAndRejectsRollback() {
    database = SagipDatabase(context)
    val repository = ReceiptRepository(requireNotNull(database), clock = { now })
    val verifierId = ByteArray(32) { 7 }
    val challengeId = UUID.randomUUID().toString()
    val bootId = UUID.randomUUID().toString()
    val nonce = ByteArray(32) { 9 }
    repository.recordTimeChallenge(
      challengeId = challengeId,
      verifierId = verifierId,
      verifierBootSessionId = bootId,
      nonce = nonce,
      sentElapsedMs = 5_000L,
      createdAtMs = 40_000L,
    )
    val proofBytes = ByteArray(96) { (it + 1).toByte() }
    val checkpoint = TimeCheckpoint(
      earliestMs = 45_000L,
      latestMs = 45_100L,
      bootId = bootId,
      receivedElapsedMs = 5_100L,
      validUntilMs = 100_000L,
      proofDigest = hex(MessageDigest.getInstance("SHA-256").digest(proofBytes)),
    )
    assertTrue(repository.commitTimeCheckpoint(challengeId, verifierId, nonce, checkpoint, proofBytes))
    assertTrue(!repository.commitTimeCheckpoint(challengeId, verifierId, nonce, checkpoint))

    val second = UUID.randomUUID().toString()
    repository.recordTimeChallenge(second, verifierId, bootId, ByteArray(32) { 8 }, 5_200L, 41_000L)
    assertTrue(
      !repository.commitTimeCheckpoint(
        second,
        verifierId,
        ByteArray(32) { 8 },
        checkpoint.copy(earliestMs = 44_999L, latestMs = 45_050L, proofDigest = "rollback"),
      ),
    )

    requireNotNull(database).close()
    database = SagipDatabase(context)
    val restored = ReceiptRepository(requireNotNull(database)).latestTimeCheckpoint(verifierId)
    assertNotNull(restored)
    assertEquals(checkpoint, restored)
    assertArrayEquals(proofBytes, ReceiptRepository(requireNotNull(database)).latestTimeProof(verifierId))
    assertEquals(null, ReceiptAuthority.advanceCheckpoint(checkpoint, MonotonicClock(UUID.randomUUID().toString(), 5_200L)))
  }

  @Test
  fun equalProviderSequenceIsQuarantinedAndHigherSequenceCannotRegressStatus() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    val source = receiptRepository(db,responder,origin)
    source.recordReportEnvelope(createEnvelope(reportId,1,origin),now=1000)
    val actionId=UUID.randomUUID().toString()
    source.allocateAction(ActionIntent(actionId,reportId,1,status=3,note="On scene"))
    val original=requireNotNull(source.prepareReceipt(actionId).bytes)
    val originalFields=ReceiptV2Codec.decode(original).fields as ReceiptFields.Responder
    fun changed(sequence:Long,status:Int):ByteArray {
      val draft=originalFields.copy(actionId=UUID.randomUUID().toString(),sequence=sequence,status=status,
        actionDigest=ByteArray(32),note="Changed status")
      return signReceipt(draft.copy(actionDigest=ReceiptAuthority.actionDigest(draft)),responder)
    }
    val before=source.projection(reportId)!!.eventId
    assertEquals(ReceiptApplication.REJECTED,source.applyToReport(changed(originalFields.sequence,4),rootContext(responder)))
    assertEquals(1,countRows(db,"receipt_quarantine"))
    assertEquals(ReceiptApplication.HISTORICAL,source.applyToReport(changed(originalFields.sequence+1,1),rootContext(responder)))
    assertEquals(before,source.projection(reportId)!!.eventId)
  }

  @Test
  fun laterProviderArrivalCannotRegressSharedVisibleStage() {
    database=SagipDatabase(context)
    val db=requireNotNull(database)
    val origin=JcaSigningIdentity()
    val first=receiptRepository(db,JcaSigningIdentity(),origin)
    val second=receiptRepository(db,JcaSigningIdentity(),origin)
    val reportId=UUID.randomUUID().toString()
    first.recordReportEnvelope(createEnvelope(reportId,1,origin),now=1000)
    val onScene=UUID.randomUUID().toString()
    first.allocateAction(ActionIntent(onScene,reportId,1,status=3,note="On scene"))
    assertEquals(ActionCommitState.SIGNED,first.prepareReceipt(onScene).state)
    now += 1000
    val lower=UUID.randomUUID().toString()
    second.allocateAction(ActionIntent(lower,reportId,second.currentReceiptVersion(reportId),status=1,note="Late ACK"))
    assertEquals(ActionCommitState.SIGNED,second.prepareReceipt(lower).state)
    assertEquals(2,countRows(db,"receipt_projections"))
    assertEquals(onScene,second.projection(reportId)!!.eventId)
  }

  private fun receiptRepository(
    db: SagipDatabase,
    responder: SigningIdentity,
    requester: SigningIdentity,
  ): ReceiptRepository {
    val profile = ResponderSignerProfile(
      identity = responder,
      providerKind = 1,
      grantId = "00000000-0000-0000-0000-000000000000",
      responderId = UUID.fromString("11111111-1111-4111-8111-111111111111").toString(),
      callsign = "TAGUM-1",
      proof = byteArrayOf(),
    )
    return ReceiptRepository(
      database = db,
      responderSigner = profile,
      requesterSigner = requester,
      verificationContextProvider = { report, linkedAck -> rootContext(responder).copy(report = report, linkedAck = linkedAck) },
      clock = { now },
    )
  }

  private fun rootContext(responder: SigningIdentity): VerificationContext = VerificationContext(
    roots = mapOf(hex(responder.keyId) to responder.publicKeyDer),
    revokedGrants = emptySet(),
    allowedScopes = emptySet(),
    trustedTime = TimeInterval(now, now + 100L),
    authorityCheckedAtMs = now,
    currentAuthorityChecked = true,
    report = null,
    pairedTimeProviderId = null,
  )

  private fun createEnvelope(reportId: String, revision: Int, origin: SigningIdentity): ByteArray =
    TransportEnvelopeV1.create(
      EnvelopeUnsignedInput(
        messageId = UUID.randomUUID().toString(),
        reportId = reportId,
        revision = revision,
        createdAt = 1_000L + revision,
        expiresAt = null,
        priority = 0,
        payload = EmergencyPayloadV1.encode(EmergencyType.MEDICAL, Urgency.NEED_ASSISTANCE, null),
      ),
      origin,
    )

  private fun oneMemberProof(member: ByteArray): ByteArray = ByteBuffer.allocate(3 + member.size)
    .put(1.toByte())
    .putShort(member.size.toShort())
    .put(member)
    .array()

  private fun signReceipt(fields: ReceiptFields, signer: SigningIdentity): ByteArray {
    val one = ByteArray(32).also { it[31] = 1 }
    val placeholder = one + one
    val encoded = ReceiptV2Codec.encode(fields, placeholder, ByteArray(0))
    val input = "SAGIP-SIGNED-V2\u0000".toByteArray(Charsets.US_ASCII) +
      encoded.copyOfRange(0, encoded.size - 64)
    return ReceiptV2Codec.encode(fields, derToP1363LowS(signer.sign(input)), ByteArray(0))
  }

  private fun derToP1363LowS(der: ByteArray): ByteArray {
    var offset = 0
    require((der[offset++].toInt() and 0xff) == 0x30)
    val sequenceLength = readDerLength(der, offset)
    offset += sequenceLength.second
    require(offset + sequenceLength.first == der.size)
    require((der[offset++].toInt() and 0xff) == 0x02)
    val rLength = readDerLength(der, offset)
    offset += rLength.second
    val r = BigInteger(1, der.copyOfRange(offset, offset + rLength.first))
    offset += rLength.first
    require((der[offset++].toInt() and 0xff) == 0x02)
    val sLength = readDerLength(der, offset)
    offset += sLength.second
    var scalarS = BigInteger(1, der.copyOfRange(offset, offset + sLength.first))
    val order = BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)
    if (scalarS > order.shiftRight(1)) scalarS = order - scalarS
    return scalar32(r) + scalar32(scalarS)
  }

  private fun readDerLength(bytes: ByteArray, offset: Int): Pair<Int, Int> {
    val first = bytes[offset].toInt() and 0xff
    if (first < 128) return first to 1
    val count = first and 0x7f
    require(count in 1..2)
    var value = 0
    repeat(count) { value = (value shl 8) or (bytes[offset + 1 + it].toInt() and 0xff) }
    return value to (count + 1)
  }

  private fun scalar32(value: BigInteger): ByteArray {
    val source = value.toByteArray()
    val raw = if (source.size == 33 && source[0] == 0.toByte()) source.copyOfRange(1, 33) else source
    require(raw.size <= 32)
    return ByteArray(32 - raw.size) + raw
  }

  private fun insertLocalReport(db: SagipDatabase, reportId: String) {
    db.writableDatabase.insertOrThrow(
      "reports",
      null,
      ContentValues().apply {
        put("report_id", reportId)
        put("created_at", 1_000L)
        put("emergency_type", "MEDICAL")
        put("urgency", "NEED_ASSISTANCE")
        put("lifecycle_state", "LOCALLY_COMMITTED")
      },
    )
  }

  private fun createLegacyDatabase(
    targetVersion: Int,
    reportId: String,
    messageId: String,
    envelopeBytes: ByteArray,
  ) {
    require(targetVersion in 1..7)
    val path = context.getDatabasePath(SagipDatabase.DATABASE_NAME)
    path.parentFile?.mkdirs()
    FrameworkSQLiteDatabase.openOrCreateDatabase(path, null).use { raw ->
      raw.execSQL(
        """
          CREATE TABLE reports (
            report_id TEXT PRIMARY KEY NOT NULL,
            created_at INTEGER NOT NULL,
            emergency_type TEXT NOT NULL,
            urgency TEXT NOT NULL,
            lifecycle_state TEXT NOT NULL
          )
        """.trimIndent(),
      )
      raw.execSQL(
        """
          CREATE TABLE report_revisions (
            report_id TEXT NOT NULL,
            revision INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            emergency_type TEXT NOT NULL,
            urgency TEXT NOT NULL,
            PRIMARY KEY (report_id, revision),
            FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE
          )
        """.trimIndent(),
      )
      raw.execSQL(
        """
          CREATE TABLE locations (
            location_id INTEGER PRIMARY KEY AUTOINCREMENT,
            report_id TEXT NOT NULL UNIQUE,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            accuracy_meters REAL,
            captured_at INTEGER NOT NULL,
            source TEXT NOT NULL,
            freshness TEXT NOT NULL,
            FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE
          )
        """.trimIndent(),
      )
      raw.execSQL(
        """
          CREATE TABLE outbound_envelopes (
            message_id TEXT PRIMARY KEY NOT NULL,
            report_id TEXT NOT NULL UNIQUE,
            revision INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            delivery_state TEXT NOT NULL,
            FOREIGN KEY (report_id, revision) REFERENCES report_revisions(report_id, revision) ON DELETE CASCADE
          )
        """.trimIndent(),
      )
      raw.execSQL(
        """
          CREATE TABLE delivery_events (
            event_id TEXT PRIMARY KEY NOT NULL,
            report_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            occurred_at INTEGER NOT NULL,
            FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE,
            FOREIGN KEY (message_id) REFERENCES outbound_envelopes(message_id) ON DELETE CASCADE
          )
        """.trimIndent(),
      )
      raw.insertOrThrow("reports", null, ContentValues().apply {
        put("report_id", reportId)
        put("created_at", 1_000L)
        put("emergency_type", "MEDICAL")
        put("urgency", "NEED_ASSISTANCE")
        put("lifecycle_state", "LOCALLY_COMMITTED")
      })
      raw.insertOrThrow("report_revisions", null, ContentValues().apply {
        put("report_id", reportId)
        put("revision", 1)
        put("created_at", 1_000L)
        put("emergency_type", "MEDICAL")
        put("urgency", "NEED_ASSISTANCE")
      })
      raw.insertOrThrow("outbound_envelopes", null, ContentValues().apply {
        put("message_id", messageId)
        put("report_id", reportId)
        put("revision", 1)
        put("created_at", 1_000L)
        put("delivery_state", "DELIVERY_PENDING")
      })

      val migrations = listOf(
        Schema.MIGRATE_1_TO_2,
        Schema.MIGRATE_2_TO_3,
        Schema.MIGRATE_3_TO_4,
        Schema.MIGRATE_4_TO_5,
        Schema.MIGRATE_5_TO_6,
        Schema.MIGRATE_6_TO_7,
      )
      repeat(targetVersion - 1) { index -> migrations[index].forEach(raw::execSQL) }
      if (targetVersion >= 2) {
        raw.execSQL(
          "UPDATE outbound_envelopes SET envelope_bytes=? WHERE report_id=?",
          arrayOf<Any?>(envelopeBytes, reportId),
        )
      }
      raw.version = targetVersion
    }
  }

  private fun createVersion7Database(reportId: String, envelopeBytes: ByteArray) {
    // Use the complete historical schema, then restore this test's signed/ready-envelope precondition.
    createLegacyDatabase(7, reportId, "receipt-migration-message", envelopeBytes)
    FrameworkSQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(SagipDatabase.DATABASE_NAME), null).use { raw ->
      raw.execSQL("UPDATE outbound_envelopes SET preparation_state='READY' WHERE report_id=?", arrayOf(reportId))
    }
  }

  private fun assertTableExists(table: String) {
    requireNotNull(database).readableDatabase.rawQuery(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      arrayOf(table),
    ).use { cursor -> assertTrue("Missing table $table", cursor.moveToFirst()) }
  }

  private fun countRows(db: SagipDatabase, table: String): Int =
    db.readableDatabase.rawQuery("SELECT COUNT(*) FROM $table", null).use { cursor ->
      cursor.moveToFirst()
      cursor.getInt(0)
    }

  private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

  private fun clearDatabaseFiles() {
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
    listOf(
      context.getDatabasePath(SagipDatabase.DATABASE_NAME + ".sqlcipher-migrating"),
      context.getDatabasePath(SagipDatabase.DATABASE_NAME + ".plaintext-backup"),
    ).forEach { file ->
      listOf(file, java.io.File(file.absolutePath + "-wal"), java.io.File(file.absolutePath + "-shm"))
        .forEach { it.delete() }
    }
    context.getSharedPreferences("sagip.database.key.v1", Context.MODE_PRIVATE).edit().clear().commit()
    runCatching {
      KeyStore.getInstance("AndroidKeyStore").apply {
        load(null)
        if (containsAlias(DatabaseKeyManager.KEY_ALIAS)) deleteEntry(DatabaseKeyManager.KEY_ALIAS)
      }
    }
  }

  private class JcaSigningIdentity : SigningIdentity {
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

  private class FailingSigningIdentity(private val delegate: SigningIdentity) : SigningIdentity {
    override val publicKeyDer: ByteArray = delegate.publicKeyDer
    override val keyId: ByteArray = delegate.keyId
    override fun sign(data: ByteArray): ByteArray = throw IllegalStateException("injected signing failure")
  }
}
