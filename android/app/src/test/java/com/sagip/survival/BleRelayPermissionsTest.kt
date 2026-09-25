package com.sagip.survival

import android.Manifest
import org.junit.Assert.assertEquals
import org.junit.Test

class BleRelayPermissionsTest {
  @Test
  fun `android 11 and below require fine location for BLE scanning`() {
    assertEquals(
      listOf(Manifest.permission.ACCESS_FINE_LOCATION),
      BleRelayPermissions.requiredPermissionsForSdk(30),
    )
  }

  @Test
  fun `android 12 and above require nearby device BLE permissions`() {
    assertEquals(
      listOf(
        Manifest.permission.BLUETOOTH_SCAN,
        Manifest.permission.BLUETOOTH_ADVERTISE,
        Manifest.permission.BLUETOOTH_CONNECT,
      ),
      BleRelayPermissions.requiredPermissionsForSdk(31),
    )
  }
}
