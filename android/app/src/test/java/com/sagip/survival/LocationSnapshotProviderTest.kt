package com.sagip.survival

import org.junit.Assert.assertEquals
import org.junit.Test

class LocationSnapshotProviderTest {
  @Test
  fun `fresh fix wins over stale fix`() {
    val now = 1_000_000L
    val stale = LocationRank(
      capturedAt = now - LocationSnapshotProvider.FRESH_LOCATION_MS - 1,
      accuracyMeters = 2f,
    )
    val fresh = LocationRank(
      capturedAt = now - 1000,
      accuracyMeters = 50f,
    )

    assertEquals(1, LocationSnapshotProvider.selectBestIndex(listOf(stale, fresh), now))
  }

  @Test
  fun `more accurate fix wins within same freshness class`() {
    val now = 1_000_000L
    val lessAccurate = LocationRank(
      capturedAt = now - 100,
      accuracyMeters = 80f,
    )
    val accurate = LocationRank(
      capturedAt = now - 200,
      accuracyMeters = 5f,
    )

    assertEquals(1, LocationSnapshotProvider.selectBestIndex(listOf(lessAccurate, accurate), now))
  }

  @Test
  fun `more recent fix breaks tie when freshness and accuracy match`() {
    val now = 1_000_000L
    val older = LocationRank(capturedAt = now - 200, accuracyMeters = 5f)
    val newer = LocationRank(capturedAt = now - 100, accuracyMeters = 5f)

    assertEquals(1, LocationSnapshotProvider.selectBestIndex(listOf(older, newer), now))
  }

  @Test
  fun `no candidates yields no location`() {
    assertEquals(null, LocationSnapshotProvider.selectBestIndex(emptyList(), 1_000_000L))
  }
}
