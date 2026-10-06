package com.sagip.survival

import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import org.junit.Assert.*
import org.junit.Test

class CustodyReceiptReturnTransportTest {
  private val pair=KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
  private val identity=object:SigningIdentity {
    override val publicKeyDer=pair.public.encoded
    override val keyId=MessageDigest.getInstance("SHA-256").digest(publicKeyDer)
    override fun sign(data:ByteArray):ByteArray=Signature.getInstance("SHA256withECDSA").run {
      initSign(pair.private);update(data);sign()
    }
  }
  private val report="22222222-2222-2222-2222-222222222222"
  private val boot="11111111-1111-4111-8111-111111111111"
  private fun challenge()=TimeChallenge("33333333-3333-4333-8333-333333333333",identity.keyId,boot,ByteArray(32){7},
    1000L,null,VerificationContext(emptyMap(),emptySet(),emptySet(),null,null,false,null,null),{false})
  private fun transport(envelope:ByteArray?=byteArrayOf(1,2,3))=HttpCustodyReceiptReturnTransport(
    "https://sagip.example",{if(it==report)envelope else null},{setOf(report)},identity,{MonotonicClock(boot,1000L)})

  @Test fun native_request_binds_exact_envelope_verifier_boot_nonce_cursor_and_operation_without_shared_secrets() {
    val request=transport().prepareRequest(report,"receipts",challenge())
    assertEquals("/v2/custody/reports/$report/receipts",request.path)
    val text=request.body.toString(Charsets.UTF_8)
    assertTrue(text.contains("\"envelopeBase64\":\"AQID\""))
    assertTrue(text.contains("\"cursor\":null"))
    assertFalse(text.contains("token"))
    val hash=MessageDigest.getInstance("SHA-256").digest(request.body).joinToString("") { "%02x".format(it.toInt() and 255) }
    val input=("SAGIP-CUSTODY-REQUEST-V1\nPOST\n${request.path}\n$hash\n").toByteArray(Charsets.US_ASCII)
    val signature=java.util.Base64.getDecoder().decode(request.signature)
    assertEquals(64,signature.size)
    val r=java.math.BigInteger(1,signature.copyOfRange(0,32)).toByteArray()
    val s=java.math.BigInteger(1,signature.copyOfRange(32,64)).toByteArray()
    val der=byteArrayOf(0x30,(r.size+s.size+4).toByte(),0x02,r.size.toByte())+r+byteArrayOf(0x02,s.size.toByte())+s
    val verifier=Signature.getInstance("SHA256withECDSA")
    verifier.initVerify(pair.public);verifier.update(input);assertTrue(verifier.verify(der))
    val time=transport().prepareRequest(report,"authority/time",challenge())
    assertFalse(time.body.toString(Charsets.UTF_8).contains("cursor"))
    assertNotEquals(time.signature,request.signature)
  }
  @Test fun unavailable_envelope_wrong_verifier_and_non_https_endpoint_do_not_make_requests() {
    assertThrows(Exception::class.java) {transport(null).prepareRequest(report,"receipts",challenge())}
    assertThrows(Exception::class.java) {transport().prepareRequest(report,"receipts",challenge().copy(verifierId=ByteArray(32)))}
    assertThrows(Exception::class.java) {transport().prepareRequest(report,"receipts",challenge(),"bad")}
    assertThrows(Exception::class.java) {HttpCustodyReceiptReturnTransport("http://sagip.example",{null},{emptySet()},identity,{MonotonicClock(boot,1L)})}
  }
  @Test fun universal_checkpoint_advancement_uses_wider_deployment_uncertainty_and_expires_after_reboot() {
    val checkpoint=TimeCheckpoint(1_000_000L,1_000_010L,boot,1000L,2_000_000L,"0".repeat(64))
    val advanced=ReceiptAuthority.advanceCheckpoint(checkpoint,MonotonicClock(boot,101000L),1000)!!
    assertEquals(1_099_900L,advanced.earliestMs);assertEquals(1_100_110L,advanced.latestMs)
    assertNull(ReceiptAuthority.advanceCheckpoint(checkpoint,MonotonicClock("other-boot",101000L),1000))
    assertNull(ReceiptAuthority.advanceCheckpoint(checkpoint,MonotonicClock(boot,999L),1000))
    assertNull(ReceiptAuthority.advanceCheckpoint(checkpoint,MonotonicClock(boot,101000L),1001))
  }
  @Test fun first_launch_device_time_request_requires_no_SOS_or_responder_credential() {
    val request=HttpDeviceReceiptTimeTransport("https://sagip.example",identity).prepareRequest(challenge())
    assertEquals("/v2/authority/device-time",request.path)
    val body=request.body.toString(Charsets.UTF_8)
    assertFalse(body.contains("envelope"));assertFalse(body.contains("reportId"));assertFalse(body.contains("token"))
    assertTrue(body.contains("verifierPublicKeyDer"));assertTrue(body.contains(boot))
    val signature=java.util.Base64.getDecoder().decode(request.signature)
    val r=java.math.BigInteger(1,signature.copyOfRange(0,32)).toByteArray()
    val s=java.math.BigInteger(1,signature.copyOfRange(32,64)).toByteArray()
    val der=byteArrayOf(0x30,(r.size+s.size+4).toByte(),0x02,r.size.toByte())+r+byteArrayOf(0x02,s.size.toByte())+s
    val hash=MessageDigest.getInstance("SHA-256").digest(request.body).joinToString("") { "%02x".format(it.toInt() and 255) }
    val verifier=Signature.getInstance("SHA256withECDSA")
    verifier.initVerify(pair.public)
    verifier.update(("SAGIP-DEVICE-TIME-REQUEST-V1\nPOST\n${request.path}\n$hash\n").toByteArray(Charsets.US_ASCII))
    assertTrue(verifier.verify(der))
    assertThrows(Exception::class.java) {HttpDeviceReceiptTimeTransport("https://sagip.example",identity)
      .prepareRequest(challenge().copy(verifierId=ByteArray(32)))}
  }
  @Test fun signed_device_checkpoint_reserves_full_network_uncertainty_inside_its_horizon() {
    val nil="00000000-0000-0000-0000-000000000000"
    val signedTime=1_700_000_000_000L
    val uncertainty=5000L
    val fields=ReceiptFields.Time("44444444-4444-4444-8444-444444444444",
      ReceiptAuthority.issuerProviderId(1,identity.keyId,nil),identity.keyId,nil,nil,identity.keyId,boot,
      ByteArray(32){7},ByteArray(32),signedTime,0L,uncertainty,signedTime+86_400_000L-uncertainty-60_000L)
    val placeholder=ByteArray(64).also { it[31]=1;it[63]=1 }
    val unsigned=ReceiptV2Codec.encode(fields,placeholder,byteArrayOf())
    val input="SAGIP-SIGNED-V2\u0000".toByteArray(Charsets.US_ASCII)+unsigned.copyOf(unsigned.size-64)
    val signature=StatusRequestProof.canonicalSignature(identity.sign(input))
    val encoded=ReceiptV2Codec.encode(fields,signature,byteArrayOf())
    var committed:TimeCheckpoint?=null
    val q=challenge().copy(sentElapsedMs=1000L,
      context=VerificationContext(mapOf(OfflineRootSnapshotCodec.hex(identity.keyId) to identity.publicKeyDer),
        emptySet(),setOf("TAGUM_PILOT"),null,null,false,null,null),
      commitCheckpoint={committed=it;true})
    val accepted=ReceiptAuthority.acceptTimeProof(encoded,q,MonotonicClock(boot,1600L))
    assertEquals("ACCEPTED",accepted.kind)
    assertTrue(committed!!.validUntilMs-committed!!.earliestMs<=86_400_000L)
  }
}
