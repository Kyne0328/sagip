package com.sagip.survival

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.CodingErrorAction
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.UUID

sealed interface ReceiptFields {
  data class Responder(
    val providerKind: Int, val issuerProviderId: ByteArray, val actionId: String, val actionDigest: ByteArray,
    val reportId: String, val reportProtocolVersion: Int, val revision: Int, val payloadDigest: ByteArray,
    val originKeyId: ByteArray, val issuerKeyId: ByteArray, val grantId: String, val responderId: String,
    val callsign: String, val observedIncidentVersion: Long, val status: Int, val sequence: Long,
    val issuedAtMs: Long, val forwardingExpiresAtMs: Long, val note: String,
  ) : ReceiptFields
  data class Requester(
    val eventId: String, val reportId: String, val reportProtocolVersion: Int, val revision: Int,
    val originKeyId: ByteArray, val originPublicKeyDer: ByteArray, val ackEventId: String,
    val ackDigest: ByteArray, val receivedAtMs: Long, val forwardingExpiresAtMs: Long,
  ) : ReceiptFields
  data class Grant(
    val rootKeyId: ByteArray, val grantId: String, val issuerKeyId: ByteArray, val issuerPublicKeyDer: ByteArray,
    val issuerProviderId: ByteArray, val responderId: String, val callsign: String, val statusMask: Int,
    val purposeMask: Int, val scope: String, val notBeforeMs: Long, val expiresAtMs: Long,
  ) : ReceiptFields
  data class Time(
    val proofId: String, val signerProviderId: ByteArray, val signerKeyId: ByteArray, val grantId: String,
    val signerBootSessionId: String, val verifierId: ByteArray, val verifierBootSessionId: String,
    val nonce: ByteArray, val parentCheckpointDigest: ByteArray, val signedTimeMs: Long,
    val elapsedSinceCheckpointMs: Long, val uncertaintyMs: Long, val validUntilMs: Long,
  ) : ReceiptFields
}
data class DecodedReceipt(val fields: ReceiptFields, val signature: ByteArray, val proof: ByteArray)

object ReceiptV2Codec {
  const val MAX_RECEIPT_BYTES = 8192
  private const val MAX_TIME = 9007199254740991L
  private const val NIL = "00000000-0000-0000-0000-000000000000"
  private val MAGIC = listOf("SGA2", "SGR2", "SGG2", "SGT2")
  private val DOMAIN = "SAGIP-SIGNED-V2\u0000".toByteArray(Charsets.US_ASCII)
  private val N = BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)
  private val P = BigInteger("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16)
  private val B = BigInteger("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16)
  private val SPKI = "3059301306072a8648ce3d020106082a8648ce3d03010703420004".chunked(2).map { it.toInt(16).toByte() }.toByteArray()
  private val UUID_PATTERN = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

  fun validatePublicKey(bytes: ByteArray) {
    require(bytes.size == 91 && bytes.copyOfRange(0, 27).contentEquals(SPKI)) { "public key encoding" }
    val x = BigInteger(1, bytes.copyOfRange(27, 59))
    val y = BigInteger(1, bytes.copyOfRange(59, 91))
    require(x < P && y < P && y.multiply(y).mod(P) == x.pow(3).subtract(x.multiply(BigInteger.valueOf(3))).add(B).mod(P)) { "public key curve" }
  }
  private fun validateSignature(bytes: ByteArray) {
    require(bytes.size == 64) { "signature length" }
    val r = BigInteger(1, bytes.copyOfRange(0, 32))
    val s = BigInteger(1, bytes.copyOfRange(32, 64))
    require(r.signum() > 0 && r < N && s.signum() > 0 && s <= N.shiftRight(1)) { "signature canonicality" }
  }
  private fun validateString(s: String, kind: String) {
    val encoder = Charsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
    val size = try { encoder.encode(java.nio.CharBuffer.wrap(s)).remaining() } catch (e: Exception) { throw IllegalArgumentException("invalid UTF-8 input", e) }
    when (kind) {
      "note" -> require(size <= 1024 && !s.contains('\u0000')) { "note" }
      "scope" -> require(size in 1..64 && Regex("[A-Z0-9_:-]+").matches(s)) { "scope" }
      else -> require(size in 1..64 && s.all { it.code in 32..126 } && s.trim() == s) { "callsign" }
    }
  }
  private class Reader(val bytes: ByteArray) {
    var offset = 0
    fun take(n: Int): ByteArray { require(n >= 0 && n <= bytes.size - offset) { "truncated" }; val result = bytes.copyOfRange(offset, offset + n); offset += n; return result }
    fun u8() = take(1)[0].toInt() and 255
    fun u16() = ByteBuffer.wrap(take(2)).order(ByteOrder.BIG_ENDIAN).short.toInt() and 65535
    fun u32() = ByteBuffer.wrap(take(4)).order(ByteOrder.BIG_ENDIAN).int.toLong() and 0xffffffffL
    fun u64(max: Long = Long.MAX_VALUE): Long { val value = ByteBuffer.wrap(take(8)).order(ByteOrder.BIG_ENDIAN).long; require(value in 0..max) { "integer bound" }; return value }
    fun time() = u64(MAX_TIME)
    fun uuid(nil: Boolean = false): String {
      val b = ByteBuffer.wrap(take(16)).order(ByteOrder.BIG_ENDIAN)
      val result = UUID(b.long, b.long).toString()
      require(nil || result != NIL) { "nil UUID" }; return result
    }
    fun string(kind: String): String {
      val n = u16(); require(n <= if (kind == "note") 1024 else 64) { "string bound" }
      val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
      val result = try { decoder.decode(ByteBuffer.wrap(take(n))).toString() } catch (e: Exception) { throw IllegalArgumentException("invalid UTF-8", e) }
      validateString(result, kind); return result
    }
    fun finish() { require(offset == bytes.size) { "trailing bytes" } }
  }
  private class Writer {
    private val bytes = ByteArrayOutputStream()
    private val out = DataOutputStream(bytes)
    fun bytes(b: ByteArray, n: Int = b.size) { require(b.size == n) { "bytes length" }; out.write(b) }
    fun u8(n: Int) { require(n in 0..255); out.writeByte(n) }
    fun u16(n: Int) { require(n in 0..65535); out.writeShort(n) }
    fun u32(n: Long) { require(n in 0..0xffffffffL); out.writeInt(n.toInt()) }
    fun u64(n: Long, max: Long = Long.MAX_VALUE) { require(n in 0..max); out.writeLong(n) }
    fun time(n: Long) = u64(n, MAX_TIME)
    fun uuid(s: String, nil: Boolean = false) { require(UUID_PATTERN.matches(s) && (nil || s != NIL)) { "UUID" }; val id = UUID.fromString(s); out.writeLong(id.mostSignificantBits); out.writeLong(id.leastSignificantBits) }
    fun string(s: String, kind: String) { validateString(s, kind); val b = s.toByteArray(Charsets.UTF_8); u16(b.size); bytes(b) }
    fun build() = bytes.toByteArray()
  }
  private fun validReport(protocol: Int, revision: Long) {
    require(protocol in 1..2 && revision in 1..2147483647L) { "report binding" }
  }
  private fun readBody(purpose: Int, body: ByteArray): ReceiptFields {
    val r = Reader(body)
    val fields = when (purpose) {
      1 -> {
        val providerKind = r.u8(); val provider = r.take(32); val action = r.uuid(); val digest = r.take(32)
        val report = r.uuid(); val protocol = r.u8(); val revision = r.u32(); validReport(protocol, revision)
        val payload = r.take(32); val origin = r.take(32); val issuer = r.take(32); val grant = r.uuid(true)
        val responder = r.uuid(); val callsign = r.string("callsign"); val observed = r.u64(); val status = r.u8()
        val sequence = r.u64(); val issued = r.time(); val expiry = r.time(); val note = r.string("note")
        require(providerKind in 1..2 && status in 1..4 && sequence > 0 && (if (providerKind == 1) grant == NIL else grant != NIL)) { "ACK fields" }
        require(expiry > issued && expiry - issued <= 604800000L) { "ACK expiry" }
        ReceiptFields.Responder(providerKind, provider, action, digest, report, protocol, revision.toInt(), payload, origin, issuer, grant, responder, callsign, observed, status, sequence, issued, expiry, note)
      }
      2 -> {
        val event = r.uuid(); val report = r.uuid(); val protocol = r.u8(); val revision = r.u32(); validReport(protocol, revision)
        val origin = r.take(32); val public = r.take(91); validatePublicKey(public)
        ReceiptFields.Requester(event, report, protocol, revision.toInt(), origin, public, r.uuid(), r.take(32), r.time(), r.time())
      }
      3 -> {
        val root = r.take(32); val grant = r.uuid(); val issuer = r.take(32); val public = r.take(91); validatePublicKey(public)
        val provider = r.take(32); val responder = r.uuid(); val callsign = r.string("callsign"); val statuses = r.u8(); val purposes = r.u8()
        require(statuses and 1 == 1 && statuses and 15.inv() == 0 && purposes and 1 == 1 && purposes and 9.inv() == 0) { "grant purposes" }
        ReceiptFields.Grant(root, grant, issuer, public, provider, responder, callsign, statuses, purposes, r.string("scope"), r.time(), r.time())
      }
      4 -> {
        val id = r.uuid(); val provider = r.take(32); val signer = r.take(32); val grant = r.uuid(true); val boot = r.uuid(true)
        val verifier = r.take(32); val verifierBoot = r.uuid(); val nonce = r.take(32); val parent = r.take(32)
        require(if (grant == NIL) boot == NIL else boot != NIL) { "time boot identity" }
        ReceiptFields.Time(id, provider, signer, grant, boot, verifier, verifierBoot, nonce, parent, r.time(), r.time(), r.u32(), r.time())
      }
      else -> throw IllegalArgumentException("purpose")
    }
    r.finish(); return fields
  }
  private fun writeBody(f: ReceiptFields): ByteArray {
    val w = Writer()
    when (f) {
      is ReceiptFields.Responder -> {
        w.u8(f.providerKind); w.bytes(f.issuerProviderId, 32); w.uuid(f.actionId); w.bytes(f.actionDigest, 32)
        w.uuid(f.reportId); w.u8(f.reportProtocolVersion); w.u32(f.revision.toLong()); w.bytes(f.payloadDigest, 32); w.bytes(f.originKeyId, 32)
        w.bytes(f.issuerKeyId, 32); w.uuid(f.grantId, true); w.uuid(f.responderId); w.string(f.callsign, "callsign"); w.u64(f.observedIncidentVersion)
        w.u8(f.status); w.u64(f.sequence); w.time(f.issuedAtMs); w.time(f.forwardingExpiresAtMs); w.string(f.note, "note")
      }
      is ReceiptFields.Requester -> {
        w.uuid(f.eventId); w.uuid(f.reportId); w.u8(f.reportProtocolVersion); w.u32(f.revision.toLong()); w.bytes(f.originKeyId, 32)
        w.bytes(f.originPublicKeyDer, 91); w.uuid(f.ackEventId); w.bytes(f.ackDigest, 32); w.time(f.receivedAtMs); w.time(f.forwardingExpiresAtMs)
      }
      is ReceiptFields.Grant -> {
        w.bytes(f.rootKeyId, 32); w.uuid(f.grantId); w.bytes(f.issuerKeyId, 32); w.bytes(f.issuerPublicKeyDer, 91); w.bytes(f.issuerProviderId, 32)
        w.uuid(f.responderId); w.string(f.callsign, "callsign"); w.u8(f.statusMask); w.u8(f.purposeMask); w.string(f.scope, "scope"); w.time(f.notBeforeMs); w.time(f.expiresAtMs)
      }
      is ReceiptFields.Time -> {
        w.uuid(f.proofId); w.bytes(f.signerProviderId, 32); w.bytes(f.signerKeyId, 32); w.uuid(f.grantId, true); w.uuid(f.signerBootSessionId, true)
        w.bytes(f.verifierId, 32); w.uuid(f.verifierBootSessionId); w.bytes(f.nonce, 32); w.bytes(f.parentCheckpointDigest, 32)
        w.time(f.signedTimeMs); w.time(f.elapsedSinceCheckpointMs); w.u32(f.uncertaintyMs); w.time(f.validUntilMs)
      }
    }
    return w.build()
  }
  private fun purpose(f: ReceiptFields) = when (f) {
    is ReceiptFields.Responder -> 1
    is ReceiptFields.Requester -> 2
    is ReceiptFields.Grant -> 3
    is ReceiptFields.Time -> 4
  }
  fun decode(bytes: ByteArray): DecodedReceipt = decode(bytes, false)
  private fun decode(bytes: ByteArray, member: Boolean): DecodedReceipt {
    require(bytes.size in 80..MAX_RECEIPT_BYTES) { "total length" }
    val r = Reader(bytes)
    val magic = r.take(4).toString(Charsets.US_ASCII); val version = r.u8(); val algorithm = r.u8(); val purpose = r.u8(); val flags = r.u8()
    require(version == 2 && algorithm == 1 && purpose in 1..4 && magic == MAGIC[purpose - 1] && flags == 0) { "header" }
    val bodyLength = r.u16(); val proofLength = r.u16(); val signatureLength = r.u16(); val reserved = r.u16()
    require(signatureLength == 64 && reserved == 0 && 16 + bodyLength + proofLength + 64 == bytes.size) { "lengths" }
    require(!member || proofLength == 0) { "proof depth" }
    val fields = readBody(purpose, r.take(bodyLength)); val proof = r.take(proofLength); val signature = r.take(64); r.finish(); validateSignature(signature)
    val members = mutableListOf<DecodedReceipt>()
    if (proof.isNotEmpty()) {
      val pr = Reader(proof); val count = pr.u8(); require(count in 1..2) { "proof count" }
      val seen = mutableListOf<ByteArray>()
      repeat(count) { val b = pr.take(pr.u16()); require(seen.none { it.contentEquals(b) }) { "duplicate proof" }; seen.add(b); members.add(decode(b, true)) }
      pr.finish()
    }
    when (fields) {
      is ReceiptFields.Responder -> require(if (fields.providerKind == 1) members.isEmpty() else members.size == 1 && members[0].fields is ReceiptFields.Grant) { "ACK proof" }
      is ReceiptFields.Time -> if (fields.grantId == NIL) require(members.isEmpty()) else require(members.size == 2 && members[0].fields is ReceiptFields.Grant && (members[1].fields as? ReceiptFields.Time)?.grantId == NIL) { "time proof" }
      else -> require(members.isEmpty()) { "proof profile" }
    }
    return DecodedReceipt(fields, signature, proof)
  }
  fun encode(fields: ReceiptFields, signature: ByteArray, proof: ByteArray): ByteArray {
    val body = writeBody(fields); val w = Writer(); val purpose = purpose(fields)
    require(body.size + proof.size + 80 <= MAX_RECEIPT_BYTES) { "total length" }
    w.bytes(MAGIC[purpose - 1].toByteArray(Charsets.US_ASCII)); w.u8(2); w.u8(1); w.u8(purpose); w.u8(0)
    w.u16(body.size); w.u16(proof.size); w.u16(64); w.u16(0); w.bytes(body); w.bytes(proof); w.bytes(signature, 64)
    val bytes = w.build(); decode(bytes); return bytes
  }
  fun verifySignature(receipt: DecodedReceipt, publicKey: ByteArray): Boolean = try {
    validatePublicKey(publicKey)
    val bytes = encode(receipt.fields, receipt.signature, receipt.proof)
    val verifier = Signature.getInstance("SHA256withECDSA")
    verifier.initVerify(KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(publicKey)))
    verifier.update(DOMAIN); verifier.update(bytes, 0, bytes.size - 64)
    verifier.verify(toDer(receipt.signature))
  } catch (_: Exception) { false }
  private fun toDer(signature: ByteArray): ByteArray {
    validateSignature(signature)
    val r = BigInteger(1, signature.copyOfRange(0, 32)).toByteArray()
    val s = BigInteger(1, signature.copyOfRange(32, 64)).toByteArray()
    return byteArrayOf(0x30, (r.size + s.size + 4).toByte(), 0x02, r.size.toByte()) + r + byteArrayOf(0x02, s.size.toByte()) + s
  }
}
