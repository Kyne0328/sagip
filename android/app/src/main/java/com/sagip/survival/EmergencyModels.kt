package com.sagip.survival

enum class EmergencyType {
  MEDICAL,
  FLOOD,
  FIRE,
  TRAPPED,
  VIOLENCE,
  OTHER,
}

enum class Urgency {
  IMMEDIATE_DANGER,
  NEED_ASSISTANCE,
}

data class CreateEmergencyReportInput(
  val emergencyType: EmergencyType,
  val urgency: Urgency,
)

data class LocationSnapshot(
  val latitude: Double,
  val longitude: Double,
  val accuracyMeters: Double?,
  val capturedAt: Long,
  val source: String,
  val freshness: String,
)

data class EmergencyReportSummary(
  val reportId: String,
  val createdAt: Long,
  val emergencyType: EmergencyType,
  val urgency: Urgency,
  val lifecycleState: String,
  val deliveryState: String,
  val location: LocationSnapshot?,
  val responderAck: ResponderAck? = null,
)

data class EnvelopePreparationSource(
  val messageId: String,
  val reportId: String,
  val revision: Int,
  val priority: Int,
  val createdAt: Long,
  val expiresAt: Long?,
  val emergencyType: EmergencyType,
  val urgency: Urgency,
  val location: LocationSnapshot?,
)

data class OutboundEnvelopeWork(
  val messageId: String,
  val reportId: String,
  val revision: Int,
  val priority: Int,
  val createdAt: Long,
  val expiresAt: Long?,
  val nextAttemptAt: Long,
  val attemptCount: Int,
  val deliveryState: String,
  val envelopeBytes: ByteArray,
) {
  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is OutboundEnvelopeWork) return false
    return messageId == other.messageId &&
      reportId == other.reportId &&
      revision == other.revision &&
      priority == other.priority &&
      createdAt == other.createdAt &&
      expiresAt == other.expiresAt &&
      nextAttemptAt == other.nextAttemptAt &&
      attemptCount == other.attemptCount &&
      deliveryState == other.deliveryState &&
      envelopeBytes.contentEquals(other.envelopeBytes)
  }

  override fun hashCode(): Int {
    var result = messageId.hashCode()
    result = 31 * result + reportId.hashCode()
    result = 31 * result + revision
    result = 31 * result + priority
    result = 31 * result + createdAt.hashCode()
    result = 31 * result + (expiresAt?.hashCode() ?: 0)
    result = 31 * result + nextAttemptAt.hashCode()
    result = 31 * result + attemptCount
    result = 31 * result + deliveryState.hashCode()
    result = 31 * result + envelopeBytes.contentHashCode()
    return result
  }
}

interface OutboundDeliveryStore {
  fun listDueOutbound(now: Long, limit: Int = 20): List<OutboundEnvelopeWork>
  fun recordAttemptStarted(messageId: String, transport: String, peerIdentifier: String? = null, now: Long = System.currentTimeMillis()): String
  fun recordAttemptCompleted(attemptId: String, outcome: String, retryClassification: String? = null, now: Long = System.currentTimeMillis())
  fun markServerAccepted(receipt: ServerReceipt, now: Long = System.currentTimeMillis())
  fun scheduleRetry(messageId: String, now: Long = System.currentTimeMillis(), jitterUnit: Double = Math.random()): Long
  fun markDeliveryFailed(messageId: String, reason: String? = null, now: Long = System.currentTimeMillis())
}

interface RelayDeliveryStore {
  fun listDueInbound(now: Long, limit: Int = 20): List<InboundEnvelope>
  fun markInboundServerAccepted(messageId: String, now: Long = System.currentTimeMillis())
  fun scheduleInboundRetry(messageId: String, now: Long = System.currentTimeMillis(), jitterUnit: Double = Math.random()): Long
}

interface ResponderAckStore {
  fun listReportsAwaitingAck(limit: Int = 10): List<String>
  fun recordResponderAck(ack: ResponderAck, now: Long = System.currentTimeMillis()): Boolean
}


