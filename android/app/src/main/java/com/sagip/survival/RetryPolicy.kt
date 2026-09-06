package com.sagip.survival

import kotlin.math.min

object RetryPolicy {
  const val BASE_DELAY_MS = 5_000L
  const val MAX_DELAY_MS = 5 * 60_000L

  fun delayMs(attemptNumber: Int, jitterUnit: Double): Long {
    require(attemptNumber >= 1) { "attemptNumber must be at least 1" }
    require(jitterUnit in 0.0..1.0) { "jitterUnit must be between 0 and 1" }

    val exponent = (attemptNumber - 1).coerceAtMost(20)
    val exponentialDelay = min(MAX_DELAY_MS, BASE_DELAY_MS * (1L shl exponent))
    val jitterFactor = 0.8 + (jitterUnit * 0.4)
    return min(MAX_DELAY_MS, (exponentialDelay * jitterFactor).toLong())
  }

  fun nextAttemptAt(now: Long, attemptNumber: Int, jitterUnit: Double): Long =
    now + delayMs(attemptNumber, jitterUnit)
}
