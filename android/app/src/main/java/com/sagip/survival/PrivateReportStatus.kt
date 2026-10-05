package com.sagip.survival

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.SecureRandom
import java.util.UUID
import org.json.JSONObject
import org.json.JSONTokener

/** Authenticated server observations are distinct from portable, signed receipt evidence. */
data class PrivateStatusPage(
  val reportId: String,
  val currentRevision: Int,
  val checkedAt: Long,
  val acknowledgements: List<ResponderAck>,
  val latestAck: ResponderAck?,
  val nextCursor: String?,
)

interface PrivateReportStatusSender {
  suspend fun fetchPrivateReportStatus(reportId: String, cursor: String?): PrivateStatusPage
}

internal object StatusRequestProof {
  private val order = BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)

  fun domain(reportId: String, timestamp: Long, nonce: String, cursor: String?): ByteArray {
    require(UUID.fromString(reportId).toString() == reportId)
    require(timestamp >= 0 && nonce.matches(Regex("[A-Za-z0-9+/]{43}=")) &&
      (ALPHABET.indexOf(nonce[42]) and 3) == 0)
    return "SAGIP-REPORT-STATUS-V1\n$reportId\n$timestamp\n$nonce\n${cursor ?: ""}\n".toByteArray(Charsets.UTF_8)
  }

  // java.util.Base64 is unavailable on supported Android 24/25.
  private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  fun base64(bytes: ByteArray): String = buildString {
    var i = 0
    while(i < bytes.size) {
      val remaining = bytes.size - i
      val n = ((bytes[i].toInt() and 255) shl 16) or
        (if(remaining > 1) (bytes[i+1].toInt() and 255) shl 8 else 0) or
        (if(remaining > 2) bytes[i+2].toInt() and 255 else 0)
      append(ALPHABET[(n ushr 18) and 63]);append(ALPHABET[(n ushr 12) and 63])
      append(if(remaining > 1) ALPHABET[(n ushr 6) and 63] else '=')
      append(if(remaining > 2) ALPHABET[n and 63] else '=')
      i += 3
    }
  }

  fun canonicalSignature(der: ByteArray): ByteArray {
    var offset = 0
    fun octet(): Int { require(offset < der.size); return der[offset++].toInt() and 255 }
    fun scalar(): BigInteger {
      require(octet() == 2)
      val size = octet()
      require(size in 1..33 && offset + size <= der.size)
      val bytes = der.copyOfRange(offset, offset + size)
      offset += size
      require(bytes[0].toInt() >= 0)
      return BigInteger(1, bytes).also { require(it.signum() > 0 && it < order) }
    }
    require(octet() == 0x30)
    require(octet() == der.size - 2)
    val r = scalar()
    var s = scalar()
    require(offset == der.size)
    if (s > order.shiftRight(1)) s = order - s
    fun fixed(n: BigInteger): ByteArray {
      val b = n.toByteArray().let { if (it.size == 33) it.copyOfRange(1, 33) else it }
      return ByteArray(32 - b.size) + b
    }
    return fixed(r) + fixed(s)
  }
}

class HttpPrivateReportStatusSender(
  private val envelopeUrl: String,
  private val identity: SigningIdentity,
  private val clock: () -> Long = System::currentTimeMillis,
  private val random: SecureRandom = SecureRandom(),
) : PrivateReportStatusSender {
  override suspend fun fetchPrivateReportStatus(reportId: String, cursor: String?): PrivateStatusPage {
    require(UUID.fromString(reportId).toString() == reportId)
    require(cursor == null || cursor.length <= 1024)
    val endpoint = URL(envelopeUrl)
    require(endpoint.protocol == "https" || (org.sagip.app.BuildConfig.DEBUG && endpoint.protocol == "http"))
    val basePath = endpoint.path.removeSuffix("/v1/envelopes")
    require(basePath != endpoint.path)
    val query = cursor?.let { "?cursor=" + URLEncoder.encode(it, "UTF-8") } ?: ""
    val target = URL(endpoint, "$basePath/v1/reports/$reportId/status$query")
    val nonce = StatusRequestProof.base64(ByteArray(32).also(random::nextBytes))
    val timestamp = clock()
    val signature = StatusRequestProof.base64(
      StatusRequestProof.canonicalSignature(identity.sign(StatusRequestProof.domain(reportId, timestamp, nonce, cursor))),
    )
    val connection = (target.openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      instanceFollowRedirects = false
      connectTimeout = 10_000
      readTimeout = 10_000
      setRequestProperty("Accept", "application/json")
      setRequestProperty("X-Sagip-Status-Timestamp", timestamp.toString())
      setRequestProperty("X-Sagip-Status-Nonce", nonce)
      setRequestProperty("X-Sagip-Status-Signature", signature)
    }
    return try {
      check(connection.responseCode == 200) { "STATUS_HTTP_${connection.responseCode}" }
      val json = connection.inputStream.use { readBounded(it) }
      parse(reportId, json)
    } finally {
      connection.disconnect()
    }
  }

  companion object {
    const val MAX_BYTES = 262_144
    internal fun readBounded(input: InputStream): String {
      val out = ByteArrayOutputStream()
      val bytes = ByteArray(8192)
      while (true) {
        val count = input.read(bytes)
        if (count < 0) break
        require(out.size() + count <= MAX_BYTES) { "Status response too large" }
        out.write(bytes, 0, count)
      }
      return Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(out.toByteArray())).toString()
    }

    internal fun parse(reportId: String, json: String): PrivateStatusPage {
      require(json.toByteArray(Charsets.UTF_8).size <= MAX_BYTES)
      val tokener = JSONTokener(json)
      val root = tokener.nextValue() as? JSONObject ?: error("Status object required")
      require(tokener.nextClean() == '\u0000') { "Trailing status content" }
      require(root.get("reportId") == reportId) { "Status report mismatch" }
      require(root.get("serverAccepted") == true)
      require(root.get("transport") == "AUTHENTICATED_SERVER" && root.get("statusScope") == "REPORT")
      val rawRevision = root.get("currentRevision")
      require(rawRevision is Number && rawRevision.toDouble() == rawRevision.toInt().toDouble() && rawRevision.toInt() > 0)
      val checkedAt = timestamp(root.getString("checkedAt"))
      fun ack(value: JSONObject): ResponderAck {
        val id = value.getString("ackId")
        require(UUID.fromString(id).toString() == id)
        require(value.has("revision") && value.isNull("revision"))
        val status = value.getString("status")
        require(status in setOf("ACKNOWLEDGED", "EN_ROUTE", "ON_SCENE", "RESOLVED"))
        fun optional(name: String, maxBytes: Int): String? =
          if (value.isNull(name)) null else value.getString(name).also {
            require(it.toByteArray(Charsets.UTF_8).size <= maxBytes && !it.contains('\u0000'))
          }
        return ResponderAck(id, reportId, "SERVER", optional("callsign", 128), status,
          optional("note", 4096), timestamp(value.getString("acknowledgedAt")))
      }
      val array = root.getJSONArray("acknowledgements")
      require(array.length() <= 100)
      val acknowledgements = (0 until array.length()).map { ack(array.getJSONObject(it)) }
      require(acknowledgements.map { it.ackId }.distinct().size == acknowledgements.size)
      val latest = if (root.isNull("latestAck")) null else ack(root.getJSONObject("latestAck"))
      val next = if (root.isNull("nextCursor")) null else root.getString("nextCursor").also {
        require(it.isNotEmpty() && it.length <= 1024 && !it.contains('\n'))
      }
      return PrivateStatusPage(reportId, rawRevision.toInt(), checkedAt, acknowledgements, latest, next)
    }

    private fun timestamp(value: String): Long {
      require(value.matches(Regex("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z")))
      return java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply {
        isLenient = false
        timeZone = java.util.TimeZone.getTimeZone("UTC")
      }.parse(value)!!.time.also { require(it >= 0) }
    }
  }
}
