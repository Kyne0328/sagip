package com.sagip.survival

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

data class DecodedEmergencyPayloadV2(
  val emergencyType: EmergencyType,
  val urgency: Urgency,
  val location: LocationSnapshot?,
  val message: String?,
)

object EmergencyPayloadV2 {
  const val MAX_MESSAGE_BYTES = 500
  const val MAX_PAYLOAD_BYTES = 532
  private const val HEADER_SIZE = 8
  private const val LOCATION_SIZE = 22
  private const val LENGTH_SIZE = 2
  private const val VERSION = 2

  fun encode(type: EmergencyType, urgency: Urgency, location: LocationSnapshot?, message: String?): ByteArray {
    // A valid UTF-8 string has at least as many bytes as UTF-16 units. Bound allocation first.
    require(message == null || message.length <= MAX_MESSAGE_BYTES) { "message exceeds 500 UTF-8 bytes" }
    val messageBytes = try {
      val encoded = Charsets.UTF_8.newEncoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .encode(CharBuffer.wrap(message ?: ""))
      ByteArray(encoded.remaining()).also(encoded::get)
    } catch (error: CharacterCodingException) {
      throw IllegalArgumentException("message contains malformed Unicode", error)
    }
    require(messageBytes.size <= MAX_MESSAGE_BYTES) { "message exceeds 500 UTF-8 bytes" }
    val prefix = EmergencyPayloadV1.encode(type, urgency, location).also { it[4] = VERSION.toByte() }
    return ByteBuffer.allocate(prefix.size + LENGTH_SIZE + messageBytes.size)
      .order(ByteOrder.BIG_ENDIAN)
      .put(prefix)
      .putShort(messageBytes.size.toShort())
      .put(messageBytes)
      .array()
  }

  fun decode(bytes: ByteArray): DecodedEmergencyPayloadV2 {
    require(bytes.size in HEADER_SIZE + LENGTH_SIZE..MAX_PAYLOAD_BYTES) { "invalid format-2 payload length" }
    require(bytes[4].toInt() and 0xff == VERSION) { "unsupported payload version" }
    val locationFlag = bytes[7].toInt() and 0xff
    require(locationFlag == 0 || locationFlag == 1) { "invalid location flag" }
    val prefixSize = HEADER_SIZE + if (locationFlag == 1) LOCATION_SIZE else 0
    require(bytes.size >= prefixSize + LENGTH_SIZE) { "truncated location or message length" }
    // Reuse the unchanged v1 accepted header/location bytes and validation without re-encoding.
    val prefix = bytes.copyOf(prefixSize).also { it[4] = 1 }
    val decodedPrefix = EmergencyPayloadV1.decode(prefix)
    val body = ByteBuffer.wrap(bytes, prefixSize, bytes.size - prefixSize).order(ByteOrder.BIG_ENDIAN)
    val messageLength = body.short.toInt() and 0xffff
    require(messageLength <= MAX_MESSAGE_BYTES) { "message exceeds 500 UTF-8 bytes" }
    require(body.remaining() == messageLength) { "message length mismatch or trailing bytes" }
    val message = if (messageLength == 0) null else try {
      Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(body)
        .toString()
    } catch (error: CharacterCodingException) {
      throw IllegalArgumentException("malformed message UTF-8", error)
    }
    return DecodedEmergencyPayloadV2(decodedPrefix.emergencyType, decodedPrefix.urgency, decodedPrefix.location, message)
  }
}
