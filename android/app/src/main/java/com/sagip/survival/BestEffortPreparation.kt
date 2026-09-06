package com.sagip.survival

internal object BestEffortPreparation {
  fun <T> afterCommit(
    committed: T,
    preparation: () -> Unit,
  ): T {
    try {
      preparation()
    } catch (_: Exception) {
      // A committed SOS remains successful even when envelope preparation is unavailable.
    }
    return committed
  }
}
