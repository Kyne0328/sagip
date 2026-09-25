package com.sagip.survival

import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

interface BleCentralController {
  fun startScanning(scanMode: Int)
  fun pauseScanning()
  fun stopScanning()
  fun isScanning(): Boolean
  fun getDiscoveredPeerCount(): Int
}

interface BlePeripheralController {
  fun start(advertiseMode: Int)
  fun pauseAdvertising()
  fun stop()
  fun isRunning(): Boolean
}

data class BleRelayRuntimeStatus(
  val readiness: BleRelayReadiness,
  val isScanning: Boolean,
  val isAdvertising: Boolean,
  val peerCount: Int,
  val isDutyCyclePaused: Boolean,
)

/**
 * Process-local owner of the BLE transport objects.
 *
 * React Native and the foreground service both talk to this same instance so
 * React bridge teardown cannot accidentally tear down an active emergency
 * relay. Durable custody and delivery state remain in SQLite.
 */
class BleRelayRuntime internal constructor(
  private val readinessProvider: () -> BleRelayReadiness,
  private val activityTimestampProvider: () -> Long,
  private val central: BleCentralController,
  private val peripheral: BlePeripheralController,
) {
  private val scheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
    Thread(runnable, "sagip-ble-duty-cycle").apply { isDaemon = true }
  }
  private var requested = false
  private var dutyCyclePaused = false
  private var scheduledTransition: ScheduledFuture<*>? = null

  @Synchronized
  fun start(): Boolean {
    val readiness = readinessProvider()
    if (!readiness.canRun) {
      stop()
      return false
    }
    if (requested) {
      if (dutyCyclePaused || (central.isScanning() && peripheral.isRunning())) {
        return true
      }
      scheduledTransition?.cancel(false)
      scheduledTransition = null
      return activateCycleLocked()
    }

    requested = true
    return activateCycleLocked()
  }

  @Synchronized
  fun expediteForNewActivity() {
    if (!requested || !readinessProvider().canRun) return
    scheduledTransition?.cancel(false)
    scheduledTransition = null
    activateCycleLocked()
  }

  @Synchronized
  fun stop() {
    requested = false
    dutyCyclePaused = false
    scheduledTransition?.cancel(false)
    scheduledTransition = null
    runCatching { central.stopScanning() }
    runCatching { peripheral.stop() }
  }

  @Synchronized
  fun status(): BleRelayRuntimeStatus {
    val readiness = readinessProvider()
    val canRun = readiness.canRun
    if (!canRun) {
      stop()
    }
    return BleRelayRuntimeStatus(
      readiness = readiness,
      isScanning = canRun && central.isScanning(),
      isAdvertising = canRun && peripheral.isRunning(),
      peerCount = if (canRun) central.getDiscoveredPeerCount() else 0,
      isDutyCyclePaused = canRun && requested && dutyCyclePaused,
    )
  }

  private fun activateCycleLocked(): Boolean {
    val readiness = readinessProvider()
    if (!requested || !readiness.canRun) {
      stop()
      return false
    }

    val now = System.currentTimeMillis()
    val activityTimestamp = activityTimestampProvider()
    val scanMode = BleDutyCycleManager.getRecommendedScanMode(activityTimestamp, now)
    val advertiseMode = BleDutyCycleManager.getRecommendedAdvertiseMode(activityTimestamp, now)
    val (activeMs, pauseMs) = BleDutyCycleManager.getScanDutyCycleMs(activityTimestamp, now)

    return runCatching {
      dutyCyclePaused = false
      peripheral.start(advertiseMode)
      central.startScanning(scanMode)
      scheduleActiveWindowEnd(activeMs, pauseMs)
      true
    }.getOrElse {
      stop()
      false
    }
  }

  private fun scheduleActiveWindowEnd(activeMs: Long, pauseMs: Long) {
    scheduledTransition?.cancel(false)
    val delayMs = if (pauseMs == 0L) {
      minOf(activeMs, PROFILE_REEVALUATION_MS)
    } else {
      activeMs
    }
    scheduledTransition = scheduler.schedule(
      { onActiveWindowEnded(pauseMs) },
      delayMs,
      TimeUnit.MILLISECONDS,
    )
  }

  @Synchronized
  private fun onActiveWindowEnded(previousPauseMs: Long) {
    if (!requested) return
    if (!readinessProvider().canRun) {
      stop()
      return
    }

    val now = System.currentTimeMillis()
    val activityTimestamp = activityTimestampProvider()
    val (_, currentPauseMs) = BleDutyCycleManager.getScanDutyCycleMs(activityTimestamp, now)
    if (currentPauseMs == 0L) {
      activateCycleLocked()
      return
    }

    runCatching { central.pauseScanning() }
    runCatching { peripheral.pauseAdvertising() }
    dutyCyclePaused = true
    scheduledTransition = scheduler.schedule(
      { resumeAfterPause() },
      if (previousPauseMs == 0L) currentPauseMs else minOf(previousPauseMs, currentPauseMs),
      TimeUnit.MILLISECONDS,
    )
  }

  @Synchronized
  private fun resumeAfterPause() {
    if (!requested) return
    activateCycleLocked()
  }

  companion object {
    private const val PROFILE_REEVALUATION_MS = 60_000L
  }
}
