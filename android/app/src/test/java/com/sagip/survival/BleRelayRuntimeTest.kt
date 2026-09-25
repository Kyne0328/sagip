package com.sagip.survival

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BleRelayRuntimeTest {
  private class FakeCentral : BleCentralController {
    var scanning = false
    var peers = 0
    var starts = 0
    var stops = 0
    var pauses = 0
    var lastScanMode: Int? = null

    override fun startScanning(scanMode: Int) {
      starts++
      lastScanMode = scanMode
      scanning = true
    }

    override fun pauseScanning() {
      pauses++
      scanning = false
    }

    override fun stopScanning() {
      stops++
      scanning = false
      peers = 0
    }

    override fun isScanning(): Boolean = scanning
    override fun getDiscoveredPeerCount(): Int = peers
  }

  private class FakePeripheral : BlePeripheralController {
    var running = false
    var starts = 0
    var stops = 0
    var pauses = 0
    var lastAdvertiseMode: Int? = null

    override fun start(advertiseMode: Int) {
      starts++
      lastAdvertiseMode = advertiseMode
      running = true
    }

    override fun pauseAdvertising() {
      pauses++
      running = false
    }

    override fun stop() {
      stops++
      running = false
    }

    override fun isRunning(): Boolean = running
  }

  private fun readiness(available: Boolean) = BleRelayReadiness(
    availability = if (available) BleRelayAvailability.READY else BleRelayAvailability.PERMISSION_REQUIRED,
    isSupported = true,
    permissionGranted = available,
    bluetoothEnabled = available,
  )

  @Test
  fun `ready runtime starts both BLE roles and reports authoritative transport state`() {
    var ready = true
    val central = FakeCentral()
    val peripheral = FakePeripheral()
    val runtime = BleRelayRuntime(
      readinessProvider = { readiness(ready) },
      activityTimestampProvider = { 0L },
      central = central,
      peripheral = peripheral,
    )

    assertTrue(runtime.start())
    central.peers = 2

    val status = runtime.status()
    assertTrue(status.isScanning)
    assertTrue(status.isAdvertising)
    assertEquals(2, status.peerCount)
    assertEquals(1, central.starts)
    assertEquals(1, peripheral.starts)
  }

  @Test
  fun `permission loss stops stale radios before reporting relay unavailable`() {
    var ready = true
    val central = FakeCentral()
    val peripheral = FakePeripheral()
    val runtime = BleRelayRuntime(
      readinessProvider = { readiness(ready) },
      activityTimestampProvider = { 0L },
      central = central,
      peripheral = peripheral,
    )

    assertTrue(runtime.start())
    ready = false

    assertFalse(runtime.start())
    val status = runtime.status()
    assertFalse(status.isScanning)
    assertFalse(status.isAdvertising)
    assertEquals(0, status.peerCount)
    assertTrue(central.stops > 0)
    assertTrue(peripheral.stops > 0)
  }

  @Test
  fun `start repairs an unexpectedly stopped radio instead of reporting stale success`() {
    val central = FakeCentral()
    val peripheral = FakePeripheral()
    val runtime = BleRelayRuntime(
      readinessProvider = { readiness(true) },
      activityTimestampProvider = { System.currentTimeMillis() },
      central = central,
      peripheral = peripheral,
    )

    assertTrue(runtime.start())
    central.scanning = false
    peripheral.running = false

    assertTrue(runtime.start())
    assertEquals(2, central.starts)
    assertEquals(2, peripheral.starts)
    assertTrue(runtime.status().isScanning)
    assertTrue(runtime.status().isAdvertising)
  }
}
