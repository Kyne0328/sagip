package com.sagip.survival

import android.bluetooth.le.ScanSettings
import org.junit.Assert.assertEquals
import org.junit.Test

class BleDutyCycleManagerTest {

  @Test
  fun `returns LOW_LATENCY during first 15 minutes after emergency creation`() {
    val now = 100_000_000L
    val reportTime = now - (5 * 60 * 1000L) // 5 minutes old

    val mode = BleDutyCycleManager.getRecommendedScanMode(reportTime, now)
    assertEquals(ScanSettings.SCAN_MODE_LOW_LATENCY, mode)

    val dutyCycle = BleDutyCycleManager.getScanDutyCycleMs(reportTime, now)
    assertEquals(15_000L, dutyCycle.first)
    assertEquals(0L, dutyCycle.second)
  }

  @Test
  fun `returns BALANCED during conserve window between 15 mins and 24 hours`() {
    val now = 100_000_000L
    val reportTime = now - (2 * 60 * 60 * 1000L) // 2 hours old

    val mode = BleDutyCycleManager.getRecommendedScanMode(reportTime, now)
    assertEquals(ScanSettings.SCAN_MODE_BALANCED, mode)

    val dutyCycle = BleDutyCycleManager.getScanDutyCycleMs(reportTime, now)
    assertEquals(5_000L, dutyCycle.first)
    assertEquals(25_000L, dutyCycle.second)
  }

  @Test
  fun `returns LOW_POWER during survival mode after 24 hours`() {
    val now = 100_000_000L
    val reportTime = now - (30 * 60 * 60 * 1000L) // 30 hours old

    val mode = BleDutyCycleManager.getRecommendedScanMode(reportTime, now)
    assertEquals(ScanSettings.SCAN_MODE_LOW_POWER, mode)

    val dutyCycle = BleDutyCycleManager.getScanDutyCycleMs(reportTime, now)
    assertEquals(5_000L, dutyCycle.first)
    assertEquals(115_000L, dutyCycle.second)
  }

  @Test
  fun `defaults to LOW_POWER when no active report exists`() {
    val mode = BleDutyCycleManager.getRecommendedScanMode(0L, System.currentTimeMillis())
    assertEquals(ScanSettings.SCAN_MODE_LOW_POWER, mode)

    val dutyCycle = BleDutyCycleManager.getScanDutyCycleMs(0L, System.currentTimeMillis())
    assertEquals(5_000L, dutyCycle.first)
    assertEquals(115_000L, dutyCycle.second)
  }
}
