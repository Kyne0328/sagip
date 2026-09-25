package com.sagip.survival

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Android Foreground Service maintaining BLE emergency relay operations
 * and survival connectivity under Doze / App Standby execution constraints.
 */
class EmergencyRelayService : Service() {
  private val runtime by lazy { SurvivalCoreRuntime.get(applicationContext) }
  private var foregroundStarted = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    if (!BleRelayReadinessChecker.evaluate(applicationContext).canRun) {
      stopSelf()
      return
    }

    createNotificationChannel()
    val notification = buildForegroundNotification()
    foregroundStarted = runCatching {
      ServiceCompat.startForeground(
        this,
        NOTIFICATION_ID,
        notification,
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        } else {
          0
        },
      )
    }.isSuccess
    if (!foregroundStarted) stopSelf()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!foregroundStarted || !runtime.bleRelay.start()) {
      runtime.bleRelay.stop()
      stopSelf()
      return START_NOT_STICKY
    }
    return START_STICKY
  }

  override fun onDestroy() {
    runtime.bleRelay.stop()
    super.onDestroy()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "SAGIP Emergency Relay",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Maintains Bluetooth Low Energy store-carry-forward relaying for disaster communications"
      }
      val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
      manager?.createNotificationChannel(channel)
    }
  }

  private fun buildForegroundNotification(): Notification {
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("SAGIP Nearby Relay")
      .setContentText("Keeping nearby SOS relay available over Bluetooth")
      .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
  }

  companion object {
    const val NOTIFICATION_ID = 54419
    const val CHANNEL_ID = "sagip_emergency_relay_channel"
    const val ACTION_START_RELAY = "com.sagip.survival.ACTION_START_RELAY"

    fun start(context: Context): Boolean {
      if (!BleRelayReadinessChecker.evaluate(context.applicationContext).canRun) {
        return false
      }
      val intent = Intent(context, EmergencyRelayService::class.java).apply {
        action = ACTION_START_RELAY
      }
      return runCatching {
        ContextCompat.startForegroundService(context, intent)
      }.isSuccess
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, EmergencyRelayService::class.java))
    }
  }
}
