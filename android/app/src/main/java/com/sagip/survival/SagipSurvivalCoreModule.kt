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
  private val victimStatusStore = VictimStatusStore(database)
  private val locationProvider = runtime.locationProvider
  private val preparationService by lazy {
    EnvelopePreparationService(repository, AndroidKeystoreSigningIdentity())
  }
  private val executor = Executors.newSingleThreadExecutor()
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
      runCatching { runBlocking { runtime.runDeliveryPass() } }
    }
  }

  override fun getName() = NAME

  @ReactMethod
  fun triggerDelivery(promise: Promise) {
    executor.execute {
      try {
        promise.resolve(runBlocking { runtime.runDeliveryPass() })
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
  fun primeLocation(promise: Promise) {
    // Provider callbacks outlive this React bridge and must use the process-owned scope.
    promise.resolve(runtime.primeLocation())
  }

  @ReactMethod
  fun createEmergencyReport(input: ReadableMap, promise: Promise) {
    val parsed = runCatching { parseInput(input) }.getOrElse {
      promise.reject(ERROR_INVALID_INPUT, "Emergency type or urgency is invalid")
      return
    }

    val committed = try {
      // Last-known data only. Location/permission/provider failures cannot block saving SOS.
      val location = runCatching { locationProvider.getBestAvailableLocation() }.getOrNull()
      repository.createReport(parsed, location)
    } catch (_: Exception) {
      promise.reject(ERROR_PERSISTENCE_FAILED, "The SOS could not be saved on this device")
      return
    }

    // Only the durable transaction is on the success path. Signing/network/relay are retriable.
    promise.resolve(toWritableMap(committed))
    dispatchCommittedReport()
  }

  @ReactMethod
  fun newEmergencyDetailsOperationId(promise: Promise) {
    promise.resolve(java.util.UUID.randomUUID().toString())
  }

  @ReactMethod
  fun appendEmergencyReportDetails(reportId: String, input: ReadableMap, promise: Promise) {
    val parsed = try {
      EmergencyBridgeInput.parseDetails(reportId, input)
    } catch (failure: EmergencyDetailsException) {
      promise.reject(failure.code, failure.message)
      return
    } catch (_: Exception) {
      promise.reject(ERROR_INVALID_INPUT, "Optional SOS details are invalid")
      return
    }
    val committed = try {
      repository.appendEmergencyDetails(parsed)
    } catch (failure: EmergencyDetailsException) {
      promise.reject(failure.code, failure.message)
      return
    } catch (_: Exception) {
      promise.reject(ERROR_PERSISTENCE_FAILED, "The optional details could not be saved on this device")
      return
    }
    // A repeated operation can refer to an older revision. Return the current snapshot.
    val latest = runCatching { repository.getReportSummary(reportId) }.getOrDefault(committed)
    promise.resolve(toWritableMap(latest))
    dispatchCommittedReport()
  }

  private fun dispatchCommittedReport() {
    runCatching { EmergencyJobScheduler.scheduleNetworkSync(reactApplicationContext.applicationContext) }
    runCatching {
      executor.execute {
        runCatching { preparationService.preparePending() }
        runCatching {
          if (EmergencyRelayService.start(reactApplicationContext.applicationContext)) {
            runtime.bleRelay.start()
          }
          runtime.bleRelay.expediteForNewActivity()
        }
        runCatching { runBlocking { runtime.runDeliveryPass() } }
      }
    }
  }

  @ReactMethod
  fun claimVerifiedReceiptNotification(reportId: String, eventId: String, promise: Promise) {
    executor.execute {
      try {
        val snapshot=database.readableDatabase.rawQuery(
          "SELECT 1 FROM receipt_records WHERE report_id=? AND event_id=? AND verification_kind='VERIFIED_OFFLINE_ROOT_SNAPSHOT'",
          arrayOf(reportId,eventId),
        ).use { it.moveToFirst() }
        if(snapshot && runtime.receiptReturn?.offlineEvidenceState(eventId)!="VALID_AT_LAST_CHECK") {
          promise.resolve(false)
        } else promise.resolve(receiptRepository.claimVerifiedReceiptNotification(reportId, eventId))
      } catch (_: IllegalArgumentException) {
        promise.reject(ERROR_INVALID_INPUT, "Report or receipt event ID is invalid")
      } catch (_: Exception) {
        promise.reject(ERROR_PERSISTENCE_FAILED, "Verified receipt notification state could not be updated")
      }
    }
  }

  @ReactMethod
  fun listEmergencyReports(promise: Promise) {
    try {
      val result = Arguments.createArray()
      repository.listReports().forEach { result.pushMap(toWritableMap(withVerifiedReceipt(it))) }
      promise.resolve(result)
    } catch (_: Exception) {
      promise.reject(ERROR_PERSISTENCE_FAILED, "Saved SOS reports could not be loaded")
    }
  }

  private fun withVerifiedReceipt(inputSummary: EmergencyReportSummary): EmergencyReportSummary {
    val hold = database.readableDatabase.rawQuery(
      "SELECT 1 FROM receipt_projections WHERE report_id=? AND revision=? AND verification_kind='VERIFIED_OFFLINE_ROOT_SNAPSHOT' LIMIT 1",
      arrayOf(inputSummary.reportId,inputSummary.latestRevision.toString()),
    ).use { it.moveToFirst() }
    val summary = inputSummary.copy(offlineSnapshotClosureHold = hold)
    val projection = receiptRepository.projection(summary.reportId) ?: return summary
    if (projection.verificationKind !in VERIFIED_RECEIPT_KINDS) return summary
    if (projection.requesterDeliveryState !in REQUESTER_DELIVERY_STATES) return summary

    if (projection.revision != summary.latestRevision) return summary

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
        issuedAt = if(projection.verificationKind == OfflineRootSnapshotCodec.KIND) fields.issuedAtMs else null,
        authorityExpiresAt = if(projection.verificationKind == OfflineRootSnapshotCodec.KIND) database.readableDatabase.rawQuery(
          "SELECT MAX(expires_at_ms) FROM offline_root_evidence WHERE event_id=?", arrayOf(projection.eventId)
        ).use { if(it.moveToFirst() && !it.isNull(0)) it.getLong(0) else 0L } else null,
        offlineEvidenceState = if(projection.verificationKind == OfflineRootSnapshotCodec.KIND)
          runtime.receiptReturn?.offlineEvidenceState(projection.eventId) ?: "TIME_UNAVAILABLE" else null,
      ),
    )
  }

  internal fun parseInput(input: ReadableMap): CreateEmergencyReportInput = EmergencyBridgeInput.parseCreate(input)

  private fun deliveryMap(delivery: RevisionDeliverySummary): WritableMap = Arguments.createMap().apply {
    putInt("revision", delivery.revision)
    putString("messageId", delivery.messageId)
    putString("deliveryState", delivery.deliveryState)
  }

  internal fun toWritableMap(summary: EmergencyReportSummary): WritableMap {
    return Arguments.createMap().apply {
      val history = Arguments.createArray()
      victimStatusStore.history(summary.reportId).forEach { event ->
        history.pushMap(Arguments.createMap().apply {
          putString("id",event.id); putString("kind",event.kind); putDouble("occurredAt",event.occurredAt.toDouble())
          event.revision?.let { putInt("revision",it) } ?: putNull("revision")
          event.status?.let { putString("status",it) } ?: putNull("status")
          putString("provenance",event.provenance)
          event.callsign?.let { putString("callsign",it) } ?: putNull("callsign")
          event.note?.let { putString("note",it) } ?: putNull("note")
        })
      }
      putArray("history",history)
      val sync = victimStatusStore.syncState(summary.reportId)
      putMap("statusSync",Arguments.createMap().apply {
        sync.lastAttemptAt?.let { putDouble("lastAttemptAt",it.toDouble()) } ?: putNull("lastAttemptAt")
        sync.lastSuccessAt?.let { putDouble("lastSuccessAt",it.toDouble()) } ?: putNull("lastSuccessAt")
        putString("state",sync.state)
        putBoolean("historyPending",sync.historyPending)
      })
      victimStatusStore.serverStatus(summary.reportId)?.let { status ->
        putMap("serverStatus",Arguments.createMap().apply {
          putString("status",status.status); putNull("revision"); putString("statusScope","REPORT")
          putDouble("updatedAt",status.updatedAt.toDouble())
          status.callsign?.let { putString("callsign",it) } ?: putNull("callsign")
          status.note?.let { putString("note",it) } ?: putNull("note")
        })
      }
      putString("receiptReturnState", when {
        runtime.receiptReturn == null -> "DISABLED"
        runtime.receiptReturn?.baseContext() == null -> "WAITING_FOR_QUALIFICATION"
        else -> "READY"
      })
      putBoolean("providerConflict", victimStatusStore.providerConflict(summary.reportId, summary.latestRevision))
      putString("reportId", summary.reportId)
      putBoolean("offlineSnapshotClosureHold", summary.offlineSnapshotClosureHold)
      putDouble("createdAt", summary.createdAt.toDouble())
      putString("emergencyType", summary.emergencyType.name)
      putString("urgency", summary.urgency.name)
      putString("lifecycleState", summary.lifecycleState)
      putString("deliveryState", summary.deliveryState)
      putInt("revision", summary.latestRevision)
      putInt("latestRevision", summary.latestRevision)
      summary.message?.let { putString("message", it) } ?: putNull("message")
      summary.originalDelivery?.let { putMap("originalDelivery", deliveryMap(it)) }
      summary.latestDelivery?.let { putMap("latestDelivery", deliveryMap(it)) }
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
            receipt.issuedAt?.let { putDouble("issuedAt", it.toDouble()) }
            receipt.authorityExpiresAt?.let { putDouble("authorityExpiresAt", it.toDouble()) }
            receipt.offlineEvidenceState?.let { putString("offlineEvidenceState", it) }
          },
        )
      }
    }
  }

  companion object {
    private val VERIFIED_RECEIPT_KINDS = setOf("VERIFIED_CURRENT", "VERIFIED_OFFLINE_AUTHORITY", OfflineRootSnapshotCodec.KIND)
    private val REQUESTER_DELIVERY_STATES = setOf("UNKNOWN", "RECEIVED")
    const val NAME = "SagipSurvivalCore"
    const val ERROR_INVALID_INPUT = "INVALID_INPUT"
    const val ERROR_PERSISTENCE_FAILED = "PERSISTENCE_FAILED"
  }
}
