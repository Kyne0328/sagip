package com.sagip.survival

import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class BestEffortPreparationTest {
  @Test
  fun `post commit preparation failure preserves committed result`() {
    val committed = Any()
    var attempted = false

    val result = BestEffortPreparation.afterCommit(committed) {
      attempted = true
      throw IllegalStateException("simulated Keystore failure")
    }

    assertTrue(attempted)
    assertSame(committed, result)
  }
}
