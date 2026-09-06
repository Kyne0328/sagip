package com.sagip.survival

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class EmergencyPayloadV1Test {
  @Test
  fun `encodes deterministic payload without location`() {
    val bytes = EmergencyPayloadV1.encode(
      emergencyType = EmergencyType.MEDICAL,
      urgency = Urgency.IMMEDIATE_DANGER,
      location = null,
    )

    assertEquals("5352503101010100", bytes.toHex())

    val decoded = EmergencyPayloadV1.decode(bytes)
    assertEquals(EmergencyType.MEDICAL, decoded.emergencyType)
    assertEquals(Urgency.IMMEDIATE_DANGER, decoded.urgency)
    assertNull(decoded.location)
  }

  @Test
  fun `encodes scaled GPS location in fixed field order`() {
    val location = LocationSnapshot(
      latitude = 14.5995,
      longitude = 120.9842,
      accuracyMeters = 8.0,
      capturedAt = 1200L,
      source = "GPS",
      freshness = "FRESH",
    )

    val bytes = EmergencyPayloadV1.encode(
      emergencyType = EmergencyType.FLOOD,
      urgency = Urgency.NEED_ASSISTANCE,
      location = location,
    )

    assertEquals(
      "535250310102020100dec54c073612880000032000000000000004b00101",
      bytes.toHex(),
    )

    val decoded = EmergencyPayloadV1.decode(bytes)
    assertEquals(EmergencyType.FLOOD, decoded.emergencyType)
    assertEquals(Urgency.NEED_ASSISTANCE, decoded.urgency)
    assertEquals(14.5995, decoded.location!!.latitude, 0.000001)
    assertEquals(120.9842, decoded.location.longitude, 0.000001)
    assertEquals(8.0, decoded.location.accuracyMeters!!, 0.001)
    assertEquals(1200L, decoded.location.capturedAt)
    assertEquals("GPS", decoded.location.source)
    assertEquals("FRESH", decoded.location.freshness)
  }

  @Test
  fun `rejects trailing bytes`() {
    val valid = EmergencyPayloadV1.encode(
      emergencyType = EmergencyType.OTHER,
      urgency = Urgency.NEED_ASSISTANCE,
      location = null,
    )

    assertThrows(IllegalArgumentException::class.java) {
      EmergencyPayloadV1.decode(valid + byteArrayOf(0x00))
    }
  }

  private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }
}
