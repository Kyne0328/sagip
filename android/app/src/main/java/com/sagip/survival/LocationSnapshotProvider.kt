package com.sagip.survival

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Looper
import androidx.core.content.ContextCompat

internal data class LocationRank(
  val capturedAt: Long,
  val accuracyMeters: Float?,
)

class LocationSnapshotProvider(private val context: Context) {
  private val locationLock = Any()
  private var primedLocation: Location? = null

  fun getBestAvailableLocation(now: Long = System.currentTimeMillis()): LocationSnapshot? {
    if (!hasLocationPermission()) return null
    val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
    val candidates = mutableListOf<Location>()

    synchronized(locationLock) {
      primedLocation?.let { candidates += Location(it) }
    }

    availableProviders().forEach { provider ->
      runCatching { manager.getLastKnownLocation(provider) }
        .getOrNull()
        ?.takeIf(::isUsable)
        ?.let(candidates::add)
    }

    val bestIndex = selectBestIndex(candidates.map { it.toRank() }, now) ?: return null
    return candidates[bestIndex].toSnapshot(now)
  }

  fun primeBestEffortLocation(onLocationAvailable: (() -> Unit)? = null): Boolean {
    if (!hasLocationPermission()) return false
    val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return false

    var started = false
    availableProviders().forEach { provider ->
      val enabled = runCatching { manager.isProviderEnabled(provider) }.getOrDefault(false)
      if (!enabled) return@forEach

      val providerStarted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        runCatching {
          manager.getCurrentLocation(
            provider,
            CancellationSignal(),
            ContextCompat.getMainExecutor(context),
          ) { location ->
            location?.takeIf(::isUsable)?.let {
              if (rememberLocation(it)) onLocationAvailable?.invoke()
            }
          }
        }.isSuccess
      } else {
        requestSingleUpdate(manager, provider, onLocationAvailable)
      }
      started = started || providerStarted
    }
    return started
  }

  private fun availableProviders(): List<String> {
    val hasFine = ContextCompat.checkSelfPermission(
      context,
      Manifest.permission.ACCESS_FINE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED

    return if (hasFine) {
      listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
    } else {
      listOf(LocationManager.NETWORK_PROVIDER)
    }
  }

  private fun hasLocationPermission(): Boolean {
    return ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
  }

  @Suppress("DEPRECATION")
  private fun requestSingleUpdate(
    manager: LocationManager,
    provider: String,
    onLocationAvailable: (() -> Unit)?,
  ): Boolean {
    val listener = object : LocationListener {
      override fun onLocationChanged(location: Location) {
        if (isUsable(location) && rememberLocation(location)) onLocationAvailable?.invoke()
      }

      override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
      override fun onProviderEnabled(provider: String) = Unit
      override fun onProviderDisabled(provider: String) = Unit
    }

    return runCatching {
      manager.requestSingleUpdate(provider, listener, Looper.getMainLooper())
    }.isSuccess
  }

  private fun rememberLocation(location: Location): Boolean {
    val candidate = Location(location)
    val now = System.currentTimeMillis()
    return synchronized(locationLock) {
      val existing = primedLocation
      if (existing == null) {
        primedLocation = candidate
        true
      } else {
        val bestIndex = selectBestIndex(
          listOf(existing.toRank(), candidate.toRank()),
          now,
        )
        if (bestIndex == 1) {
          primedLocation = candidate
          true
        } else {
          false
        }
      }
    }
  }

  private fun isUsable(location: Location): Boolean {
    return location.latitude.isFinite() &&
      location.latitude in -90.0..90.0 &&
      location.longitude.isFinite() &&
      location.longitude in -180.0..180.0 &&
      location.time >= 0L
  }

  private fun Location.toRank(): LocationRank {
    return LocationRank(
      capturedAt = time,
      accuracyMeters = if (hasAccuracy()) accuracy else null,
    )
  }

  private fun Location.toSnapshot(now: Long): LocationSnapshot {
    return LocationSnapshot(
      latitude = latitude,
      longitude = longitude,
      accuracyMeters = if (hasAccuracy()) accuracy.toDouble() else null,
      capturedAt = time,
      source = if (provider == LocationManager.GPS_PROVIDER) "GPS" else "NETWORK",
      freshness = if (now - time <= FRESH_LOCATION_MS) "FRESH" else "STALE",
    )
  }

  companion object {
    const val FRESH_LOCATION_MS = 5 * 60 * 1000L

    internal fun selectBestIndex(locations: List<LocationRank>, now: Long): Int? {
      return locations.indices.minWithOrNull(
        compareBy<Int> { index ->
          if (now - locations[index].capturedAt <= FRESH_LOCATION_MS) 0 else 1
        }.thenBy { index ->
          locations[index].accuracyMeters ?: Float.MAX_VALUE
        }.thenByDescending { index ->
          locations[index].capturedAt
        },
      )
    }
  }
}
