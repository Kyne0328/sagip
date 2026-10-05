package com.sagip.survival

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.util.UUID

/** Explicit owner-selected report and signing identity; no responder account or wall-clock authority. */
class HttpOriginReceiptTimeTransport(
  baseUrl: String,
  private val reportId: () -> String?,
  private val identity: SigningIdentity,
) : ReceiptReturnTimeTransport {
  private val base = URI(baseUrl).also {
    require(it.scheme == "https" && it.host != null && it.rawUserInfo == null &&
      it.rawQuery == null && it.rawFragment == null)
    require(it.rawPath.isNullOrEmpty() || it.rawPath == "/")
  }.toString().trimEnd('/')

  override fun fetch(challenge: TimeChallenge): ByteArray {
    val report = requireNotNull(reportId()) { "ORIGIN_REPORT_UNAVAILABLE" }
    val request = prepareRequest(report, challenge)
    val connection = URI(base + request.path).toURL().openConnection() as HttpURLConnection
    try {
      connection.instanceFollowRedirects = false
      connection.connectTimeout = 10_000
      connection.readTimeout = 10_000
      connection.requestMethod = "POST"
      connection.doOutput = true
      connection.setFixedLengthStreamingMode(request.body.size)
      connection.setRequestProperty("Content-Type", "application/json")
      connection.setRequestProperty("Accept", "application/octet-stream")
      connection.setRequestProperty("Accept-Encoding", "identity")
      connection.setRequestProperty("X-Sagip-Origin-Time-Signature", request.signature)
      connection.outputStream.use { it.write(request.body) }
      check(connection.responseCode == 200) { "ORIGIN_TIME_UNAVAILABLE" }
      require(connection.contentLengthLong <= ReceiptV2Codec.MAX_RECEIPT_BYTES)
      return connection.inputStream.use(ReceiptReturnTimeCodec::readResponse)
    } finally { connection.disconnect() }
  }

  internal fun prepareRequest(report: String, challenge: TimeChallenge): OriginTimeRequest {
    val keyId = identity.keyId
    require(keyId.size == 32 && MessageDigest.isEqual(keyId, challenge.verifierId) &&
      MessageDigest.isEqual(keyId, MessageDigest.getInstance("SHA-256").digest(identity.publicKeyDer))) {
      "ORIGIN_TIME_IDENTITY_MISMATCH"
    }
    val body = ReceiptReturnTimeCodec.encodeRequest(challenge)
    val path = OriginTimeRequestProof.path(report)
    val signature = StatusRequestProof.base64(StatusRequestProof.canonicalSignature(
      identity.sign(OriginTimeRequestProof.domain(report, body))))
    return OriginTimeRequest(path, body, signature)
  }
}

internal data class OriginTimeRequest(val path: String, val body: ByteArray, val signature: String)

internal object OriginTimeRequestProof {
  fun path(reportId: String): String {
    require(UUID.fromString(reportId).toString() == reportId)
    return "/v2/reports/" + reportId + "/authority/time"
  }
  fun domain(reportId: String, body: ByteArray): ByteArray {
    require(body.size in 1..1024)
    val digest = MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it.toInt() and 255) }
    return ("SAGIP-ORIGIN-TIME-REQUEST-V1\nPOST\n" + path(reportId) + "\n" + digest + "\n")
      .toByteArray(Charsets.UTF_8)
  }
}

internal object ReceiptReturnTimeCodec {
  fun encodeRequest(challenge: TimeChallenge): ByteArray {
    require(challenge.verifierId.size == 32 && challenge.nonce.size == 32)
    require(UUID.fromString(challenge.verifierBootSessionId).toString() == challenge.verifierBootSessionId)
    // All strings are canonical UUID/base64, so none can introduce JSON escapes or syntax.
    return ("{\"verifierId\":\"" + StatusRequestProof.base64(challenge.verifierId) +
      "\",\"verifierBootSessionId\":\"" + challenge.verifierBootSessionId +
      "\",\"nonce\":\"" + StatusRequestProof.base64(challenge.nonce) + "\"}").toByteArray(Charsets.UTF_8)
  }

  fun decodeResponse(bytes: ByteArray): ByteArray {
    require(bytes.size in 1..ReceiptV2Codec.MAX_RECEIPT_BYTES)
    require(ReceiptV2Codec.decode(bytes).fields is ReceiptFields.Time) { "NOT_TIME_PROOF" }
    return bytes
  }

  fun readResponse(input: InputStream): ByteArray {
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(1024)
    while (true) {
      val count = input.read(buffer)
      if (count < 0) break
      require(out.size() + count <= ReceiptV2Codec.MAX_RECEIPT_BYTES) { "TIME_RESPONSE_TOO_LARGE" }
      out.write(buffer, 0, count)
    }
    return decodeResponse(out.toByteArray())
  }
}
