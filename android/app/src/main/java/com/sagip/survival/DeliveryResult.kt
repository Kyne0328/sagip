package com.sagip.survival

sealed interface DeliveryResult {
  data class Accepted(val receipt: ServerReceipt) : DeliveryResult
  data class RetryableFailure(val classification: String) : DeliveryResult
  data class PermanentFailure(val classification: String) : DeliveryResult
}
