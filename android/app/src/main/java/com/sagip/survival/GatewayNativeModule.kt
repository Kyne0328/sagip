package com.sagip.survival

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import com.facebook.react.bridge.*
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors

/** Sensitive operations run off the UI thread and are independently checked by the native service. */
class GatewayNativeModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context), LifecycleEventListener {
  private val runtime get() = SurvivalCoreRuntime.get(context)
  private val executor = Executors.newSingleThreadExecutor()
  private var authentication: Promise? = null
  private var cancellation: CancellationSignal? = null
  private val activityListener = object : BaseActivityEventListener() {
    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
      if (requestCode == AUTH_REQUEST) finishAuthentication(resultCode == Activity.RESULT_OK)
    }
  }
  init { context.addActivityEventListener(activityListener); context.addLifecycleEventListener(this) }
  override fun getName() = "SagipGatewayCore"
  private fun finishAuthentication(accepted: Boolean) {
    val promise = authentication ?: return
    authentication = null; cancellation = null
    if (accepted) runtime.gatewayAccess.verifiedBySystem() else runtime.gatewayAccess.lock()
    if (accepted) runCatching { runtime.resumeGatewayServer() }
    promise.resolve(accepted && runtime.gatewayAccess.isAllowed())
  }
  @ReactMethod fun authenticate(promise: Promise) {
    context.runOnUiQueueThread {
      if (authentication != null) { promise.reject("AUTH_IN_PROGRESS", "Device verification is already open"); return@runOnUiQueueThread }
      val activity = context.currentActivity
      val guard = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
      if (activity == null || !guard.isDeviceSecure) { promise.resolve(false); return@runOnUiQueueThread }
      runtime.gatewayAccess.lock(); authentication = promise
      try {
        if (Build.VERSION.SDK_INT >= 30) {
          val signal = CancellationSignal(); cancellation = signal
          BiometricPrompt.Builder(activity).setTitle("Unlock SAGIP responder workspace")
            .setAllowedAuthenticators(android.hardware.biometrics.BiometricManager.Authenticators.DEVICE_CREDENTIAL)
            .build().authenticate(signal, activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
              override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) { finishAuthentication(true) }
              override fun onAuthenticationError(errorCode: Int, errString: CharSequence) { finishAuthentication(false) }
            })
        } else {
          val intent = guard.createConfirmDeviceCredentialIntent("SAGIP responder workspace", "Confirm device access")
          if (intent == null) finishAuthentication(false) else activity.startActivityForResult(intent, AUTH_REQUEST)
        }
      } catch (_: Exception) { finishAuthentication(false) }
    }
  }
  @ReactMethod fun lock(promise: Promise) { runtime.stopGatewayServer(); runtime.gatewayAccess.lock(); promise.resolve(null) }
  @ReactMethod fun newActionId(promise: Promise) { promise.resolve(UUID.randomUUID().toString()) }
  @ReactMethod fun exportProvisioningRequest(input: ReadableMap, promise: Promise) = operation(promise) {
    check(runtime.gatewayAccess.isAllowed())
    check(input.toHashMap().keys == setOf("grantId", "responderId", "callsign", "statusMask", "purposeMask", "scope"))
    val grantId = input.getString("grantId")!!; val responderId = input.getString("responderId")!!
    check(UUID.fromString(grantId).toString() == grantId && grantId != "00000000-0000-0000-0000-000000000000")
    check(UUID.fromString(responderId).toString() == responderId && responderId != "00000000-0000-0000-0000-000000000000")
    val statusMask = input.getDouble("statusMask"); val purposeMask = input.getDouble("purposeMask")
    check(statusMask == statusMask.toInt().toDouble() && statusMask.toInt() and 1 == 1 && statusMask.toInt() and 15.inv() == 0)
    check(purposeMask == purposeMask.toInt().toDouble() && purposeMask.toInt() and 1 == 1 && purposeMask.toInt() and 9.inv() == 0)
    val callsign = input.getString("callsign")!!; val scope = input.getString("scope")!!
    check(Regex("[A-Z0-9_-]{1,16}").matches(callsign) && Regex("[A-Z0-9_:-]{1,64}").matches(scope))
    val request = GatewaySigningIdentity().exportProvisioningRequest(grantId, responderId, callsign, statusMask.toInt(), purposeMask.toInt(), scope)
    fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it.toInt() and 255) }
    Arguments.createMap().apply {
      putString("requestId", request.requestId); putString("issuerKeyId", hex(request.issuerKeyId))
      putString("issuerPublicKeyDer", android.util.Base64.encodeToString(request.issuerPublicKeyDer, android.util.Base64.NO_WRAP))
      putString("issuerProviderId", hex(request.issuerProviderId)); putString("grantId", request.grantId)
      putString("responderId", request.responderId); putString("callsign", request.callsign)
      putInt("statusMask", request.statusMask); putInt("purposeMask", request.purposeMask); putString("scope", request.scope)
    }
  }
  private fun operation(promise: Promise, block: () -> Any?) {
    executor.execute { try { promise.resolve(block()) } catch (_: Exception) { promise.reject("GATEWAY_UNAVAILABLE", "Responder workspace unavailable or locked") } }
  }
  @ReactMethod fun status(promise: Promise) = operation(promise) {
    check(runtime.gatewayAccess.isAllowed())
    Arguments.createMap().apply { putBoolean("authorityReady", runtime.gateway.authorityReady()); putNull("callsign") }
  }
  @ReactMethod fun listGatewayIncidents(promise: Promise) = operation(promise) {
    Arguments.createArray().apply {
      runtime.gateway.listGatewayIncidents().forEach { incident -> pushMap(Arguments.createMap().apply {
        putString("reportId", incident.identity.reportId); putInt("revision", incident.identity.revision)
        putString("observedIncidentVersion", incident.observedIncidentVersion.toString())
        putString("emergencyType", incident.emergencyType.name); putString("urgency", incident.urgency.name)
        putArray("pendingActions", Arguments.createArray().apply {
          incident.pendingActions.forEach { action -> pushMap(Arguments.createMap().apply {
            putString("actionId", action.actionId); putString("reportId", action.reportId)
            putString("observedIncidentVersion", action.observedIncidentVersion.toString())
            putInt("status", action.status); putString("note", action.note)
          }) }
        })
        val location = incident.location
        if (location == null) putNull("location") else putMap("location", Arguments.createMap().apply {
          putDouble("latitude", location.latitude); putDouble("longitude", location.longitude)
        })
        putArray("timeline", Arguments.createArray().apply {
          incident.receiptTimeline.forEach { bytes ->
            val receipt = ReceiptV2Codec.decode(bytes).fields
            if (receipt is ReceiptFields.Responder) pushMap(Arguments.createMap().apply {
              putString("eventId", receipt.actionId); putString("callsign", receipt.callsign); putInt("status", receipt.status)
              putString("note", receipt.note); putInt("revision", receipt.revision)
            })
          }
        })
      }) }
    }
  }
  private fun resultMap(result: ActionCommitResult) = Arguments.createMap().apply {
    putString("actionId", result.actionId); putString("state", result.state.name)
    putString("reason", result.reason)
    if (result.bytes == null) putNull("eventDigest") else putString("eventDigest", MessageDigest.getInstance("SHA-256").digest(result.bytes).joinToString("") { "%02x".format(it.toInt() and 255) })
  }
  @ReactMethod fun recordGatewayAction(input: ReadableMap, promise: Promise) = operation(promise) {
    check(input.toHashMap().keys == setOf("actionId", "reportId", "observedIncidentVersion", "status", "note"))
    val version = input.getString("observedIncidentVersion") ?: error("INVALID_FIELDS")
    check(Regex("0|[1-9][0-9]{0,15}").matches(version))
    val status = input.getDouble("status"); check(status.isFinite() && status == status.toInt().toDouble())
    resultMap(runtime.gateway.recordGatewayAction(ActionIntent(input.getString("actionId")!!,
      input.getString("reportId")!!, version.toLong(), status.toInt(), input.getString("note") ?: "")))
  }
  @ReactMethod fun getGatewayAction(actionId: String, promise: Promise) = operation(promise) { resultMap(runtime.gateway.getGatewayAction(actionId)) }
  private fun signedBytes(value: String): ByteArray {
    check(value.length <= 10924)
    val bytes = android.util.Base64.decode(value, android.util.Base64.NO_WRAP)
    check(bytes.size in 1..8192 && android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP) == value)
    return bytes
  }
  @ReactMethod fun provisionGrant(bytesBase64: String, promise: Promise) = operation(promise) {
    val result = runtime.gateway.provisionGrant(signedBytes(bytesBase64))
    Arguments.createMap().apply { putString("state", result.state); putString("reason", result.reason) }
  }
  @ReactMethod fun beginAuthorityTimeChallenge(promise: Promise) = operation(promise) {
    val challenge = runtime.gateway.beginAuthorityTimeChallenge()
    Arguments.createMap().apply {
      putString("challengeId", challenge.id)
      putString("verifierId", challenge.verifierId.joinToString("") { "%02x".format(it.toInt() and 255) })
      putString("verifierBootSessionId", challenge.verifierBootSessionId)
      putString("nonce", challenge.nonce.joinToString("") { "%02x".format(it.toInt() and 255) })
    }
  }
  @ReactMethod fun acceptAuthorityTimeProof(challengeId: String, bytesBase64: String, promise: Promise) = operation(promise) {
    val result = runtime.gateway.acceptAuthorityTimeProof(challengeId, signedBytes(bytesBase64))
    Arguments.createMap().apply { putString("kind", result.kind); putString("reason", result.reason) }
  }
  override fun onHostResume() { runCatching { runtime.resumeGatewayServer() } }
  override fun onHostPause() { runtime.stopGatewayServer(); runtime.gatewayAccess.lock() }
  override fun onHostDestroy() { runtime.stopGatewayServer(); runtime.gatewayAccess.lock(); cancellation?.cancel(); finishAuthentication(false) }
  override fun invalidate() {
    runtime.gatewayAccess.lock(); cancellation?.cancel(); finishAuthentication(false)
    context.removeActivityEventListener(activityListener); context.removeLifecycleEventListener(this)
    executor.shutdown(); super.invalidate()
  }
  companion object { private const val AUTH_REQUEST = 54420 }
}
