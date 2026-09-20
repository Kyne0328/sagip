package com.sagip.survival

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class BleManifestHandshakeTest {

  @Test
  fun `encodes and decodes manifest offer accurately`() {
    val messageId = UUID.randomUUID()
    val digest = ByteArray(32) { (it + 1).toByte() }

    val encoded = BleProtocolConstants.encodeOffer(messageId, digest)
    assertEquals(BleProtocolConstants.OFFER_PAYLOAD_SIZE, encoded.size)

    val decoded = BleProtocolConstants.decodeOffer(encoded)
    assertEquals(1, decoded.protocolVersion)
    assertEquals(messageId.toString(), decoded.messageId)
    assertArrayEquals(digest, decoded.payloadDigest)
  }

  @Test
  fun `encodes and decodes durable ACK accurately`() {
    val messageId = UUID.randomUUID()
    val receiptId = UUID.randomUUID()
    val now = System.currentTimeMillis()

    val encoded = BleProtocolConstants.encodeAck(messageId, receiptId, now)
    assertEquals(BleProtocolConstants.ACK_PAYLOAD_SIZE, encoded.size)

    val decoded = BleProtocolConstants.decodeAck(encoded)
    assertEquals(messageId, decoded.first)
    assertEquals(receiptId, decoded.second)
    assertEquals(now, decoded.third)
  }

  @Test
  fun `rejects malformed offer or ack payloads`() {
    var offerFailed = false
    try {
      BleProtocolConstants.decodeOffer(ByteArray(10))
    } catch (e: IllegalArgumentException) {
      offerFailed = true
    }
    assertTrue("Should fail on short offer", offerFailed)

    var ackFailed = false
    try {
      BleProtocolConstants.decodeAck(ByteArray(20))
    } catch (e: IllegalArgumentException) {
      ackFailed = true
    }
    assertTrue("Should fail on short ack", ackFailed)
  }
}
