package com.sagip.survival

import android.content.Context
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.math.BigInteger
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

@RunWith(AndroidJUnit4::class)
class GatewayLocalConnectionTest {
  private val base = ApplicationProvider.getApplicationContext<Context>()
  private lateinit var context: IsolatedGatewayTestContext
  private lateinit var db: SagipDatabase
  private lateinit var tls: TestTls
  private lateinit var server: GatewayLocalServer
  private var elapsed = 10_000L
  private val boot = "11111111-1111-4111-8111-111111111111"
  private val authority = GatewaySessionAuthority(
    providerId = "ab".repeat(32),
    grantId = "22222222-2222-4222-8222-222222222222",
    grantExpiresAtMs = 1_000_000L,
    trustedTime = TimeInterval(100_000L, 100_100L),
  )

  @Before fun setUp() {
    context = IsolatedGatewayTestContext(base)
    db = SagipDatabase(context)
    tls = testTls()
  }

  @After fun tearDown() {
    if (::server.isInitialized) server.stop()
    db.close()
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
  }

  @Test fun https_pairing_requires_possession_exact_origin_csrf_and_restart_verification() {
    val port = freePort()
    val origin = "https://gateway.test:$port"
    val pairing = GatewayPairingStore(db, origin, { true }, { authority }, { MonotonicClock(boot, elapsed) }, { false })
    val admission = GatewayAdmissionStore(db) { MonotonicClock(boot, elapsed) }
    val proofBytes = "SGT2-test-proof".toByteArray(StandardCharsets.US_ASCII)
    server = GatewayLocalServer(pairing, admission, { authority }, GatewayTimeProofIssuer { TimeProofResult("AVAILABLE", proofBytes) })
    val started = server.start(GatewayLocalConfig(InetAddress.getByName("127.0.0.1"), port, "gateway.test", origin, tls.server, tls.fingerprint, approvalWaitMs = 5_000L))
    assertEquals("STARTED", started.state)

    val browser = browserKey()
    val binding = hex(MessageDigest.getInstance("SHA-256").digest(browser.public.encoded))
    val pairingCode = server.startPairing()
    val pairBody = JSONObject()
      .put("code", pairingCode.code)
      .put("browserPublicKeyDerBase64", b64(browser.public.encoded))
      .put("browserSignatureBase64", b64(signP1363(browser, GatewayBrowserCredential.pairingInput(pairingCode.pairingId, pairingCode.code, origin))))
      .toString().toByteArray(StandardCharsets.UTF_8)

    val executor = Executors.newSingleThreadExecutor()
    val confirm = executor.submit<HttpResponse> { request(port, "POST", "/gateway/v1/pairing/${pairingCode.pairingId}/confirm", origin, pairBody, mapOf("Content-Type" to "application/json")) }
    Thread.sleep(150)
    assertTrue(server.approveNative(pairingCode.pairingId, binding))
    val paired = confirm.get(5, TimeUnit.SECONDS)
    executor.shutdownNow()
    assertEquals(200, paired.status)
    val cookie = paired.headers.getValue("set-cookie").substringBefore(';')
    assertTrue(paired.headers.getValue("set-cookie").contains("Secure"))
    assertTrue(paired.headers.getValue("set-cookie").contains("HttpOnly"))
    assertTrue(paired.headers.getValue("set-cookie").contains("SameSite=Strict"))
    val csrf = JSONObject(String(paired.body, StandardCharsets.UTF_8)).getString("csrf")

    val sessionHeaders = signedHeaders(browser, "GET", "/gateway/v1/session", origin, "", "01".repeat(32), ByteArray(0)) + mapOf("Cookie" to cookie)
    val session = request(port, "GET", "/gateway/v1/session", origin, ByteArray(0), sessionHeaders)
    assertEquals(200, session.status)
    assertEquals(authority.grantId, JSONObject(String(session.body, StandardCharsets.UTF_8)).getString("grantId"))

    // Browsers generally omit Origin on same-origin GET/HEAD. The read-only session route
    // must still verify the signed configured origin instead of requiring a wire Origin header.
    val originlessHeaders = signedHeaders(browser, "GET", "/gateway/v1/session", origin, "", "0a".repeat(32), ByteArray(0)) + mapOf("Cookie" to cookie)
    assertEquals(200, request(port, "GET", "/gateway/v1/session", origin, ByteArray(0), originlessHeaders, includeOrigin = false).status)

    val challenge = JSONObject()
      .put("challengeId", "33333333-3333-4333-8333-333333333333")
      .put("verifierId", "11".repeat(32))
      .put("verifierBootSessionId", "44444444-4444-4444-8444-444444444444")
      .put("nonce", "22".repeat(32))
      .toString().toByteArray(StandardCharsets.UTF_8)
    val timeHeaders = signedHeaders(browser, "POST", "/gateway/v1/time", origin, csrf, "02".repeat(32), challenge) +
      mapOf("Cookie" to cookie, "X-Sagip-CSRF" to csrf, "Content-Type" to "application/json")
    val time = request(port, "POST", "/gateway/v1/time", origin, challenge, timeHeaders)
    assertEquals(200, time.status)
    assertArrayEquals(proofBytes, time.body)
    val replay = request(port, "POST", "/gateway/v1/time", origin, challenge, timeHeaders)
    assertEquals(403, replay.status)
    assertEquals("REPLAY_DENIED", JSONObject(String(replay.body, StandardCharsets.UTF_8)).getString("error"))

    val wrongOriginHeaders = signedHeaders(browser, "GET", "/gateway/v1/session", "https://evil.test", "", "03".repeat(32), ByteArray(0)) + mapOf("Cookie" to cookie)
    assertEquals(403, request(port, "GET", "/gateway/v1/session", "https://evil.test", ByteArray(0), wrongOriginHeaders).status)

    server.stop()
    server = GatewayLocalServer(pairing, admission, { authority }, GatewayTimeProofIssuer { TimeProofResult("AVAILABLE", proofBytes) })
    server.start(GatewayLocalConfig(InetAddress.getByName("127.0.0.1"), port, "gateway.test", origin, tls.server, tls.fingerprint))
    val restartHeaders = signedHeaders(browser, "GET", "/gateway/v1/session", origin, "", "04".repeat(32), ByteArray(0)) + mapOf("Cookie" to cookie)
    assertEquals(401, request(port, "GET", "/gateway/v1/session", origin, ByteArray(0), restartHeaders).status)
  }

  @Test fun delete_session_revokes_authorized_browser_session() {
    val port = freePort()
    val origin = "https://gateway.test:$port"
    val pairing = GatewayPairingStore(db, origin, { true }, { authority }, { MonotonicClock(boot, elapsed) }, { false })
    server = GatewayLocalServer(pairing, GatewayAdmissionStore(db) { MonotonicClock(boot, elapsed) }, { authority }, GatewayTimeProofIssuer { TimeProofResult("TIME_UNAVAILABLE") })
    server.start(GatewayLocalConfig(InetAddress.getByName("127.0.0.1"), port, "gateway.test", origin, tls.server, tls.fingerprint, approvalWaitMs = 5_000L))
    val browser = browserKey()
    val binding = hex(MessageDigest.getInstance("SHA-256").digest(browser.public.encoded))
    val pair = server.startPairing()
    val body = JSONObject()
      .put("code", pair.code)
      .put("browserPublicKeyDerBase64", b64(browser.public.encoded))
      .put("browserSignatureBase64", b64(signP1363(browser, GatewayBrowserCredential.pairingInput(pair.pairingId, pair.code, origin))))
      .toString().toByteArray(StandardCharsets.UTF_8)
    val executor = Executors.newSingleThreadExecutor()
    val confirm = executor.submit<HttpResponse> { request(port, "POST", "/gateway/v1/pairing/${pair.pairingId}/confirm", origin, body, mapOf("Content-Type" to "application/json")) }
    Thread.sleep(150)
    assertTrue(server.approveNative(pair.pairingId, binding))
    val paired = confirm.get(5, TimeUnit.SECONDS)
    executor.shutdownNow()
    val cookie = paired.headers.getValue("set-cookie").substringBefore(';')
    val csrf = JSONObject(String(paired.body, StandardCharsets.UTF_8)).getString("csrf")
    val deleteHeaders = signedHeaders(browser, "DELETE", "/gateway/v1/session", origin, csrf, "05".repeat(32), ByteArray(0)) +
      mapOf("Cookie" to cookie, "X-Sagip-CSRF" to csrf)
    assertEquals(200, request(port, "DELETE", "/gateway/v1/session", origin, ByteArray(0), deleteHeaders).status)
    val afterHeaders = signedHeaders(browser, "GET", "/gateway/v1/session", origin, "", "06".repeat(32), ByteArray(0)) + mapOf("Cookie" to cookie)
    assertEquals(401, request(port, "GET", "/gateway/v1/session", origin, ByteArray(0), afterHeaders).status)
  }

  @Test fun listener_enforces_body_and_source_admission_bounds() {
    val port = freePort()
    val origin = "https://gateway.test:$port"
    val pairing = GatewayPairingStore(db, origin, { true }, { authority }, { MonotonicClock(boot, elapsed) }, { false })
    val admission = GatewayAdmissionStore(db) { MonotonicClock(boot, elapsed) }
    server = GatewayLocalServer(pairing, admission, { authority }, GatewayTimeProofIssuer { TimeProofResult("TIME_UNAVAILABLE") })
    server.start(GatewayLocalConfig(InetAddress.getByName("127.0.0.1"), port, "gateway.test", origin, tls.server, tls.fingerprint))
    assertEquals(413, request(port, "POST", "/gateway/v1/time", origin, ByteArray(4097) { 'a'.code.toByte() }, mapOf("Content-Type" to "application/json")).status)
    repeat(9) { request(port, "GET", "/gateway/v1/session", origin, ByteArray(0)) }
    val limitedBody = ByteArray(4096) { 'x'.code.toByte() }
    val limited = request(port, "POST", "/gateway/v1/time", origin, limitedBody, mapOf("Content-Type" to "application/json"))
    assertEquals(429, limited.status)
    assertTrue(limited.headers.containsKey("retry-after"))
  }

  @Test fun pairing_rejects_unknown_json_fields() {
    val port = freePort()
    val origin = "https://gateway.test:$port"
    val pairing = GatewayPairingStore(db, origin, { true }, { authority }, { MonotonicClock(boot, elapsed) }, { false })
    server = GatewayLocalServer(pairing, GatewayAdmissionStore(db) { MonotonicClock(boot, elapsed) }, { authority }, GatewayTimeProofIssuer { TimeProofResult("TIME_UNAVAILABLE") })
    server.start(GatewayLocalConfig(InetAddress.getByName("127.0.0.1"), port, "gateway.test", origin, tls.server, tls.fingerprint, approvalWaitMs = 100L))
    val browser = browserKey()
    val pair = server.startPairing()
    val body = JSONObject()
      .put("code", pair.code)
      .put("browserPublicKeyDerBase64", b64(browser.public.encoded))
      .put("browserSignatureBase64", b64(signP1363(browser, GatewayBrowserCredential.pairingInput(pair.pairingId, pair.code, origin))))
      .put("unexpected", "field")
      .toString().toByteArray(StandardCharsets.UTF_8)
    assertEquals(400, request(port, "POST", "/gateway/v1/pairing/${pair.pairingId}/confirm", origin, body, mapOf("Content-Type" to "application/json")).status)
  }

  @Test fun pairing_rejects_duplicate_keys_and_trailing_json() {
    val port = freePort()
    val origin = "https://gateway.test:$port"
    val pairing = GatewayPairingStore(db, origin, { true }, { authority }, { MonotonicClock(boot, elapsed) }, { false })
    server = GatewayLocalServer(pairing, GatewayAdmissionStore(db) { MonotonicClock(boot, elapsed) }, { authority }, GatewayTimeProofIssuer { TimeProofResult("TIME_UNAVAILABLE") })
    server.start(GatewayLocalConfig(InetAddress.getByName("127.0.0.1"), port, "gateway.test", origin, tls.server, tls.fingerprint, approvalWaitMs = 100L))
    val browser = browserKey()

    fun body(pair: GatewayPairingCode, duplicate: Boolean, trailing: Boolean): ByteArray {
      val signature = b64(signP1363(browser, GatewayBrowserCredential.pairingInput(pair.pairingId, pair.code, origin)))
      val duplicateCode = if (duplicate) "\"code\":\"${pair.code}\"," else ""
      val suffix = if (trailing) "x" else ""
      return ("{" + duplicateCode +
        "\"code\":\"${pair.code}\"," +
        "\"browserPublicKeyDerBase64\":\"${b64(browser.public.encoded)}\"," +
        "\"browserSignatureBase64\":\"$signature\"}" + suffix).toByteArray(StandardCharsets.UTF_8)
    }

    val duplicate = server.startPairing()
    assertEquals(400, request(port, "POST", "/gateway/v1/pairing/${duplicate.pairingId}/confirm", origin, body(duplicate, duplicate = true, trailing = false), mapOf("Content-Type" to "application/json")).status)
    val trailing = server.startPairing()
    assertEquals(400, request(port, "POST", "/gateway/v1/pairing/${trailing.pairingId}/confirm", origin, body(trailing, duplicate = false, trailing = true), mapOf("Content-Type" to "application/json")).status)
  }
  @Test fun configured_certificate_fingerprint_must_match_served_certificate() {
    val port = freePort()
    val origin = "https://gateway.test:$port"
    val pairing = GatewayPairingStore(db, origin, { true }, { authority }, { MonotonicClock(boot, elapsed) }, { false })
    server = GatewayLocalServer(pairing, GatewayAdmissionStore(db) { MonotonicClock(boot, elapsed) }, { authority }, GatewayTimeProofIssuer { TimeProofResult("TIME_UNAVAILABLE") })
    server.start(GatewayLocalConfig(InetAddress.getByName("127.0.0.1"), port, "gateway.test", origin, tls.server, ByteArray(32) { 7 }))
    assertTrue(runCatching { request(port, "GET", "/gateway/v1/session", origin, ByteArray(0)) }.isFailure)
  }

  private fun signedHeaders(key: KeyPair, method: String, path: String, origin: String, csrf: String, nonce: String, body: ByteArray): Map<String, String> {
    val host = origin.removePrefix("https://")
    return mapOf(
      "X-Sagip-Browser-Key" to b64(key.public.encoded),
      "X-Sagip-Request-Nonce" to nonce,
      "X-Sagip-Browser-Signature" to b64(signP1363(key, GatewayBrowserCredential.requestInput(method, path, host, origin, csrf, nonce, body))),
    )
  }

  private fun request(port: Int, method: String, path: String, origin: String, body: ByteArray, extra: Map<String, String> = emptyMap(), includeOrigin: Boolean = true): HttpResponse {
    val socket = tls.client.socketFactory.createSocket("127.0.0.1", port) as SSLSocket
    socket.soTimeout = 5_000
    socket.startHandshake()
    val headers = linkedMapOf("Host" to origin.removePrefix("https://"), "Connection" to "close")
    if (includeOrigin) headers["Origin"] = origin
    if (method == "POST") headers["Content-Length"] = body.size.toString()
    extra.forEach { (k, v) -> headers[k] = v }
    val head = buildString {
      append("$method $path HTTP/1.1\r\n")
      headers.forEach { (k, v) -> append("$k: $v\r\n") }
      append("\r\n")
    }.toByteArray(StandardCharsets.US_ASCII)
    socket.outputStream.write(head)
    if (body.isNotEmpty()) socket.outputStream.write(body)
    socket.outputStream.flush()
    val bytes = socket.inputStream.readBytes()
    socket.close()
    val split = indexOf(bytes, "\r\n\r\n".toByteArray(StandardCharsets.US_ASCII))
    assertTrue(split >= 0)
    val lines = String(bytes, 0, split, StandardCharsets.US_ASCII).split("\r\n")
    val status = lines.first().split(' ')[1].toInt()
    val responseHeaders = lines.drop(1).associate { line ->
      val i = line.indexOf(':')
      line.substring(0, i).lowercase() to line.substring(i + 1).trim()
    }
    return HttpResponse(status, responseHeaders, bytes.copyOfRange(split + 4, bytes.size))
  }

  private fun indexOf(haystack: ByteArray, needle: ByteArray): Int {
    outer@ for (i in 0..haystack.size - needle.size) {
      for (j in needle.indices) if (haystack[i + j] != needle[j]) continue@outer
      return i
    }
    return -1
  }

  private fun freePort(): Int = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
  private fun browserKey(): KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
  private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)
  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }

  private fun signP1363(key: KeyPair, bytes: ByteArray): ByteArray {
    val der = Signature.getInstance("SHA256withECDSA").run { initSign(key.private); update(bytes); sign() }
    var p = 2
    fun scalar(): BigInteger {
      assertEquals(2, der[p++].toInt() and 255)
      val n = der[p++].toInt() and 255
      return BigInteger(1, der.copyOfRange(p, p + n)).also { p += n }
    }
    fun fixed(v: BigInteger): ByteArray {
      val raw = v.toByteArray().let { if (it.size > 32) it.copyOfRange(it.size - 32, it.size) else it }
      return ByteArray(32 - raw.size) + raw
    }
    return fixed(scalar()) + fixed(scalar())
  }

  private fun testTls(): TestTls {
    val pass = "changeit".toCharArray()
    val store = KeyStore.getInstance("PKCS12")
    store.load(ByteArrayInputStream(Base64.decode(TEST_P12, Base64.DEFAULT)), pass)
    val cert = store.getCertificate("gateway-test") as X509Certificate
    val sans = cert.subjectAlternativeNames.orEmpty().mapNotNull { it.getOrNull(1) as? String }
    assertTrue(sans.contains("gateway.test"))
    val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
    kmf.init(store, pass)
    val serverContext = SSLContext.getInstance("TLS")
    serverContext.init(kmf.keyManagers, null, SecureRandom())
    val trust = object : X509TrustManager {
      override fun getAcceptedIssuers() = arrayOf(cert)
      override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
      override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        require(chain != null && chain.isNotEmpty() && chain[0].encoded.contentEquals(cert.encoded))
      }
    }
    val clientContext = SSLContext.getInstance("TLS")
    clientContext.init(null, arrayOf<TrustManager>(trust), SecureRandom())
    return TestTls(serverContext, clientContext, MessageDigest.getInstance("SHA-256").digest(cert.encoded))
  }

  private data class HttpResponse(val status: Int, val headers: Map<String, String>, val body: ByteArray)
  private data class TestTls(val server: SSLContext, val client: SSLContext, val fingerprint: ByteArray)

  companion object {
    private const val TEST_P12 = "MIIELAIBAzCCA9YGCSqGSIb3DQEHAaCCA8cEggPDMIIDvzCCATYGCSqGSIb3DQEHAaCCAScEggEjMIIBHzCCARsGCyqGSIb3DQEMCgECoIG9MIG6MGYGCSqGSIb3DQEFDTBZMDgGCSqGSIb3DQEFDDArBBQzV/CxuD6sWK/5Z74MhB6FAJRv9gICJxACASAwDAYIKoZIhvcNAgkFADAdBglghkgBZQMEASoEEEzZQpp7g8jJzimmwShVF8gEUAmeAT2UuShACBeXu/3Bqd1KOeaCcTTHVTK2s9+R8krObB4KTIP4xbjox2eILheQ6/s5Roq1I589C+Zl+jOuvzLvBATdbw4JNL2GQAg/JcxhMUwwJwYJKoZIhvcNAQkUMRoeGABnAGEAdABlAHcAYQB5AC0AdABlAHMAdDAhBgkqhkiG9w0BCRUxFAQSVGltZSAxNzkwOTExMTA5NDk1MIICgQYJKoZIhvcNAQcGoIICcjCCAm4CAQAwggJnBgkqhkiG9w0BBwEwZgYJKoZIhvcNAQUNMFkwOAYJKoZIhvcNAQUMMCsEFB8sPyXpUDie8B2PYYZdQcs4SfpLAgInEAIBIDAMBggqhkiG9w0CCQUAMB0GCWCGSAFlAwQBKgQQNU+3Ryq+e8dNRgscoB69dICCAfAVxlXrgmJkT6KI3pNjvOGfxKhGSwWyfIsSFE/VxYNr831UOcUv+/yA7Rp+VHWabw+b4bSfmt1RSV1bfcGQfoQXs/kn/Np1uTUyP0uEXgUnGBG9ud6m2z0LPxM1eZ29u7pEL870nAFGxbthtGi64mDb1aqwe342+Sb0RzI+GZlaaXnXMun3Yqh88PptwTIYAIJFfLR1sc2ejZGHUG3Y6x8AgifhVwgVx7GreZ0v7u7vtC10uQrwWUmw8lnXwzuS+EQzn0pP5mMa1IezIoUtIeylK9Ti687vC0kwUXp6HkRQAFqbQUEx0mLUE3wr9gWqokjzt8+nnxjqesXA5AM5WycDO/MWgU6gND2un57Ib5pvoSN7IJ5u+LiEdoxZkR82TdwJfVvs00HkG5F8scDk65vNmnSKGVgMWOyeU93U91wpGhab6g1dSAKiEImPeEFvao1KrFd6pAyDNrL0uPWQ07dzEkRWQorjcFNQyFCnKBGzvqJwDHG87hesM1JUTBjbAZ8DGmlaqqJicVlai6gOF4Lr0k2CZdsJbVpgeZNtQQ9zCT2wyaOcksP6SQ80swN14BfUWuuHdmBt0frKH84Q0mcP4S86R97WvRjArkZumjnMg1ubSuBeurWTHuzucgiCLUKZ0Py6OOpGeDsIuccCCFVWME0wMTANBglghkgBZQMEAgEFAAQgTKBxuhon3r10mKfAqyNlVF9PMvmlfALmYE7M9ROjqJkEFDv5y3ypK7LBDARpQWEeTWcq2IhlAgInEA=="
  }
}
