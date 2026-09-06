package com.sagip.survival

import org.junit.Assert.assertThrows
import org.junit.Test

class TransportReadinessTest {
  @Test
  fun `rejects transport attempt when envelope is not ready`() {
    assertThrows(IllegalArgumentException::class.java) {
      TransportReadiness.requireReady(
        preparationState = EmergencyRepository.PREPARATION_NEEDS,
        envelopeBytes = null,
      )
    }
  }

  @Test
  fun `accepts ready envelope with persisted bytes`() {
    TransportReadiness.requireReady(
      preparationState = EmergencyRepository.PREPARATION_READY,
      envelopeBytes = byteArrayOf(1),
    )
  }

  @Test
  fun `rejects ready state without persisted bytes`() {
    assertThrows(IllegalArgumentException::class.java) {
      TransportReadiness.requireReady(
        preparationState = EmergencyRepository.PREPARATION_READY,
        envelopeBytes = null,
      )
    }
  }

  @Test
  fun `rejects transport attempt before retry lease is due`() {
    assertThrows(IllegalArgumentException::class.java) {
      TransportReadiness.requireAttemptable(
        preparationState = EmergencyRepository.PREPARATION_READY,
        envelopeBytes = byteArrayOf(1),
        deliveryState = EmergencyRepository.DELIVERY_PENDING,
        nextAttemptAt = 2_000L,
        expiresAt = null,
        now = 1_999L,
      )
    }
  }

  @Test
  fun `rejects expired transport attempt`() {
    assertThrows(IllegalArgumentException::class.java) {
      TransportReadiness.requireAttemptable(
        preparationState = EmergencyRepository.PREPARATION_READY,
        envelopeBytes = byteArrayOf(1),
        deliveryState = EmergencyRepository.DELIVERY_PENDING,
        nextAttemptAt = 1_000L,
        expiresAt = 1_500L,
        now = 1_500L,
      )
    }
  }

  @Test
  fun `accepts ready pending due unexpired transport attempt`() {
    TransportReadiness.requireAttemptable(
      preparationState = EmergencyRepository.PREPARATION_READY,
      envelopeBytes = byteArrayOf(1),
      deliveryState = EmergencyRepository.DELIVERY_PENDING,
      nextAttemptAt = 1_000L,
      expiresAt = 2_000L,
      now = 1_500L,
    )
  }
}
