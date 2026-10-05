package com.sagip.survival

import android.content.Context
import android.content.ContextWrapper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.facebook.react.bridge.JavaOnlyMap
import java.io.File
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OneTapSosInstrumentedTest {
  private val context = object : ContextWrapper(ApplicationProvider.getApplicationContext<Context>()) {
    override fun getApplicationContext(): Context = this
    override fun getDatabasePath(name: String): File = super.getDatabasePath("one-tap-$name")
    override fun deleteDatabase(name: String): Boolean = super.deleteDatabase("one-tap-$name")
  }
  private lateinit var database: SagipDatabase
  private lateinit var repository: EmergencyRepository
  private val identity = TestIdentity()

  @Before fun setUp() {
    check(context.packageName == "org.sagip.app.sosvalidation")
    System.loadLibrary("sqlcipher")
    SurvivalCoreRuntime.get(ApplicationProvider.getApplicationContext())
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
    open()
  }
  @After fun tearDown() {
    if (::database.isInitialized) database.close()
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
  }

  @Test fun emptyNativeInputIsDurableIdempotentAndUrgentAcrossReopen() {
    val parsed = EmergencyBridgeInput.parseCreate(JavaOnlyMap())
    val first = repository.createReport(parsed, null, 100)
    assertEquals(EmergencyType.UNSPECIFIED, first.emergencyType)
    assertEquals(Urgency.UNSPECIFIED, first.urgency)
    assertNull(first.location)
    assertEquals(0, repository.listEnvelopePreparationSources().single().priority)
    assertEquals(first.reportId, repository.createReport(parsed, null, 101).reportId)
    reopen()
    assertEquals(first.reportId, repository.createReport(parsed, null, 102).reportId)
    assertEquals(1, repository.listReports().size)
    assertEquals(PreparationBatchResult(1, 0), EnvelopePreparationService(repository, identity).preparePending())
    val wire = TransportEnvelopeV1.decode(repository.listDueOutbound(200).single().envelopeBytes)
    assertTrue(TransportEnvelopeV1.verify(wire))
    assertEquals(EmergencyType.UNSPECIFIED, EmergencyPayload.decode(wire.payload).emergencyType)
    assertEquals(Urgency.UNSPECIFIED, EmergencyPayload.decode(wire.payload).urgency)
  }

  @Test fun lateLocationBecomesDurableRevisionAndFreshFixCanUpgradeStaleOnce() {
    val first = repository.createReport(
      CreateEmergencyReportInput(EmergencyType.FIRE, Urgency.NEED_ASSISTANCE),
      null,
      100,
    )
    assertNull(first.location)

    val stale = LocationSnapshot(7.4471, 125.8078, 80.0, 120, "NETWORK", "STALE")
    assertTrue(repository.attachLocationToActiveReportIfBetter(stale, 200))
    var summary = repository.listReports().single()
    assertEquals(2, summary.latestRevision)
    assertEquals(stale, summary.location)

    assertFalse(repository.attachLocationToActiveReportIfBetter(stale, 201))
    assertEquals(2, repository.listReports().single().latestRevision)

    val fresh = LocationSnapshot(7.4480, 125.8084, 8.0, 250, "GPS", "FRESH")
    assertTrue(repository.attachLocationToActiveReportIfBetter(fresh, 300))
    val newerFresh = LocationSnapshot(7.4481, 125.8085, 5.0, 260, "GPS", "FRESH")
    assertFalse(repository.attachLocationToActiveReportIfBetter(newerFresh, 301))

    reopen()
    summary = repository.listReports().single()
    assertEquals(first.reportId, summary.reportId)
    assertEquals(3, summary.latestRevision)
    assertEquals(fresh, summary.location)
    assertEquals(PreparationBatchResult(3, 0), EnvelopePreparationService(repository, identity).preparePending())

    val revisions = repository.listDueOutbound(400)
    assertEquals(3, revisions.size)
    assertNull(EmergencyPayload.decode(TransportEnvelopeV1.decode(revisions.single { it.revision == 1 }.envelopeBytes).payload).location)
    assertEquals(stale, EmergencyPayload.decode(TransportEnvelopeV1.decode(revisions.single { it.revision == 2 }.envelopeBytes).payload).location)
    val newest = EmergencyPayload.decode(TransportEnvelopeV1.decode(revisions.single { it.revision == 3 }.envelopeBytes).payload)
    assertEquals(fresh, newest.location)
    assertEquals(EmergencyType.FIRE, newest.emergencyType)
    assertEquals(Urgency.NEED_ASSISTANCE, newest.urgency)
  }

  @Test fun lateFixIsAttemptedInSamePassWithoutBypassingExistingBackoff() = runBlocking {
    repository.createReport(CreateEmergencyReportInput(), null, 100)
    EnvelopePreparationService(repository, identity).preparePending()
    val original = repository.listDueOutbound(100).single()
    val retryAt = repository.scheduleRetry(original.messageId, now = 100, jitterUnit = 0.5,
      minimumDelayMs = 60_000)
    val passTime = 200L
    var wallTime = passTime
    val location = LocationSnapshot(7.4471, 125.8078, 8.0, passTime, "GPS", "FRESH")
    assertTrue(attachLocationForDelivery(passTime, {
      wallTime++ // Deterministic T/T+1 boundary between pass start and insertion.
      location
    }, repository::attachLocationToActiveReportIfBetter))
    assertEquals(201L, wallTime)
    EnvelopePreparationService(repository, identity).preparePending()
    val newest = repository.listDueOutbound(passTime).single()
    assertEquals(2, newest.revision)
    assertEquals(passTime, newest.nextAttemptAt)
    val sent = mutableListOf<String>()
    val sender = object : EnvelopeSender {
      override suspend fun send(envelope: OutboundEnvelope): DeliveryTransportResult {
        sent += envelope.messageId
        return DeliveryTransportResult.Accepted(receipt(newest))
      }
    }
    assertEquals(1, DeliveryWorker(repository, sender, relayStore = null, ackStore = null).runOnce(passTime))
    assertEquals(listOf(newest.messageId), sent)
    assertTrue(repository.listDueOutbound(retryAt - 1).isEmpty())
    val stillBackedOff = repository.listDueOutbound(retryAt).single()
    assertEquals(original.messageId, stillBackedOff.messageId)
    assertEquals(retryAt, stillBackedOff.nextAttemptAt)
    reopen()
    assertEquals(location, repository.listReports().single().location)
    assertEquals(EmergencyRepository.DELIVERY_SERVER_ACCEPTED,
      repository.listReports().single().latestDelivery?.deliveryState)
  }

  @Test fun locationOnlyRevisionDoesNotRejectDetailsFromPreviousRevision() {
    val first = repository.createReport(CreateEmergencyReportInput(EmergencyType.FIRE, Urgency.NEED_ASSISTANCE), null, 100)
    val location = LocationSnapshot(7.4471, 125.8078, 12.0, 150, "GPS", "FRESH")
    assertTrue(repository.attachLocationToActiveReportIfBetter(location, 200))

    val updated = repository.appendEmergencyDetails(
      AppendEmergencyDetailsInput(first.reportId, 1, id(), EmergencyType.MEDICAL),
      300,
    )

    assertEquals(3, updated.latestRevision)
    assertEquals(EmergencyType.MEDICAL, updated.emergencyType)
    assertEquals(Urgency.NEED_ASSISTANCE, updated.urgency)
    assertEquals(location, updated.location)
  }

  @Test fun optionalCategoryAndUrgencyKeepOriginalBytesAndListOnlyLatestRevision() {
    val first = repository.createReport(CreateEmergencyReportInput(), null, 100)
    EnvelopePreparationService(repository, identity).preparePending()
    val original = repository.listDueOutbound(100).single()
    val request = AppendEmergencyDetailsInput(first.reportId, 1, id(), EmergencyType.MEDICAL, urgency = Urgency.NEED_ASSISTANCE)
    val details = repository.appendEmergencyDetails(request, 200)
    assertEquals(first.reportId, details.reportId)
    assertEquals(2, details.latestRevision)
    assertEquals(PreparationBatchResult(1, 0), EnvelopePreparationService(repository, identity).preparePending())
    val all = repository.listDueOutbound(200)
    assertArrayEquals(original.envelopeBytes, all.single { it.revision == 1 }.envelopeBytes)
    val newest = all.single { it.revision == 2 }
    assertNotEquals(original.messageId, newest.messageId)
    val decoded = EmergencyPayload.decode(TransportEnvelopeV1.decode(newest.envelopeBytes).payload)
    assertEquals(EmergencyType.MEDICAL, decoded.emergencyType)
    assertEquals(Urgency.NEED_ASSISTANCE, decoded.urgency)
    assertEquals(10, newest.priority)
    reopen()
    val summary = repository.listReports().single()
    assertEquals(2, summary.latestRevision)
    assertEquals(EmergencyType.MEDICAL, summary.emergencyType)
    assertEquals(Urgency.NEED_ASSISTANCE, summary.urgency)
    assertEquals(newest.messageId, repository.appendEmergencyDetails(request, 300).latestDelivery?.messageId)
    assertEquals(2, repository.listDueOutbound(300).size)
    assertEquals(2, repository.appendEmergencyDetails(AppendEmergencyDetailsInput(first.reportId, 2, id()), 301).latestRevision)
    val error = assertThrows(EmergencyDetailsException::class.java) {
      repository.appendEmergencyDetails(request.copy(urgency = Urgency.IMMEDIATE_DANGER), 302)
    }
    assertEquals("DETAILS_OPERATION_REUSED", error.code)
  }

  @Test fun urgencyOnlyChangeAndSnapshotMessageArePreparedAfterRestart() {
    val location = LocationSnapshot(12.0, 34.0, 5.0, 90, "GPS", "FRESH")
    val first = repository.createReport(CreateEmergencyReportInput(), location, 100)
    val revised = repository.appendEmergencyDetails(AppendEmergencyDetailsInput(
      first.reportId, 1, id(), message = "Need help", urgency = Urgency.IMMEDIATE_DANGER,
    ), 200)
    assertEquals(EmergencyType.UNSPECIFIED, revised.emergencyType)
    assertEquals(Urgency.IMMEDIATE_DANGER, revised.urgency)
    reopen()
    assertEquals(PreparationBatchResult(2, 0), EnvelopePreparationService(repository, identity).preparePending())
    val newest = repository.listDueOutbound(300).single { it.revision == 2 }
    val decoded = EmergencyPayload.decode(TransportEnvelopeV1.decode(newest.envelopeBytes).payload)
    assertEquals("Need help", decoded.message)
    assertEquals(location, decoded.location)
    assertEquals(Urgency.IMMEDIATE_DANGER, decoded.urgency)
  }

  @Test fun lateLegacyAckCannotCancelOptionalDetailsAndOfflineRetrySurvivesReopen() = runBlocking {
    val first = repository.createReport(CreateEmergencyReportInput(), null, 100)
    EnvelopePreparationService(repository, identity).preparePending()
    val original = repository.listDueOutbound(100).single()
    repository.markServerAccepted(receipt(original), 110)
    repository.appendEmergencyDetails(AppendEmergencyDetailsInput(first.reportId, 1, id(), EmergencyType.FIRE), 200)
    EnvelopePreparationService(repository, identity).preparePending()
    val pending = repository.listDueOutbound(200).single()
    repository.recordResponderAck(ResponderAck(id(), first.reportId, "synthetic", "Test", "ACKNOWLEDGED", null, 150), 201)
    assertEquals(EmergencyRepository.DELIVERY_SERVER_ACCEPTED, repository.listReports().single().originalDelivery?.deliveryState)
    assertEquals(EmergencyRepository.DELIVERY_PENDING, repository.listReports().single().latestDelivery?.deliveryState)

    var sends = 0
    val offline = object : EnvelopeSender {
      override suspend fun send(envelope: OutboundEnvelope): DeliveryTransportResult {
        sends++
        assertArrayEquals(pending.envelopeBytes, envelope.bytes)
        return DeliveryTransportResult.RetryableFailure("SYNTHETIC_OFFLINE")
      }
    }
    assertEquals(0, DeliveryWorker(repository, offline, relayStore = null, ackStore = null).runOnce(300))
    assertEquals(1, sends)
    assertTrue(repository.listDueOutbound(301).isEmpty())
    reopen()
    val due = repository.listDueOutbound(1_000_000).single()
    assertEquals(pending.messageId, due.messageId)
    assertArrayEquals(pending.envelopeBytes, due.envelopeBytes)
    val accepted = object : EnvelopeSender {
      override suspend fun send(envelope: OutboundEnvelope): DeliveryTransportResult =
        DeliveryTransportResult.Accepted(receipt(due))
    }
    assertEquals(1, DeliveryWorker(repository, accepted, relayStore = null, ackStore = null).runOnce(1_000_000))
    assertTrue(repository.listDueOutbound(1_000_001).isEmpty())
    assertEquals(EmergencyRepository.DELIVERY_SERVER_ACCEPTED, repository.listReports().single().latestDelivery?.deliveryState)
    assertArrayEquals(original.envelopeBytes, bytes(original.messageId))
  }

  @Test fun oldServerAcceptanceCannotMarkNewRevisionAccepted() {
    val first = repository.createReport(CreateEmergencyReportInput(), null, 100)
    EnvelopePreparationService(repository, identity).preparePending()
    val original = repository.listDueOutbound(100).single()
    repository.appendEmergencyDetails(AppendEmergencyDetailsInput(first.reportId, 1, id(), EmergencyType.FLOOD), 200)
    repository.markServerAccepted(receipt(original), 201)
    val summary = repository.listReports().single()
    assertEquals(EmergencyRepository.DELIVERY_SERVER_ACCEPTED, summary.originalDelivery?.deliveryState)
    assertEquals(EmergencyRepository.DELIVERY_PENDING, summary.latestDelivery?.deliveryState)
    assertEquals(2, summary.latestRevision)
  }

  private fun open() { database = SagipDatabase(context); repository = EmergencyRepository(database) }
  private fun reopen() { database.close(); open() }
  private fun id() = UUID.randomUUID().toString()
  private fun bytes(messageId: String) = database.readableDatabase.rawQuery(
    "SELECT envelope_bytes FROM outbound_envelopes WHERE message_id=?", arrayOf(messageId),
  ).use { assertTrue(it.moveToFirst()); it.getBlob(0) }
  private fun receipt(work: OutboundEnvelopeWork) = ServerReceipt(1, "SERVER_ACCEPTED", id(), work.messageId, work.reportId, work.revision, "2026-10-05T00:00:00.000Z")
  private class TestIdentity : SigningIdentity {
    private val pair = KeyPairGenerator.getInstance("EC").run {
      initialize(ECGenParameterSpec("secp256r1")); generateKeyPair()
    }
    override val publicKeyDer = pair.public.encoded
    override val keyId = MessageDigest.getInstance("SHA-256").digest(publicKeyDer)
    override fun sign(data: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
      initSign(pair.private); update(data); sign()
    }
  }
}
