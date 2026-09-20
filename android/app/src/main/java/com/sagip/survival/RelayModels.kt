package com.sagip.survival

data class InboundEnvelope(
  val inboundId: String,
  val messageId: String,
  val envelopeBytes: ByteArray,
  val receivedAt: Long,
  val originKeyId: ByteArray,
  val priority: Int = 100,
  val deliveryState: String = "DELIVERY_PENDING",
  val nextAttemptAt: Long = 0,
  val attemptCount: Int = 0,
) {
  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is InboundEnvelope) return false
    return inboundId == other.inboundId &&
      messageId == other.messageId &&
      envelopeBytes.contentEquals(other.envelopeBytes) &&
      receivedAt == other.receivedAt &&
      originKeyId.contentEquals(other.originKeyId) &&
      priority == other.priority &&
      deliveryState == other.deliveryState &&
      nextAttemptAt == other.nextAttemptAt &&
      attemptCount == other.attemptCount
  }

  override fun hashCode(): Int {
    var result = inboundId.hashCode()
    result = 31 * result + messageId.hashCode()
    result = 31 * result + envelopeBytes.contentHashCode()
    result = 31 * result + receivedAt.hashCode()
    result = 31 * result + originKeyId.contentHashCode()
    result = 31 * result + priority
    result = 31 * result + deliveryState.hashCode()
    result = 31 * result + nextAttemptAt.hashCode()
    result = 31 * result + attemptCount
    return result
  }
}

data class RelayReceipt(
  val receiptId: String,
  val messageId: String,
  val peerIdentifier: String,
  val acknowledgedAt: Long,
)

data class BleManifestOffer(
  val protocolVersion: Int,
  val messageId: String,
  val payloadDigest: ByteArray,
) {
  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is BleManifestOffer) return false
    return protocolVersion == other.protocolVersion &&
      messageId == other.messageId &&
      payloadDigest.contentEquals(other.payloadDigest)
  }

  override fun hashCode(): Int {
    var result = protocolVersion
    result = 31 * result + messageId.hashCode()
    result = 31 * result + payloadDigest.contentHashCode()
    return result
  }
}

enum class OfferDecision(val code: Byte) {
  ACCEPT(0x01),
  ALREADY_HAVE(0x02),
  CAPACITY_FULL(0x03),
  REJECT_UNSUPPORTED(0xFF.toByte());

  companion object {
    fun fromCode(code: Byte): OfferDecision = when (code) {
      0x01.toByte() -> ACCEPT
      0x02.toByte() -> ALREADY_HAVE
      0x03.toByte() -> CAPACITY_FULL
      else -> REJECT_UNSUPPORTED
    }
  }
}

sealed class InboundPersistResult {
  data class Stored(val inboundId: String, val messageId: String) : InboundPersistResult()
  data class DuplicateIgnored(val messageId: String) : InboundPersistResult()
  data class ValidationFailed(val reason: String) : InboundPersistResult()
}
