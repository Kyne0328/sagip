package com.sagip.survival

import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import org.junit.Assert.*
import org.junit.Test

class OriginReceiptTimeTransportTest {
  private val report = "11111111-1111-4111-8111-111111111111"
  private val boot = "22222222-2222-4222-8222-222222222222"
  private class Identity : SigningIdentity {
    val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    override val publicKeyDer: ByteArray get() = pair.public.encoded
    override val keyId: ByteArray get() = MessageDigest.getInstance("SHA-256").digest(publicKeyDer)
    var signed = 0
    override fun sign(data: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
      signed++; initSign(pair.private); update(data); sign()
    }
  }
  private fun challenge(identity: SigningIdentity) = TimeChallenge(
    report, identity.keyId, boot, ByteArray(32) { 2 }, 10L, null,
    VerificationContext(emptyMap(), emptySet(), emptySet(), null, null, false, null, null), { false },
  )

  @Test fun owner_proof_binds_exact_method_path_and_body_without_wall_clock() {
    val identity = Identity()
    val challenge = challenge(identity)
    val transport = HttpOriginReceiptTimeTransport("https://synthetic.invalid", { report }, identity)
    val request = transport.prepareRequest(report, challenge)
    assertEquals("/v2/reports/" + report + "/authority/time", request.path)
    assertEquals(1, identity.signed)
    val domain = OriginTimeRequestProof.domain(report, request.body)
    val digest = MessageDigest.getInstance("SHA-256").digest(request.body).joinToString("") { "%02x".format(it.toInt() and 255) }
    assertEquals("SAGIP-ORIGIN-TIME-REQUEST-V1\nPOST\n" + request.path + "\n" + digest + "\n", String(domain, Charsets.UTF_8))
    val signature = java.util.Base64.getDecoder().decode(request.signature)
    assertEquals(64, signature.size)
    fun verifyInput(input: ByteArray): Boolean {
      val verifier: Signature = Signature.getInstance("SHA256withECDSAinP1363Format")
      verifier.initVerify(identity.pair.public)
      verifier.update(input)
      return verifier.verify(signature)
    }
    assertTrue(verifyInput(domain))
    assertFalse(verifyInput(OriginTimeRequestProof.domain(report, request.body + byteArrayOf(32))))
    assertFalse(verifyInput(OriginTimeRequestProof.domain("33333333-3333-4333-8333-333333333333", request.body)))
  }

  @Test fun verifier_identity_must_match_the_native_signing_key_before_signing() {
    val identity = Identity()
    val transport = HttpOriginReceiptTimeTransport("https://synthetic.invalid", { report }, identity)
    assertThrows(IllegalArgumentException::class.java) {
      transport.prepareRequest(report, challenge(identity).copy(verifierId=ByteArray(32)))
    }
    assertEquals(0, identity.signed)
  }

  @Test fun request_json_is_exact_canonical_challenge_only() {
    val identity = Identity()
    val challenge = challenge(identity)
    val bytes = ReceiptReturnTimeCodec.encodeRequest(challenge)
    val expected = "{\"verifierId\":\"" + StatusRequestProof.base64(identity.keyId) +
      "\",\"verifierBootSessionId\":\"" + boot +
      "\",\"nonce\":\"" + StatusRequestProof.base64(challenge.nonce) + "\"}"
    assertEquals(expected, String(bytes, Charsets.UTF_8))
    assertThrows(IllegalArgumentException::class.java) {
      ReceiptReturnTimeCodec.encodeRequest(challenge.copy(nonce=ByteArray(31)))
    }
    assertThrows(IllegalArgumentException::class.java) {
      ReceiptReturnTimeCodec.encodeRequest(challenge.copy(verifierBootSessionId="invalid"))
    }
  }

  @Test fun origin_transport_rejects_non_https_or_credential_embedded_endpoints() {
    val identity = Identity()
    for (url in listOf("http://synthetic.invalid", "https://user:pass@synthetic.invalid",
      "https://synthetic.invalid/path", "https://synthetic.invalid?token=1", "https://synthetic.invalid#fragment")) {
      assertThrows(IllegalArgumentException::class.java) { HttpOriginReceiptTimeTransport(url, { report }, identity) }
    }
  }

  @Test fun binary_time_response_limits_are_enforced_without_trusting_received_bytes() {
    assertThrows(IllegalArgumentException::class.java) { ReceiptReturnTimeCodec.decodeResponse(ByteArray(0)) }
    assertThrows(IllegalArgumentException::class.java) { ReceiptReturnTimeCodec.decodeResponse(ByteArray(8193)) }
    assertThrows(IllegalArgumentException::class.java) {
      ReceiptReturnTimeCodec.readResponse(java.io.ByteArrayInputStream(ByteArray(8193)))
    }
  }
}
