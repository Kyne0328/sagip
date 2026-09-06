package com.sagip.survival

import java.nio.BufferUnderflowException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.roundToInt

data class DecodedEmergencyPayload(
  val emergencyType: EmergencyType,
  val urgency: Urgency,
  val location: LocationSnapshot?,
)

object EmergencyPayloadV1 {
  private val MAGIC = byteArrayOf('S'.code.toByte(), 'R'.code.toByte(), 'P'.code.toByte(), '1'.code.toByte())
  private const val VERSION: Int = 1
  private const val HEADER_SIZE = 8
  private const val LOCATION_SIZE = 22

  fun encode(
    emergencyType: EmergencyType,
    urgency: Urgency,
    location: LocationSnapshot?,
  ): ByteArray {
    val buffer = ByteBuffer.allocate(HEADER_SIZE + if (location == null) 0 else LOCATION_SIZE)
      .order(ByteOrder.BIG_ENDIAN)
    buffer.put(MAGIC)
    buffer.put(VERSION.toByte())
    buffer.put(emergencyTypeCode(emergencyType).toByte())
    buffer.put(urgencyCode(urgency).toByte())
    buffer.put(if (location == null) 0 else 1)

    if (location != null) {
      require(location.latitude.isFinite() && location.latitude in -90.0..90.0) { "latitude is out of range" }
      require(location.longitude.isFinite() && location.longitude in -180.0..180.0) { "longitude is out of range" }
      require(location.capturedAt >= 0) { "capturedAt must not be negative" }
      val accuracyCm = location.accuracyMeters?.let {
        require(it.isFinite() && it >= 0.0 && it <= Int.MAX_VALUE / 100.0) { "accuracy is out of range" }
        (it * 100.0).roundToInt()
      } ?: -1

      buffer.putInt((location.latitude * 1_000_000.0).roundToInt())
      buffer.putInt((location.longitude * 1_000_000.0).roundToInt())
      buffer.putInt(accuracyCm)
      buffer.putLong(location.capturedAt)
      buffer.put(sourceCode(location.source).toByte())
      buffer.put(freshnessCode(location.freshness).toByte())
    }

    return buffer.array()
  }

  fun decode(bytes: ByteArray): DecodedEmergencyPayload {
    require(bytes.size == HEADER_SIZE || bytes.size == HEADER_SIZE + LOCATION_SIZE) { "invalid payload length" }
    try {
      val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
      val magic = ByteArray(MAGIC.size).also(buffer::get)
      require(magic.contentEquals(MAGIC)) { "invalid payload magic" }
      require(buffer.get().toInt() and 0xff == VERSION) { "unsupported payload version" }
      val emergencyType = emergencyTypeFromCode(buffer.get().toInt() and 0xff)
      val urgency = urgencyFromCode(buffer.get().toInt() and 0xff)
      val locationPresent = buffer.get().toInt() and 0xff
      require(locationPresent == 0 || locationPresent == 1) { "invalid location flag" }

      val location = if (locationPresent == 0) {
        require(bytes.size == HEADER_SIZE) { "unexpected location bytes" }
        null
      } else {
        require(bytes.size == HEADER_SIZE + LOCATION_SIZE) { "missing location bytes" }
        val latitudeE6 = buffer.int
        val longitudeE6 = buffer.int
        require(latitudeE6 in -90_000_000..90_000_000) { "latitude is out of range" }
        require(longitudeE6 in -180_000_000..180_000_000) { "longitude is out of range" }
        val accuracyCm = buffer.int
        require(accuracyCm >= -1) { "accuracy is out of range" }
        val capturedAt = buffer.long
        require(capturedAt >= 0) { "capturedAt must not be negative" }
        LocationSnapshot(
          latitude = latitudeE6 / 1_000_000.0,
          longitude = longitudeE6 / 1_000_000.0,
          accuracyMeters = if (accuracyCm == -1) null else accuracyCm / 100.0,
          capturedAt = capturedAt,
          source = sourceFromCode(buffer.get().toInt() and 0xff),
          freshness = freshnessFromCode(buffer.get().toInt() and 0xff),
        )
      }

      require(!buffer.hasRemaining()) { "trailing payload bytes" }
      return DecodedEmergencyPayload(emergencyType, urgency, location)
    } catch (error: BufferUnderflowException) {
      throw IllegalArgumentException("truncated emergency payload", error)
    }
  }

  private fun emergencyTypeCode(type: EmergencyType): Int = when (type) {
    EmergencyType.MEDICAL -> 1
    EmergencyType.FLOOD -> 2
    EmergencyType.FIRE -> 3
    EmergencyType.TRAPPED -> 4
    EmergencyType.VIOLENCE -> 5
    EmergencyType.OTHER -> 6
  }

  private fun emergencyTypeFromCode(code: Int): EmergencyType = when (code) {
    1 -> EmergencyType.MEDICAL
    2 -> EmergencyType.FLOOD
    3 -> EmergencyType.FIRE
    4 -> EmergencyType.TRAPPED
    5 -> EmergencyType.VIOLENCE
    6 -> EmergencyType.OTHER
    else -> throw IllegalArgumentException("unknown emergency type code")
  }

  private fun urgencyCode(urgency: Urgency): Int = when (urgency) {
    Urgency.IMMEDIATE_DANGER -> 1
    Urgency.NEED_ASSISTANCE -> 2
  }

  private fun urgencyFromCode(code: Int): Urgency = when (code) {
    1 -> Urgency.IMMEDIATE_DANGER
    2 -> Urgency.NEED_ASSISTANCE
    else -> throw IllegalArgumentException("unknown urgency code")
  }

  private fun sourceCode(source: String): Int = when (source) {
    "GPS" -> 1
    "NETWORK" -> 2
    else -> throw IllegalArgumentException("unknown location source")
  }

  private fun sourceFromCode(code: Int): String = when (code) {
    1 -> "GPS"
    2 -> "NETWORK"
    else -> throw IllegalArgumentException("unknown location source code")
  }

  private fun freshnessCode(freshness: String): Int = when (freshness) {
    "FRESH" -> 1
    "STALE" -> 2
    else -> throw IllegalArgumentException("unknown location freshness")
  }

  private fun freshnessFromCode(code: Int): String = when (code) {
    1 -> "FRESH"
    2 -> "STALE"
    else -> throw IllegalArgumentException("unknown location freshness code")
  }
}
