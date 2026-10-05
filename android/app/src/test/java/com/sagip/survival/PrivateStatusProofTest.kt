package com.sagip.survival

import java.io.File
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import org.junit.Assert.*
import org.junit.Test

class PrivateStatusProofTest {
  private fun fixture(): String = File("../../backend/test/fixtures/victim-status-proof-v1.json").readText()
  private fun field(json: String, name: String): String =
    Regex("\"" + name + "\"\\s*:\\s*\"([^\"]*)\"").find(json)!!.groupValues[1]

  @Test fun nativeSignerProducesBackendCompatibleOwnerProof() {
    val fixture = fixture()
    val factory = KeyFactory.getInstance("EC")
    val secret = factory.generatePrivate(PKCS8EncodedKeySpec(Base64.getDecoder().decode(field(fixture,"privateKeyPkcs8Base64"))))
    val publicBase64 = field(fixture,"publicKeySpkiBase64")
    val publicKey = factory.generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(publicBase64)))
    val reportId = field(fixture,"reportId")
    val nonce = Base64.getEncoder().encodeToString(ByteArray(32) { it.toByte() })
    val timestamp = System.currentTimeMillis()
    val body = StatusRequestProof.domain(reportId,timestamp,nonce,null)
    assertEquals("SAGIP-REPORT-STATUS-V1\n$reportId\n$timestamp\n$nonce\n\n",String(body,Charsets.UTF_8))
    val der = Signature.getInstance("SHA256withECDSA").run { initSign(secret); update(body); sign() }
    val p1363 = StatusRequestProof.canonicalSignature(der)
    assertEquals(64,p1363.size)
    assertTrue(Signature.getInstance("SHA256withECDSAinP1363Format").run {
      initVerify(publicKey);update(body);verify(p1363)
    })
    val artifact = """{"reportId":"$reportId","timestamp":$timestamp,"nonce":"$nonce","cursor":null,"signatureBase64":"${Base64.getEncoder().encodeToString(p1363)}","publicKeySpkiBase64":"$publicBase64"}"""
    File("../build/private-status-proof.json").apply { parentFile.mkdirs();writeText(artifact) }
  }

  @Test fun android24CompatibleBase64MatchesCanonicalEncoding() {
    for(size in 0..256) {
      val bytes=ByteArray(size) { (it * 131).toByte() }
      assertEquals(Base64.getEncoder().encodeToString(bytes),StatusRequestProof.base64(bytes))
    }
  }

  @Test fun cursorAndReportAreBoundToSignatureDomain() {
    val id = "11111111-1111-4111-8111-111111111111"
    val nonce = Base64.getEncoder().encodeToString(ByteArray(32))
    assertFalse(StatusRequestProof.domain(id,1,nonce,null).contentEquals(
      StatusRequestProof.domain(id,1,nonce,"22222222-2222-4222-8222-222222222222")))
    assertThrows(IllegalArgumentException::class.java) { StatusRequestProof.domain("bad",1,nonce,null) }
    assertThrows(IllegalArgumentException::class.java) { StatusRequestProof.canonicalSignature(byteArrayOf(0x30,0)) }
  }
}
