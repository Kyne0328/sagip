package com.sagip.survival

import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.yield
import org.junit.Assert.*
import org.junit.Test

class LocationDeliveryDispatcherTest {
  @Test fun passCutoffStaysCoherentWhenClockAdvancesDuringLocationRead() {
    val passTime = 1_000L
    var wallTime = passTime
    var newNextAttempt: Long? = null
    val existingBackoff = passTime + 10_000L
    val location = LocationSnapshot(7.4471, 125.8078, 8.0, passTime, "GPS", "FRESH")
    assertTrue(attachLocationForDelivery(passTime, { freshnessTime ->
      assertEquals(passTime, freshnessTime)
      wallTime++ // Old code would have used this later wall time for the insertion.
      location
    }, { selected, commitTime ->
      assertEquals(location, selected)
      newNextAttempt = commitTime
      true
    }))
    assertEquals(passTime + 1, wallTime)
    assertTrue(requireNotNull(newNextAttempt) <= passTime)
    assertFalse(existingBackoff <= passTime)
    assertEquals(location.capturedAt, passTime)
  }

  @Test fun lateFixSurvivesBridgeExecutorShutdownAndQueuesOfflinePersistence() = runBlocking {
    val bridgeExecutor = Executors.newSingleThreadExecutor()
    var callback: (() -> Unit)? = null
    var persisted = 0
    var queued = 0
    val dispatcher = LocationDeliveryDispatcher(this, { callback = it; true }) {
      persisted++
      queued++
      // Simulate unavailable transport after durable attachment/preparation.
      throw IllegalStateException("OFFLINE")
    }
    assertTrue(dispatcher.primeLocation())
    // This is the executor lifetime ended by SagipSurvivalCoreModule.invalidate().
    bridgeExecutor.shutdown()
    assertThrows(RejectedExecutionException::class.java) { bridgeExecutor.execute {} }
    requireNotNull(callback).invoke()
    yield()
    assertEquals(1, persisted)
    assertEquals(1, queued)
    // Failure in one pass must not cancel the process scope or lose another fix.
    requireNotNull(callback).invoke()
    yield()
    assertEquals(2, persisted)
  }

  @Test fun fixArrivingDuringDeliveryGetsAnotherSerializedPass() = runBlocking {
    val release = CompletableDeferred<Unit>()
    val mutex = Mutex()
    var callback: (() -> Unit)? = null
    var passes = 0
    val dispatcher = LocationDeliveryDispatcher(this, { callback = it; true }) {
      mutex.withLock {
        passes++
        if (passes == 1) release.await()
      }
    }
    assertTrue(dispatcher.primeLocation())
    requireNotNull(callback).invoke()
    yield()
    assertEquals(1, passes)
    requireNotNull(callback).invoke()
    yield()
    assertEquals(1, passes)
    release.complete(Unit)
    yield()
    yield()
    assertEquals(2, passes)
  }

  @Test fun deniedOrUnavailableLocationDoesNotDispatchOrThrow() = runBlocking {
    var passes = 0
    val dispatcher = LocationDeliveryDispatcher(this, { false }) { passes++ }
    assertFalse(dispatcher.primeLocation())
    yield()
    assertEquals(0, passes)
  }
}
