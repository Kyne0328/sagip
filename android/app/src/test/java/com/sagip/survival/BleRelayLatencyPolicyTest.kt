package com.sagip.survival

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BleRelayLatencyPolicyTest {
  @Test
  fun `contact activity persistence is throttled but clock rollback forces refresh`() {
    assertTrue(BleRelayLatencyPolicy.shouldPersistContactActivity(null, 1_000L))
    assertFalse(BleRelayLatencyPolicy.shouldPersistContactActivity(1_000L, 5_000L))
    assertTrue(
      BleRelayLatencyPolicy.shouldPersistContactActivity(
        1_000L,
        1_000L + BleRelayLatencyPolicy.CONTACT_ACTIVITY_PERSIST_INTERVAL_MS,
      ),
    )
    assertTrue(BleRelayLatencyPolicy.shouldPersistContactActivity(5_000L, 4_000L))
  }

  @Test
  fun `small complete inventory uses direct offer and larger inventory does not`() {
    fun entry(index: Int) = InventoryEntry(
      objectKind = ObjectKind.SOS,
      objectId = "00000000-0000-0000-0000-%012d".format(index + 1),
      digest = ByteArray(32) { index.toByte() },
      reportId = "10000000-0000-0000-0000-%012d".format(index + 1),
      revision = 1,
      custodyAcceptedAtMs = index.toLong(),
      reportProtocolVersion = 1,
      forwardingExpiresAtMs = 0L,
    )

    assertFalse(BleRelayLatencyPolicy.shouldDirectOffer(null))
    assertFalse(BleRelayLatencyPolicy.shouldDirectOffer(InventoryPage(emptyList(), null)))
    assertTrue(BleRelayLatencyPolicy.shouldDirectOffer(InventoryPage(listOf(entry(0)), null)))
    assertTrue(BleRelayLatencyPolicy.shouldDirectOffer(InventoryPage(listOf(entry(0), entry(1)), null)))
    assertFalse(
      BleRelayLatencyPolicy.shouldDirectOffer(
        InventoryPage(listOf(entry(0), entry(1)), "cursor-more"),
      ),
    )
  }

  @Test
  fun `latency budgets stay bounded for emergency relay`() {
    assertTrue(BleRelayLatencyPolicy.PEER_RETRY_INTERVAL_MS <= 5_000L)
    assertTrue(BleRelayLatencyPolicy.CONNECT_TIMEOUT_MS <= 12_000L)
    assertTrue(BleRelayLatencyPolicy.MTU_FALLBACK_MS <= 1_500L)
    assertTrue(BleRelayLatencyPolicy.TRANSFER_PROGRESS_TIMEOUT_MS <= 10_000L)
    assertTrue(BleRelayLatencyPolicy.MAX_ACTIVE_OUTGOING_CONNECTIONS in 1..2)
  }
}
