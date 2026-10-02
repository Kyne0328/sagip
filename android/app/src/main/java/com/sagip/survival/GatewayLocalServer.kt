package com.sagip.survival

import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.LinkedHashSet
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.Semaphore
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket

fun interface GatewayTimeProofIssuer {
  fun issue(challenge: TimeChallenge): TimeProofResult
}

data class GatewayLocalConfig(
  val bindAddress: InetAddress,
  val port: Int,
  val hostname: String,
  val allowedOrigin: String,
  val sslContext: SSLContext,
  val certificateSha256: ByteArray,
  val maxConnections: Int = 8,
  val workerCount: Int = 4,
  val headerLimitBytes: Int = 4096,
  val jsonBodyLimitBytes: Int = 4096,
  val signedBodyLimitBytes: Int = 8192,
  val readTimeoutMs: Int = 15_000,
  val requestTimeoutMs: Int = 30_000,
  val approvalWaitMs: Long = 30_000,
)

data class GatewayStartResult(
  val state: String,
  val port: Int,
  val origin: String,
  val certificateSha256Hex: String,
)

object GatewayBrowserCredential {
  private val REQUEST_DOMAIN = "SAGIP-GATEWAY-REQUEST-V1\u0000".toByteArray(StandardCharsets.US_ASCII)
  private val PAIR_DOMAIN = "SAGIP-GATEWAY-PAIR-V1\u0000".toByteArray(StandardCharsets.US_ASCII)

  fun pairingInput(pairingId: String, code: String, origin: String): ByteArray =
    PAIR_DOMAIN + "$pairingId\u0000$code\u0000$origin".toByteArray(StandardCharsets.US_ASCII)

  fun requestInput(method: String, path: String, host: String, origin: String, csrf: String, nonce: String, body: ByteArray): ByteArray {
    val digest = MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it.toInt() and 255) }
    return REQUEST_DOMAIN + "$method\u0000$path\u0000$host\u0000$origin\u0000$csrf\u0000$nonce\u0000$digest"
      .toByteArray(StandardCharsets.US_ASCII)
  }

  fun binding(publicKeyDer: ByteArray): String {
    ReceiptV2Codec.validatePublicKey(publicKeyDer)
    return MessageDigest.getInstance("SHA-256").digest(publicKeyDer)
      .joinToString("") { "%02x".format(it.toInt() and 255) }
  }

  fun verify(publicKeyDer: ByteArray, signatureP1363: ByteArray, input: ByteArray): Boolean = runCatching {
    ReceiptV2Codec.validatePublicKey(publicKeyDer)
    require(signatureP1363.size == 64)
    val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(publicKeyDer))
    Signature.getInstance("SHA256withECDSA").run {
      initVerify(key)
      update(input)
      verify(p1363ToDer(signatureP1363))
    }
  }.getOrDefault(false)

  private fun p1363ToDer(signature: ByteArray): ByteArray {
    fun integer(bytes: ByteArray): ByteArray {
      var first = 0
      while (first < bytes.size - 1 && bytes[first] == 0.toByte()) first++
      val raw = bytes.copyOfRange(first, bytes.size)
      return if ((raw[0].toInt() and 0x80) != 0) byteArrayOf(0) + raw else raw
    }
    val r = integer(signature.copyOfRange(0, 32))
    val s = integer(signature.copyOfRange(32, 64))
    val body = byteArrayOf(0x02, r.size.toByte()) + r + byteArrayOf(0x02, s.size.toByte()) + s
    require(body.size < 128)
    return byteArrayOf(0x30, body.size.toByte()) + body
  }
}

class GatewayLocalServer(
  private val pairingStore: GatewayPairingStore,
  private val admissionStore: GatewayAdmissionStore,
  private val sessionAuthority: () -> GatewaySessionAuthority?,
  private val timeProofIssuer: GatewayTimeProofIssuer,
) {
  private data class BrowserSession(val binding: String, val csrf: String, val nonces: LinkedHashSet<String> = LinkedHashSet())
  private data class NativeApproval(val binding: String, val secrets: GatewaySessionSecrets, val expiresAtNanos: Long)
  private data class Request(val method: String, val path: String, val host: String, val origin: String, val headers: Map<String, String>, val body: ByteArray)
  private data class Response(val status: Int, val body: ByteArray, val contentType: String = "application/json", val headers: Map<String, String> = emptyMap())

  private val sessions = ConcurrentHashMap<String, BrowserSession>()
  private val waiters = ConcurrentHashMap<String, CompletableFuture<NativeApproval>>()
  private val approvals = ConcurrentHashMap<String, NativeApproval>()
  @Volatile private var running = false
  @Volatile private var config: GatewayLocalConfig? = null
  @Volatile private var serverSocket: SSLServerSocket? = null
  private var acceptThread: Thread? = null
  private var executor: ThreadPoolExecutor? = null
  private var slots: Semaphore? = null
  private val lastAuthorizationResponse = ThreadLocal<Response?>()

  @Synchronized fun start(config: GatewayLocalConfig): GatewayStartResult {
    validateConfig(config)
    if (running) {
      val current = requireNotNull(this.config)
      return GatewayStartResult("ALREADY_STARTED", current.port, current.allowedOrigin, hex(current.certificateSha256))
    }
    val socket = config.sslContext.serverSocketFactory.createServerSocket() as SSLServerSocket
    socket.reuseAddress = false
    socket.needClientAuth = false
    socket.bind(InetSocketAddress(config.bindAddress, config.port), config.maxConnections)
    val supported = socket.supportedProtocols.toSet()
    socket.enabledProtocols = listOf("TLSv1.3", "TLSv1.2").filter { it in supported }.toTypedArray()
    val pool = ThreadPoolExecutor(
      config.workerCount,
      config.workerCount,
      0L,
      TimeUnit.MILLISECONDS,
      ArrayBlockingQueue((config.maxConnections - config.workerCount).coerceAtLeast(1)),
      { r -> Thread(r, "sagip-gateway-request").apply { isDaemon = true } },
      ThreadPoolExecutor.AbortPolicy(),
    )
    this.config = config
    this.serverSocket = socket
    this.executor = pool
    this.slots = Semaphore(config.maxConnections)
    running = true
    acceptThread = Thread({ acceptLoop(socket, pool, requireNotNull(slots)) }, "sagip-gateway-accept").apply {
      isDaemon = true
      start()
    }
    return GatewayStartResult("STARTED", socket.localPort, config.allowedOrigin, hex(config.certificateSha256))
  }

  @Synchronized fun stop() {
    running = false
    runCatching { serverSocket?.close() }
    acceptThread?.interrupt()
    executor?.shutdownNow()
    waiters.values.forEach { it.cancel(true) }
    waiters.clear()
    approvals.clear()
    sessions.clear()
    serverSocket = null
    executor = null
    slots = null
    acceptThread = null
    config = null
  }

  fun startPairing(): GatewayPairingCode = pairingStore.startPairing()

  fun approveNative(pairingId: String, binding: String): Boolean {
    val secrets = pairingStore.approveNative(pairingId, binding) ?: return false
    val approval = NativeApproval(binding, secrets, System.nanoTime() + TimeUnit.SECONDS.toNanos(30))
    val waiter = waiters[pairingId]
    if (waiter != null) waiter.complete(approval) else approvals[pairingId] = approval
    return true
  }

  fun issueTimeProof(challenge: TimeChallenge): TimeProofResult = timeProofIssuer.issue(challenge)

  private fun acceptLoop(server: SSLServerSocket, pool: ThreadPoolExecutor, slots: Semaphore) {
    while (running) {
      val socket = try { server.accept() as SSLSocket } catch (_: Exception) { if (running) continue else break }
      if (!slots.tryAcquire()) {
        runCatching { socket.close() }
        continue
      }
      try {
        pool.execute {
          try { handleSocket(socket) }
          finally {
            runCatching { socket.close() }
            slots.release()
          }
        }
      } catch (_: RejectedExecutionException) {
        slots.release()
        runCatching { socket.close() }
      }
    }
  }

  private fun handleSocket(socket: SSLSocket) {
    val cfg = config ?: return
    socket.soTimeout = cfg.readTimeoutMs
    try {
      socket.startHandshake()
      val localCertificate = socket.session.localCertificates?.firstOrNull()?.encoded ?: return
      val actualFingerprint = MessageDigest.getInstance("SHA-256").digest(localCertificate)
      if (!MessageDigest.isEqual(actualFingerprint, cfg.certificateSha256)) return
      val admission = admissionStore.admit(socket.inetAddress?.address ?: return)
      if (admission.outcome != "ADMITTED") {
        val response = when (admission.outcome) {
          "RATE_LIMITED", "CAPACITY" -> Response(
            429,
            errorJson(if (admission.outcome == "CAPACITY") "CAPACITY_FULL" else "RATE_LIMITED"),
            headers = mapOf("Retry-After" to ((admission.retryAfterMs + 999) / 1000).coerceAtLeast(1).toString()),
          )
          "TIME_UNAVAILABLE" -> Response(503, errorJson("TIME_UNAVAILABLE"))
          else -> Response(400, errorJson("INVALID_SOURCE"))
        }
        drainDeniedRequest(socket.inputStream, cfg)
        writeResponse(socket, response)
        return
      }
      val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(cfg.requestTimeoutMs.toLong())
      writeResponse(socket, dispatch(readRequest(socket.inputStream, cfg), deadline))
    } catch (_: HeaderTooLarge) {
      runCatching { writeResponse(socket, Response(400, errorJson("INVALID_FIELDS"))) }
    } catch (_: BodyTooLarge) {
      runCatching { writeResponse(socket, Response(413, errorJson("BODY_TOO_LARGE"))) }
    } catch (_: UnsupportedEncoding) {
      runCatching { writeResponse(socket, Response(415, errorJson("UNSUPPORTED_ENCODING"))) }
    } catch (_: Exception) {
      runCatching { writeResponse(socket, Response(400, errorJson("INVALID_FIELDS"))) }
    }
  }

  private fun dispatch(request: Request, deadline: Long): Response {
    val cfg = requireNotNull(config)
    if (request.host != expectedHost(cfg) || request.origin != cfg.allowedOrigin) return Response(403, errorJson("ORIGIN_DENIED"))
    if (System.nanoTime() > deadline) return Response(503, errorJson("TIME_UNAVAILABLE"))
    val pair = Regex("/gateway/v1/pairing/([0-9a-f-]{36})/confirm").matchEntire(request.path)
    if (request.method == "POST" && pair != null) return confirmPairing(pair.groupValues[1], request, deadline)
    if (request.method == "GET" && request.path == "/gateway/v1/session") return session(request)
    if (request.method == "DELETE" && request.path == "/gateway/v1/session") return logout(request)
    if (request.method == "POST" && request.path == "/gateway/v1/time") return time(request)
    return Response(404, errorJson("NOT_FOUND"))
  }

  private fun confirmPairing(pairingId: String, request: Request, deadline: Long): Response {
    val cfg = requireNotNull(config)
    if (!isCanonicalUuid(pairingId)) return Response(400, errorJson("INVALID_FIELDS"))
    if (request.headers["content-type"] != "application/json") return Response(415, errorJson("UNSUPPORTED_MEDIA_TYPE"))
    val json = strictStringObject(request.body) ?: return Response(400, errorJson("INVALID_JSON"))
    if (json.keys != setOf("code", "browserPublicKeyDerBase64", "browserSignatureBase64")) {
      return Response(400, errorJson("INVALID_FIELDS"))
    }
    val code = json["code"].orEmpty()
    val publicKey = decodeBase64(json["browserPublicKeyDerBase64"].orEmpty()) ?: return Response(400, errorJson("INVALID_FIELDS"))
    val signature = decodeBase64(json["browserSignatureBase64"].orEmpty()) ?: return Response(400, errorJson("INVALID_FIELDS"))
    if (!code.matches(Regex("[0-9]{8}")) || signature.size != 64) return Response(400, errorJson("INVALID_FIELDS"))
    val binding = runCatching { GatewayBrowserCredential.binding(publicKey) }.getOrNull() ?: return Response(403, errorJson("SESSION_REQUIRED"))
    if (!GatewayBrowserCredential.verify(publicKey, signature, GatewayBrowserCredential.pairingInput(pairingId, code, cfg.allowedOrigin))) {
      return Response(403, errorJson("SESSION_REQUIRED"))
    }
    approvals.remove(pairingId)?.takeIf { it.binding == binding && System.nanoTime() < it.expiresAtNanos }?.let {
      return pairedResponse(it, binding)
    }
    return when (val state = pairingStore.confirmBrowser(pairingId, code, binding, request.origin)) {
      "AWAITING_NATIVE_CONFIRMATION" -> {
        val future = CompletableFuture<NativeApproval>()
        waiters[pairingId] = future
        approvals.remove(pairingId)?.takeIf { it.binding == binding && System.nanoTime() < it.expiresAtNanos }?.let { future.complete(it) }
        val remainingMs = ((deadline - System.nanoTime()) / 1_000_000).coerceAtLeast(1)
        val approval = runCatching { future.get(minOf(cfg.approvalWaitMs, remainingMs), TimeUnit.MILLISECONDS) }.getOrNull()
        waiters.remove(pairingId, future)
        if (approval == null || approval.binding != binding) Response(503, errorJson("NATIVE_CONFIRMATION_PENDING"))
        else pairedResponse(approval, binding)
      }
      "CODE_DENIED" -> Response(403, errorJson("PAIRING_DENIED"))
      "PAIRING_EXPIRED" -> Response(410, errorJson("PAIRING_EXPIRED"))
      "ORIGIN_DENIED" -> Response(403, errorJson("ORIGIN_DENIED"))
      "DEVICE_ACCESS_REQUIRED", "AUTHORITY_UNAVAILABLE" -> Response(403, errorJson(state))
      "TIME_UNAVAILABLE" -> Response(503, errorJson(state))
      else -> Response(400, errorJson("INVALID_FIELDS"))
    }
  }

  private fun pairedResponse(approval: NativeApproval, binding: String): Response {
    val token = approval.secrets.token
    val csrf = approval.secrets.csrf
    sessions[token] = BrowserSession(binding, csrf)
    val body = JSONObject().put("state", "AUTHORIZED").put("csrf", csrf).toString().toByteArray(StandardCharsets.UTF_8)
    return Response(200, body, headers = mapOf("Set-Cookie" to "__Host-sagip_gateway=$token; Path=/; Secure; HttpOnly; SameSite=Strict"))
  }

  private fun session(request: Request): Response {
    val auth = authorize(request, csrfRequired = false) ?: return lastAuthorizationResponse.get() ?: Response(401, errorJson("SESSION_REQUIRED"))
    val authority = sessionAuthority() ?: return Response(403, errorJson("AUTHORITY_UNAVAILABLE"))
    val body = JSONObject()
      .put("state", "AUTHORIZED")
      .put("providerId", authority.providerId)
      .put("grantId", authority.grantId)
      .put("grantExpiresAtMs", authority.grantExpiresAtMs)
      .put("trustedEarliestMs", authority.trustedTime.earliestMs)
      .put("trustedLatestMs", authority.trustedTime.latestMs)
      .put("csrf", auth.second.csrf)
      .toString().toByteArray(StandardCharsets.UTF_8)
    return Response(200, body)
  }

  private fun logout(request: Request): Response {
    val auth = authorize(request, csrfRequired = true)
      ?: return lastAuthorizationResponse.get() ?: Response(401, errorJson("SESSION_REQUIRED"))
    val token = auth.first
    val session = auth.second
    return when (val state = pairingStore.logout(token, session.csrf, session.binding, request.origin)) {
      "COMPLETE" -> {
        sessions.remove(token)
        Response(200, JSONObject().put("state", "COMPLETE").toString().toByteArray(StandardCharsets.UTF_8),
          headers = mapOf("Set-Cookie" to "__Host-sagip_gateway=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict"))
      }
      "BLOCKED_PENDING_ACTIONS" -> Response(409, errorJson("PENDING_ACTIONS"))
      "SESSION_REQUIRED", "SESSION_EXPIRED" -> { sessions.remove(token); Response(401, errorJson(state)) }
      "CSRF_DENIED", "ORIGIN_DENIED", "DEVICE_ACCESS_REQUIRED", "AUTHORITY_UNAVAILABLE" -> Response(403, errorJson(state))
      "TIME_UNAVAILABLE" -> Response(503, errorJson(state))
      else -> Response(403, errorJson("SESSION_REQUIRED"))
    }
  }

  private fun time(request: Request): Response {
    if (request.headers["content-type"] != "application/json") return Response(415, errorJson("UNSUPPORTED_MEDIA_TYPE"))
    authorize(request, csrfRequired = true) ?: return lastAuthorizationResponse.get() ?: Response(401, errorJson("SESSION_REQUIRED"))
    val json = strictStringObject(request.body) ?: return Response(400, errorJson("INVALID_JSON"))
    if (json.keys != setOf("challengeId", "verifierId", "verifierBootSessionId", "nonce")) {
      return Response(400, errorJson("INVALID_FIELDS"))
    }
    val id = json["challengeId"].orEmpty()
    val verifier = decodeHex32(json["verifierId"].orEmpty()) ?: return Response(400, errorJson("INVALID_FIELDS"))
    val boot = json["verifierBootSessionId"].orEmpty()
    val nonce = decodeHex32(json["nonce"].orEmpty()) ?: return Response(400, errorJson("INVALID_FIELDS"))
    if (!isCanonicalUuid(id) || !isCanonicalUuid(boot)) return Response(400, errorJson("INVALID_FIELDS"))
    val challenge = TimeChallenge(
      id, verifier, boot, nonce, 0L, null,
      VerificationContext(emptyMap(), emptySet(), emptySet(), null, null, false, null, null),
      { false },
    )
    val result = issueTimeProof(challenge)
    return if (result.kind == "AVAILABLE" && result.bytes != null) Response(200, result.bytes, "application/octet-stream")
    else if (result.reason == "CHALLENGE_CONFLICT") Response(409, errorJson("CHALLENGE_CONFLICT"))
    else Response(503, errorJson(result.reason ?: "TIME_UNAVAILABLE"))
  }

  private fun authorize(request: Request, csrfRequired: Boolean): Pair<String, BrowserSession>? {
    lastAuthorizationResponse.set(null)
    val token = cookie(request.headers["cookie"], "__Host-sagip_gateway") ?: return deny(401, "SESSION_REQUIRED")
    val session = sessions[token] ?: return deny(401, "SESSION_REQUIRED")
    val publicKey = decodeBase64(request.headers["x-sagip-browser-key"] ?: "") ?: return deny(401, "SESSION_REQUIRED")
    val binding = runCatching { GatewayBrowserCredential.binding(publicKey) }.getOrNull() ?: return deny(401, "SESSION_REQUIRED")
    if (binding != session.binding) return deny(401, "SESSION_REQUIRED")
    val csrf = request.headers["x-sagip-csrf"] ?: ""
    if (csrfRequired && csrf != session.csrf) return deny(403, "CSRF_DENIED")
    if (!csrfRequired && csrf.isNotEmpty()) return deny(403, "CSRF_DENIED")
    val nonce = request.headers["x-sagip-request-nonce"] ?: return deny(403, "SESSION_REQUIRED")
    if (!nonce.matches(Regex("[0-9a-f]{64}"))) return deny(403, "SESSION_REQUIRED")
    val signature = decodeBase64(request.headers["x-sagip-browser-signature"] ?: "") ?: return deny(403, "SESSION_REQUIRED")
    if (signature.size != 64 || !GatewayBrowserCredential.verify(publicKey, signature,
        GatewayBrowserCredential.requestInput(request.method, request.path, request.host, request.origin, csrf, nonce, request.body))) {
      return deny(403, "SESSION_REQUIRED")
    }
    synchronized(session) {
      if (nonce in session.nonces) return deny(403, "REPLAY_DENIED")
      if (session.nonces.size >= 256) session.nonces.remove(session.nonces.first())
      session.nonces.add(nonce)
    }
    return when (val state = pairingStore.authorize(token, session.csrf, binding, request.origin, false)) {
      "AUTHORIZED" -> token to session
      "SESSION_REQUIRED" -> deny(401, state)
      "SESSION_EXPIRED" -> { sessions.remove(token); deny(401, state) }
      "CSRF_DENIED", "ORIGIN_DENIED", "DEVICE_ACCESS_REQUIRED", "AUTHORITY_UNAVAILABLE" -> deny(403, state)
      "TIME_UNAVAILABLE" -> deny(503, state)
      "RATE_LIMITED" -> deny(429, state)
      else -> deny(403, "SESSION_REQUIRED")
    }
  }

  private fun deny(status: Int, error: String): Nothing? {
    lastAuthorizationResponse.set(Response(status, errorJson(error)))
    return null
  }

  private fun drainDeniedRequest(input: InputStream, cfg: GatewayLocalConfig) {
    var bytes = 0
    var matched = 0
    while (bytes < cfg.headerLimitBytes) {
      val b = input.read()
      if (b < 0) return
      bytes++
      matched = when {
        matched == 0 && b == '\r'.code -> 1
        matched == 1 && b == '\n'.code -> 2
        matched == 2 && b == '\r'.code -> 3
        matched == 3 && b == '\n'.code -> 4
        b == '\r'.code -> 1
        else -> 0
      }
      if (matched == 4) return
    }
  }

  private fun readRequest(input: InputStream, cfg: GatewayLocalConfig): Request {
    val header = ByteArrayOutputStream()
    var matched = 0
    while (true) {
      val b = input.read()
      if (b < 0) throw IllegalArgumentException("early eof")
      header.write(b)
      if (header.size() > cfg.headerLimitBytes) throw HeaderTooLarge()
      matched = when {
        matched == 0 && b == '\r'.code -> 1
        matched == 1 && b == '\n'.code -> 2
        matched == 2 && b == '\r'.code -> 3
        matched == 3 && b == '\n'.code -> 4
        b == '\r'.code -> 1
        else -> 0
      }
      if (matched == 4) break
    }
    val lines = String(header.toByteArray(), StandardCharsets.US_ASCII).removeSuffix("\r\n\r\n").split("\r\n")
    val first = lines.firstOrNull()?.split(' ') ?: throw IllegalArgumentException("request")
    if (first.size != 3 || first[2] != "HTTP/1.1" || first[0] !in setOf("GET", "POST", "DELETE") || !first[1].startsWith('/'))
      throw IllegalArgumentException("request")
    val headers = linkedMapOf<String, String>()
    for (line in lines.drop(1)) {
      val colon = line.indexOf(':')
      if (colon <= 0) throw IllegalArgumentException("header")
      val name = line.substring(0, colon).lowercase()
      val value = line.substring(colon + 1).trim()
      if (!name.matches(Regex("[a-z0-9-]+")) || value.any { it == '\r' || it == '\n' } || headers.put(name, value) != null)
        throw IllegalArgumentException("header")
    }
    if (headers.containsKey("transfer-encoding") || headers.containsKey("content-encoding")) throw UnsupportedEncoding()
    val host = headers["host"] ?: throw IllegalArgumentException("host")
    // Same-origin browser GET/HEAD requests commonly omit Origin. Only the read-only session GET may
    // substitute the already-configured origin; all state-changing G02 requests require the wire header.
    val origin = headers["origin"] ?: if (first[0] == "GET" && first[1] == "/gateway/v1/session") {
      cfg.allowedOrigin
    } else {
      throw IllegalArgumentException("origin")
    }
    val length = headers["content-length"]?.toIntOrNull() ?: if (first[0] == "POST") throw IllegalArgumentException("length") else 0
    if (length < 0 || length > cfg.jsonBodyLimitBytes) throw BodyTooLarge()
    val body = ByteArray(length)
    var offset = 0
    while (offset < length) {
      val n = input.read(body, offset, length - offset)
      if (n <= 0) throw IllegalArgumentException("body")
      offset += n
    }
    return Request(first[0], first[1], host, origin, headers, body)
  }

  private fun writeResponse(socket: SSLSocket, response: Response) {
    val reason = when (response.status) {
      200 -> "OK"; 400 -> "Bad Request"; 401 -> "Unauthorized"; 403 -> "Forbidden"; 404 -> "Not Found"
      409 -> "Conflict"; 410 -> "Gone"; 413 -> "Payload Too Large"; 415 -> "Unsupported Media Type"
      429 -> "Too Many Requests"; 503 -> "Service Unavailable"; else -> "Error"
    }
    val headers = linkedMapOf(
      "Content-Type" to response.contentType,
      "Content-Length" to response.body.size.toString(),
      "Connection" to "close",
      "Cache-Control" to "no-store",
      "Pragma" to "no-cache",
      "X-Content-Type-Options" to "nosniff",
      "Referrer-Policy" to "no-referrer",
      "Content-Security-Policy" to "default-src 'none'",
    )
    response.headers.forEach { (k, v) -> headers[k] = v }
    val head = buildString {
      append("HTTP/1.1 ${response.status} $reason\r\n")
      headers.forEach { (k, v) -> append("$k: $v\r\n") }
      append("\r\n")
    }.toByteArray(StandardCharsets.US_ASCII)
    socket.outputStream.write(head)
    socket.outputStream.write(response.body)
    socket.outputStream.flush()
  }

  private fun strictStringObject(bytes: ByteArray): Map<String, String>? = runCatching {
    val text = StandardCharsets.UTF_8.newDecoder()
      .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
      .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
      .decode(ByteBuffer.wrap(bytes)).toString()
    var index = 0

    fun skipWhitespace() {
      while (index < text.length && text[index] in charArrayOf(' ', '\t', '\r', '\n')) index++
    }

    fun parseString(): String {
      require(index < text.length && text[index] == '"')
      index++
      val out = StringBuilder()
      while (index < text.length) {
        val ch = text[index++]
        when {
          ch == '"' -> return out.toString()
          ch == '\\' -> {
            require(index < text.length)
            when (val escaped = text[index++]) {
              '"', '\\', '/' -> out.append(escaped)
              'b' -> out.append('\b')
              'f' -> out.append('\u000C')
              'n' -> out.append('\n')
              'r' -> out.append('\r')
              't' -> out.append('\t')
              'u' -> {
                require(index + 4 <= text.length)
                val code = text.substring(index, index + 4).toInt(16)
                out.append(code.toChar())
                index += 4
              }
              else -> error("json escape")
            }
          }
          ch.code < 0x20 -> error("json control")
          else -> out.append(ch)
        }
      }
      error("unterminated json string")
    }

    skipWhitespace()
    require(index < text.length && text[index] == '{')
    index++
    skipWhitespace()
    val result = linkedMapOf<String, String>()
    if (index < text.length && text[index] == '}') {
      index++
    } else {
      while (true) {
        val key = parseString()
        require(!result.containsKey(key))
        skipWhitespace()
        require(index < text.length && text[index] == ':')
        index++
        skipWhitespace()
        val value = parseString()
        result[key] = value
        skipWhitespace()
        require(index < text.length)
        when (text[index++]) {
          ',' -> { skipWhitespace() }
          '}' -> break
          else -> error("json delimiter")
        }
      }
    }
    skipWhitespace()
    require(index == text.length)
    result
  }.getOrNull()

  private fun validateConfig(c: GatewayLocalConfig) {
    require(c.port in 1..65535)
    require(c.hostname == c.hostname.lowercase() && c.hostname.matches(Regex("[a-z0-9.-]+")) && !c.hostname.startsWith('.') && !c.hostname.endsWith('.'))
    val uri = URI(c.allowedOrigin)
    require(uri.scheme == "https" && uri.host == c.hostname && uri.rawUserInfo == null && uri.rawPath.isNullOrEmpty() && uri.rawQuery == null && uri.rawFragment == null)
    val expectedPort = if (c.port == 443) -1 else c.port
    require(uri.port == expectedPort)
    require(c.allowedOrigin == "https://${c.hostname}${if (c.port == 443) "" else ":${c.port}"}")
    require(c.certificateSha256.size == 32 && c.certificateSha256.any { it != 0.toByte() })
    require(c.maxConnections in 1..8 && c.workerCount in 1..4 && c.workerCount <= c.maxConnections)
    require(c.headerLimitBytes in 512..4096 && c.jsonBodyLimitBytes in 256..4096 && c.signedBodyLimitBytes in c.jsonBodyLimitBytes..8192)
    require(c.readTimeoutMs in 1000..15_000 && c.requestTimeoutMs in c.readTimeoutMs..30_000 && c.approvalWaitMs in 1..c.requestTimeoutMs.toLong())
  }

  private fun expectedHost(c: GatewayLocalConfig) = if (c.port == 443) c.hostname else "${c.hostname}:${c.port}"
  private fun errorJson(code: String) = JSONObject().put("error", code).toString().toByteArray(StandardCharsets.UTF_8)
  private fun isCanonicalUuid(value: String) = runCatching { UUID.fromString(value).toString() == value }.getOrDefault(false)
  private fun cookie(header: String?, name: String): String? = header?.split(';')?.map { it.trim() }?.firstOrNull { it.startsWith("$name=") }?.substringAfter('=')
  private fun decodeBase64(value: String): ByteArray? = runCatching {
    val decoded = Base64.decode(value, Base64.NO_WRAP)
    if (Base64.encodeToString(decoded, Base64.NO_WRAP) != value) null else decoded
  }.getOrNull()
  private fun decodeHex32(value: String): ByteArray? {
    if (!value.matches(Regex("[0-9a-f]{64}"))) return null
    return ByteArray(32) { i -> value.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
  }
  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }

  private class HeaderTooLarge : Exception()
  private class BodyTooLarge : Exception()
  private class UnsupportedEncoding : Exception()
}
