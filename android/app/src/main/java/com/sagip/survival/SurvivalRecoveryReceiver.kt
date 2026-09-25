package com.sagip.survival

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Restores OS-owned SAGIP scheduling after reboot or app replacement.
 *
 * BLE restarts only when authoritative SQLite state says relay work is still
 * active. Recovery never changes delivery success state.
 */
class SurvivalRecoveryReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    when (intent?.action) {
      Intent.ACTION_BOOT_COMPLETED,
      Intent.ACTION_MY_PACKAGE_REPLACED,
      -> Unit
      else -> return
    }

    val appContext = context.applicationContext
    runCatching {
      EmergencyJobScheduler.scheduleNetworkSync(appContext)
    }

    val runtime = runCatching {
      SurvivalCoreRuntime.get(appContext)
    }.getOrNull() ?: return

    if (
      runtime.repository.hasActiveRelayWork() &&
      BleRelayReadinessChecker.evaluate(appContext).canRun
    ) {
      EmergencyRelayService.start(appContext)
    }
  }
}
