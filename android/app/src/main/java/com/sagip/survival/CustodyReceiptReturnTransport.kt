package com.sagip.survival

import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID

/** Exact accepted SOS possession authorizes its note-free feed; no shared credential is installed. */
class HttpCustodyReceiptReturnTransport(
  baseUrl: String,
  private val envelopes: (String) -> ByteArray?,
  private val reports: () -> Set<String>,
  private val identity: SigningIdentity,
  private val clock: () -> MonotonicClock,
) : ReceiptReturnTransport, ReceiptReturnTimeTransport {
  private val base = URI(baseUrl).also {
    require(it.scheme=="https" && it.host!=null && it.rawUserInfo==null && it.rawQuery==null && it.rawFragment==null)
    require(it.rawPath.isNullOrEmpty() || it.rawPath=="/")
  }.toString().trimEnd('/')
  private val decoder = HttpReceiptReturnTransport(base) { error("CUSTODY_TRANSPORT_HAS_NO_BEARER_TOKEN") }

  override fun fetch(reportId: String, cursor: String?): ReceiptReturnPage {
    val current=clock()
    val challenge=TimeChallenge(UUID.randomUUID().toString(),identity.keyId,current.bootId,
      SecureRandom().generateSeed(32),current.elapsedMs,null,
      VerificationContext(emptyMap(),emptySet(),emptySet(),null,null,false,null,null),{false})
    val request=prepareRequest(reportId,"receipts",challenge,cursor)
    return decoder.decodePage(post(request,262144),cursor)
  }

  override fun fetch(challenge: TimeChallenge): ByteArray {
    // Retained reports come from successful SOS upload/custody, not from a caller-supplied identifier.
    for(report in reports().take(4)) {
      try { return ReceiptReturnTimeCodec.decodeResponse(post(prepareRequest(report,"authority/time",challenge),ReceiptV2Codec.MAX_RECEIPT_BYTES)) }
      catch (_: Exception) { /* Another retained accepted report may bootstrap the same local challenge. */ }
    }
    error("CUSTODY_TIME_UNAVAILABLE")
  }

  internal fun prepareRequest(report: String, operation: String, challenge: TimeChallenge,
    cursor: String? = null): OriginTimeRequest {
    require(UUID.fromString(report).toString()==report && operation in setOf("receipts","authority/time"))
    require(cursor==null || cursor.matches(Regex("[0-9a-f]{64}")))
    require(challenge.verifierId.size==32 && challenge.nonce.size==32 &&
      MessageDigest.isEqual(identity.keyId,challenge.verifierId) &&
      MessageDigest.isEqual(identity.keyId,MessageDigest.getInstance("SHA-256").digest(identity.publicKeyDer)))
    require(UUID.fromString(challenge.verifierBootSessionId).toString()==challenge.verifierBootSessionId &&
      challenge.verifierBootSessionId!="00000000-0000-0000-0000-000000000000")
    val envelope=requireNotNull(envelopes(report)) { "CUSTODY_ENVELOPE_UNAVAILABLE" }
    require(envelope.size in 1..8192)
    val body=("{\"verifierId\":\""+StatusRequestProof.base64(challenge.verifierId)+
      "\",\"verifierBootSessionId\":\""+challenge.verifierBootSessionId+
      "\",\"nonce\":\""+StatusRequestProof.base64(challenge.nonce)+
      "\",\"verifierPublicKeyDer\":\""+StatusRequestProof.base64(identity.publicKeyDer)+
      "\",\"envelopeBase64\":\""+StatusRequestProof.base64(envelope)+"\""+
      (if(operation=="receipts") ",\"cursor\":"+(cursor?.let { "\"$it\"" } ?: "null") else "")+"}").toByteArray(Charsets.UTF_8)
    val path="/v2/custody/reports/$report/$operation"
    val digest=MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it.toInt() and 255) }
    val input=("SAGIP-CUSTODY-REQUEST-V1\nPOST\n$path\n$digest\n").toByteArray(Charsets.US_ASCII)
    val signature=StatusRequestProof.base64(StatusRequestProof.canonicalSignature(identity.sign(input)))
    return OriginTimeRequest(path,body,signature)
  }

  private fun post(request: OriginTimeRequest, maxBytes: Int): ByteArray {
    val connection=URI(base+request.path).toURL().openConnection() as HttpURLConnection
    try {
      connection.instanceFollowRedirects=false;connection.connectTimeout=10_000;connection.readTimeout=10_000
      connection.requestMethod="POST";connection.doOutput=true;connection.setFixedLengthStreamingMode(request.body.size)
      connection.setRequestProperty("Content-Type","application/json")
      connection.setRequestProperty("Accept",if(request.path.endsWith("/receipts")) "application/json" else "application/octet-stream")
      connection.setRequestProperty("Accept-Encoding","identity")
      connection.setRequestProperty("X-Sagip-Custody-Signature",request.signature)
      connection.outputStream.use { it.write(request.body) }
      check(connection.responseCode==200) { "CUSTODY_FEED_UNAVAILABLE" }
      require(connection.contentLengthLong<=maxBytes)
      return connection.inputStream.use { input ->
        val out=java.io.ByteArrayOutputStream();val chunk=ByteArray(2048)
        while(true) {val n=input.read(chunk);if(n<0)break;require(out.size()+n<=maxBytes);out.write(chunk,0,n)}
        out.toByteArray()
      }
    } finally {connection.disconnect()}
  }
}

/** Bounded native inventory of upload-confirmed original envelopes, including relayed SOS. */
internal class CustodyReceiptInventory(private val database: SagipDatabase) {
  private val sql="""SELECT report_id,envelope_bytes FROM outbound_envelopes
    WHERE envelope_bytes IS NOT NULL AND delivery_state IN ('SERVER_ACCEPTED','RESPONDER_ACKNOWLEDGED')
    UNION ALL SELECT report_id,envelope_bytes FROM inbound_envelopes
    WHERE report_id IS NOT NULL AND delivery_state IN ('SERVER_ACCEPTED','RESPONDER_ACKNOWLEDGED')""".trimIndent()
  fun reports(): Set<String> = database.readableDatabase.rawQuery(
    "SELECT DISTINCT report_id FROM ($sql) LIMIT 10000",null).use { c ->
    buildSet {while(c.moveToNext()) add(c.getString(0))}
  }
  fun envelope(report: String): ByteArray? = database.readableDatabase.rawQuery(
    "SELECT envelope_bytes FROM ($sql) WHERE report_id=? LIMIT 1",arrayOf(report)).use {
    if(it.moveToFirst())it.getBlob(0) else null
  }
}
