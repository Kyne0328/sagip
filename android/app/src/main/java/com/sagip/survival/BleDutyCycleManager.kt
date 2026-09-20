package com.sagip.survival

import android.bluetooth.le.ScanSettings

/**
 * Manages adaptive BLE scan and advertise duty cycles to preserve battery life
 * during prolonged disaster scenarios while maintaining rapid discovery immediately
 * following an emergency creation.
 */
object BleDutyCycleManager {
  const val URGENT_WINDOW_MS = 15 * 60 * 1000L       // First 15 minutes
  const val CONSERVE_WINDOW_MS = 24 * 60 * 60 * 1000L // 15 mins to 24 hours

  /**
   * Returns the recommended ScanSettings scan mode based on age of the newest emergency report.
   */
  fun getRecommendedScanMode(newestReportTimestamp: Long, now: Long = System.currentTimeMillis()): Int {
    if (newestReportTimestamp <= 0) {
      return ScanSettings.SCAN_MODE_LOW_POWER
    }
    val elapsed = maxOf(0L, now - newestReportTimestamp)
    return when {
      elapsed < URGENT_WINDOW_MS -> ScanSettings.SCAN_MODE_LOW_LATENCY
      elapsed < CONSERVE_WINDOW_MS -> ScanSettings.SCAN_MODE_BALANCED
      else -> ScanSettings.SCAN_MODE_LOW_POWER
    }
  }

  /**
   * Returns a Pair of (activeScanDurationMs, pauseDurationMs) for software duty cycling.
   */
  fun getScanDutyCycleMs(newestReportTimestamp: Long, now: Long = System.currentTimeMillis()): Pair<Long, Long> {
    if (newestReportTimestamp <= 0) {
      return Pair(5_000L, 115_000L) // 5s scan every 2 minutes
    }
    val elapsed = maxOf(0L, now - newestReportTimestamp)
    return when {
      elapsed < URGENT_WINDOW_MS -> Pair(15_000L, 0L)       // Continuous scan
      elapsed < CONSERVE_WINDOW_MS -> Pair(5_000L, 25_000L) // 5s scan every 30s
      else -> Pair(5_000L, 115_000L)                         // 5s scan every 120s
    }
  }
}
