package com.sagip.survival

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkConnectivityMonitorTest {
  @Test
  fun `initial state is not listening`() {
    val monitor = NetworkConnectivityMonitor(connectivityManager = null) {}
    assertFalse(monitor.isListening)
  }

  @Test
  fun `startListening updates isListening state and is idempotent`() {
    val monitor = NetworkConnectivityMonitor(connectivityManager = null) {}
    monitor.startListening()
    assertTrue(monitor.isListening)

    monitor.startListening()
    assertTrue(monitor.isListening)
  }

  @Test
  fun `stopListening resets isListening state and is idempotent`() {
    val monitor = NetworkConnectivityMonitor(connectivityManager = null) {}
    monitor.startListening()
    assertTrue(monitor.isListening)

    monitor.stopListening()
    assertFalse(monitor.isListening)

    monitor.stopListening()
    assertFalse(monitor.isListening)
  }

  @Test
  fun `isConnectedToInternet returns false when connectivity manager is missing`() {
    val monitor = NetworkConnectivityMonitor(connectivityManager = null) {}
    assertFalse(monitor.isConnectedToInternet())
  }

  @Test
  fun `handleNetworkAvailable triggers callback`() {
    var triggerCount = 0
    val monitor = NetworkConnectivityMonitor(connectivityManager = null) {
      triggerCount++
    }

    monitor.handleNetworkAvailable()
    assertEquals(1, triggerCount)
  }

  @Test
  fun `handleCapabilitiesChanged triggers callback only when internet capability is present`() {
    var triggerCount = 0
    val monitor = NetworkConnectivityMonitor(connectivityManager = null) {
      triggerCount++
    }

    monitor.handleCapabilitiesChanged(false)
    assertEquals(0, triggerCount)

    monitor.handleCapabilitiesChanged(true)
    assertEquals(1, triggerCount)
  }
}
