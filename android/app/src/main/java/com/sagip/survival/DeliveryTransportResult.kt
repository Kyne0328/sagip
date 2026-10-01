package com.sagip.survival

sealed interface DeliveryTransportResult {
    data class Accepted(val receipt: ServerReceipt) : DeliveryTransportResult
    data class RetryableFailure(
        val reason: String,
        val minimumRetryDelayMs: Long? = null,
    ) : DeliveryTransportResult
    data class PermanentFailure(val reason: String) : DeliveryTransportResult
}
