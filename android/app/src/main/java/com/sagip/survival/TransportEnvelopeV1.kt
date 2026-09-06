package com.sagip.survival

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.nio.BufferUnderflowException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.UUID

data class EnvelopeUnsignedInput(
  val messageId: String,
  val reportId: String,
  val revision: Int,
  val createdAt: Long,
  val expiresAt: Long?,
  val priority: Int,
  val payload: ByteArray,
)

data class DecodedEnvelopeV1(
  val messageId: String,
  val reportId: String,
  val revision: Int,
  val createdAt: Long,
  val expiresAt: Long?,
  val priority: Int,
  val originKeyId: ByteArray,
  val originPublicKeyDer: ByteArray,
  val payloadDigest: ByteArray,
  val payload: ByteArray,
  val canonicalUnsignedBody: ByteArray,
  val signature: ByteArray,
)

object TransportEnvelopeV1 {
  const val MAX_ENVELOPE_BYTES = 8192
  const val MAX_PUBLIC_KEY_BYTES = 512
  const val MAX_PAYLOAD_BYTES = 4096
  const val MAX_SIGNATURE_BYTES = 256

  private val MAGIC = byteArrayOf('S'.code.toByte(), 'G'.code.toByte(), 'P'.code.toByte(), '1'.code.toByte())
  private const val VERSION = 1
  private const val SIGNATURE_ALGORITHM_ECDSA_P256_SHA256 = 1
  private const val SHA256_BYTES = 32

  fun create(input: EnvelopeUnsignedInput, identity: SigningIdentity): ByteArray {
    val messageId = parseUuid(input.messageId, "messageId")
    val reportId = parseUuid(input.reportId, "reportId")
    require(input.revision >= 1) { "revision must be at least 1" }
    require(input.createdAt >= 0) { "createdAt must not be negative" }
    input.expiresAt?.let { require(it >= 0) { "expiresAt must not be negative" } }
    require(input.payload.size in 1..MAX_PAYLOAD_BYTES) { "payload length is out of range" }

    val publicKey = identity.publicKeyDer.copyOf()
    require(publicKey.size in 1..MAX_PUBLIC_KEY_BYTES) { "public key length is out of range" }
    val expectedKeyId = sha256(publicKey)
    val keyId = identity.keyId.copyOf()
    require(keyId.size == SHA256_BYTES && keyId.contentEquals(expectedKeyId)) { "keyId does not match public key" }
    val payloadDigest = sha256(input.payload)

    val unsigned = ByteArrayOutputStream().use { bytes ->
      DataOutputStream(bytes).use { output ->
        output.write(MAGIC)
        output.writeByte(VERSION)
        output.writeByte(SIGNATURE_ALGORITHM_ECDSA_P256_SHA256)
        writeUuid(output, messageId)
        writeUuid(output, reportId)
        output.writeInt(input.revision)
        output.writeLong(input.createdAt)
        output.writeLong(input.expiresAt ?: -1L)
        output.writeInt(input.priority)
        output.write(keyId)
        output.writeShort(publicKey.size)
        output.write(publicKey)
        output.write(payloadDigest)
        output.writeInt(input.payload.size)
        output.write(input.payload)
      }
      bytes.toByteArray()
    }

    val signature = identity.sign(unsigned)
    require(signature.size in 1..MAX_SIGNATURE_BYTES) { "signature length is out of range" }
    require(unsigned.size + 2 + signature.size <= MAX_ENVELOPE_BYTES) { "envelope is too large" }

    return ByteArrayOutputStream(unsigned.size + 2 + signature.size).use { bytes ->
      DataOutputStream(bytes).use { output ->
        output.write(unsigned)
        output.writeShort(signature.size)
        output.write(signature)
      }
      bytes.toByteArray()
    }
  }

  fun decode(bytes: ByteArray): DecodedEnvelopeV1 {
    require(bytes.size <= MAX_ENVELOPE_BYTES) { "envelope is too large" }
    require(bytes.size >= 4 + 2 + 16 + 16 + 4 + 8 + 8 + 4 + SHA256_BYTES + 2 + 1 + SHA256_BYTES + 4 + 1 + 2 + 1) {
      "envelope is truncated"
    }

    try {
      val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
      val magic = ByteArray(MAGIC.size).also(buffer::get)
      require(magic.contentEquals(MAGIC)) { "invalid envelope magic" }
      require(buffer.get().toInt() and 0xff == VERSION) { "unsupported envelope version" }
      require(buffer.get().toInt() and 0xff == SIGNATURE_ALGORITHM_ECDSA_P256_SHA256) {
        "unsupported signature algorithm"
      }

      val messageId = readUuid(buffer).toString()
      val reportId = readUuid(buffer).toString()
      val revision = buffer.int
      require(revision >= 1) { "revision must be at least 1" }
      val createdAt = buffer.long
      require(createdAt >= 0) { "createdAt must not be negative" }
      val expiresAtRaw = buffer.long
      require(expiresAtRaw == -1L || expiresAtRaw >= 0) { "expiresAt is invalid" }
      val priority = buffer.int

      val keyId = readExact(buffer, SHA256_BYTES, "origin key id")
      val publicKeyLength = buffer.short.toInt() and 0xffff
      require(publicKeyLength in 1..MAX_PUBLIC_KEY_BYTES) { "public key length is out of range" }
      val publicKey = readExact(buffer, publicKeyLength, "public key")
      val payloadDigest = readExact(buffer, SHA256_BYTES, "payload digest")
      val payloadLength = buffer.int
      require(payloadLength in 1..MAX_PAYLOAD_BYTES) { "payload length is out of range" }
      val payload = readExact(buffer, payloadLength, "payload")

      val unsignedEnd = buffer.position()
      val signatureLength = buffer.short.toInt() and 0xffff
      require(signatureLength in 1..MAX_SIGNATURE_BYTES) { "signature length is out of range" }
      require(buffer.remaining() == signatureLength) { "trailing or truncated signature bytes" }
      val signature = readExact(buffer, signatureLength, "signature")
      require(!buffer.hasRemaining()) { "trailing envelope bytes" }

      return DecodedEnvelopeV1(
        messageId = messageId,
        reportId = reportId,
        revision = revision,
        createdAt = createdAt,
        expiresAt = if (expiresAtRaw == -1L) null else expiresAtRaw,
        priority = priority,
        originKeyId = keyId,
        originPublicKeyDer = publicKey,
        payloadDigest = payloadDigest,
        payload = payload,
        canonicalUnsignedBody = bytes.copyOfRange(0, unsignedEnd),
        signature = signature,
      )
    } catch (error: BufferUnderflowException) {
      throw IllegalArgumentException("envelope is truncated", error)
    }
  }

  fun verify(envelope: DecodedEnvelopeV1): Boolean = runCatching {
    if (!envelope.originKeyId.contentEquals(sha256(envelope.originPublicKeyDer))) return false
    if (!envelope.payloadDigest.contentEquals(sha256(envelope.payload))) return false

    val publicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(envelope.originPublicKeyDer))
    Signature.getInstance("SHA256withECDSA").run {
      initVerify(publicKey)
      update(envelope.canonicalUnsignedBody)
      verify(envelope.signature)
    }
  }.getOrDefault(false)

  private fun writeUuid(output: DataOutputStream, value: UUID) {
    output.writeLong(value.mostSignificantBits)
    output.writeLong(value.leastSignificantBits)
  }

  private fun readUuid(buffer: ByteBuffer): UUID = UUID(buffer.long, buffer.long)

  private fun parseUuid(value: String, field: String): UUID = try {
    UUID.fromString(value)
  } catch (error: IllegalArgumentException) {
    throw IllegalArgumentException("$field must be a UUID", error)
  }

  private fun readExact(buffer: ByteBuffer, length: Int, field: String): ByteArray {
    require(length >= 0 && buffer.remaining() >= length) { "$field is truncated" }
    return ByteArray(length).also(buffer::get)
  }

  private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
}
