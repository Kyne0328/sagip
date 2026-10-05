package com.sagip.survival

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File
import org.junit.Assert.*
import org.junit.Test

class EmergencyPayloadV2Test {
  private val location = LocationSnapshot(14.5995, 120.9842, 8.0, 1200L, "GPS", "FRESH")

  @Test
  fun `all frozen fixtures including unspecified decode and valid fixtures encode exactly`() {
    val fixture = File("../../fixtures/srp1-details-v2.json")
    assertTrue("canonical fixture must exist: ${fixture.absolutePath}", fixture.isFile)
    val cases = JsonParser.parseString(fixture.readText(Charsets.UTF_8)).asJsonObject.getAsJsonArray("cases")
    assertEquals(40, cases.size())
    cases.forEach { entry ->
      val vector = entry.asJsonObject
      val name = vector.get("name").asString
      val bytes = vector.get("hex").asString.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
      assertEquals(name, vector.get("byteLength").asInt, bytes.size)
      val expected = vector.getAsJsonObject("expected")
      val version = vector.get("formatVersion").asInt
      if (!expected.get("accepted").asBoolean) {
        assertThrows(name, IllegalArgumentException::class.java) { EmergencyPayload.decode(bytes) }
        assertThrows(name, IllegalArgumentException::class.java) {
          if (version == 1) EmergencyPayloadV1.decode(bytes) else EmergencyPayloadV2.decode(bytes)
        }
      } else {
        val typeCode = expected.get("emergencyType").asInt
        val type = if (typeCode == 0) EmergencyType.UNSPECIFIED else EmergencyType.entries[typeCode - 1]
        val urgencyCode = expected.get("urgency").asInt
        val urgency = if (urgencyCode == 0) Urgency.UNSPECIFIED else Urgency.entries[urgencyCode - 1]
        val expectedLocation = if (expected.get("location").isJsonNull) null else expected.getAsJsonObject("location").location()
        val message = if (expected.get("message").isJsonNull) null else expected.get("message").asString
        assertEquals(name, DecodedEmergencyPayload(type, urgency, expectedLocation, message), EmergencyPayload.decode(bytes))
        if (version == 1) {
          assertEquals(name, DecodedEmergencyPayload(type, urgency, expectedLocation), EmergencyPayloadV1.decode(bytes))
          assertArrayEquals(name, bytes, EmergencyPayload.encode(type, urgency, expectedLocation, null))
        } else {
          assertEquals(name, DecodedEmergencyPayloadV2(type, urgency, expectedLocation, message), EmergencyPayloadV2.decode(bytes))
          assertArrayEquals(name, bytes, EmergencyPayloadV2.encode(type, urgency, expectedLocation, message))
          if (message != null) assertArrayEquals(name, bytes, EmergencyPayload.encode(type, urgency, expectedLocation, message))
        }
      }
    }
  }

  @Test
  fun `null message preserves every legacy type urgency and location encoding`() {
    EmergencyType.entries.forEach { type ->
      Urgency.entries.forEach { urgency ->
        listOf(null, location, location.copy(accuracyMeters = null, source = "NETWORK", freshness = "STALE")).forEach { snapshot ->
          assertArrayEquals(EmergencyPayloadV1.encode(type, urgency, snapshot), EmergencyPayload.encode(type, urgency, snapshot, null))
        }
      }
    }
  }

  @Test
  fun `non-null empty string uses v2 and decodes to null`() {
    val bytes = EmergencyPayload.encode(EmergencyType.OTHER, Urgency.IMMEDIATE_DANGER, null, "")
    assertEquals("53525031020601000000", bytes.toHex())
    assertNull(EmergencyPayloadV2.decode(bytes).message)
  }

  @Test
  fun `valid replacement character and leading BOM preserve exact bytes`() {
    val message = "\uFEFF\uFFFD"
    val bytes = encode(message)
    assertEquals("53525031020601000006efbbbfefbfbd", bytes.toHex())
    assertEquals(message, EmergencyPayloadV2.decode(bytes).message)
  }

  @Test
  fun `whitespace and Unicode are preserved verbatim without normalization`() {
    val message = " \t\r\n救助 🆘 e\u0301  "
    assertEquals(message, EmergencyPayloadV2.decode(encode(message)).message)
  }

  @Test
  fun `encoder rejects unpaired high and low surrogates without downgrading`() {
    listOf("\uD800", "\uDC00", "Help\uD800", "\uD800x\uDC00").forEach { message ->
      assertThrows(IllegalArgumentException::class.java) { encode(message) }
      assertThrows(IllegalArgumentException::class.java) {
        EmergencyPayload.encode(EmergencyType.OTHER, Urgency.IMMEDIATE_DANGER, null, message)
      }
    }
  }

  @Test
  fun `byte bounds accept 500 and reject 501 multibyte bytes`() {
    val message = "é".repeat(250)
    val bytes = EmergencyPayloadV2.encode(EmergencyType.OTHER, Urgency.IMMEDIATE_DANGER, location, message)
    assertEquals(532, bytes.size)
    assertEquals(message, EmergencyPayloadV2.decode(bytes).message)
    listOf(message + "a", "a".repeat(501), "🆘".repeat(126)).forEach {
      assertThrows(IllegalArgumentException::class.java) { encode(it) }
    }
    assertThrows(IllegalArgumentException::class.java) { EmergencyPayloadV2.decode(bytes + byteArrayOf(0)) }
  }

  @Test
  fun `every truncation of a location message and v1 passed to v2 reject`() {
    val bytes = EmergencyPayloadV2.encode(EmergencyType.OTHER, Urgency.IMMEDIATE_DANGER, location, "Help")
    for (length in 0 until bytes.size) {
      assertThrows("length $length", IllegalArgumentException::class.java) { EmergencyPayloadV2.decode(bytes.copyOf(length)) }
    }
    assertThrows(IllegalArgumentException::class.java) {
      EmergencyPayloadV2.decode(EmergencyPayloadV1.encode(EmergencyType.OTHER, Urgency.IMMEDIATE_DANGER, null))
    }
  }

  @Test
  fun `v2 encoder shares v1 location validation and quantization`() {
    listOf(
      location.copy(latitude = Double.NaN), location.copy(latitude = 90.1),
      location.copy(longitude = Double.POSITIVE_INFINITY), location.copy(longitude = -180.1),
      location.copy(accuracyMeters = -1.0), location.copy(accuracyMeters = Double.NaN),
      location.copy(accuracyMeters = Int.MAX_VALUE / 100.0 + 1), location.copy(capturedAt = -1),
      location.copy(source = "UNKNOWN"), location.copy(freshness = "UNKNOWN"),
    ).forEach { invalid ->
      assertThrows(IllegalArgumentException::class.java) { EmergencyPayloadV2.encode(EmergencyType.OTHER, Urgency.IMMEDIATE_DANGER, invalid, "Help") }
    }
    val rounded = location.copy(latitude = 14.5995004, accuracyMeters = 8.004)
    val prefix = EmergencyPayloadV1.encode(EmergencyType.OTHER, Urgency.IMMEDIATE_DANGER, rounded).also { it[4] = 2 }
    assertArrayEquals(prefix, EmergencyPayloadV2.encode(EmergencyType.OTHER, Urgency.IMMEDIATE_DANGER, rounded, "Help").copyOf(prefix.size))
  }

  private fun encode(message: String) = EmergencyPayloadV2.encode(EmergencyType.OTHER, Urgency.IMMEDIATE_DANGER, null, message)
  private fun ByteArray.toHex() = joinToString("") { "%02x".format(it.toInt() and 0xff) }
  private fun JsonObject.location() = LocationSnapshot(
    get("latitude").asDouble, get("longitude").asDouble,
    if (get("accuracyMeters").isJsonNull) null else get("accuracyMeters").asDouble,
    get("capturedAtMs").asLong,
    if (get("source").asInt == 1) "GPS" else "NETWORK",
    if (get("freshness").asInt == 1) "FRESH" else "STALE",
  )
}
