package com.sagip.survival

data class VerifiedTransportEnvelope(
  val protocolVersion: Int,
  val messageId: String,
  val reportId: String,
  val revision: Int,
  val priority: Int,
  val payloadDigest: ByteArray,
  val originKeyId: ByteArray,
)

object TransportEnvelope {
  private val SGP1_MAGIC = byteArrayOf('S'.code.toByte(), 'G'.code.toByte(), 'P'.code.toByte(), '1'.code.toByte())
  private val SGP2_MAGIC = byteArrayOf('S'.code.toByte(), 'G'.code.toByte(), 'P'.code.toByte(), '2'.code.toByte())

  fun decodeAndVerify(bytes: ByteArray): VerifiedTransportEnvelope {
    require(bytes.size <= TransportEnvelopeV1.MAX_ENVELOPE_BYTES) { "envelope is too large" }
    require(bytes.size >= 4) { "envelope is truncated" }
    return when {
      bytes.startsWith(SGP1_MAGIC) -> {
        val decoded = TransportEnvelopeV1.decode(bytes)
        require(TransportEnvelopeV1.verify(decoded)) { "SGP1 signature or digest verification failed" }
        VerifiedTransportEnvelope(
          protocolVersion = 1,
          messageId = decoded.messageId,
          reportId = decoded.reportId,
          revision = decoded.revision,
          priority = decoded.priority,
          payloadDigest = decoded.payloadDigest.copyOf(),
          originKeyId = decoded.originKeyId.copyOf(),
        )
      }
      bytes.startsWith(SGP2_MAGIC) -> {
        val decoded = TransportEnvelopeV2.decode(bytes)
        require(TransportEnvelopeV2.verify(decoded)) { "SGP2 signature or digest verification failed" }
        VerifiedTransportEnvelope(
          protocolVersion = 2,
          messageId = decoded.messageId,
          reportId = decoded.reportId,
          revision = decoded.revision,
          priority = decoded.priority,
          payloadDigest = decoded.payloadDigest.copyOf(),
          originKeyId = decoded.originKeyId.copyOf(),
        )
      }
      else -> throw IllegalArgumentException("unsupported transport envelope magic")
    }
  }

  private fun ByteArray.startsWith(prefix: ByteArray): Boolean {
    if (size < prefix.size) return false
    return prefix.indices.all { this[it] == prefix[it] }
  }
}
