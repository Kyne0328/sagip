package com.sagip.survival

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class EmergencyDeliveryJobServiceTest {
  @Test
  fun `background delivery prepares committed rows before selecting transport work`() = runBlocking {
    val calls = mutableListOf<String>()

    val delivered = prepareThenRunDelivery(
      preparePending = { calls += "prepare" },
      runDelivery = {
        calls += "deliver"
        3
      },
    )

    assertEquals(listOf("prepare", "deliver"), calls)
    assertEquals(3, delivered)
  }

  @Test
  fun `preparation failure prevents transport from running`() = runBlocking {
    val calls = mutableListOf<String>()

    runCatching {
      prepareThenRunDelivery(
        preparePending = {
          calls += "prepare"
          error("preparation failed")
        },
        runDelivery = {
          calls += "deliver"
          1
        },
      )
    }

    assertEquals(listOf("prepare"), calls)
  }
}
