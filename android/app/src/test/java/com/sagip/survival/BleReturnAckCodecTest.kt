package com.sagip.survival

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class BleReturnAckCodecTest {

  @Test
  fun `encodes and decodes SGA1 return ACK accurately`() {
    val reportId = UUID.randomUUID().toString()
    val ack = ResponderAck(
      ackId = UUID.randomUUID().toString(),
      reportId = reportId,
      responderId = "MED-DISPATCH-99",
      callsign = "RESCUE-LEAD-1",
      status = "EN_ROUTE",
      note = "Dispatched via fast-boat",
      acknowledgedAt = 1774000000000L,
    )

    val encoded = BleReturnAckCodec.encode(ack, etaMinutes = 25)
    assertEquals(56, encoded.size)
    assertEquals('S'.code.toByte(), encoded[0])
    assertEquals('G'.code.toByte(), encoded[1])
    assertEquals('A'.code.toByte(), encoded[2])
    assertEquals('1'.code.toByte(), encoded[3])

    val decoded = BleReturnAckCodec.decode(encoded)
    assertEquals(reportId, decoded.reportId)
    assertEquals("RESCUE-LEAD-1", decoded.callsign)
    assertEquals("EN_ROUTE", decoded.status)
    assertEquals(1774000000000L, decoded.acknowledgedAt)
    assertNotNull(decoded.note)
    assertTrue(decoded.note!!.contains("25 mins"))
  }

  @Test
  fun `handles all 4 responder status codes roundtrip`() {
    val statuses = listOf("ACKNOWLEDGED", "EN_ROUTE", "ON_SCENE", "RESOLVED")
    for (status in statuses) {
      val reportId = UUID.randomUUID().toString()
      val ack = ResponderAck(
        ackId = UUID.randomUUID().toString(),
        reportId = reportId,
        responderId = "UNIT-1",
        callsign = "CALLSIGN",
        status = status,
        note = null,
        acknowledgedAt = System.currentTimeMillis(),
      )
      val encoded = BleReturnAckCodec.encode(ack, etaMinutes = 0)
      val decoded = BleReturnAckCodec.decode(encoded)
      assertEquals(status, decoded.status)
      assertEquals(reportId, decoded.reportId)
    }
  }

  @Test
  fun `rejects corrupted CRC32 checksum`() {
    val ack = ResponderAck(
      ackId = UUID.randomUUID().toString(),
      reportId = UUID.randomUUID().toString(),
      responderId = "UNIT-1",
      callsign = "LEAD",
      status = "ACKNOWLEDGED",
      note = null,
      acknowledgedAt = 1000L,
    )
    val encoded = BleReturnAckCodec.encode(ack)
    // Mutate a byte in the payload
    encoded[10] = (encoded[10].toInt() xor 0xFF).toByte()

    assertThrows(IllegalArgumentException::class.java) {
      BleReturnAckCodec.decode(encoded)
    }
  }

  @Test
  fun `rejects invalid magic header`() {
    val ack = ResponderAck(
      ackId = UUID.randomUUID().toString(),
      reportId = UUID.randomUUID().toString(),
      responderId = "UNIT-1",
      callsign = "LEAD",
      status = "ACKNOWLEDGED",
      note = null,
      acknowledgedAt = 1000L,
    )
    val encoded = BleReturnAckCodec.encode(ack)
    encoded[0] = 'X'.code.toByte()

    assertThrows(IllegalArgumentException::class.java) {
      BleReturnAckCodec.decode(encoded)
    }
  }

  @Test
  fun `rejects invalid frame sizes`() {
    assertThrows(IllegalArgumentException::class.java) {
      BleReturnAckCodec.decode(ByteArray(55))
    }
    assertThrows(IllegalArgumentException::class.java) {
      BleReturnAckCodec.decode(ByteArray(57))
    }
  }
}
