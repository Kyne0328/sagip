package com.sagip.survival

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RetryPolicyTest {
  @Test
  fun `backoff doubles and applies bounded jitter`() {
    assertEquals(4_000L, RetryPolicy.delayMs(attemptNumber = 1, jitterUnit = 0.0))
    assertEquals(5_000L, RetryPolicy.delayMs(attemptNumber = 1, jitterUnit = 0.5))
    assertEquals(6_000L, RetryPolicy.delayMs(attemptNumber = 1, jitterUnit = 1.0))
    assertEquals(10_000L, RetryPolicy.delayMs(attemptNumber = 2, jitterUnit = 0.5))
  }

  @Test
  fun `backoff is capped`() {
    assertTrue(RetryPolicy.delayMs(attemptNumber = 20, jitterUnit = 1.0) <= RetryPolicy.MAX_DELAY_MS)
  }

  @Test(expected = IllegalArgumentException::class)
  fun `attempt number must be positive`() {
    RetryPolicy.delayMs(attemptNumber = 0, jitterUnit = 0.5)
  }
}
