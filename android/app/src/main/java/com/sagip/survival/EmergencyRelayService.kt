package com.sagip.survival

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Android Foreground Service maintaining BLE emergency relay operations
 * and survival connectivity under Doze / App Standby execution constraints.
 */
class EmergencyRelayService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    val notification = buildForegroundNotification()
    startForeground(NOTIFICATION_ID, notification)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP_RELAY -> {
        stopSelf()
        return START_NOT_STICKY
      }
    }
    return START_STICKY
  }

  override fun onDestroy() {
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
      .setContentTitle("SAGIP Emergency Relay Active")
      .setContentText("Listening and relaying emergency SOS packets via BLE")
      .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
  }

  companion object {
    const val NOTIFICATION_ID = 54419
    const val CHANNEL_ID = "sagip_emergency_relay_channel"
    const val ACTION_START_RELAY = "com.sagip.survival.ACTION_START_RELAY"
    const val ACTION_STOP_RELAY = "com.sagip.survival.ACTION_STOP_RELAY"

    fun start(context: Context) {
      val intent = Intent(context, EmergencyRelayService::class.java).apply {
        action = ACTION_START_RELAY
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      val intent = Intent(context, EmergencyRelayService::class.java).apply {
        action = ACTION_STOP_RELAY
      }
      context.startService(intent)
    }
  }
}
