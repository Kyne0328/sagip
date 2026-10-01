package com.sagip.survival

import android.content.Context
import android.content.ContextWrapper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.Closeable
import java.io.File
import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class OfflineReceiptRoundTripTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()

  @Before fun setUp() = clearMainDatabaseAndKeyMaterial()
  @After fun tearDown() = clearMainDatabaseAndKeyMaterial()

  @Test
  fun offline_three_phone_return_receipt() {
    OfflineReceiptRoundTripFixture(context).use { fixture ->
      val result = fixture.run()
      assertArrayEquals(result.originalAckDigest, result.receivedAckDigest)
      assertArrayEquals(result.originalOriginKeyId, result.requesterProofOriginKeyId)
      assertEquals(result.originalAckExpiryMs, result.returnedAckExpiryMs)
      assertTrue(result.wrongOriginSignerRejected)
      assertEquals(BleCustodyCode.UNVERIFIED_AUTHORITY, result.missingTrustResult)
      assertEquals(BleCustodyCode.EXPIRED, result.expiredReadmissionResult)
      assertTrue(result.relayReceiptSurvivedReopen)
    }
  }

  @Test
  fun twenty_reports_progress_across_interrupted_contacts() {
    OfflineReceiptRoundTripFixture(context).use { fixture ->
      val progress = fixture.runInterruptedFairness()
      assertEquals(20, progress.totalReports)
      assertEquals(20, progress.completedReports)
      assertTrue(progress.maxLeasesPerContact <= BleReceiptExchangeCodec.MAX_CONTACT_TRANSFERS)
      assertTrue(progress.interruptedLeaseWasRetried)
    }
  }

  private fun clearMainDatabaseAndKeyMaterial() {
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
    listOf(
      context.getDatabasePath(SagipDatabase.DATABASE_NAME + ".sqlcipher-migrating"),
      context.getDatabasePath(SagipDatabase.DATABASE_NAME + ".plaintext-backup"),
    ).forEach { file ->
      listOf(file, File(file.absolutePath + "-wal"), File(file.absolutePath + "-shm")).forEach { it.delete() }
    }
    context.getSharedPreferences("sagip.database.key.v1", Context.MODE_PRIVATE).edit().clear().commit()
    runCatching {
      KeyStore.getInstance("AndroidKeyStore").apply {
        load(null)
        if (containsAlias(DatabaseKeyManager.KEY_ALIAS)) deleteEntry(DatabaseKeyManager.KEY_ALIAS)
      }
    }
  }
}

private data class OfflineReceiptRoundTripResult(
  val originalAckDigest: ByteArray,
  val receivedAckDigest: ByteArray,
  val originalOriginKeyId: ByteArray,
  val requesterProofOriginKeyId: ByteArray,
  val originalAckExpiryMs: Long,
  val returnedAckExpiryMs: Long,
  val wrongOriginSignerRejected: Boolean,
  val missingTrustResult: BleCustodyCode,
  val expiredReadmissionResult: BleCustodyCode,
  val relayReceiptSurvivedReopen: Boolean,
)

private data class InterruptedFairnessResult(
  val totalReports: Int,
  val completedReports: Int,
  val maxLeasesPerContact: Int,
  val interruptedLeaseWasRetried: Boolean,
)

private class OfflineReceiptRoundTripFixture(private val baseContext: Context) : Closeable {
  private val rootDirectory = File(baseContext.noBackupFilesDir, "d04-roundtrip-${UUID.randomUUID()}")
  private val nodeContexts = linkedMapOf<String, NodeContext>()
  private val openedDatabases = mutableListOf<SagipDatabase>()
  private var nowMs = 100_000L

  fun run(): OfflineReceiptRoundTripResult {
    val requesterIdentity = TestSigningIdentity()
    val relayIdentity = TestSigningIdentity()
    val rootIdentity = TestSigningIdentity()
    val gatewayIdentity = TestSigningIdentity()
    val requesterDb = openDatabase("requester")
    var relayDb = openDatabase("relay")
    val gatewayDb = openDatabase("gateway")
    val untrustedDb = openDatabase("untrusted-probe")
    val expiredDb = openDatabase("expired-probe")

    val requesterEmergency = EmergencyRepository(requesterDb)
    val report = requesterEmergency.createReport(
      CreateEmergencyReportInput(EmergencyType.MEDICAL, Urgency.NEED_ASSISTANCE), null, 10_000L,
    )
    check(EnvelopePreparationService(requesterEmergency, requesterIdentity).preparePending() == PreparationBatchResult(1, 0))
    val outbound = requesterEmergency.listDueOutbound(10_001L, 1).single()
    val sosBytes = outbound.envelopeBytes.copyOf()
    val decodedSos = TransportEnvelopeV1.decode(sosBytes)
    check(decodedSos.reportId == report.reportId)
    val sosDigest = sha256(sosBytes)
    val reportIdentity = ReportIdentity(
      decodedSos.reportId, 1, decodedSos.revision, decodedSos.payloadDigest,
      decodedSos.originKeyId, decodedSos.originPublicKeyDer,
    )
    val sosEntry = InventoryEntry(
      ObjectKind.SOS, decodedSos.messageId, sosDigest, decodedSos.reportId, decodedSos.revision, 0L, 1, 0L,
    )

    var relayQueue = ReceiptQueue(relayDb)
    check(receiveViaD03(relayQueue, authorityContext(rootIdentity, nowMs), "requester-phone", sosEntry, sosBytes, nowMs).result == BleCustodyCode.ACCEPTED_DURABLE)
    nowMs += 1_000L
    val gatewayQueue = ReceiptQueue(gatewayDb)
    check(transferLeased(relayQueue, gatewayQueue, authorityContext(rootIdentity, nowMs), "gateway-phone", "relay-phone", decodedSos.messageId, nowMs).result == BleCustodyCode.ACCEPTED_DURABLE)

    val grantExpiryMs = nowMs + 300_000L
    val grantId = UUID.randomUUID().toString()
    val responderId = UUID.randomUUID().toString()
    val grantFields = ReceiptFields.Grant(
      rootIdentity.keyId, grantId, gatewayIdentity.keyId, gatewayIdentity.publicKeyDer,
      ReceiptAuthority.issuerProviderId(2, gatewayIdentity.keyId, grantId), responderId,
      "TAGUM-GATEWAY", 0x0f, 0x09, "TAGUM_PILOT", nowMs - 10_000L, grantExpiryMs,
    )
    val gatewayProfile = ResponderSignerProfile(
      gatewayIdentity, 2, grantId, responderId, "TAGUM-GATEWAY", oneMemberProof(signReceipt(grantFields, rootIdentity)),
    )
    val gatewayRepository = ReceiptRepository(
      gatewayDb,
      responderSigner = gatewayProfile,
      verificationContextProvider = { linkedReport, linkedAck ->
        authorityContext(rootIdentity, nowMs).copy(report = linkedReport, linkedAck = linkedAck)
      },
      clock = { nowMs },
    )
    check(gatewayRepository.currentReceiptVersion(report.reportId) == 1L)
    val actionId = UUID.randomUUID().toString()
    val action = gatewayRepository.allocateAction(ActionIntent(actionId, report.reportId, 1L, 2, "Team en route"))
    val signed = gatewayRepository.prepareReceipt(action.fields.actionId)
    check(signed.state == ActionCommitState.SIGNED)
    val ackBytes = requireNotNull(signed.bytes).copyOf()
    val ackDigest = sha256(ackBytes)
    val ackFields = ReceiptV2Codec.decode(ackBytes).fields as ReceiptFields.Responder
    check(ackFields.forwardingExpiresAtMs == grantExpiryMs)
    val gatewayAdmission = gatewayQueue.admitObject(
      ackBytes, ObjectKind.RESPONDER_RECEIPT, authorityContext(rootIdentity, nowMs).copy(report = reportIdentity),
    )
    check(gatewayAdmission.kind == CustodyResultKind.COMMITTED) { "gateway admission=$gatewayAdmission" }

    val untrustedQueue = ReceiptQueue(untrustedDb)
    check(receiveViaD03(untrustedQueue, authorityContext(rootIdentity, nowMs), "requester-phone", sosEntry, sosBytes, nowMs).result == BleCustodyCode.ACCEPTED_DURABLE)
    val ackEntry = requireNotNull(gatewayQueue.inventoryEntry(actionId, ackDigest))
    val missingTrust = receiveViaD03(
      untrustedQueue,
      authorityContext(rootIdentity, nowMs).copy(
        trustedTime = null, authorityCheckedAtMs = null, currentAuthorityChecked = false, report = reportIdentity,
      ),
      "gateway-phone",
      ackEntry,
      ackBytes,
      nowMs + 10L,
    )
    check(missingTrust.result == BleCustodyCode.UNVERIFIED_AUTHORITY)

    nowMs += 1_000L
    val ackToRelay = transferLeased(
      gatewayQueue, relayQueue, authorityContext(rootIdentity, nowMs).copy(report = reportIdentity),
      "relay-phone", "gateway-phone", actionId, nowMs,
    )
    check(ackToRelay.result == BleCustodyCode.ACCEPTED_DURABLE)
    check(requireNotNull(relayQueue.getObject(actionId, ackDigest)).bytes.contentEquals(ackBytes))

    relayDb.close()
    openedDatabases.remove(relayDb)
    relayDb = openDatabase("relay")
    relayQueue = ReceiptQueue(relayDb)
    val relayStoredAfterReopen = requireNotNull(relayQueue.getObject(actionId, ackDigest))
    val survivedReopen = relayStoredAfterReopen.bytes.contentEquals(ackBytes)

    nowMs += 1_000L
    val requesterQueue = ReceiptQueue(requesterDb)
    val ackToRequester = transferLeased(
      relayQueue, requesterQueue, authorityContext(rootIdentity, nowMs).copy(report = reportIdentity),
      "requester-phone", "relay-phone", actionId, nowMs,
    )
    check(ackToRequester.result == BleCustodyCode.ACCEPTED_DURABLE)
    val requesterStoredAck = requireNotNull(requesterQueue.getObject(actionId, ackDigest))
    check(requesterStoredAck.bytes.contentEquals(ackBytes))

    val wrongSignerResult = ReceiptRepository(requesterDb, requesterSigner = relayIdentity, clock = { nowMs })
      .prepareRequesterReceipt(actionId)
    val wrongSignerRejected = wrongSignerResult.state == ActionCommitState.FAILED &&
      wrongSignerResult.reason == "ORIGIN_SIGNER_MISMATCH"

    val requesterRepository = ReceiptRepository(requesterDb, requesterSigner = requesterIdentity, clock = { nowMs })
    val requesterReceipt = requesterRepository.prepareRequesterReceipt(actionId)
    check(requesterReceipt.state == ActionCommitState.SIGNED)
    val requesterReceiptBytes = requireNotNull(requesterReceipt.bytes)
    val requesterDecoded = ReceiptV2Codec.decode(requesterReceiptBytes)
    val requesterFields = requesterDecoded.fields as ReceiptFields.Requester
    check(ReceiptV2Codec.verifySignature(requesterDecoded, requesterIdentity.publicKeyDer))
    check(MessageDigest.isEqual(requesterFields.ackDigest, ackDigest))
    check(requesterFields.forwardingExpiresAtMs == ackFields.forwardingExpiresAtMs)

    val expiredQueue = ReceiptQueue(expiredDb)
    check(
      receiveViaD03(
        expiredQueue,
        authorityContext(rootIdentity, ackFields.forwardingExpiresAtMs),
        "requester-phone",
        sosEntry,
        sosBytes,
        ackFields.forwardingExpiresAtMs,
      ).result == BleCustodyCode.ACCEPTED_DURABLE,
    )
    val expiredReadmission = receiveViaD03(
      expiredQueue,
      authorityContext(rootIdentity, ackFields.forwardingExpiresAtMs).copy(report = reportIdentity),
      "relay-phone",
      ackEntry,
      ackBytes,
      ackFields.forwardingExpiresAtMs,
    )
    check(expiredReadmission.result == BleCustodyCode.EXPIRED)

    val receivedAckFields = ReceiptV2Codec.decode(requesterStoredAck.bytes).fields as ReceiptFields.Responder
    return OfflineReceiptRoundTripResult(
      originalAckDigest = ackDigest,
      receivedAckDigest = sha256(requesterStoredAck.bytes),
      originalOriginKeyId = decodedSos.originKeyId.copyOf(),
      requesterProofOriginKeyId = requesterFields.originKeyId.copyOf(),
      originalAckExpiryMs = ackFields.forwardingExpiresAtMs,
      returnedAckExpiryMs = receivedAckFields.forwardingExpiresAtMs,
      wrongOriginSignerRejected = wrongSignerRejected,
      missingTrustResult = missingTrust.result,
      expiredReadmissionResult = expiredReadmission.result,
      relayReceiptSurvivedReopen = survivedReopen,
    )
  }

  fun runInterruptedFairness(): InterruptedFairnessResult {
    val database = openDatabase("fairness")
    val queue = ReceiptQueue(database)
    val origin = TestSigningIdentity()
    val context = authorityContext(TestSigningIdentity(), nowMs)
    repeat(20) { index ->
      val envelope = TransportEnvelopeV1.create(
        EnvelopeUnsignedInput(
          UUID.randomUUID().toString(), UUID.randomUUID().toString(), 1, 10_000L + index, null, 0,
          EmergencyPayloadV1.encode(EmergencyType.MEDICAL, Urgency.NEED_ASSISTANCE, null),
        ),
        origin,
      )
      check(queue.admitObject(envelope, ObjectKind.SOS, context).kind == CustodyResultKind.COMMITTED)
    }

    val completed = linkedSetOf<String>()
    var interruptedObjectId: String? = null
    var interruptedWasRetried = false
    var maxLeases = 0
    var contact = 0
    while (completed.size < 20 && contact < 10) {
      val contactTime = nowMs + contact * 61_000L
      val leases = queue.leaseContactWork("field-relay", contactTime, BleReceiptExchangeCodec.MAX_CONTACT_TRANSFERS)
      maxLeases = maxOf(maxLeases, leases.size)
      check(leases.size <= BleReceiptExchangeCodec.MAX_CONTACT_TRANSFERS)
      if (contact > 0 && interruptedObjectId != null && leases.any { it.objectId == interruptedObjectId }) {
        interruptedWasRetried = true
      }
      leases.forEachIndexed { index, lease ->
        check(queue.claimContactTransfer("field-relay", contactTime))
        if (contact == 0 && index == leases.lastIndex) {
          interruptedObjectId = lease.objectId
          queue.releaseTransferLease(lease.leaseId, contactTime + 1L)
        } else {
          queue.finishTransfer(lease.leaseId, TransferOutcome.PEER_CUSTODY, contactTime + 1L)
          completed += lease.reportId
        }
      }
      if (leases.size == BleReceiptExchangeCodec.MAX_CONTACT_TRANSFERS) {
        check(!queue.claimContactTransfer("field-relay", contactTime))
      }
      contact++
    }
    return InterruptedFairnessResult(20, completed.size, maxLeases, interruptedWasRetried)
  }

  private fun transferLeased(
    senderQueue: ReceiptQueue,
    receiverQueue: ReceiptQueue,
    receiverContext: VerificationContext,
    senderPeerId: String,
    receiverPeerId: String,
    objectId: String,
    atMs: Long,
  ): BleCustodyResult {
    val leases = senderQueue.leaseContactWork(
      senderPeerId,
      atMs,
      BleReceiptExchangeCodec.MAX_CONTACT_TRANSFERS,
    )
    val selected = leases.firstOrNull { it.objectId == objectId }
      ?: error("requested D04 object was not leased")
    leases.filterNot { it.leaseId == selected.leaseId }
      .forEach { senderQueue.releaseTransferLease(it.leaseId, atMs + 1L) }
    val entry = requireNotNull(senderQueue.inventoryEntry(selected.objectId, selected.digest))
    val custody = receiveViaD03(
      receiverQueue,
      receiverContext,
      receiverPeerId,
      entry,
      selected.bytes,
      atMs + 2L,
    )
    val outcome = when (custody.result) {
      BleCustodyCode.ACCEPTED_DURABLE -> TransferOutcome.PEER_CUSTODY
      BleCustodyCode.DUPLICATE_VERIFIED -> TransferOutcome.ALREADY_HAVE_VERIFIED
      BleCustodyCode.CAPACITY_FULL -> TransferOutcome.RETRYABLE
      BleCustodyCode.UNVERIFIED_AUTHORITY -> TransferOutcome.PENDING_VERIFICATION
      BleCustodyCode.EXPIRED,
      BleCustodyCode.REJECTED -> TransferOutcome.PERMANENT_REJECTION
    }
    senderQueue.finishTransfer(selected.leaseId, outcome, atMs + 3L)
    return custody
  }

  private fun receiveViaD03(
    receiverQueue: ReceiptQueue,
    receiverContext: VerificationContext,
    peerId: String,
    entry: InventoryEntry,
    bytes: ByteArray,
    atMs: Long,
  ): BleCustodyResult {
    var currentTime = atMs
    val receiver = BleReceiptExchangeReceiver(
      admit = { kind, objectBytes -> receiverQueue.admitObject(objectBytes, kind, receiverContext) },
      alreadyHaveVerified = { offered ->
        receiverQueue.knownVerifiedDigest(offered.objectKind, offered.objectId)?.let { known ->
          MessageDigest.isEqual(known, offered.digest)
        } == true
      },
      nowProvider = { currentTime },
      receiptIdProvider = { UUID.randomUUID().toString() },
    )
    val decision = receiver.beginOffer(peerId, BleReceiptExchangeCodec.encodeOffer(entry, bytes.size))
    if (decision.decision == BleDecisionCode.ALREADY_HAVE_VERIFIED) {
      return BleCustodyResult(entry.objectId, entry.digest.copyOf(), BleCustodyCode.DUPLICATE_VERIFIED, null, null)
    }
    check(decision.decision == BleDecisionCode.ACCEPT_TRANSFER)
    var custody: BleCustodyResult? = null
    BleReceiptExchangeCodec.encodeObjectChunks(bytes, 64).forEach { chunk ->
      currentTime += 1L
      receiver.addChunk(peerId, chunk)?.let { custody = it }
    }
    return requireNotNull(custody)
  }

  private fun authorityContext(root: SigningIdentity, atMs: Long): VerificationContext = VerificationContext(
    roots = mapOf(hex(root.keyId) to root.publicKeyDer),
    revokedGrants = emptySet(),
    allowedScopes = setOf("TAGUM_PILOT"),
    trustedTime = TimeInterval(atMs, atMs + 10L),
    authorityCheckedAtMs = atMs,
    currentAuthorityChecked = true,
    report = null,
    pairedTimeProviderId = null,
  )

  private fun openDatabase(label: String): SagipDatabase {
    val node = nodeContexts.getOrPut(label) { NodeContext(baseContext, File(rootDirectory, label)) }
    return SagipDatabase(node).also(openedDatabases::add)
  }

  override fun close() {
    openedDatabases.reversed().forEach { runCatching { it.close() } }
    openedDatabases.clear()
    rootDirectory.deleteRecursively()
  }

  private class NodeContext(base: Context, private val databaseDirectory: File) : ContextWrapper(base) {
    override fun getApplicationContext(): Context = this
    override fun getDatabasePath(name: String): File {
      databaseDirectory.mkdirs()
      return File(databaseDirectory, name)
    }
  }

  private class TestSigningIdentity : SigningIdentity {
    private val keyPair: KeyPair = KeyPairGenerator.getInstance("EC").run {
      initialize(ECGenParameterSpec("secp256r1"))
      generateKeyPair()
    }
    override val publicKeyDer: ByteArray = keyPair.public.encoded
    override val keyId: ByteArray = sha256(publicKeyDer)
    override fun sign(data: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
      initSign(keyPair.private)
      update(data)
      sign()
    }
  }

  private fun oneMemberProof(member: ByteArray): ByteArray = ByteBuffer.allocate(3 + member.size)
    .put(1.toByte()).putShort(member.size.toShort()).put(member).array()

  private fun signReceipt(fields: ReceiptFields, signer: SigningIdentity): ByteArray {
    val one = ByteArray(32).also { it[31] = 1 }
    val encoded = ReceiptV2Codec.encode(fields, one + one, ByteArray(0))
    val input = "SAGIP-SIGNED-V2\u0000".toByteArray(Charsets.US_ASCII) + encoded.copyOfRange(0, encoded.size - 64)
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

  companion object {
    private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }
}
