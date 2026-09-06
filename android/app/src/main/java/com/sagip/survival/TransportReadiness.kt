package com.sagip.survival

internal object TransportReadiness {
  fun requireReady(
    preparationState: String,
    envelopeBytes: ByteArray?,
  ) {
    require(preparationState == EmergencyRepository.PREPARATION_READY) {
      "Outbound envelope is not ready for transport"
    }
    require(envelopeBytes != null && envelopeBytes.isNotEmpty()) {
      "READY outbound envelope has no persisted bytes"
    }
  }

  fun requireAttemptable(
    preparationState: String,
    envelopeBytes: ByteArray?,
    deliveryState: String,
    nextAttemptAt: Long,
    expiresAt: Long?,
    now: Long,
  ) {
    requireReady(preparationState, envelopeBytes)
    require(deliveryState == EmergencyRepository.DELIVERY_PENDING) {
      "Outbound envelope is not pending delivery"
    }
    require(nextAttemptAt <= now) {
      "Outbound envelope retry lease is not due"
    }
    require(expiresAt == null || expiresAt > now) {
      "Outbound envelope has expired"
    }
  }
}
