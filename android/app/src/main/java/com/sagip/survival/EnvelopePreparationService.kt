package com.sagip.survival

data class PreparationBatchResult(
  val prepared: Int,
  val failed: Int,
)

class EnvelopePreparationService(
  private val repository: EmergencyRepository,
  private val identity: SigningIdentity,
) {
  fun preparePending(limit: Int = 20): PreparationBatchResult {
    require(limit in 1..100) { "limit must be between 1 and 100" }
    var prepared = 0
    var failed = 0

    repository.listEnvelopePreparationSources(limit).forEach { source ->
      try {
        val payload = EmergencyPayloadV1.encode(
          emergencyType = source.emergencyType,
          urgency = source.urgency,
          location = source.location,
        )
        val envelope = TransportEnvelopeV1.create(
          EnvelopeUnsignedInput(
            messageId = source.messageId,
            reportId = source.reportId,
            revision = source.revision,
            createdAt = source.createdAt,
            expiresAt = source.expiresAt,
            priority = source.priority,
            payload = payload,
          ),
          identity,
        )
        repository.markEnvelopeReady(source.messageId, envelope)
        prepared += 1
      } catch (_: Exception) {
        failed += 1
      }
    }

    return PreparationBatchResult(prepared = prepared, failed = failed)
  }
}
