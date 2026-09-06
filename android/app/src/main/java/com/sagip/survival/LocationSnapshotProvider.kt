package com.sagip.survival

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import androidx.core.content.ContextCompat

internal data class LocationRank(
  val capturedAt: Long,
  val accuracyMeters: Float?,
)

class LocationSnapshotProvider(private val context: Context) {

  fun getBestAvailableLocation(now: Long = System.currentTimeMillis()): LocationSnapshot? {
    if (!hasLocationPermission()) return null
    val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
    val candidates = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
      .mapNotNull { provider ->
        runCatching { manager.getLastKnownLocation(provider) }.getOrNull()
      }
    val bestIndex = selectBestIndex(candidates.map { it.toRank() }, now) ?: return null
    return candidates[bestIndex].toSnapshot(now)
  }

  private fun hasLocationPermission(): Boolean {
    return ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
      ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
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
