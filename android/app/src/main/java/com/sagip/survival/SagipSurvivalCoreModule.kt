package com.sagip.survival

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.Executors
import kotlinx.coroutines.runBlocking

class SagipSurvivalCoreModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  private val database = SagipDatabase(reactContext.applicationContext)
  private val repository = EmergencyRepository(database)
  private val locationProvider = LocationSnapshotProvider(reactContext.applicationContext)
  private val preparationService by lazy {
    EnvelopePreparationService(repository, AndroidKeystoreSigningIdentity())
  }
  private val executor = Executors.newSingleThreadExecutor()
  private val sender by lazy {
    HttpEnvelopeSender()
  }
  private val deliveryWorker by lazy {
    DeliveryWorker(repository, sender)
  }
  private val connectivityMonitor by lazy {
    NetworkConnectivityMonitor(reactContext.applicationContext) {
      triggerBackgroundDelivery()
    }
  }
  private val blePeripheral by lazy {
    BlePeripheralManager(reactContext.applicationContext, repository)
  }
  private val bleCentral by lazy {
    BleCentralManager(reactContext.applicationContext, repository)
  }

  init {
    connectivityMonitor.startListening()
    blePeripheral.start()
    bleCentral.startScanning()
  }

  override fun invalidate() {
    super.invalidate()
    connectivityMonitor.stopListening()
    blePeripheral.stop()
    bleCentral.stopScanning()
    executor.shutdown()
  }

  private fun triggerBackgroundDelivery() {
    executor.execute {
      try {
        preparationService.preparePending()
        runBlocking { deliveryWorker.runOnce() }
      } catch (_: Exception) {
      }
    }
  }

  override fun getName() = NAME

  @ReactMethod
  fun triggerDelivery(promise: Promise) {
    executor.execute {
      try {
        preparationService.preparePending()
        val completed = runBlocking { deliveryWorker.runOnce() }
        promise.resolve(completed)
      } catch (_: Exception) {
        promise.resolve(0)
      }
    }
  }

  @ReactMethod
  fun getRelayStatus(promise: Promise) {
    val map = Arguments.createMap().apply {
      putBoolean("isScanning", bleCentral.isScanning())
      putBoolean("isAdvertising", blePeripheral.isRunning())
      putInt("peerCount", bleCentral.getDiscoveredPeerCount())
    }
    promise.resolve(map)
  }

  @ReactMethod
  fun startBleRelay(promise: Promise) {
    blePeripheral.start()
    bleCentral.startScanning()
    promise.resolve(true)
  }

  @ReactMethod
  fun stopBleRelay(promise: Promise) {
    blePeripheral.stop()
    bleCentral.stopScanning()
    promise.resolve(true)
  }

  @ReactMethod
  fun createEmergencyReport(input: ReadableMap, promise: Promise) {
    val parsed = runCatching { parseInput(input) }.getOrElse {
      promise.reject(ERROR_INVALID_INPUT, "Emergency type or urgency is invalid")
      return
    }

    val committed = try {
      val location = locationProvider.getBestAvailableLocation()
      repository.createReport(parsed, location)
    } catch (_: Exception) {
      promise.reject(ERROR_PERSISTENCE_FAILED, "The SOS could not be saved on this device")
      return
    }

    val result = BestEffortPreparation.afterCommit(committed) {
      preparationService.preparePending()
    }
    triggerBackgroundDelivery()
    promise.resolve(toWritableMap(result))
  }

  @ReactMethod
  fun listEmergencyReports(promise: Promise) {
    BestEffortPreparation.afterCommit(Unit) {
      preparationService.preparePending()
    }

    try {
      val result = Arguments.createArray()
      repository.listReports().forEach { result.pushMap(toWritableMap(it)) }
      promise.resolve(result)
    } catch (_: Exception) {
      promise.reject(ERROR_PERSISTENCE_FAILED, "Saved SOS reports could not be loaded")
    }
  }

  internal fun parseInput(input: ReadableMap): CreateEmergencyReportInput {
    val emergencyType = EmergencyType.valueOf(input.getString("emergencyType") ?: error("missing emergencyType"))
    val urgency = Urgency.valueOf(input.getString("urgency") ?: error("missing urgency"))
    return CreateEmergencyReportInput(emergencyType, urgency)
  }

  internal fun toWritableMap(summary: EmergencyReportSummary): WritableMap {
    return Arguments.createMap().apply {
      putString("reportId", summary.reportId)
      putDouble("createdAt", summary.createdAt.toDouble())
      putString("emergencyType", summary.emergencyType.name)
      putString("urgency", summary.urgency.name)
      putString("lifecycleState", summary.lifecycleState)
      putString("deliveryState", summary.deliveryState)
      if (summary.location == null) {
        putNull("location")
      } else {
        putMap(
          "location",
          Arguments.createMap().apply {
            putDouble("latitude", summary.location.latitude)
            putDouble("longitude", summary.location.longitude)
            summary.location.accuracyMeters?.let { putDouble("accuracyMeters", it) } ?: putNull("accuracyMeters")
            putDouble("capturedAt", summary.location.capturedAt.toDouble())
            putString("source", summary.location.source)
            putString("freshness", summary.location.freshness)
          },
        )
      }
      if (summary.responderAck == null) {
        putNull("responderAck")
      } else {
        putMap(
          "responderAck",
          Arguments.createMap().apply {
            putString("ackId", summary.responderAck.ackId)
            putString("responderId", summary.responderAck.responderId)
            summary.responderAck.callsign?.let { putString("callsign", it) } ?: putNull("callsign")
            putString("status", summary.responderAck.status)
            summary.responderAck.note?.let { putString("note", it) } ?: putNull("note")
            putDouble("acknowledgedAt", summary.responderAck.acknowledgedAt.toDouble())
          },
        )
      }
    }
  }

  companion object {
    const val NAME = "SagipSurvivalCore"
    const val ERROR_INVALID_INPUT = "INVALID_INPUT"
    const val ERROR_PERSISTENCE_FAILED = "PERSISTENCE_FAILED"
  }
}
