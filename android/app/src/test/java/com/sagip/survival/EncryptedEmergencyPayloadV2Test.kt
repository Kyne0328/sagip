package com.sagip.survival

import com.google.crypto.tink.HybridDecrypt
import com.google.crypto.tink.HybridEncrypt
import com.google.crypto.tink.KeyTemplates
import com.google.crypto.tink.KeysetHandle
import com.google.crypto.tink.hybrid.HybridConfig
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class EncryptedEmergencyPayloadV2Test {
  @Test
  fun `HPKE round trip succeeds and wrong key fails`() {
    val first = hpkeIdentity()
    val second = hpkeIdentity()
    val keyId = ByteArray(32) { (it + 1).toByte() }
    val plaintext = byteArrayOf(0x53, 0x52, 0x50, 0x31, 1, 2, 1, 0)
    val messageId = "11111111-1111-1111-1111-111111111111"
    val reportId = "22222222-2222-2222-2222-222222222222"

    val container = EncryptedEmergencyPayloadV2.encryptSrp1(
      plaintext,
      messageId,
      reportId,
      1,
      listOf(ResponderEncryptionRecipient(keyId, first.encrypt)),
    )

    assertArrayEquals(
      plaintext,
      EncryptedEmergencyPayloadV2.decryptSrp1ForRecipient(
        container, keyId, first.decrypt, messageId, reportId, 1,
      ),
    )
    assertThrows(Exception::class.java) {
      EncryptedEmergencyPayloadV2.decryptSrp1ForRecipient(
        container, keyId, second.decrypt, messageId, reportId, 1,
      )
    }
  }

  @Test
  fun `ciphertext corruption and context mismatch fail`() {
    val identity = hpkeIdentity()
    val keyId = ByteArray(32) { 7 }
    val messageId = "11111111-1111-1111-1111-111111111111"
    val reportId = "22222222-2222-2222-2222-222222222222"
    val container = EncryptedEmergencyPayloadV2.encryptSrp1(
      byteArrayOf(0x53, 0x52, 0x50, 0x31, 1, 1, 1, 0),
      messageId,
      reportId,
      1,
      listOf(ResponderEncryptionRecipient(keyId, identity.encrypt)),
    )
    val decoded = EncryptedEmergencyPayloadV2.decode(container)
    val corruptedCiphertext = decoded.recipients.single().ciphertext.copyOf().also {
      it[it.lastIndex] = (it.last().toInt() xor 1).toByte()
    }
    val corruptedContainer = EncryptedEmergencyPayloadV2.encode(
      listOf(EncryptedRecipientEntryV2(keyId, corruptedCiphertext)),
    )

    assertThrows(Exception::class.java) {
      EncryptedEmergencyPayloadV2.decryptSrp1ForRecipient(
        corruptedContainer, keyId, identity.decrypt, messageId, reportId, 1,
      )
    }
    assertThrows(Exception::class.java) {
      EncryptedEmergencyPayloadV2.decryptSrp1ForRecipient(
        container, keyId, identity.decrypt, messageId, reportId, 2,
      )
    }
  }

  @Test
  fun `SRE2 canonical framing matches cross platform golden vector`() {
    val encoded = EncryptedEmergencyPayloadV2.encode(
      listOf(
        EncryptedRecipientEntryV2(
          ByteArray(32) { 0x01 },
          byteArrayOf(0x01, 0x02, 0x03, 0x04),
        ),
      ),
    )
    val expectedHex =
      "53524532010101" +
        "01".repeat(32) +
        "0004" +
        "01020304"
    assertEquals(expectedHex, encoded.joinToString("") { "%02x".format(it.toInt() and 0xff) })
  }

  @Test
  fun `container canonicalizes recipients and rejects duplicate key ids`() {
    val high = ByteArray(32) { 0xff.toByte() }
    val low = ByteArray(32) { 0x01 }
    val encoded = EncryptedEmergencyPayloadV2.encode(
      listOf(
        EncryptedRecipientEntryV2(high, byteArrayOf(2)),
        EncryptedRecipientEntryV2(low, byteArrayOf(1)),
      ),
    )
    val decoded = EncryptedEmergencyPayloadV2.decode(encoded)
    assertArrayEquals(low, decoded.recipients.first().keyId)

    assertThrows(IllegalArgumentException::class.java) {
      EncryptedEmergencyPayloadV2.encode(
        listOf(
          EncryptedRecipientEntryV2(low, byteArrayOf(1)),
          EncryptedRecipientEntryV2(low, byteArrayOf(2)),
        ),
      )
    }
  }

  private data class HpkeIdentity(val encrypt: HybridEncrypt, val decrypt: HybridDecrypt)

  private fun hpkeIdentity(): HpkeIdentity {
    val privateHandle = KeysetHandle.generateNew(
      KeyTemplates.get("DHKEM_X25519_HKDF_SHA256_HKDF_SHA256_AES_256_GCM"),
    )
    val publicHandle = privateHandle.publicKeysetHandle
    return HpkeIdentity(
      publicHandle.getPrimitive(HybridEncrypt::class.java),
      privateHandle.getPrimitive(HybridDecrypt::class.java),
    )
  }

  companion object {
    @JvmStatic
    @BeforeClass
    fun registerTink() {
      HybridConfig.register()
    }
  }
}

class TransportEnvelopeV2Test {
  @Test
  fun `SGP2 signs ciphertext and dispatcher preserves SGP1 compatibility`() {
    val identity = JvmEcSigningIdentity()
    val encryptedPayload = EncryptedEmergencyPayloadV2.encode(
      listOf(EncryptedRecipientEntryV2(ByteArray(32) { 1 }, byteArrayOf(1, 2, 3, 4))),
    )
    val bytes = TransportEnvelopeV2.create(
      EnvelopeUnsignedInputV2(
        messageId = "11111111-1111-1111-1111-111111111111",
        reportId = "22222222-2222-2222-2222-222222222222",
        revision = 1,
        createdAt = 1_000L,
        expiresAt = null,
        priority = 0,
        encryptedPayload = encryptedPayload,
      ),
      identity,
    )
    val decoded = TransportEnvelopeV2.decode(bytes)
    assertTrue(TransportEnvelopeV2.verify(decoded))
    assertEquals(2, TransportEnvelope.decodeAndVerify(bytes).protocolVersion)

    val sgp1 = TransportEnvelopeV1.create(
      EnvelopeUnsignedInput(
        messageId = "33333333-3333-3333-3333-333333333333",
        reportId = "44444444-4444-4444-4444-444444444444",
        revision = 1,
        createdAt = 1L,
        expiresAt = null,
        priority = 0,
        payload = byteArrayOf(0x53, 0x52, 0x50, 0x31, 1, 1, 1, 0),
      ),
      identity,
    )
    assertEquals(1, TransportEnvelope.decodeAndVerify(sgp1).protocolVersion)
  }

  @Test
  fun `SGP2 rejects tampering and preserves 8192 byte ceiling`() {
    val identity = JvmEcSigningIdentity()
    val payload = EncryptedEmergencyPayloadV2.encode(
      listOf(EncryptedRecipientEntryV2(ByteArray(32) { 2 }, ByteArray(100) { 5 })),
    )
    val bytes = TransportEnvelopeV2.create(
      EnvelopeUnsignedInputV2(
        "55555555-5555-5555-5555-555555555555",
        "66666666-6666-6666-6666-666666666666",
        1, 1L, null, 0, payload,
      ),
      identity,
    )
    val corrupted = bytes.copyOf().also { it[it.size / 2] = (it[it.size / 2].toInt() xor 1).toByte() }
    assertThrows(IllegalArgumentException::class.java) {
      TransportEnvelope.decodeAndVerify(corrupted)
    }
    val exactLimitError = assertThrows(IllegalArgumentException::class.java) {
      TransportEnvelopeV2.decode(ByteArray(8192))
    }
    assertEquals("invalid envelope magic", exactLimitError.message)
    val overLimitError = assertThrows(IllegalArgumentException::class.java) {
      TransportEnvelopeV2.decode(ByteArray(8193))
    }
    assertEquals("envelope is too large", overLimitError.message)
  }

  private class JvmEcSigningIdentity : SigningIdentity {
    private val keyPair = KeyPairGenerator.getInstance("EC").apply {
      initialize(java.security.spec.ECGenParameterSpec("secp256r1"))
    }.generateKeyPair()
    override val publicKeyDer: ByteArray = keyPair.public.encoded
    override val keyId: ByteArray = MessageDigest.getInstance("SHA-256").digest(publicKeyDer)
    override fun sign(data: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
      initSign(keyPair.private)
      update(data)
      sign()
    }
  }
}
