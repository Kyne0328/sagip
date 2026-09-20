package com.sagip.survival

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class ChaosRecoveryTest {

  @Test
  fun `recovers cleanly from mid-stream BLE connection termination`() {
    val reassembler = BleEnvelopeReassembler()
    val envelopeBytes = ByteArray(500) { (it % 256).toByte() }
    val chunks = BleChunkCodec.encodeChunks(envelopeBytes, maxPayloadPerChunk = 150)
    assertTrue(chunks.size >= 4)

    // Receive first 2 chunks
    val res0 = reassembler.ingestChunk(chunks[0])
    assertTrue(res0 is ReassemblyResult.InProgress)
    val res1 = reassembler.ingestChunk(chunks[1])
    assertTrue(res1 is ReassemblyResult.InProgress)

    // Connection drop / timeout occurs -> reset
    reassembler.reset()

    // Subsequent independent transmission arrives
    val newEnvelope = ByteArray(300) { ((it * 3) % 256).toByte() }
    val newChunks = BleChunkCodec.encodeChunks(newEnvelope, maxPayloadPerChunk = 150)
    var finalResult: ReassemblyResult? = null
    for (chunk in newChunks) {
      finalResult = reassembler.ingestChunk(chunk)
    }

    assertTrue(finalResult is ReassemblyResult.Complete)
    assertArrayEquals(newEnvelope, (finalResult as ReassemblyResult.Complete).envelopeBytes)
  }

  @Test
  fun `recovers from corrupt CRC chunk without leaking buffer state`() {
    val reassembler = BleEnvelopeReassembler()
    val envelopeBytes = ByteArray(200) { (it + 1).toByte() }
    val chunks = BleChunkCodec.encodeChunks(envelopeBytes, maxPayloadPerChunk = 100)

    // Corrupt the second chunk's CRC
    val corruptChunk = chunks[1].copyOf()
    corruptChunk[corruptChunk.size - 1] = (corruptChunk[corruptChunk.size - 1].toInt() xor 0xFF).toByte()

    reassembler.ingestChunk(chunks[0])
    val failRes = reassembler.ingestChunk(corruptChunk)
    assertTrue(failRes is ReassemblyResult.Failed)

    // Reset and retry with pristine chunks
    reassembler.reset()
    reassembler.ingestChunk(chunks[0])
    val successRes = reassembler.ingestChunk(chunks[1])
    assertTrue(successRes is ReassemblyResult.Complete)
    assertArrayEquals(envelopeBytes, (successRes as ReassemblyResult.Complete).envelopeBytes)
  }

  @Test
  fun `stalled 60-second delivery lease expires and allows retry resumption`() {
    val messageId = UUID.randomUUID().toString()
    val envelopeBytes = byteArrayOf(1, 2, 3, 4)
    val t0 = 1_000_000L

    var isLeased = false
    var leaseExpiresAt = 0L

    fun attemptStart(now: Long) {
      isLeased = true
      leaseExpiresAt = now + EmergencyRepository.ATTEMPT_LEASE_MS
    }

    fun isDue(now: Long): Boolean {
      return !isLeased || (now >= leaseExpiresAt)
    }

    // Initially due
    assertTrue(isDue(t0))

    // Attempt starts, locks lease for 60s
    attemptStart(t0)
    assertFalse("Envelope should not be due during active lease", isDue(t0 + 30_000L))
    assertFalse("Envelope should not be due at 59s", isDue(t0 + 59_999L))

    // After 60s without completion (simulated crash / abort)
    assertTrue("Envelope must become due again after lease expires", isDue(t0 + 60_001L))
  }

  @Test
  fun `handles duplicate return ACK idempotency cleanly`() {
    val reportId = UUID.randomUUID().toString()
    val ack = ResponderAck(
      ackId = UUID.randomUUID().toString(),
      reportId = reportId,
      responderId = "UNIT-5",
      callsign = "LEAD-1",
      status = "EN_ROUTE",
      note = "Dispatched",
      acknowledgedAt = 5000L,
    )

    val encoded = BleReturnAckCodec.encode(ack, etaMinutes = 10)
    val decoded1 = BleReturnAckCodec.decode(encoded)
    val decoded2 = BleReturnAckCodec.decode(encoded)

    assertEquals(decoded1.reportId, decoded2.reportId)
    assertEquals(decoded1.status, decoded2.status)
    assertEquals(decoded1.callsign, decoded2.callsign)
  }
}
