package com.sagip.survival

import java.io.File
import org.junit.Assert.*
import org.junit.Test

class ReceiptV2CodecTest {
  private data class Vector(val name: String, val bytes: ByteArray, val key: ByteArray, val accepts: Boolean, val signatureValid: Boolean)
  private fun hex(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
  private fun vectors(): List<Vector> {
    val file = listOf(File("../sagip-docs/fixtures/receipts-v2/golden.json"), File("../../sagip-docs/fixtures/receipts-v2/golden.json")).first { it.isFile }
    val text = file.readText()
    // Narrow fixture extraction; no Android JSON runtime is available in JVM tests.
    val matches = Regex("\\\"name\\\": \\\"([^\\\"]+)\\\",\\s*\\\"hex\\\": \\\"([0-9a-f]+)\\\"").findAll(text).toList()
    return matches.mapIndexed { i, m ->
      val tail = text.substring(m.range.last + 1, matches.getOrNull(i + 1)?.range?.first ?: text.length)
      val key = Regex("\\\"publicKeyDerHex\\\": \\\"([0-9a-f]+)\\\"").find(tail)!!.groupValues[1]
      val parse = Regex("\\\"parse\\\": \\\"(ACCEPT|REJECT)\\\"").find(tail)!!.groupValues[1]
      val signature = Regex("\\\"signature\\\": (true|false)").find(tail)?.groupValues?.get(1) == "true"
      Vector(m.groupValues[1], hex(m.groupValues[2]), hex(key), parse == "ACCEPT", signature)
    }
  }
  @Test fun sharedGoldenRoundTripAndRejections() {
    val fixtures = vectors()
    assertEquals(19, fixtures.size)
    fixtures.forEach { v ->
      if (!v.accepts) {
        assertThrows(v.name, IllegalArgumentException::class.java) { ReceiptV2Codec.decode(v.bytes) }
      } else {
        val decoded = ReceiptV2Codec.decode(v.bytes)
        assertArrayEquals(v.name, v.bytes, ReceiptV2Codec.encode(decoded.fields, decoded.signature, decoded.proof))
        assertEquals(v.name, v.signatureValid, ReceiptV2Codec.verifySignature(decoded, v.key))
      }
    }
  }
  @Test fun semanticMutationAndEncoderBounds() {
    val v = vectors().first { it.name == "valid_cloud_ack" }
    val decoded = ReceiptV2Codec.decode(v.bytes)
    val fields = decoded.fields as ReceiptFields.Responder
    assertFalse(ReceiptV2Codec.verifySignature(decoded.copy(fields = fields.copy(status = 2)), v.key))
    assertThrows(IllegalArgumentException::class.java) { ReceiptV2Codec.encode(fields.copy(note = "x".repeat(1025)), decoded.signature, decoded.proof) }
    assertThrows(IllegalArgumentException::class.java) { ReceiptV2Codec.encode(fields.copy(note = "\uD800"), decoded.signature, decoded.proof) }
    assertThrows(IllegalArgumentException::class.java) { ReceiptV2Codec.decode(ByteArray(8193)) }
    assertFalse(ReceiptV2Codec.verifySignature(decoded, ByteArray(91)))
  }

  @Test fun hostileFieldsProofDepthAndBom() {
    val raw = vectors().first { it.name == "valid_cloud_ack" }.bytes
    fun reject(mutate: (ByteArray) -> Unit) {
      val b = raw.copyOf(); mutate(b)
      assertThrows(IllegalArgumentException::class.java) { ReceiptV2Codec.decode(b) }
    }
    reject { it[0] = (it[0].toInt() or 128).toByte() }
    reject { it.fill(0, 49, 65) }
    reject { it[113] = 3 }
    val callsignSize = ((raw[246].toInt() and 255) shl 8) or (raw[247].toInt() and 255)
    val status = 248 + callsignSize + 8
    reject { it[status] = 0 }
    reject { it.fill(255.toByte(), status + 1, status + 9) }
    reject { it[status + 27] = 0xc0.toByte() }
    val grant = vectors().first { it.name == "valid_grant" }.bytes
    val badKey = grant.copyOf(); badKey.fill(0, 123, 187)
    assertThrows(IllegalArgumentException::class.java) { ReceiptV2Codec.decode(badKey) }
    val nested = byteArrayOf(1, (grant.size shr 8).toByte(), grant.size.toByte()) + grant
    val nestedGrant = grant.copyOfRange(0, grant.size - 64) + nested + grant.copyOfRange(grant.size - 64, grant.size)
    nestedGrant[10] = (nested.size shr 8).toByte(); nestedGrant[11] = nested.size.toByte()
    val proof = byteArrayOf(1, (nestedGrant.size shr 8).toByte(), nestedGrant.size.toByte()) + nestedGrant
    val offline = ReceiptV2Codec.decode(vectors().first { it.name == "valid_offline_ack" }.bytes)
    assertThrows(IllegalArgumentException::class.java) { ReceiptV2Codec.encode(offline.fields, offline.signature, proof) }
    val decoded = ReceiptV2Codec.decode(raw)
    val fields = (decoded.fields as ReceiptFields.Responder).copy(note = "\uFEFFnotice")
    val encoded = ReceiptV2Codec.encode(fields, decoded.signature, decoded.proof)
    assertEquals("\uFEFFnotice", (ReceiptV2Codec.decode(encoded).fields as ReceiptFields.Responder).note)
  }

}
