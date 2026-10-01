package com.sagip.survival

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.math.BigInteger
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ReceiptQueueTest {
  private val context: Context = ApplicationProvider.getApplicationContext()
  private var database: SagipDatabase? = null
  private var now = 10_000L

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
  fun custodyAdmissionIsAtomicAndBounded() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    val fixture = receiptFixture(db, reportId, origin, responder, note = "Acknowledged")
    val queue = ReceiptQueue(db)

    val invalid = fixture.bytes.copyOf().also { bytes ->
      bytes[bytes.lastIndex] = (bytes.last().toInt() xor 0x01).toByte()
    }
    assertEquals(
      CustodyResultKind.REJECTED,
      queue.admitObject(invalid, ObjectKind.RESPONDER_RECEIPT, fixture.context).kind,
    )
    assertNull(queue.getObject(fixture.eventId, sha256(fixture.bytes)))

    val committed = queue.admitObject(
      fixture.bytes,
      ObjectKind.RESPONDER_RECEIPT,
      fixture.context,
    )
    assertEquals(CustodyResultKind.COMMITTED, committed.kind)
    val digest = sha256(fixture.bytes)
    val stored = requireNotNull(queue.getObject(fixture.eventId, digest))
    assertArrayEquals(fixture.bytes, stored.bytes)
    assertEquals(reportId, stored.reportId)
    assertEquals(1, stored.revision)
    assertEquals("VERIFIED_CURRENT", stored.verificationClass)
    assertEquals("READY", stored.transportState)

    db.close()
    database = SagipDatabase(context)
    val reopened = ReceiptQueue(requireNotNull(database))
    assertArrayEquals(
      fixture.bytes,
      requireNotNull(reopened.getObject(fixture.eventId, digest)).bytes,
    )
    assertEquals(
      CustodyResultKind.DUPLICATE,
      reopened.admitObject(fixture.bytes, ObjectKind.RESPONDER_RECEIPT, fixture.context).kind,
    )

    val conflicting = receiptFixture(
      requireNotNull(database),
      reportId,
      origin,
      responder,
      actionId = fixture.eventId,
      note = "Different authenticated note",
      sequence = 2L,
      recordEnvelope = false,
    )
    assertEquals(
      CustodyResultKind.REJECTED,
      reopened.admitObject(conflicting.bytes, ObjectKind.RESPONDER_RECEIPT, conflicting.context).kind,
    )
    assertArrayEquals(
      fixture.bytes,
      requireNotNull(reopened.getObject(fixture.eventId, digest)).bytes,
    )
    assertTrue(hasQuarantineDigest(requireNotNull(database), sha256(conflicting.bytes)))
  }

  @Test
  fun unknownAndRolledBackTimeStayPendingAndCannotForward() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    val fixture = receiptFixture(db, reportId, origin, responder)
    val queue = ReceiptQueue(db)

    val noTime = fixture.context.copy(trustedTime = null)
    assertEquals(
      CustodyResultKind.PENDING_VERIFICATION,
      queue.admitObject(fixture.bytes, ObjectKind.RESPONDER_RECEIPT, noTime).kind,
    )
    assertNull(queue.getObject(fixture.eventId, sha256(fixture.bytes)))
    assertEquals(1, countRows(db, "receipt_quarantine"))

    val fresh = receiptFixture(db, reportId, origin, responder, note = "Second", sequence = 2L, recordEnvelope = false)
    assertEquals(
      CustodyResultKind.COMMITTED,
      queue.admitObject(fresh.bytes, ObjectKind.RESPONDER_RECEIPT, fresh.context).kind,
    )
    val rollback = fresh.context.copy(trustedTime = TimeInterval(now - 5_000L, now - 4_900L))
    val expiry = queue.expireRelayObjects(rollback)
    assertFalse(expiry.timeAvailable)
    assertEquals(0, expiry.expiredObjects)
    assertTrue(queue.getObject(fresh.eventId, sha256(fresh.bytes)) != null)
  }

  @Test
  fun oversizedObjectIsRejectedBeforeQuarantine() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val queue = ReceiptQueue(db)
    val oversized = ByteArray(ReceiptV2Codec.MAX_RECEIPT_BYTES + 1)

    val result = queue.admitObject(
      oversized,
      ObjectKind.RESPONDER_RECEIPT,
      emptyContext(TimeInterval(now, now + 10L)),
    )

    assertEquals(CustodyResultKind.REJECTED, result.kind)
    assertEquals(0, countRows(db, "relay_objects"))
    assertEquals(0, countRows(db, "receipt_quarantine"))
  }

  @Test
  fun activeCountByteAndProtectedTombstoneLimitsRefuseWithoutEviction() {
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()

    database = SagipDatabase(context)
    var db = requireNotNull(database)
    var reportId = UUID.randomUUID().toString()
    var one = receiptFixture(db, reportId, origin, responder)
    var two = receiptFixture(db, reportId, origin, responder, note = "Two", sequence = 2L, recordEnvelope = false)
    var queue = ReceiptQueue(
      db,
      ReceiptQueueLimits(activeObjects = 1, activeBytes = 1_000_000L, tombstoneObjects = 10, tombstoneBytes = 1_000_000L),
    )
    assertEquals(CustodyResultKind.COMMITTED, queue.admitObject(one.bytes, ObjectKind.RESPONDER_RECEIPT, one.context).kind)
    assertEquals(CustodyResultKind.CAPACITY_FULL, queue.admitObject(two.bytes, ObjectKind.RESPONDER_RECEIPT, two.context).kind)
    assertEquals(1, countRows(db, "relay_objects"))

    db.close(); database = null; clearDatabaseFiles()
    database = SagipDatabase(context); db = requireNotNull(database)
    reportId = UUID.randomUUID().toString()
    one = receiptFixture(db, reportId, origin, responder)
    two = receiptFixture(db, reportId, origin, responder, note = "Two", sequence = 2L, recordEnvelope = false)
    queue = ReceiptQueue(
      db,
      ReceiptQueueLimits(activeObjects = 10, activeBytes = 1_000_000L, tombstoneObjects = 10, tombstoneBytes = 1_000_000L),
    )
    assertEquals(CustodyResultKind.COMMITTED, queue.admitObject(one.bytes, ObjectKind.RESPONDER_RECEIPT, one.context).kind)
    val usedActiveBytes = db.readableDatabase.rawQuery(
      "SELECT accounted_bytes FROM relay_objects WHERE object_id=?",
      arrayOf(one.eventId),
    ).use { cursor ->
      assertTrue(cursor.moveToFirst())
      cursor.getLong(0)
    }
    queue = ReceiptQueue(
      db,
      ReceiptQueueLimits(activeObjects = 10, activeBytes = usedActiveBytes, tombstoneObjects = 10, tombstoneBytes = 1_000_000L),
    )
    assertEquals(CustodyResultKind.CAPACITY_FULL, queue.admitObject(two.bytes, ObjectKind.RESPONDER_RECEIPT, two.context).kind)
    assertEquals(1, countRows(db, "relay_objects"))

    db.close(); database = null; clearDatabaseFiles()
    database = SagipDatabase(context); db = requireNotNull(database)
    reportId = UUID.randomUUID().toString()
    one = receiptFixture(db, reportId, origin, responder)
    two = receiptFixture(db, reportId, origin, responder, note = "Two", sequence = 2L, recordEnvelope = false)
    queue = ReceiptQueue(
      db,
      ReceiptQueueLimits(activeObjects = 10, activeBytes = 1_000_000L, tombstoneObjects = 1, tombstoneBytes = 1_000_000L),
    )
    assertEquals(CustodyResultKind.COMMITTED, queue.admitObject(one.bytes, ObjectKind.RESPONDER_RECEIPT, one.context).kind)
    assertEquals(CustodyResultKind.CAPACITY_FULL, queue.admitObject(two.bytes, ObjectKind.RESPONDER_RECEIPT, two.context).kind)
    assertEquals(1, countRows(db, "relay_object_tombstones"))
    assertEquals(1, countRows(db, "relay_objects"))

    val usedTombstoneBytes = db.readableDatabase.rawQuery(
      "SELECT accounted_bytes FROM relay_object_tombstones WHERE object_id=?",
      arrayOf(one.eventId),
    ).use { cursor ->
      assertTrue(cursor.moveToFirst())
      cursor.getLong(0)
    }
    queue = ReceiptQueue(
      db,
      ReceiptQueueLimits(
        activeObjects = 10,
        activeBytes = 1_000_000L,
        tombstoneObjects = 10,
        tombstoneBytes = usedTombstoneBytes,
      ),
    )
    assertEquals(CustodyResultKind.CAPACITY_FULL, queue.admitObject(two.bytes, ObjectKind.RESPONDER_RECEIPT, two.context).kind)
    assertEquals(1, countRows(db, "relay_object_tombstones"))
    assertEquals(1, countRows(db, "relay_objects"))
  }

  @Test
  fun quarantineIsBoundedAndEvictsOldestWithoutReservingIdentity() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    val one = receiptFixture(db, reportId, origin, responder)
    val two = receiptFixture(db, reportId, origin, responder, note = "Two", sequence = 2L, recordEnvelope = false)
    val three = receiptFixture(db, reportId, origin, responder, note = "Three", sequence = 3L, recordEnvelope = false)
    val queue = ReceiptQueue(
      db,
      ReceiptQueueLimits(quarantineObjects = 2, quarantineBytes = 1_000_000L),
    )
    val noTime = one.context.copy(trustedTime = null)

    assertEquals(CustodyResultKind.PENDING_VERIFICATION, queue.admitObject(one.bytes, ObjectKind.RESPONDER_RECEIPT, noTime).kind)
    now += 1
    assertEquals(CustodyResultKind.PENDING_VERIFICATION, queue.admitObject(two.bytes, ObjectKind.RESPONDER_RECEIPT, noTime).kind)
    now += 1
    assertEquals(CustodyResultKind.PENDING_VERIFICATION, queue.admitObject(three.bytes, ObjectKind.RESPONDER_RECEIPT, noTime).kind)
    assertEquals(2, countRows(db, "receipt_quarantine"))
    assertFalse(hasQuarantineDigest(db, sha256(one.bytes)))
    assertNull(queue.getObject(one.eventId, sha256(one.bytes)))

    val byteBoundQueue = ReceiptQueue(
      db,
      ReceiptQueueLimits(quarantineObjects = 128, quarantineBytes = 0),
    )
    now += 1
    assertEquals(
      CustodyResultKind.PENDING_VERIFICATION,
      byteBoundQueue.admitObject(one.bytes, ObjectKind.RESPONDER_RECEIPT, noTime).kind,
    )
    assertEquals(0, countRows(db, "receipt_quarantine"))
  }

  @Test
  fun expiryKeepsProtectedReplayAndExpiredBytesCannotReviveAfterTombstoneCleanup() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    val fixture = receiptFixture(db, reportId, origin, responder, expiresAt = now + 2_000L)
    val queue = ReceiptQueue(db)
    assertEquals(CustodyResultKind.COMMITTED, queue.admitObject(fixture.bytes, ObjectKind.RESPONDER_RECEIPT, fixture.context).kind)

    val expiredContext = fixture.context.copy(trustedTime = TimeInterval(now + 2_001L, now + 2_002L))
    val expired = queue.expireRelayObjects(expiredContext)
    assertTrue(expired.timeAvailable)
    assertEquals(1, expired.expiredObjects)
    assertNull(queue.getObject(fixture.eventId, sha256(fixture.bytes)))
    assertEquals(1, countRows(db, "relay_object_tombstones"))
    assertEquals(CustodyResultKind.DUPLICATE, queue.admitObject(fixture.bytes, ObjectKind.RESPONDER_RECEIPT, expiredContext).kind)

    val purgeAt = now + 2_000L + ReceiptQueueLimits.REPLAY_RETENTION_MS + 1L
    val purged = queue.expireRelayObjects(fixture.context.copy(trustedTime = TimeInterval(purgeAt, purgeAt + 1L)))
    assertEquals(1, purged.purgedTombstones)
    assertEquals(0, countRows(db, "relay_object_tombstones"))
    assertEquals(CustodyResultKind.REJECTED, queue.admitObject(fixture.bytes, ObjectKind.RESPONDER_RECEIPT, fixture.context.copy(trustedTime = TimeInterval(purgeAt, purgeAt + 1L))).kind)
    assertEquals(
      CustodyResultKind.REJECTED,
      queue.admitObject(
        fixture.bytes,
        ObjectKind.RESPONDER_RECEIPT,
        fixture.context.copy(trustedTime = null),
      ).kind,
    )
    assertEquals(0, countRows(db, "relay_objects"))
  }

  @Test
  fun sosCustodyIsRelayOnlyAndDoesNotCreateOwnedReport() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    val envelope = createEnvelope(reportId, 1, origin)
    val decoded = TransportEnvelope.decodeAndVerify(envelope)
    val context = emptyContext(TimeInterval(now, now + 10L))
    val queue = ReceiptQueue(db)

    val result = queue.admitObject(envelope, ObjectKind.SOS, context)
    assertEquals(CustodyResultKind.COMMITTED, result.kind)
    assertEquals(0, countRows(db, "reports"))
    assertEquals(1, countRows(db, "inbound_envelopes"))
    assertEquals(1, countRows(db, "relay_objects"))
    assertArrayEquals(envelope, requireNotNull(queue.getObject(decoded.messageId, sha256(envelope))).bytes)
  }

  @Test
  fun storageFailureRollsBackObjectAndTombstone() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    val fixture = receiptFixture(db, reportId, origin, responder)
    db.writableDatabase.execSQL(
      "CREATE TRIGGER fail_relay_object_insert BEFORE INSERT ON relay_objects BEGIN SELECT RAISE(ABORT, 'simulated full disk'); END",
    )
    val queue = ReceiptQueue(db)

    assertThrows(RuntimeException::class.java) {
      queue.admitObject(fixture.bytes, ObjectKind.RESPONDER_RECEIPT, fixture.context)
    }
    assertEquals(0, countRows(db, "relay_objects"))
    assertEquals(0, countRows(db, "relay_object_tombstones"))
  }

  @Test
  fun inventoryLeasesAndOutcomesPersistAcrossReopenWithoutFalseRequesterDelivery() {
    database = SagipDatabase(context)
    var db = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val fixtures = (1..3).map { index ->
      val reportId = UUID.randomUUID().toString()
      val fixture = receiptFixture(db, reportId, origin, responder, note = "Report $index")
      assertEquals(
        CustodyResultKind.COMMITTED,
        ReceiptQueue(db).admitObject(fixture.bytes, ObjectKind.RESPONDER_RECEIPT, fixture.context).kind,
      )
      fixture
    }
    var queue = ReceiptQueue(db)

    val page1 = queue.inventory(cursor = null, limit = 2)
    assertEquals(2, page1.entries.size)
    assertTrue(page1.nextCursor != null)
    val page2 = queue.inventory(cursor = page1.nextCursor, limit = 2)
    assertEquals(1, page2.entries.size)
    assertNull(page2.nextCursor)
    assertEquals(
      fixtures.map { it.eventId }.toSet(),
      (page1.entries + page2.entries).map { it.objectId }.toSet(),
    )

    val t0 = now + 1_000L
    val peerA = queue.leaseContactWork("peer-a", t0, maxObjects = 2)
    assertEquals(2, peerA.size)
    assertTrue(peerA.all { it.leaseUntilMs == t0 + 60_000L })
    val peerB = queue.leaseContactWork("peer-b", t0, maxObjects = 8)
    assertEquals(1, peerB.size)
    assertTrue(peerB.none { lease -> peerA.any { it.objectId == lease.objectId } })

    val abandoned = peerA.first()
    val abandonedBytes = abandoned.bytes.copyOf()
    db.close()
    database = SagipDatabase(context)
    db = requireNotNull(database)
    queue = ReceiptQueue(db)

    assertTrue(queue.leaseContactWork("peer-c", t0 + 30_000L, maxObjects = 8).isEmpty())
    val recovered = queue.leaseContactWork("peer-c", t0 + 60_001L, maxObjects = 8)
    assertEquals(3, recovered.size)
    val recoveredAbandoned = recovered.first { it.objectId == abandoned.objectId }
    assertArrayEquals(abandonedBytes, recoveredAbandoned.bytes)
    assertFalse(recoveredAbandoned.leaseId == abandoned.leaseId)

    val retryLease = recovered[0]
    val custodyLease = recovered[1]
    val alreadyHaveLease = recovered[2]
    val finishAt = t0 + 60_100L
    queue.finishTransfer(retryLease.leaseId, TransferOutcome.RETRYABLE, finishAt)
    queue.finishTransfer(custodyLease.leaseId, TransferOutcome.PEER_CUSTODY, finishAt)
    queue.finishTransfer(alreadyHaveLease.leaseId, TransferOutcome.ALREADY_HAVE_VERIFIED, finishAt)
    queue.finishTransfer(custodyLease.leaseId, TransferOutcome.PEER_CUSTODY, finishAt)
    assertThrows(IllegalStateException::class.java) {
      queue.finishTransfer(custodyLease.leaseId, TransferOutcome.RETRYABLE, finishAt)
    }

    val retryState = db.readableDatabase.rawQuery(
      "SELECT next_attempt_at_ms FROM relay_peer_object_state WHERE peer_id=? AND object_id=?",
      arrayOf("peer-c", retryLease.objectId),
    ).use { cursor ->
      assertTrue(cursor.moveToFirst())
      cursor.getLong(0)
    }
    assertTrue(retryState in finishAt..(finishAt + 900_000L))

    val samePeerLater = queue.leaseContactWork("peer-c", finishAt + 900_001L, maxObjects = 8)
    assertTrue(samePeerLater.none { it.objectId == custodyLease.objectId })
    assertTrue(samePeerLater.none { it.objectId == alreadyHaveLease.objectId })

    val deliveryState = db.readableDatabase.rawQuery(
      "SELECT requester_delivery_state FROM receipt_projections WHERE event_id=?",
      arrayOf(custodyLease.objectId),
    ).use { cursor ->
      assertTrue(cursor.moveToFirst())
      cursor.getString(0)
    }
    assertEquals("UNKNOWN", deliveryState)
  }

  @Test
  fun contactQuotaSurvivesReopenAndRequiresSixtySecondsInactivity() {
    database = SagipDatabase(context)
    var db = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    repeat(10) { index ->
      val fixture = receiptFixture(
        db,
        UUID.randomUUID().toString(),
        origin,
        responder,
        note = "Quota report $index",
      )
      assertEquals(
        CustodyResultKind.COMMITTED,
        ReceiptQueue(db).admitObject(fixture.bytes, ObjectKind.RESPONDER_RECEIPT, fixture.context).kind,
      )
    }
    val t0 = now + 5_000L
    var queue = ReceiptQueue(db)
    repeat(8) { assertTrue(queue.claimContactTransfer("quota-peer", t0)) }
    assertFalse(queue.claimContactTransfer("quota-peer", t0))
    assertFalse(queue.claimContactTransfer("quota-peer", t0 - 1_000L))

    db.close()
    database = SagipDatabase(context)
    db = requireNotNull(database)
    queue = ReceiptQueue(db)
    assertFalse(queue.claimContactTransfer("quota-peer", t0 + 30_000L))
    assertTrue(queue.claimContactTransfer("quota-peer", t0 + 90_001L))
    repeat(7) { assertTrue(queue.claimContactTransfer("quota-peer", t0 + 90_001L)) }
    assertFalse(queue.claimContactTransfer("quota-peer", t0 + 90_001L))
  }

  @Test
  fun releasedUnattemptedLeaseIsImmediatelyEligibleWithoutPeerOutcome() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val fixture = receiptFixture(db, UUID.randomUUID().toString(), origin, responder)
    val queue = ReceiptQueue(db)
    assertEquals(
      CustodyResultKind.COMMITTED,
      queue.admitObject(fixture.bytes, ObjectKind.RESPONDER_RECEIPT, fixture.context).kind,
    )

    val t0 = now + 2_000L
    val first = queue.leaseContactWork("release-peer", t0, maxObjects = 1).single()
    queue.releaseTransferLease(first.leaseId, t0 + 1L)
    queue.releaseTransferLease(first.leaseId, t0 + 2L)

    val peerStateCount = db.readableDatabase.rawQuery(
      "SELECT COUNT(*) FROM relay_peer_object_state WHERE peer_id=? AND object_id=?",
      arrayOf("release-peer", first.objectId),
    ).use { cursor ->
      assertTrue(cursor.moveToFirst())
      cursor.getInt(0)
    }
    assertEquals(0, peerStateCount)

    val second = queue.leaseContactWork("release-peer", t0 + 3L, maxObjects = 1).single()
    assertEquals(first.objectId, second.objectId)
    assertArrayEquals(first.bytes, second.bytes)
    assertFalse(first.leaseId == second.leaseId)
  }
  @Test
  fun transferLeaseDeadlineIsExclusive() {
    database = SagipDatabase(context)
    val db = requireNotNull(database)
    val origin = JcaSigningIdentity()
    val responder = JcaSigningIdentity()
    val reportId = UUID.randomUUID().toString()
    val fixture = receiptFixture(db, reportId, origin, responder)
    val queue = ReceiptQueue(db)
    assertEquals(
      CustodyResultKind.COMMITTED,
      queue.admitObject(fixture.bytes, ObjectKind.RESPONDER_RECEIPT, fixture.context).kind,
    )

    val lease = queue.leaseContactWork("deadline-peer", now + 1_000L, maxObjects = 1).single()
    assertThrows(IllegalStateException::class.java) {
      queue.finishTransfer(lease.leaseId, TransferOutcome.PEER_CUSTODY, lease.leaseUntilMs)
    }
    assertEquals(
      "EXPIRED",
      db.readableDatabase.rawQuery(
        "SELECT state FROM relay_transfer_leases WHERE lease_id=?",
        arrayOf(lease.leaseId),
      ).use { cursor ->
        assertTrue(cursor.moveToFirst())
        cursor.getString(0)
      },
    )
  }

  @Test
  fun defaultBudgetsMatchApprovedPilotLimits() {
    val limits = ReceiptQueueLimits()
    assertEquals(10_000, limits.activeObjects)
    assertEquals(64L * 1024L * 1024L, limits.activeBytes)
    assertEquals(128, limits.quarantineObjects)
    assertEquals(1L * 1024L * 1024L, limits.quarantineBytes)
    assertEquals(100_000, limits.tombstoneObjects)
    assertEquals(8L * 1024L * 1024L, limits.tombstoneBytes)
    assertEquals(7L * 24L * 60L * 60L * 1000L, ReceiptQueueLimits.RELAY_RETENTION_MS)
    assertEquals(7L * 24L * 60L * 60L * 1000L, ReceiptQueueLimits.REPLAY_RETENTION_MS)
  }

  private data class ReceiptFixture(
    val bytes: ByteArray,
    val eventId: String,
    val context: VerificationContext,
  )

  private fun receiptFixture(
    db: SagipDatabase,
    reportId: String,
    origin: SigningIdentity,
    responder: SigningIdentity,
    actionId: String = UUID.randomUUID().toString(),
    note: String = "Acknowledged",
    sequence: Long = 1L,
    expiresAt: Long = now + ReceiptQueueLimits.RELAY_RETENTION_MS,
    recordEnvelope: Boolean = true,
  ): ReceiptFixture {
    val envelope = createEnvelope(reportId, 1, origin)
    if (recordEnvelope) ReceiptRepository(db).recordReportEnvelope(envelope, now)
    val decoded = TransportEnvelopeV1.decode(envelope)
    val report = ReportIdentity(
      reportId = reportId,
      reportProtocolVersion = 1,
      revision = 1,
      payloadDigest = decoded.payloadDigest,
      originKeyId = decoded.originKeyId,
      originPublicKeyDer = decoded.originPublicKeyDer,
    )
    val grantId = "00000000-0000-0000-0000-000000000000"
    val draft = ReceiptFields.Responder(
      providerKind = 1,
      issuerProviderId = ReceiptAuthority.issuerProviderId(1, responder.keyId, grantId),
      actionId = actionId,
      actionDigest = ByteArray(32),
      reportId = reportId,
      reportProtocolVersion = 1,
      revision = 1,
      payloadDigest = decoded.payloadDigest,
      originKeyId = decoded.originKeyId,
      issuerKeyId = responder.keyId,
      grantId = grantId,
      responderId = "11111111-1111-4111-8111-111111111111",
      callsign = "TAGUM-1",
      observedIncidentVersion = 1,
      status = 1,
      sequence = sequence,
      issuedAtMs = now,
      forwardingExpiresAtMs = expiresAt,
      note = note,
    )
    val fields = draft.copy(actionDigest = ReceiptAuthority.actionDigest(draft))
    val bytes = signReceipt(fields, responder)
    return ReceiptFixture(
      bytes = bytes,
      eventId = actionId,
      context = VerificationContext(
        roots = mapOf(hex(responder.keyId) to responder.publicKeyDer),
        revokedGrants = emptySet(),
        allowedScopes = emptySet(),
        trustedTime = TimeInterval(now, now + 10L),
        authorityCheckedAtMs = now,
        currentAuthorityChecked = true,
        report = report,
        pairedTimeProviderId = null,
      ),
    )
  }

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
    var value = 0
    repeat(count) { value = (value shl 8) or (bytes[offset + 1 + it].toInt() and 0xff) }
    return value to (count + 1)
  }

  private fun scalar32(value: BigInteger): ByteArray {
    val source = value.toByteArray()
    val raw = if (source.size == 33 && source[0] == 0.toByte()) source.copyOfRange(1, 33) else source
    return ByteArray(32 - raw.size) + raw
  }

  private fun emptyContext(time: TimeInterval?): VerificationContext = VerificationContext(
    roots = emptyMap(),
    revokedGrants = emptySet(),
    allowedScopes = emptySet(),
    trustedTime = time,
    authorityCheckedAtMs = null,
    currentAuthorityChecked = false,
    report = null,
    pairedTimeProviderId = null,
  )

  private fun countRows(db: SagipDatabase, table: String): Int =
    db.readableDatabase.rawQuery("SELECT COUNT(*) FROM $table", null).use { cursor ->
      cursor.moveToFirst()
      cursor.getInt(0)
    }

  private fun hasQuarantineDigest(db: SagipDatabase, digest: ByteArray): Boolean =
    db.readableDatabase.rawQuery(
      "SELECT 1 FROM receipt_quarantine WHERE lower(hex(object_digest))=? LIMIT 1",
      arrayOf(hex(digest)),
    ).use { cursor -> cursor.moveToFirst() }

  private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
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
}
