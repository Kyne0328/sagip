package com.sagip.survival

import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class TransportEnvelopeV1Test {
  private val payload = hex("5352503101010100")

  @Test
  fun `creates exact canonical signed envelope field order`() {
    val identity = FixedSigningIdentity(byteArrayOf(1, 2, 3), byteArrayOf(0x30, 0x00))
    val bytes = TransportEnvelopeV1.create(
      EnvelopeUnsignedInput(
        messageId = "00000000-0000-0000-0000-000000000001",
        reportId = "00000000-0000-0000-0000-000000000002",
        revision = 1,
        createdAt = 1000L,
        expiresAt = null,
        priority = 0,
        payload = payload,
      ),
      identity,
    )

    val expectedUnsigned =
      "534750310101" +
        "00000000000000000000000000000001" +
        "00000000000000000000000000000002" +
        "00000001" +
        "00000000000003e8" +
        "ffffffffffffffff" +
        "00000000" +
        "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81" +
        "0003" +
        "010203" +
        "59e7a04bc21b40e90cd86d92d2d41ce93196b26d0da7112c5b689e4647bee7fc" +
        "00000008" +
        "5352503101010100"
    assertEquals(expectedUnsigned, identity.lastSignedData!!.toHex())
    assertEquals(expectedUnsigned + "00023000", bytes.toHex())

    val decoded = TransportEnvelopeV1.decode(bytes)
    assertEquals("00000000-0000-0000-0000-000000000001", decoded.messageId)
    assertEquals("00000000-0000-0000-0000-000000000002", decoded.reportId)
    assertEquals(1, decoded.revision)
    assertEquals(1000L, decoded.createdAt)
    assertEquals(null, decoded.expiresAt)
    assertEquals(0, decoded.priority)
    assertEquals(expectedUnsigned, decoded.canonicalUnsignedBody.toHex())
    assertEquals("3000", decoded.signature.toHex())
  }

  @Test
  fun `verifies valid EC signature and rejects corrupted body`() {
    val identity = JvmEcSigningIdentity()
    val bytes = TransportEnvelopeV1.create(
      EnvelopeUnsignedInput(
        messageId = "11111111-1111-1111-1111-111111111111",
        reportId = "22222222-2222-2222-2222-222222222222",
        revision = 3,
        createdAt = 5000L,
        expiresAt = 9000L,
        priority = 10,
        payload = payload,
      ),
      identity,
    )

    assertTrue(TransportEnvelopeV1.verify(TransportEnvelopeV1.decode(bytes)))

    val corrupted = bytes.copyOf().also { it[20] = (it[20].toInt() xor 0x01).toByte() }
    assertFalse(TransportEnvelopeV1.verify(TransportEnvelopeV1.decode(corrupted)))
  }

  @Test
  fun `rejects trailing and oversized envelopes`() {
    val identity = JvmEcSigningIdentity()
    val bytes = TransportEnvelopeV1.create(
      EnvelopeUnsignedInput(
        messageId = "33333333-3333-3333-3333-333333333333",
        reportId = "44444444-4444-4444-4444-444444444444",
        revision = 1,
        createdAt = 1L,
        expiresAt = null,
        priority = 0,
        payload = payload,
      ),
      identity,
    )

    assertThrows(IllegalArgumentException::class.java) {
      TransportEnvelopeV1.decode(bytes + byteArrayOf(0))
    }
    assertThrows(IllegalArgumentException::class.java) {
      TransportEnvelopeV1.decode(ByteArray(TransportEnvelopeV1.MAX_ENVELOPE_BYTES + 1))
    }
  }

  private class FixedSigningIdentity(
    override val publicKeyDer: ByteArray,
    private val fixedSignature: ByteArray,
  ) : SigningIdentity {
    override val keyId: ByteArray = MessageDigest.getInstance("SHA-256").digest(publicKeyDer)
    var lastSignedData: ByteArray? = null

    override fun sign(data: ByteArray): ByteArray {
      lastSignedData = data.copyOf()
      return fixedSignature.copyOf()
    }
  }

  private class JvmEcSigningIdentity : SigningIdentity {
    private val keyPair = KeyPairGenerator.getInstance("EC").apply { initialize(256) }.generateKeyPair()
    override val publicKeyDer: ByteArray = keyPair.public.encoded
    override val keyId: ByteArray = MessageDigest.getInstance("SHA-256").digest(publicKeyDer)

    override fun sign(data: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
      initSign(keyPair.private)
      update(data)
      sign()
    }
  }

  private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }

  private fun hex(value: String): ByteArray = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
