package com.sagip.survival

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class EnvelopePreparationServiceInstrumentedTest {
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
  fun preparesPendingEnvelopeAndPersistsVerifiableBytes() {
    repository.createReport(
      CreateEmergencyReportInput(EmergencyType.FIRE, Urgency.IMMEDIATE_DANGER),
      LocationSnapshot(14.5995, 120.9842, 8.0, 1_200L, "GPS", "FRESH"),
      now = 2_000L,
    )

    val service = EnvelopePreparationService(repository, JcaSigningIdentity())
    val result = service.preparePending()

    assertEquals(1, result.prepared)
    assertEquals(0, result.failed)
    assertTrue(repository.listEnvelopePreparationSources().isEmpty())

    val due = repository.listDueOutbound(now = 2_000L).single()
    val decoded = TransportEnvelopeV1.decode(due.envelopeBytes)
    assertEquals(due.messageId, decoded.messageId)
    assertEquals(due.reportId, decoded.reportId)
    assertTrue(TransportEnvelopeV1.verify(decoded))

    val payload = EmergencyPayloadV1.decode(decoded.payload)
    assertEquals(EmergencyType.FIRE, payload.emergencyType)
    assertEquals(Urgency.IMMEDIATE_DANGER, payload.urgency)
    assertEquals("GPS", payload.location?.source)
  }

  @Test
  fun signingFailureLeavesLocallyCommittedReportDurableAndUnprepared() {
    val created = repository.createReport(
      CreateEmergencyReportInput(EmergencyType.MEDICAL, Urgency.NEED_ASSISTANCE),
      location = null,
      now = 3_000L,
    )

    val service = EnvelopePreparationService(repository, FailingSigningIdentity())
    val result = service.preparePending()

    assertEquals(0, result.prepared)
    assertEquals(1, result.failed)
    assertEquals(created.reportId, repository.listReports().single().reportId)
    assertEquals(1, repository.listEnvelopePreparationSources().size)
    assertTrue(repository.listDueOutbound(now = 3_000L).isEmpty())
  }

  @Test
  fun onePreparationFailureDoesNotPreventLaterPendingEnvelope() {
    repository.createReport(
      CreateEmergencyReportInput(EmergencyType.TRAPPED, Urgency.IMMEDIATE_DANGER),
      location = null,
      now = 4_000L,
    )
    repository.createReport(
      CreateEmergencyReportInput(EmergencyType.FLOOD, Urgency.NEED_ASSISTANCE),
      location = null,
      now = 4_100L,
    )

    val service = EnvelopePreparationService(
      repository,
      FailFirstSigningIdentity(JcaSigningIdentity()),
    )
    val result = service.preparePending()

    assertEquals(1, result.prepared)
    assertEquals(1, result.failed)
    assertEquals(1, repository.listEnvelopePreparationSources().size)
    assertEquals(1, repository.listDueOutbound(now = 4_100L).size)
    assertEquals(2, repository.listReports().size)
  }

  @Test
  fun secondPassDoesNotRegenerateAlreadyReadyEnvelope() {
    repository.createReport(
      CreateEmergencyReportInput(EmergencyType.OTHER, Urgency.NEED_ASSISTANCE),
      location = null,
      now = 5_000L,
    )

    val identity = JcaSigningIdentity()
    val service = EnvelopePreparationService(repository, identity)
    assertEquals(PreparationBatchResult(1, 0), service.preparePending())
    val firstBytes = repository.listDueOutbound(now = 5_000L).single().envelopeBytes.copyOf()

    assertEquals(PreparationBatchResult(0, 0), service.preparePending())
    val secondBytes = repository.listDueOutbound(now = 5_000L).single().envelopeBytes
    assertArrayEquals(firstBytes, secondBytes)
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

  private class FailingSigningIdentity : SigningIdentity {
    override val publicKeyDer: ByteArray = byteArrayOf(1)
    override val keyId: ByteArray = ByteArray(32)

    override fun sign(data: ByteArray): ByteArray = error("simulated signing failure")
  }

  private class FailFirstSigningIdentity(
    private val delegate: SigningIdentity,
  ) : SigningIdentity {
    private var failed = false

    override val publicKeyDer: ByteArray
      get() = delegate.publicKeyDer
    override val keyId: ByteArray
      get() = delegate.keyId

    override fun sign(data: ByteArray): ByteArray {
      if (!failed) {
        failed = true
        error("simulated first signing failure")
      }
      return delegate.sign(data)
    }
  }
}
