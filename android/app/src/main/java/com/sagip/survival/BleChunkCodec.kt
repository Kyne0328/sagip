package com.sagip.survival

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.CRC32

data class BleChunkFrame(
  val chunkIndex: Int,
  val totalChunks: Int,
  val data: ByteArray,
  val crc32: Long,
) {
  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is BleChunkFrame) return false
    return chunkIndex == other.chunkIndex &&
      totalChunks == other.totalChunks &&
      data.contentEquals(other.data) &&
      crc32 == other.crc32
  }

  override fun hashCode(): Int {
    var result = chunkIndex
    result = 31 * result + totalChunks
    result = 31 * result + data.contentHashCode()
    result = 31 * result + crc32.hashCode()
    return result
  }
}

sealed class ReassemblyResult {
  data class InProgress(val receivedChunks: Int, val totalChunks: Int) : ReassemblyResult()
  data class Complete(val envelopeBytes: ByteArray) : ReassemblyResult() {
    override fun equals(other: Any?): Boolean {
      if (this === other) return true
      if (other !is Complete) return false
      return envelopeBytes.contentEquals(other.envelopeBytes)
    }

    override fun hashCode(): Int = envelopeBytes.contentHashCode()
  }
  data class Failed(val reason: String) : ReassemblyResult()
}

object BleChunkCodec {
  val MAGIC = byteArrayOf('S'.code.toByte(), 'G'.code.toByte(), 'C'.code.toByte(), '1'.code.toByte())
  const val FRAME_OVERHEAD = 14
  const val MAX_ENVELOPE_SIZE = 8192

  fun encodeChunks(envelopeBytes: ByteArray, maxPayloadPerChunk: Int = 240): List<ByteArray> {
    require(envelopeBytes.isNotEmpty()) { "Envelope bytes must not be empty" }
    require(envelopeBytes.size <= MAX_ENVELOPE_SIZE) { "Envelope exceeds max size of $MAX_ENVELOPE_SIZE bytes" }
    require(maxPayloadPerChunk >= 16) { "maxPayloadPerChunk must be at least 16" }

    val totalChunks = (envelopeBytes.size + maxPayloadPerChunk - 1) / maxPayloadPerChunk
    require(totalChunks <= 256) { "Total chunks exceeds 256" }

    val frames = mutableListOf<ByteArray>()
    var offset = 0
    for (chunkIndex in 0 until totalChunks) {
      val chunkSize = minOf(maxPayloadPerChunk, envelopeBytes.size - offset)
      val chunkData = envelopeBytes.copyOfRange(offset, offset + chunkSize)
      offset += chunkSize

      val crc = CRC32()
      crc.update(chunkData)
      val crcValue = crc.value

      val buffer = ByteBuffer.allocate(FRAME_OVERHEAD + chunkSize)
      buffer.order(ByteOrder.BIG_ENDIAN)
      buffer.put(MAGIC)
      buffer.putShort(chunkIndex.toShort())
      buffer.putShort(totalChunks.toShort())
      buffer.putShort(chunkSize.toShort())
      buffer.put(chunkData)
      buffer.putInt(crcValue.toInt())

      frames.add(buffer.array())
    }
    return frames
  }

  fun decodeChunk(frameBytes: ByteArray): BleChunkFrame {
    require(frameBytes.size >= FRAME_OVERHEAD) { "Frame size too small: ${frameBytes.size}" }
    val buffer = ByteBuffer.wrap(frameBytes).order(ByteOrder.BIG_ENDIAN)

    val magicBytes = ByteArray(4)
    buffer.get(magicBytes)
    require(magicBytes.contentEquals(MAGIC)) { "Invalid chunk magic" }

    val chunkIndex = buffer.short.toInt() and 0xFFFF
    val totalChunks = buffer.short.toInt() and 0xFFFF
    val dataLength = buffer.short.toInt() and 0xFFFF

    require(totalChunks in 1..256) { "Invalid total chunks: $totalChunks" }
    require(chunkIndex < totalChunks) { "Chunk index $chunkIndex >= totalChunks $totalChunks" }
    require(frameBytes.size == FRAME_OVERHEAD + dataLength) {
      "Frame length mismatch: expected ${FRAME_OVERHEAD + dataLength}, got ${frameBytes.size}"
    }

    val chunkData = ByteArray(dataLength)
    buffer.get(chunkData)

    val expectedCrc = buffer.int.toLong() and 0xFFFFFFFFL
    val crc = CRC32()
    crc.update(chunkData)
    val actualCrc = crc.value
    require(actualCrc == expectedCrc) {
      "CRC mismatch: expected $expectedCrc, got $actualCrc"
    }

    return BleChunkFrame(chunkIndex, totalChunks, chunkData, actualCrc)
  }
}

class BleEnvelopeReassembler {
  private var expectedIndex = 0
  private var expectedTotal = -1
  private val accumulated = ByteArrayOutputStream()

  fun addChunk(frameBytes: ByteArray): ReassemblyResult {
    val frame = try {
      BleChunkCodec.decodeChunk(frameBytes)
    } catch (e: Exception) {
      reset()
      return ReassemblyResult.Failed("Malformed chunk: ${e.message}")
    }

    if (expectedTotal == -1) {
      expectedTotal = frame.totalChunks
    } else if (frame.totalChunks != expectedTotal) {
      reset()
      return ReassemblyResult.Failed("Inconsistent totalChunks: expected $expectedTotal, got ${frame.totalChunks}")
    }

    if (frame.chunkIndex != expectedIndex) {
      val err = "Chunk out of order: expected $expectedIndex, got ${frame.chunkIndex}"
      reset()
      return ReassemblyResult.Failed(err)
    }

    accumulated.write(frame.data)
    expectedIndex++

    return if (expectedIndex == expectedTotal) {
      val completeBytes = accumulated.toByteArray()
      reset()
      ReassemblyResult.Complete(completeBytes)
    } else {
      ReassemblyResult.InProgress(expectedIndex, expectedTotal)
    }
  }

  fun reset() {
    expectedIndex = 0
    expectedTotal = -1
    accumulated.reset()
  }
}
