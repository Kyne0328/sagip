package com.sagip.survival

/**
 * Pure latency policy shared by BLE controllers and unit tests.
 *
 * These values intentionally shorten radio stalls without changing custody,
 * protocol framing, persistence, or retry/idempotency semantics.
 */
object BleRelayLatencyPolicy {
  const val MAX_ACTIVE_OUTGOING_CONNECTIONS = 2
  const val PEER_RETRY_INTERVAL_MS = 5_000L
  const val CONNECT_TIMEOUT_MS = 12_000L
  const val SERVICE_SETUP_TIMEOUT_MS = 10_000L
  const val SERVICE_DISCOVERY_TIMEOUT_MS = 6_000L
  const val MTU_FALLBACK_MS = 1_500L
  const val TRANSFER_PROGRESS_TIMEOUT_MS = 10_000L
  const val DIRECT_TYPED_OFFER_THRESHOLD = 2
  const val CONTACT_ACTIVITY_PERSIST_INTERVAL_MS = 15_000L

  fun shouldPersistContactActivity(lastPersistedAtMs: Long?, nowMs: Long): Boolean {
    require(nowMs >= 0L) { "nowMs must not be negative" }
    if (lastPersistedAtMs == null) return true
    return nowMs < lastPersistedAtMs ||
      nowMs - lastPersistedAtMs >= CONTACT_ACTIVITY_PERSIST_INTERVAL_MS
  }

  fun shouldDirectOffer(page: InventoryPage?): Boolean =
    page != null &&
      page.entries.isNotEmpty() &&
      page.entries.size <= DIRECT_TYPED_OFFER_THRESHOLD &&
      page.nextCursor == null
}
