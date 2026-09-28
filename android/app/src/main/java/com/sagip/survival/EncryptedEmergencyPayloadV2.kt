package com.sagip.survival

import com.google.crypto.tink.HybridDecrypt
import com.google.crypto.tink.HybridEncrypt
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.nio.BufferUnderflowException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.util.UUID

data class ResponderEncryptionRecipient(
  val keyId: ByteArray,
  val encryptor: HybridEncrypt,
)

data class EncryptedRecipientEntryV2(
  val keyId: ByteArray,
  val ciphertext: ByteArray,
)

data class DecodedEncryptedEmergencyPayloadV2(
  val plaintextFormat: Int,
  val recipients: List<EncryptedRecipientEntryV2>,
)

object EncryptedEmergencyPayloadV2 {
  const val MAX_RECIPIENTS = 8
  const val MAX_CIPHERTEXT_BYTES = 1024
  const val MAX_CONTAINER_BYTES = TransportEnvelopeV1.MAX_PAYLOAD_BYTES

  private val MAGIC = byteArrayOf('S'.code.toByte(), 'R'.code.toByte(), 'E'.code.toByte(), '2'.code.toByte())
  private const val VERSION = 1
  private const val PLAINTEXT_FORMAT_SRP1 = 1
  private const val KEY_ID_BYTES = 32
  private const val SGP2_VERSION = 2
  private val CONTEXT_LABEL = "SAGIP-SRE2\u0000".toByteArray(StandardCharsets.US_ASCII)

  fun encryptSrp1(
    plaintext: ByteArray,
    messageId: String,
    reportId: String,
    revision: Int,
    recipients: List<ResponderEncryptionRecipient>,
  ): ByteArray {
    require(plaintext.isNotEmpty()) { "plaintext must not be empty" }
    require(recipients.size in 1..MAX_RECIPIENTS) { "recipient count is out of range" }
    val contextInfo = contextInfo(messageId, reportId, revision)
    val encryptedEntries = recipients.map { recipient ->
      require(recipient.keyId.size == KEY_ID_BYTES) { "recipient key ID must be 32 bytes" }
      val ciphertext = recipient.encryptor.encrypt(plaintext, contextInfo)
      require(ciphertext.size in 1..MAX_CIPHERTEXT_BYTES) { "recipient ciphertext length is out of range" }
      EncryptedRecipientEntryV2(recipient.keyId.copyOf(), ciphertext)
    }
    return encode(encryptedEntries)
  }

  fun encode(entries: List<EncryptedRecipientEntryV2>): ByteArray {
    require(entries.size in 1..MAX_RECIPIENTS) { "recipient count is out of range" }
    val sorted = entries
      .map {
        require(it.keyId.size == KEY_ID_BYTES) { "recipient key ID must be 32 bytes" }
        require(it.ciphertext.size in 1..MAX_CIPHERTEXT_BYTES) { "recipient ciphertext length is out of range" }
        EncryptedRecipientEntryV2(it.keyId.copyOf(), it.ciphertext.copyOf())
      }
      .sortedWith { left, right -> compareUnsigned(left.keyId, right.keyId) }

    for (index in 1 until sorted.size) {
      require(!sorted[index - 1].keyId.contentEquals(sorted[index].keyId)) {
        "duplicate recipient key ID"
      }
    }

    val bytes = ByteArrayOutputStream().use { out ->
      DataOutputStream(out).use { data ->
        data.write(MAGIC)
        data.writeByte(VERSION)
        data.writeByte(PLAINTEXT_FORMAT_SRP1)
        data.writeByte(sorted.size)
        sorted.forEach { entry ->
          data.write(entry.keyId)
          data.writeShort(entry.ciphertext.size)
          data.write(entry.ciphertext)
        }
      }
      out.toByteArray()
    }
    require(bytes.size <= MAX_CONTAINER_BYTES) { "encrypted payload container is too large" }
    return bytes
  }

  fun decode(bytes: ByteArray): DecodedEncryptedEmergencyPayloadV2 {
    require(bytes.size <= MAX_CONTAINER_BYTES) { "encrypted payload container is too large" }
    require(bytes.size >= 4 + 3 + KEY_ID_BYTES + 2 + 1) { "encrypted payload container is truncated" }

    try {
      val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
      val magic = ByteArray(MAGIC.size).also(buffer::get)
      require(magic.contentEquals(MAGIC)) { "invalid encrypted payload magic" }
      require(buffer.get().toInt() and 0xff == VERSION) { "unsupported encrypted payload version" }
      val plaintextFormat = buffer.get().toInt() and 0xff
      require(plaintextFormat == PLAINTEXT_FORMAT_SRP1) { "unsupported encrypted plaintext format" }
      val recipientCount = buffer.get().toInt() and 0xff
      require(recipientCount in 1..MAX_RECIPIENTS) { "recipient count is out of range" }

      val entries = ArrayList<EncryptedRecipientEntryV2>(recipientCount)
      repeat(recipientCount) {
        val keyId = readExact(buffer, KEY_ID_BYTES, "recipient key ID")
        val ciphertextLength = buffer.short.toInt() and 0xffff
        require(ciphertextLength in 1..MAX_CIPHERTEXT_BYTES) { "recipient ciphertext length is out of range" }
        val ciphertext = readExact(buffer, ciphertextLength, "recipient ciphertext")
        if (entries.any { it.keyId.contentEquals(keyId) }) {
          throw IllegalArgumentException("duplicate recipient key ID")
        }
        entries += EncryptedRecipientEntryV2(keyId, ciphertext)
      }
      require(!buffer.hasRemaining()) { "trailing encrypted payload bytes" }

      val sorted = entries.sortedWith { left, right -> compareUnsigned(left.keyId, right.keyId) }
      require(entries.indices.all { entries[it].keyId.contentEquals(sorted[it].keyId) }) {
        "recipient entries are not canonically ordered"
      }
      return DecodedEncryptedEmergencyPayloadV2(plaintextFormat, entries)
    } catch (error: BufferUnderflowException) {
      throw IllegalArgumentException("encrypted payload container is truncated", error)
    }
  }

  fun decryptSrp1ForRecipient(
    containerBytes: ByteArray,
    recipientKeyId: ByteArray,
    decryptor: HybridDecrypt,
    messageId: String,
    reportId: String,
    revision: Int,
  ): ByteArray {
    require(recipientKeyId.size == KEY_ID_BYTES) { "recipient key ID must be 32 bytes" }
    val decoded = decode(containerBytes)
    val entry = decoded.recipients.firstOrNull { it.keyId.contentEquals(recipientKeyId) }
      ?: throw IllegalArgumentException("recipient key is not present in encrypted payload")
    return decryptor.decrypt(entry.ciphertext, contextInfo(messageId, reportId, revision))
  }

  fun contextInfo(messageId: String, reportId: String, revision: Int): ByteArray {
    require(revision >= 1) { "revision must be at least 1" }
    val messageUuid = parseUuid(messageId, "messageId")
    val reportUuid = parseUuid(reportId, "reportId")
    return ByteBuffer.allocate(CONTEXT_LABEL.size + 16 + 16 + 4 + 1)
      .order(ByteOrder.BIG_ENDIAN)
      .apply {
        put(CONTEXT_LABEL)
        putLong(messageUuid.mostSignificantBits)
        putLong(messageUuid.leastSignificantBits)
        putLong(reportUuid.mostSignificantBits)
        putLong(reportUuid.leastSignificantBits)
        putInt(revision)
        put(SGP2_VERSION.toByte())
      }
      .array()
  }

  private fun compareUnsigned(left: ByteArray, right: ByteArray): Int {
    for (index in left.indices) {
      val a = left[index].toInt() and 0xff
      val b = right[index].toInt() and 0xff
      if (a != b) return a.compareTo(b)
    }
    return 0
  }

  private fun readExact(buffer: ByteBuffer, length: Int, field: String): ByteArray {
    require(buffer.remaining() >= length) { "$field is truncated" }
    return ByteArray(length).also(buffer::get)
  }

  private fun parseUuid(value: String, field: String): UUID = try {
    UUID.fromString(value)
  } catch (error: IllegalArgumentException) {
    throw IllegalArgumentException("$field must be a UUID", error)
  }
}
