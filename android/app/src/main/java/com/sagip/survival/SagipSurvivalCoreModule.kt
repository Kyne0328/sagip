package com.sagip.survival

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import java.security.MessageDigest
import java.util.concurrent.Executors
import kotlinx.coroutines.runBlocking

class SagipSurvivalCoreModule(
  reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  private val runtime = SurvivalCoreRuntime.get(reactContext.applicationContext)
  private val database = runtime.database
  private val repository = runtime.repository
  private val receiptRepository = ReceiptRepository(database)
  private val locationProvider = LocationSnapshotProvider(reactContext.applicationContext)
  private val preparationService by lazy {
    EnvelopePreparationService(repository, AndroidKeystoreSigningIdentity())
  }
  private val executor = Executors.newSingleThreadExecutor()
  private val sender by lazy {
    HttpEnvelopeSender(BackendEndpointConfig.envelopeUrl())
  }
  private val deliveryWorker by lazy {
    DeliveryWorker(repository, sender)
  }
  private val connectivityMonitor by lazy {
    NetworkConnectivityMonitor(reactContext.applicationContext) {
      triggerBackgroundDelivery()
    }
  }
  init {
    connectivityMonitor.startListening()
    runCatching {
      EmergencyJobScheduler.scheduleNetworkSync(reactContext.applicationContext)
    }
  }

  override fun invalidate() {
    super.invalidate()
    connectivityMonitor.stopListening()
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
    val status = runtime.bleRelay.status()
    val readiness = status.readiness
    if (!readiness.canRun) {
      runtime.bleRelay.stop()
      EmergencyRelayService.stop(reactApplicationContext.applicationContext)
    }
    val custody = repository.relayCustodyStatus()
    val map = Arguments.createMap().apply {
      putString("availability", readiness.availability.name)
      putBoolean("isSupported", readiness.isSupported)
      putBoolean("permissionGranted", readiness.permissionGranted)
      putBoolean("bluetoothEnabled", readiness.bluetoothEnabled)
      putBoolean("isScanning", status.isScanning)
      putBoolean("isAdvertising", status.isAdvertising)
      putBoolean("isDutyCyclePaused", status.isDutyCyclePaused)
      putInt("peerCount", status.peerCount)
      putInt("heldRelayCount", custody.heldCount)
      putInt("pendingForwardCount", custody.pendingForwardCount)
    }
    promise.resolve(map)
  }

  @ReactMethod
  fun startBleRelay(promise: Promise) {
    val readiness = BleRelayReadinessChecker.evaluate(reactApplicationContext.applicationContext)
    if (!readiness.canRun) {
      runtime.bleRelay.stop()
      promise.resolve(false)
      return
    }

    val serviceStarted = EmergencyRelayService.start(reactApplicationContext.applicationContext)
    val relayStarted = serviceStarted && runtime.bleRelay.start()
    if (!relayStarted) runtime.bleRelay.stop()
    promise.resolve(relayStarted)
  }

  @ReactMethod
  fun stopBleRelay(promise: Promise) {
    runtime.bleRelay.stop()
    EmergencyRelayService.stop(reactApplicationContext.applicationContext)
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
    runCatching {
      if (EmergencyRelayService.start(reactApplicationContext.applicationContext)) {
        runtime.bleRelay.start()
      }
    }
    runtime.bleRelay.expediteForNewActivity()
    triggerBackgroundDelivery()
    promise.resolve(toWritableMap(result))
  }

  @ReactMethod
  fun claimVerifiedReceiptNotification(reportId: String, eventId: String, promise: Promise) {
    executor.execute {
      try {
        promise.resolve(receiptRepository.claimVerifiedReceiptNotification(reportId, eventId))
      } catch (_: IllegalArgumentException) {
        promise.reject(ERROR_INVALID_INPUT, "Report or receipt event ID is invalid")
      } catch (_: Exception) {
        promise.reject(ERROR_PERSISTENCE_FAILED, "Verified receipt notification state could not be updated")
      }
    }
  }

  @ReactMethod
  fun listEmergencyReports(promise: Promise) {
    BestEffortPreparation.afterCommit(Unit) {
      preparationService.preparePending()
    }

    try {
      val result = Arguments.createArray()
      repository.listReports().forEach { result.pushMap(toWritableMap(withVerifiedReceipt(it))) }
      promise.resolve(result)
    } catch (_: Exception) {
      promise.reject(ERROR_PERSISTENCE_FAILED, "Saved SOS reports could not be loaded")
    }
  }

  private fun withVerifiedReceipt(summary: EmergencyReportSummary): EmergencyReportSummary {
    val projection = receiptRepository.projection(summary.reportId) ?: return summary
    if (projection.verificationKind !in VERIFIED_RECEIPT_KINDS) return summary
    if (projection.requesterDeliveryState !in REQUESTER_DELIVERY_STATES) return summary

    val currentRevision = database.readableDatabase.rawQuery(
      "SELECT revision FROM outbound_envelopes WHERE report_id=? LIMIT 1",
      arrayOf(summary.reportId),
    ).use { cursor -> if (cursor.moveToFirst()) cursor.getInt(0) else null } ?: return summary
    if (projection.revision != currentRevision) return summary

    val bytes = receiptRepository.getReceipt(projection.eventId) ?: return summary
    val fields = runCatching {
      ReceiptV2Codec.decode(bytes).fields as? ReceiptFields.Responder
    }.getOrNull() ?: return summary
    if (
      fields.actionId != projection.eventId ||
      fields.reportId != summary.reportId ||
      fields.revision != projection.revision ||
      fields.sequence != projection.sequence ||
      !MessageDigest.isEqual(fields.issuerProviderId, projection.issuerProviderId)
    ) return summary

    val status = when (fields.status) {
      1 -> "ACKNOWLEDGED"
      2 -> "EN_ROUTE"
      3 -> "ON_SCENE"
      4 -> "RESOLVED"
      else -> return summary
    }
    if (fields.callsign.isBlank()) return summary

    return summary.copy(
      verifiedReceipt = VerifiedReceiptSummary(
        eventId = projection.eventId,
        revision = projection.revision,
        verificationKind = projection.verificationKind,
        authorityCheckedAt = projection.authorityCheckedAtMs,
        status = status,
        callsign = fields.callsign,
        note = fields.note,
        requesterDeliveryState = projection.requesterDeliveryState,
      ),
    )
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
      summary.verifiedReceipt?.let { receipt ->
        putMap(
          "verifiedReceipt",
          Arguments.createMap().apply {
            putString("eventId", receipt.eventId)
            putInt("revision", receipt.revision)
            putString("verificationKind", receipt.verificationKind)
            receipt.authorityCheckedAt?.let { putDouble("authorityCheckedAt", it.toDouble()) }
              ?: putNull("authorityCheckedAt")
            putString("status", receipt.status)
            putString("callsign", receipt.callsign)
            putString("note", receipt.note)
            putString("requesterDeliveryState", receipt.requesterDeliveryState)
          },
        )
      }
    }
  }

  companion object {
    private val VERIFIED_RECEIPT_KINDS = setOf("VERIFIED_CURRENT", "VERIFIED_OFFLINE_AUTHORITY")
    private val REQUESTER_DELIVERY_STATES = setOf("UNKNOWN", "RECEIVED")
    const val NAME = "SagipSurvivalCore"
    const val ERROR_INVALID_INPUT = "INVALID_INPUT"
    const val ERROR_PERSISTENCE_FAILED = "PERSISTENCE_FAILED"
  }
}
