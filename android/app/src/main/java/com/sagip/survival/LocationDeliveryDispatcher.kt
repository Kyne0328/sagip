package com.sagip.survival

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** One cutoff owns location freshness, new outbox eligibility, and this delivery pass. */
internal fun attachLocationForDelivery(
  nowMs: Long,
  bestLocation: (Long) -> LocationSnapshot?,
  attach: (LocationSnapshot, Long) -> Boolean,
): Boolean = bestLocation(nowMs)?.let { attach(it, nowMs) } == true

/**
 * Owns provider callbacks for the process, not a React bridge.
 * Every improved fix queues a pass, including fixes received during an earlier pass.
 * The pass persists/prepares location even offline; durable outbox retry remains authoritative.
 */
internal class LocationDeliveryDispatcher(
  private val scope: CoroutineScope,
  private val prime: ((() -> Unit) -> Boolean),
  private val deliver: suspend () -> Unit,
) {
  fun primeLocation(): Boolean = prime {
    scope.launch { runCatching { deliver() } }
  }
}
