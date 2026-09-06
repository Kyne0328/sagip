package com.sagip.survival

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HttpEnvelopeSenderTest {

  @Test
  fun `parses canonical server receipt JSON correctly`() {
    val json = """
      {
        "receiptVersion": 1,
        "state": "SERVER_ACCEPTED",
        "receiptId": "11111111-1111-1111-1111-111111111111",
        "messageId": "22222222-2222-2222-2222-222222222222",
        "reportId": "33333333-3333-3333-3333-333333333333",
        "revision": 1,
        "acceptedAt": "2026-09-05T20:00:00.000Z"
      }
    """.trimIndent()

    val receipt = HttpEnvelopeSender.parseServerReceipt(json)

    assertEquals(1, receipt.receiptVersion)
    assertEquals("SERVER_ACCEPTED", receipt.state)
    assertEquals("11111111-1111-1111-1111-111111111111", receipt.receiptId)
    assertEquals("22222222-2222-2222-2222-222222222222", receipt.messageId)
    assertEquals("33333333-3333-3333-3333-333333333333", receipt.reportId)
    assertEquals(1, receipt.revision)
    assertEquals("2026-09-05T20:00:00.000Z", receipt.acceptedAt)
  }

  @Test
  fun `OutboundEnvelope supports content equality and hashCode`() {
    val env1 = OutboundEnvelope("msg-1", byteArrayOf(1, 2, 3))
    val env2 = OutboundEnvelope("msg-1", byteArrayOf(1, 2, 3))
    val env3 = OutboundEnvelope("msg-1", byteArrayOf(1, 2, 4))
    val env4 = OutboundEnvelope("msg-2", byteArrayOf(1, 2, 3))

    assertEquals(env1, env2)
    assertEquals(env1.hashCode(), env2.hashCode())
    assertNotEquals(env1, env3)
    assertNotEquals(env1, env4)
  }
}
