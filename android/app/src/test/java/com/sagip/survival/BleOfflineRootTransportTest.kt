package com.sagip.survival

import java.security.MessageDigest
import org.junit.Assert.*
import org.junit.Test

/** Deterministic framing and capability checks; this is not a radio/device test. */
class BleOfflineRootTransportTest {
  private val proofId = "11111111-1111-4111-8111-111111111111"
  private val reportId = "22222222-2222-4222-8222-222222222222"
  private val snapshotId = "33333333-3333-4333-8333-333333333333"

  @Test fun bundle_support_requires_its_own_capability_bit() {
    val legacy = BleReceiptExchangeCodec.decodeCapability(
      BleReceiptExchangeCodec.encodeCapability(BleReceiptExchangeCodec.LEGACY_OBJECT_MASK))
    val upgraded = BleReceiptExchangeCodec.decodeCapability(BleReceiptExchangeCodec.encodeCapability())
    assertEquals(7, legacy.objectMask)
    assertEquals(15, upgraded.objectMask)
    for (kind in listOf(ObjectKind.SOS, ObjectKind.RESPONDER_RECEIPT, ObjectKind.REQUESTER_RECEIPT)) {
      assertTrue(BleReceiptExchangeCodec.supportsObject(legacy.objectMask, kind))
    }
    assertFalse(BleReceiptExchangeCodec.supportsObject(legacy.objectMask, ObjectKind.OFFLINE_ROOT_BUNDLE))
    assertTrue(BleReceiptExchangeCodec.supportsObject(upgraded.objectMask, ObjectKind.OFFLINE_ROOT_BUNDLE))
    assertFalse(BleReceiptExchangeCodec.supportsObject(legacy.objectMask, ObjectKind.OFFLINE_ROOT_REVOCATION))
    assertTrue(BleReceiptExchangeCodec.supportsObject(upgraded.objectMask, ObjectKind.OFFLINE_ROOT_REVOCATION))
    assertThrows(IllegalArgumentException::class.java) {
      BleReceiptExchangeCodec.decodeCapability(BleReceiptExchangeCodec.encodeCapability().also { it[5] = 31 })
    }
  }

  @Test fun inventory_request_explicitly_negotiates_bundle_support_and_keeps_legacy_bytes() {
    val oldRequest = BleReceiptExchangeCodec.encodeInventoryRequest(BleInventoryRequest(null, 0))
    assertEquals(0, oldRequest[22].toInt())
    assertEquals(0, oldRequest[23].toInt())
    assertEquals(7, BleReceiptExchangeCodec.decodeInventoryRequest(oldRequest).objectMask)
    val newRequest = BleReceiptExchangeCodec.encodeInventoryRequest(BleInventoryRequest(null, 0, 15))
    assertEquals(8, newRequest[23].toInt())
    assertEquals(15, BleReceiptExchangeCodec.decodeInventoryRequest(newRequest).objectMask)
    assertThrows(IllegalArgumentException::class.java) {
      BleReceiptExchangeCodec.decodeInventoryRequest(newRequest.copyOf().also { it[23] = 9 })
    }
    assertThrows(IllegalArgumentException::class.java) {
      BleReceiptExchangeCodec.encodeInventoryRequest(BleInventoryRequest(null, 0, 8))
    }
  }

  @Test fun bundle_inventory_and_offer_bind_complete_transport_digest() {
    val bytes = opaqueBundle()
    val entry = entry(bytes)
    val page = InventoryPage(listOf(entry), null, snapshotId, 0, 1, null)
    val decoded = BleReceiptExchangeCodec.decodeInventory(BleReceiptExchangeCodec.encodeInventory(page)).entries.single()
    assertEquals(ObjectKind.OFFLINE_ROOT_BUNDLE, decoded.objectKind)
    assertEquals(proofId, decoded.objectId)
    assertArrayEquals(hash(bytes), decoded.digest)
    val offer = BleReceiptExchangeCodec.decodeObjectFrame(BleReceiptExchangeCodec.encodeOffer(entry, bytes.size))
    assertEquals(ObjectKind.OFFLINE_ROOT_BUNDLE, offer.entry.objectKind)
    assertEquals(9000L, offer.entry.forwardingExpiresAtMs)
    assertThrows(IllegalArgumentException::class.java) {
      BleReceiptExchangeCodec.encodeOffer(entry, BleReceiptExchangeCodec.MAX_OBJECT_BYTES + 1)
    }
  }

  @Test fun bundle_chunks_are_unchanged_across_two_durable_admissions() {
    val bytes = opaqueBundle()
    var stored: ByteArray? = null
    repeat(2) {
      val received = stored ?: bytes
      val receiver = BleReceiptExchangeReceiver(
        admit = { kind, payload ->
          assertEquals(ObjectKind.OFFLINE_ROOT_BUNDLE, kind)
          assertArrayEquals(bytes, payload)
          stored = payload.copyOf()
          CustodyResult(CustodyResultKind.COMMITTED, proofId, hash(payload))
        },
        nowProvider = { 1000L },
        receiptIdProvider = { snapshotId },
      )
      assertEquals(BleDecisionCode.ACCEPT_TRANSFER,
        receiver.beginOffer("peer", BleReceiptExchangeCodec.encodeOffer(entry(received), received.size)).decision)
      val chunks = BleReceiptExchangeCodec.encodeObjectChunks(received, 50)
      for (chunk in chunks.dropLast(1)) assertNull(receiver.addChunk("peer", chunk))
      assertEquals(BleCustodyCode.ACCEPTED_DURABLE, receiver.addChunk("peer", chunks.last())?.result)
    }
    assertArrayEquals(bytes, stored)
  }

  @Test fun bundle_tampering_never_reaches_durable_admission() {
    val bytes = opaqueBundle()
    var admissions = 0
    val receiver = BleReceiptExchangeReceiver(admit = { _, _ ->
      admissions++
      CustodyResult(CustodyResultKind.COMMITTED)
    })
    receiver.beginOffer("peer", BleReceiptExchangeCodec.encodeOffer(entry(bytes), bytes.size))
    val altered = bytes.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
    var result: BleCustodyResult? = null
    BleReceiptExchangeCodec.encodeObjectChunks(altered, 50).forEach { result = receiver.addChunk("peer", it) }
    assertEquals(BleCustodyCode.REJECTED, result?.result)
    assertEquals(0, admissions)
  }

  @Test fun unverified_bundle_never_gets_successful_custody() {
    val bytes = opaqueBundle()
    val receiver = BleReceiptExchangeReceiver(admit = { _, _ ->
      CustodyResult(CustodyResultKind.PENDING_VERIFICATION, proofId, hash(bytes), "POLICY_MISSING")
    })
    receiver.beginOffer("peer", BleReceiptExchangeCodec.encodeOffer(entry(bytes), bytes.size))
    var result: BleCustodyResult? = null
    BleReceiptExchangeCodec.encodeObjectChunks(bytes, 50).forEach { result = receiver.addChunk("peer", it) }
    assertEquals(BleCustodyCode.UNVERIFIED_AUTHORITY, result?.result)
    assertNull(result?.custodyReceiptId)
    assertNull(result?.acceptedAtMs)
  }

  @Test fun only_revocations_can_take_the_no_time_transport_path() {
    for (kind in ObjectKind.entries) {
      assertEquals(kind == ObjectKind.OFFLINE_ROOT_REVOCATION, BleReceiptExchangeCodec.canTransferWithoutTime(kind))
    }
  }

  @Test fun signed_revocation_transport_requires_authority_routing_and_four_kib_bound() {
    val bytes = "SOV1".toByteArray(Charsets.US_ASCII) + ByteArray(300) { it.toByte() }
    val entry = revocationEntry(bytes)
    val decoded = BleReceiptExchangeCodec.decodeObjectFrame(BleReceiptExchangeCodec.encodeOffer(entry, bytes.size)).entry
    assertEquals(ObjectKind.OFFLINE_ROOT_REVOCATION, decoded.objectKind)
    assertEquals(decoded.objectId, decoded.reportId)
    assertEquals(1, decoded.revision)
    assertEquals(1, decoded.reportProtocolVersion)
    assertEquals(9_007_199_254_740_991L, decoded.forwardingExpiresAtMs)
    assertThrows(IllegalArgumentException::class.java) { BleReceiptExchangeCodec.encodeOffer(entry.copy(reportId=reportId), bytes.size) }
    assertThrows(IllegalArgumentException::class.java) { BleReceiptExchangeCodec.encodeOffer(entry.copy(revision=2), bytes.size) }
    assertThrows(IllegalArgumentException::class.java) { BleReceiptExchangeCodec.encodeOffer(entry.copy(forwardingExpiresAtMs=9000L), bytes.size) }
    assertThrows(IllegalArgumentException::class.java) { BleReceiptExchangeCodec.encodeOffer(entry, 4097) }
  }

  @Test fun oversized_revocation_chunks_never_reach_signature_or_store_admission() {
    val bytes = ByteArray(4097) { it.toByte() }
    val receiver = BleReceiptExchangeReceiver(admit = { _, _ -> throw AssertionError("oversized revocation admitted") })
    val entry = revocationEntry(bytes)
    receiver.beginOffer("peer", BleReceiptExchangeCodec.encodeOffer(entry, 4096))
    var result: BleCustodyResult? = null
    BleReceiptExchangeCodec.encodeObjectChunks(bytes, 100).forEach { result = receiver.addChunk("peer", it) }
    assertEquals(BleCustodyCode.REJECTED, result?.result)
  }

  @Test fun new_snapshot_proof_ids_remain_separate_transport_objects() {
    val oldBytes = opaqueBundle()
    val newBytes = oldBytes.copyOf().also { it[it.lastIndex] = 42 }
    val first = entry(oldBytes)
    val refreshed = entry(newBytes).copy(objectId = "44444444-4444-4444-8444-444444444444")
    val page = InventoryPage(listOf(first, refreshed), null, snapshotId, 0, 2, null)
    val decoded = BleReceiptExchangeCodec.decodeInventory(BleReceiptExchangeCodec.encodeInventory(page))
    assertEquals(2, decoded.entries.size)
    assertNotEquals(decoded.entries[0].objectId, decoded.entries[1].objectId)
    assertEquals(decoded.entries[0].reportId, decoded.entries[1].reportId)
  }

  private fun revocationEntry(bytes: ByteArray) = InventoryEntry(
    ObjectKind.OFFLINE_ROOT_REVOCATION, proofId, hash(bytes), proofId, 1, 0L, 1, 9_007_199_254_740_991L,
  )

  private fun entry(bytes: ByteArray) = InventoryEntry(
    ObjectKind.OFFLINE_ROOT_BUNDLE, proofId, hash(bytes), reportId, 1, 1000L, 2, 9000L,
  )
  // The receiver is payload-opaque. Real SGA2/SOR1 validation belongs to the admission service.
  private fun opaqueBundle() = "SGB1".toByteArray(Charsets.US_ASCII) + ByteArray(296) { (it % 127).toByte() }
  private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
}
