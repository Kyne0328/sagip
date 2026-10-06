package com.sagip.survival

import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.util.UUID

/** Automatic signed time bootstrap, even before an installation creates its first SOS. */
class HttpDeviceReceiptTimeTransport(baseUrl: String,private val identity: SigningIdentity):ReceiptReturnTimeTransport {
  private val base=URI(baseUrl).also {
    require(it.scheme=="https" && it.host!=null && it.rawUserInfo==null && it.rawQuery==null && it.rawFragment==null)
    require(it.rawPath.isNullOrEmpty() || it.rawPath=="/")
  }.toString().trimEnd('/')
  internal fun prepareRequest(challenge:TimeChallenge):OriginTimeRequest {
    require(challenge.verifierId.size==32 && challenge.nonce.size==32 &&
      MessageDigest.isEqual(identity.keyId,challenge.verifierId) &&
      MessageDigest.isEqual(identity.keyId,MessageDigest.getInstance("SHA-256").digest(identity.publicKeyDer)))
    require(UUID.fromString(challenge.verifierBootSessionId).toString()==challenge.verifierBootSessionId &&
      challenge.verifierBootSessionId!="00000000-0000-0000-0000-000000000000")
    val body=("{\"verifierId\":\""+StatusRequestProof.base64(challenge.verifierId)+
      "\",\"verifierBootSessionId\":\""+challenge.verifierBootSessionId+
      "\",\"nonce\":\""+StatusRequestProof.base64(challenge.nonce)+
      "\",\"verifierPublicKeyDer\":\""+StatusRequestProof.base64(identity.publicKeyDer)+"\"}").toByteArray(Charsets.UTF_8)
    val path="/v2/authority/device-time"
    val hash=MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it.toInt() and 255) }
    val signature=StatusRequestProof.base64(StatusRequestProof.canonicalSignature(
      identity.sign(("SAGIP-DEVICE-TIME-REQUEST-V1\nPOST\n$path\n$hash\n").toByteArray(Charsets.US_ASCII))))
    return OriginTimeRequest(path,body,signature)
  }
  override fun fetch(challenge:TimeChallenge):ByteArray {
    val request=prepareRequest(challenge)
    val connection=URI(base+request.path).toURL().openConnection() as HttpURLConnection
    try {
      connection.instanceFollowRedirects=false;connection.connectTimeout=10_000;connection.readTimeout=10_000
      connection.requestMethod="POST";connection.doOutput=true;connection.setFixedLengthStreamingMode(request.body.size)
      connection.setRequestProperty("Content-Type","application/json");connection.setRequestProperty("Accept","application/octet-stream")
      connection.setRequestProperty("Accept-Encoding","identity");connection.setRequestProperty("X-Sagip-Device-Time-Signature",request.signature)
      connection.outputStream.use {it.write(request.body)}
      check(connection.responseCode==200) {"DEVICE_TIME_UNAVAILABLE"}
      require(connection.contentLengthLong<=ReceiptV2Codec.MAX_RECEIPT_BYTES)
      return connection.inputStream.use(ReceiptReturnTimeCodec::readResponse)
    } finally {connection.disconnect()}
  }
}
