package com.sagip.survival

import android.app.KeyguardManager
import android.content.Context
import android.os.SystemClock

/** The bridge marks success only from the OS credential prompt callback; never from request JSON. */
class GatewayDeviceAccess(context: Context) {
  private val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
  @Volatile private var verifiedAt: Long? = null
  internal fun verifiedBySystem() { verifiedAt = SystemClock.elapsedRealtime() }
  fun lock() { verifiedAt = null }
  fun isAllowed(): Boolean {
    val at = verifiedAt ?: return false
    val age = SystemClock.elapsedRealtime() - at
    return keyguard.isDeviceSecure && !keyguard.isDeviceLocked && age in 0 until 60_000L
  }
}
