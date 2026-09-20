package com.sagip.survival

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID

object BleProtocolConstants {
  val SERVICE_UUID: UUID = UUID.fromString("00005347-5031-1000-8000-00805F9B34FB")
  val CHARACTERISTIC_OFFER_UUID: UUID = UUID.fromString("00005347-5031-1000-8000-00805F9B0001")
  val CHARACTERISTIC_CHUNK_UUID: UUID = UUID.fromString("00005347-5031-1000-8000-00805F9B0002")
  val CHARACTERISTIC_ACK_UUID: UUID = UUID.fromString("00005347-5031-1000-8000-00805F9B0003")
  val CLIENT_CONFIG_DESCRIPTOR_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

  const val OFFER_PAYLOAD_SIZE = 49 // 1 byte version + 16 bytes UUID + 32 bytes digest
  const val ACK_PAYLOAD_SIZE = 40   // 4 bytes magic + 16 bytes msg UUID + 16 bytes receipt UUID + 8 bytes timestamp

  val ACK_MAGIC = byteArrayOf('S'.code.toByte(), 'G'.code.toByte(), 'K'.code.toByte(), '1'.code.toByte())

  fun encodeOffer(messageId: UUID, payloadDigest: ByteArray, protocolVersion: Int = 1): ByteArray {
    require(payloadDigest.size == 32) { "Payload digest must be exactly 32 bytes" }
    val buffer = ByteBuffer.allocate(OFFER_PAYLOAD_SIZE).order(ByteOrder.BIG_ENDIAN)
    buffer.put(protocolVersion.toByte())
    buffer.putLong(messageId.mostSignificantBits)
    buffer.putLong(messageId.leastSignificantBits)
    buffer.put(payloadDigest)
    return buffer.array()
  }

  fun decodeOffer(bytes: ByteArray): BleManifestOffer {
    require(bytes.size == OFFER_PAYLOAD_SIZE) { "Invalid offer payload size: ${bytes.size}" }
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
    val version = buffer.get().toInt() and 0xFF
    val mostSig = buffer.long
    val leastSig = buffer.long
    val messageId = UUID(mostSig, leastSig).toString()
    val digest = ByteArray(32)
    buffer.get(digest)
    return BleManifestOffer(version, messageId, digest)
  }

  fun encodeAck(messageId: UUID, receiptId: UUID, acceptedAt: Long): ByteArray {
    val buffer = ByteBuffer.allocate(ACK_PAYLOAD_SIZE).order(ByteOrder.BIG_ENDIAN)
    buffer.put(ACK_MAGIC)
    buffer.putLong(messageId.mostSignificantBits)
    buffer.putLong(messageId.leastSignificantBits)
    buffer.putLong(receiptId.mostSignificantBits)
    buffer.putLong(receiptId.leastSignificantBits)
    buffer.putLong(acceptedAt)
    return buffer.array()
  }

  fun decodeAck(bytes: ByteArray): Triple<UUID, UUID, Long> {
    require(bytes.size == ACK_PAYLOAD_SIZE) { "Invalid ACK payload size: ${bytes.size}" }
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
    val magic = ByteArray(4)
    buffer.get(magic)
    require(magic.contentEquals(ACK_MAGIC)) { "Invalid ACK magic" }
    val msgMost = buffer.long
    val msgLeast = buffer.long
    val recMost = buffer.long
    val recLeast = buffer.long
    val acceptedAt = buffer.long
    return Triple(UUID(msgMost, msgLeast), UUID(recMost, recLeast), acceptedAt)
  }
}
