package com.sagip.survival

import android.Manifest
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build

enum class BleRelayAvailability {
  READY,
  PERMISSION_REQUIRED,
  BLUETOOTH_OFF,
  NOT_SUPPORTED,
}

data class BleRelayReadiness(
  val availability: BleRelayAvailability,
  val isSupported: Boolean,
  val permissionGranted: Boolean,
  val bluetoothEnabled: Boolean,
) {
  val canRun: Boolean
    get() = availability == BleRelayAvailability.READY
}

object BleRelayPermissions {
  internal fun requiredPermissionsForSdk(sdkInt: Int): List<String> {
    return if (sdkInt >= Build.VERSION_CODES.S) {
      listOf(
        Manifest.permission.BLUETOOTH_SCAN,
        Manifest.permission.BLUETOOTH_ADVERTISE,
        Manifest.permission.BLUETOOTH_CONNECT,
      )
    } else {
      listOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }
  }

  fun hasRequiredPermissions(context: Context): Boolean {
    return requiredPermissionsForSdk(Build.VERSION.SDK_INT).all { permission ->
      context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
    }
  }
}

object BleRelayReadinessChecker {
  fun evaluate(context: Context): BleRelayReadiness {
    val bluetoothManager =
      context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    val adapter = bluetoothManager?.adapter
      ?: return BleRelayReadiness(
        availability = BleRelayAvailability.NOT_SUPPORTED,
        isSupported = false,
        permissionGranted = false,
        bluetoothEnabled = false,
      )

    val permissionGranted = BleRelayPermissions.hasRequiredPermissions(context)
    if (!permissionGranted) {
      return BleRelayReadiness(
        availability = BleRelayAvailability.PERMISSION_REQUIRED,
        isSupported = true,
        permissionGranted = false,
        bluetoothEnabled = false,
      )
    }

    val bluetoothEnabled = try {
      adapter.isEnabled
    } catch (_: SecurityException) {
      false
    }

    return BleRelayReadiness(
      availability = if (bluetoothEnabled) {
        BleRelayAvailability.READY
      } else {
        BleRelayAvailability.BLUETOOTH_OFF
      },
      isSupported = true,
      permissionGranted = true,
      bluetoothEnabled = bluetoothEnabled,
    )
  }
}
