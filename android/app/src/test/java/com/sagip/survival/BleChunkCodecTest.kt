package com.sagip.survival

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BleChunkCodecTest {

  @Test
  fun `splits envelope into sequential SGC1 chunks and encodes valid framing`() {
    val payload = "Testing BLE store-carry-forward envelope chunking protocol for SAGIP".toByteArray()
    val maxChunkSize = 20
    val frames = BleChunkCodec.encodeChunks(payload, maxChunkSize)

    val expectedTotalChunks = (payload.size + maxChunkSize - 1) / maxChunkSize
    assertEquals(expectedTotalChunks, frames.size)

    for (i in frames.indices) {
      val decoded = BleChunkCodec.decodeChunk(frames[i])
      assertEquals(i, decoded.chunkIndex)
      assertEquals(expectedTotalChunks, decoded.totalChunks)
      assertTrue(decoded.data.size <= maxChunkSize)
    }
  }

  @Test
  fun `round trip reassembly reconstructs exact original bytes`() {
    val original = ByteArray(1500) { (it % 256).toByte() }
    val frames = BleChunkCodec.encodeChunks(original, maxPayloadPerChunk = 200)

    val reassembler = BleEnvelopeReassembler()
    var finalResult: ReassemblyResult? = null

    for (frame in frames) {
      finalResult = reassembler.addChunk(frame)
    }

    assertTrue(finalResult is ReassemblyResult.Complete)
    val complete = finalResult as ReassemblyResult.Complete
    assertArrayEquals(original, complete.envelopeBytes)
  }

  @Test
  fun `rejects corrupted CRC32 chunk data`() {
    val data = "Important emergency packet".toByteArray()
    val frames = BleChunkCodec.encodeChunks(data, 100)
    assertEquals(1, frames.size)

    val corrupted = frames[0].copyOf()
    corrupted[10] = (corrupted[10].toInt() xor 0xFF).toByte() // corrupt data byte

    var failed = false
    try {
      BleChunkCodec.decodeChunk(corrupted)
    } catch (e: IllegalArgumentException) {
      failed = true
      assertTrue(e.message!!.contains("CRC"))
    }
    assertTrue("Should have failed on CRC mismatch", failed)
  }

  @Test
  fun `reassembler detects out-of-order chunks and resets`() {
    val original = ByteArray(300) { it.toByte() }
    val frames = BleChunkCodec.encodeChunks(original, maxPayloadPerChunk = 100)
    assertEquals(3, frames.size)

    val reassembler = BleEnvelopeReassembler()
    val first = reassembler.addChunk(frames[0])
    assertTrue(first is ReassemblyResult.InProgress)

    // Skip frame 1 and deliver frame 2 out of order
    val outOfOrder = reassembler.addChunk(frames[2])
    assertTrue(outOfOrder is ReassemblyResult.Failed)
    assertTrue((outOfOrder as ReassemblyResult.Failed).reason.contains("out of order"))
  }

  @Test
  fun `rejects invalid magic bytes`() {
    val badMagic = byteArrayOf('B'.code.toByte(), 'A'.code.toByte(), 'D'.code.toByte(), '1'.code.toByte()) + ByteArray(15)
    var failed = false
    try {
      BleChunkCodec.decodeChunk(badMagic)
    } catch (e: IllegalArgumentException) {
      failed = true
      assertTrue(e.message!!.contains("magic"))
    }
    assertTrue("Should have failed on invalid magic", failed)
  }
}
