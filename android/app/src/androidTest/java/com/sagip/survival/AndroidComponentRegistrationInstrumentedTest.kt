package com.sagip.survival

import android.content.ComponentName
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidComponentRegistrationInstrumentedTest {
  @Test
  fun survivalServicesAreRegisteredUsingTheirRuntimeClasses() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val packageManager = context.packageManager

    @Suppress("DEPRECATION")
    val relayInfo = packageManager.getServiceInfo(
      ComponentName(context, EmergencyRelayService::class.java),
      0,
    )
    @Suppress("DEPRECATION")
    val deliveryInfo = packageManager.getServiceInfo(
      ComponentName(context, EmergencyDeliveryJobService::class.java),
      0,
    )
    @Suppress("DEPRECATION")
    val recoveryInfo = packageManager.getReceiverInfo(
      ComponentName(context, SurvivalRecoveryReceiver::class.java),
      0,
    )

    assertEquals(EmergencyRelayService::class.java.name, relayInfo.name)
    assertEquals(EmergencyDeliveryJobService::class.java.name, deliveryInfo.name)
    assertEquals("android.permission.BIND_JOB_SERVICE", deliveryInfo.permission)
    assertEquals(SurvivalRecoveryReceiver::class.java.name, recoveryInfo.name)
  }
}
