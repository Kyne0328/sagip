package com.sagip.survival

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.*
import org.junit.Test

class StatusSyncDispatcherTest {
  @Test fun stalledStatusDoesNotDelayFurtherDeliveryAndRemainsSingleFlight() = runBlocking {
    val release = CompletableDeferred<Unit>()
    var requests = 0
    var deliveryPasses = 0
    val dispatcher = StatusSyncDispatcher(this) { requests++;release.await() }
    fun deliver() { deliveryPasses++;dispatcher.trigger() }
    deliver()
    yield()
    assertEquals(1,requests)
    // A second delivery pass returns while the first history request is still stalled.
    deliver()
    assertEquals(2,deliveryPasses)
    assertEquals(1,requests)
    release.complete(Unit)
    yield()
    assertTrue(dispatcher.trigger())
    yield()
    assertEquals(2,requests)
  }
}
