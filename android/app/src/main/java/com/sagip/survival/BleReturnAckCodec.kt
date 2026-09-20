package com.sagip.survival

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.zip.CRC32

/**
 * Big-endian binary codec for 56-byte SGA1 Return-ACK frames transmitted over BLE.
 * Enables multi-hop propagation of responder confirmations back to offline origin devices.
 */
object BleReturnAckCodec {
  const val RETURN_ACK_FRAME_SIZE = 56
  val MAGIC = byteArrayOf('S'.code.toByte(), 'G'.code.toByte(), 'A'.code.toByte(), '1'.code.toByte())

  fun statusToCode(status: String): Int {
    return when (status.uppercase()) {
      "ACKNOWLEDGED" -> 1
      "EN_ROUTE" -> 2
      "ON_SCENE" -> 3
      "RESOLVED" -> 4
      else -> throw IllegalArgumentException("Unknown status string: $status")
    }
  }

  fun codeToStatus(code: Int): String {
    return when (code) {
      1 -> "ACKNOWLEDGED"
      2 -> "EN_ROUTE"
      3 -> "ON_SCENE"
      4 -> "RESOLVED"
      else -> throw IllegalArgumentException("Unknown status code: $code")
    }
  }

  fun encode(ack: ResponderAck, etaMinutes: Int = 0): ByteArray {
    val buffer = ByteBuffer.allocate(RETURN_ACK_FRAME_SIZE).order(ByteOrder.BIG_ENDIAN)
    buffer.put(MAGIC)

    val reportUuid = UUID.fromString(ack.reportId)
    buffer.putLong(reportUuid.mostSignificantBits)
    buffer.putLong(reportUuid.leastSignificantBits)

    val callsignBytes = ByteArray(16)
    val callsignRaw = (ack.callsign ?: "RESPONDER").toByteArray(StandardCharsets.UTF_8)
    System.arraycopy(callsignRaw, 0, callsignBytes, 0, minOf(callsignRaw.size, 16))
    buffer.put(callsignBytes)

    buffer.put(statusToCode(ack.status).toByte())
    buffer.putShort(etaMinutes.coerceIn(0, 65535).toShort())
    buffer.putLong(ack.acknowledgedAt)
    buffer.put(ByteArray(5)) // reserved

    // Calculate CRC32 over the preceding 52 bytes
    val crc = CRC32()
    crc.update(buffer.array(), 0, 52)
    buffer.putInt(crc.value.toInt())

    return buffer.array()
  }

  fun decode(frameBytes: ByteArray): ResponderAck {
    require(frameBytes.size == RETURN_ACK_FRAME_SIZE) {
      "Invalid return ACK frame size: ${frameBytes.size}, expected $RETURN_ACK_FRAME_SIZE"
    }

    // Verify CRC32
    val crc = CRC32()
    crc.update(frameBytes, 0, 52)
    val expectedCrc = crc.value.toInt()

    val buffer = ByteBuffer.wrap(frameBytes).order(ByteOrder.BIG_ENDIAN)
    val magic = ByteArray(4)
    buffer.get(magic)
    require(magic.contentEquals(MAGIC)) { "Invalid return ACK magic header" }

    val reportMostSig = buffer.long
    val reportLeastSig = buffer.long
    val reportId = UUID(reportMostSig, reportLeastSig).toString()

    val callsignBytes = ByteArray(16)
    buffer.get(callsignBytes)
    val callsign = String(callsignBytes, StandardCharsets.UTF_8).trimEnd('\u0000', ' ')

    val statusCode = buffer.get().toInt() and 0xFF
    val status = codeToStatus(statusCode)

    val etaMinutes = buffer.short.toInt() and 0xFFFF
    val acknowledgedAt = buffer.long
    val reserved = ByteArray(5)
    buffer.get(reserved)

    val actualCrc = buffer.int
    require(expectedCrc == actualCrc) { "CRC32 checksum mismatch on return ACK frame" }

    return ResponderAck(
      ackId = UUID.randomUUID().toString(),
      reportId = reportId,
      responderId = "BLE_RELAY",
      callsign = callsign.ifEmpty { null },
      status = status,
      note = if (etaMinutes > 0) "ETA $etaMinutes mins via BLE relay" else "Received via BLE relay",
      acknowledgedAt = acknowledgedAt,
    )
  }
}
