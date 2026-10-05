package com.sagip.survival

import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

data class OfflineRootBundle(val receipt: ByteArray, val proof: ByteArray)
data class OfflineRootSignedObject(val fields: Map<String, String>, val signature: ByteArray, val signingInput: ByteArray) {
  operator fun get(name: String): String = requireNotNull(fields[name])
  fun number(name: String): Long = get(name).toLong()
}
data class OfflineRootSignerBinding(val checkpointSignerKeyId: String, val receiptRootKeyId: String, val issuerProviderId: String)
data class OfflineRootPolicy(
  val mode: String,
  val authorityDomainId: String,
  val signerBindings: List<OfflineRootSignerBinding>,
  val allowedScopes: List<String>,
  val allowedStatuses: List<Int>,
  val maxAuthorityStalenessMs: Long,
  val maxReceiptIssuanceAgeMs: Long,
  val maxProofValidityMs: Long,
  val qualifiedTimeSourceIds: List<String>,
  val disseminationAudience: String,
  val providerConflictHandling: String,
  val resolvedHandling: String,
  val maxReplayRecords: Int,
)
/** Qualification is supplied by the trusted native clock owner, never by a receipt/feed. */
data class OfflineRootClockQualification(
  val sourceId: String, val timeSignerKeyId: String, val bootId: String,
  val maximumDriftPpm: Int, val maximumCheckpointAgeMs: Long,
)
data class OfflineRootConfig(
  val policy: OfflineRootPolicy,
  val checkpointSignerKeys: Map<String, ByteArray>,
  val clockQualification: () -> OfflineRootClockQualification?,
  val maxEvidenceBytes: Long = 8L * 1024L * 1024L,
)
data class OfflineRootVerificationContext(
  val proofBytes: ByteArray,
  val configuration: OfflineRootConfig,
  val revokedKeyIds: Set<String>,
  val revokedProviderIds: Set<String>,
  val activeReportRevision: Int,
)

object OfflineRootSnapshotCodec {
  const val MAX_PROOF_BYTES = 4096
  const val MAX_BUNDLE_BYTES = 8192
  const val KIND = "VERIFIED_OFFLINE_ROOT_SNAPSHOT"
  const val MAX_TIME = 9007199254740991L
  val HEX = Regex("[0-9a-f]{64}")
  private val LABEL = Regex("[A-Z0-9_:-]{1,64}")
  private val UUID = Regex("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")
  private val N = BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)
  private val proofFields = listOf("format","version","algorithm","proofId","policyDigest","authorityDomainId",
    "checkpointSignerKeyId","receiptRootKeyId","issuerProviderId","receiptDigest","eventId","actionDigest",
    "reportId","reportProtocolVersion","revision","payloadDigest","originKeyId","scope","status","authorityState",
    "authorityStateDigest","revocationEpoch","notBeforeMs","authorityCheckedAtMs","authorityTimeUncertaintyMs","expiresAtMs")
  private val revocationFields = listOf("format","version","algorithm","revocationId","policyDigest","authorityDomainId",
    "checkpointSignerKeyId","targetKind","targetId","revocationEpoch","authorityStateDigest","revokedAtMs")
  private val numbers = setOf("version","algorithm","reportProtocolVersion","revision","status",
    "notBeforeMs","authorityCheckedAtMs","authorityTimeUncertaintyMs","expiresAtMs","revokedAtMs")
  fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
  fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
  fun digest(bytes: ByteArray) = hex(hash(bytes))
  private fun uuid(value: String) = UUID.matches(value) && value != "00000000-0000-0000-0000-000000000000"
  private fun quote(value: String) = "\"" + value + "\""
  private fun signatureShape(signature: ByteArray) {
    require(signature.size == 64) { "SIGNATURE_SHAPE" }
    val r = BigInteger(1, signature.copyOfRange(0,32))
    val s = BigInteger(1, signature.copyOfRange(32,64))
    require(r.signum() > 0 && r < N && s.signum() > 0 && s <= N.shiftRight(1)) { "SIGNATURE_SHAPE" }
  }
  private fun decode(bytes: ByteArray, magic: String, names: List<String>, domain: String): OfflineRootSignedObject {
    require(bytes.size in 74..MAX_PROOF_BYTES) { "PROOF_SIZE" }
    require(bytes.copyOfRange(0,4).contentEquals(magic.toByteArray(Charsets.US_ASCII))) { "PROOF_MAGIC" }
    val length = ByteBuffer.wrap(bytes,4,4).int
    require(length > 0 && length == bytes.size - 72) { "PROOF_LENGTH" }
    val raw = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes,8,length)).toString()
    // This contract deliberately contains only constrained ASCII strings and nonnegative integers.
    // Exact reconstruction rejects duplicate keys, whitespace, alternate escapes/order and BOM.
    var offset = 1
    require(raw.startsWith("{") && raw.endsWith("}")) { "PROOF_JSON" }
    val fields = linkedMapOf<String,String>()
    for ((index,name) in names.withIndex()) {
      val prefix = quote(name) + ":"
      require(raw.startsWith(prefix,offset)) { "PROOF_FIELDS" }; offset += prefix.length
      val token = if(name in numbers) Regex("0|[1-9][0-9]*") else Regex("\"[A-Za-z0-9_:-]+\"")
      val match = token.find(raw,offset)
      require(match != null && match.range.first == offset) { "PROOF_TYPE" }
      val value = match.value
      fields[name] = if(name in numbers) value else value.substring(1,value.length-1)
      offset += value.length
      require(raw.getOrNull(offset) == if(index == names.lastIndex) '}' else ',') { "PROOF_CANONICAL" }
      offset++
    }
    require(offset == raw.length) { "PROOF_TRAILING" }
    require(fields["version"] == "1" && fields["algorithm"] == "1") { "PROOF_VERSION" }
    for(name in names.filter { it.endsWith("Digest") || it.endsWith("KeyId") || it == "issuerProviderId" || it == "targetId" })
      require(HEX.matches(fields.getValue(name))) { "PROOF_DIGEST" }
    require(LABEL.matches(fields.getValue("authorityDomainId"))) { "PROOF_DOMAIN" }
    val epoch = fields.getValue("revocationEpoch")
    require(Regex("0|[1-9][0-9]{0,18}").matches(epoch) && epoch.toLongOrNull() != null) { "PROOF_EPOCH" }
    for(name in names.filter { it in numbers }) require(fields.getValue(name).toLongOrNull() in 0..MAX_TIME) { "PROOF_TIME" }
    val signature = bytes.copyOfRange(bytes.size-64,bytes.size)
    signatureShape(signature)
    return OfflineRootSignedObject(fields,signature,domain.toByteArray(Charsets.US_ASCII)+byteArrayOf(0)+bytes.copyOfRange(0,bytes.size-64))
  }
  fun decodeProof(bytes: ByteArray): OfflineRootSignedObject {
    val p = decode(bytes,"SOR1",proofFields,"SAGIP-OFFLINE-ROOT-SNAPSHOT-V1")
    require(p["format"] == "SAGIP_OFFLINE_ROOT_SNAPSHOT") { "PROOF_FORMAT" }
    require(uuid(p["proofId"]) && uuid(p["eventId"]) && uuid(p["reportId"])) { "PROOF_UUID" }
    require(LABEL.matches(p["scope"])) { "PROOF_SCOPE" }
    require(p.number("reportProtocolVersion") in 1..2 && p.number("revision") in 1..Int.MAX_VALUE.toLong() &&
      p.number("status") in 1..4) { "PROOF_REPORT" }
    require(p["authorityState"] in setOf("ACTIVE_AT_CHECKPOINT","REVOKED_AT_CHECKPOINT")) { "PROOF_STATE" }
    val low = p.number("authorityCheckedAtMs") - p.number("authorityTimeUncertaintyMs")
    val high = p.number("authorityCheckedAtMs") + p.number("authorityTimeUncertaintyMs")
    require(low in 0..MAX_TIME && high in low..MAX_TIME && p.number("notBeforeMs") <= low && high < p.number("expiresAtMs")) { "PROOF_INTERVAL" }
    return p
  }
  fun decodeRevocation(bytes: ByteArray): OfflineRootSignedObject {
    val r = decode(bytes,"SOV1",revocationFields,"SAGIP-OFFLINE-ROOT-REVOCATION-V1")
    require(r["format"] == "SAGIP_OFFLINE_ROOT_REVOCATION" && uuid(r["revocationId"]) &&
      r["targetKind"] in setOf("KEY","PROVIDER") && r.number("revocationEpoch") > 0) { "REVOCATION_PROFILE" }
    return r
  }
  fun decodeBundle(bytes: ByteArray): OfflineRootBundle {
    require(bytes.size in 14..MAX_BUNDLE_BYTES && bytes.copyOfRange(0,4).contentEquals("SGB1".toByteArray())) { "BUNDLE_HEADER" }
    val r = ByteBuffer.wrap(bytes,4,4).int; val p = ByteBuffer.wrap(bytes,8,4).int
    require(r in 1..ReceiptV2Codec.MAX_RECEIPT_BYTES && p in 74..MAX_PROOF_BYTES && 12L+r+p == bytes.size.toLong()) { "BUNDLE_LENGTH" }
    val bundle = OfflineRootBundle(bytes.copyOfRange(12,12+r),bytes.copyOfRange(12+r,bytes.size))
    val receipt = ReceiptV2Codec.decode(bundle.receipt).fields as? ReceiptFields.Responder ?: error("ROOT_RECEIPT_PROFILE")
    require(receipt.providerKind == 1 && receipt.note.isEmpty()) { "ROOT_RECEIPT_PRIVACY" }
    val proof = decodeProof(bundle.proof)
    require(proof["receiptDigest"] == digest(bundle.receipt)) { "BUNDLE_BINDING" }
    return bundle
  }
  fun validUntil(p:OfflineRootSignedObject,r:ReceiptFields.Responder,policy:OfflineRootPolicy):Long = minOf(
    p.number("expiresAtMs"),r.forwardingExpiresAtMs,
    p.number("authorityCheckedAtMs")-p.number("authorityTimeUncertaintyMs")+policy.maxAuthorityStalenessMs,
    r.issuedAtMs+policy.maxReceiptIssuanceAgeMs)

  fun verifySignature(p: OfflineRootSignedObject, key: ByteArray): Boolean = runCatching {
    ReceiptV2Codec.validatePublicKey(key); signatureShape(p.signature)
    val r = BigInteger(1,p.signature.copyOfRange(0,32)).toByteArray()
    val s = BigInteger(1,p.signature.copyOfRange(32,64)).toByteArray()
    val der = byteArrayOf(0x30,(4+r.size+s.size).toByte(),2,r.size.toByte())+r+byteArrayOf(2,s.size.toByte())+s
    Signature.getInstance("SHA256withECDSA").run {
      initVerify(KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(key)))
      update(p.signingInput); verify(der)
    }
  }.getOrDefault(false)
  fun policyDigest(p: OfflineRootPolicy): String {
    require(p.mode == "BOUNDED_OFFLINE_ROOT_SNAPSHOT" && LABEL.matches(p.authorityDomainId)) { "POLICY_MODE" }
    fun <T> list(values: List<T>, valid: (T)->Boolean) = values.size in 1..64 && values.distinct().size == values.size && values.all(valid)
    require(list(p.signerBindings) { HEX.matches(it.checkpointSignerKeyId) && HEX.matches(it.receiptRootKeyId) &&
      HEX.matches(it.issuerProviderId) && it.checkpointSignerKeyId != it.receiptRootKeyId }) { "POLICY_SIGNERS" }
    require(list(p.allowedScopes) { LABEL.matches(it) } && list(p.qualifiedTimeSourceIds) { LABEL.matches(it) } &&
      list(p.allowedStatuses) { it in 1..4 }) { "POLICY_ALLOWLIST" }
    require(p.maxAuthorityStalenessMs in 1..900000 && p.maxProofValidityMs in 1..900000 &&
      p.maxReceiptIssuanceAgeMs in 1..86400000 && p.maxReplayRecords in 1..100000) { "POLICY_BOUNDS" }
    require(p.disseminationAudience in setOf("ORIGIN_ONLY","ORIGIN_AND_CUSTODY_RELAYS") &&
      p.providerConflictHandling == "KEEP_SEPARATE_NO_AUTOMATIC_CLOSURE" &&
      p.resolvedHandling in setOf("EXCLUDE","REPORTED_STATUS_ONLY_NO_AUTOMATIC_CLOSURE") &&
      (4 !in p.allowedStatuses || p.resolvedHandling == "REPORTED_STATUS_ONLY_NO_AUTOMATIC_CLOSURE")) { "POLICY_CLOSURE" }
    fun strings(v:List<String>) = v.joinToString(",", "[", "]", transform = ::quote)
    val tuple = listOf(quote("SAGIP-OFFLINE-ROOT-POLICY-V1"),quote(p.mode),quote(p.authorityDomainId),
      p.signerBindings.joinToString(",","[","]") { strings(listOf(it.checkpointSignerKeyId,it.receiptRootKeyId,it.issuerProviderId)) },
      strings(p.allowedScopes),p.allowedStatuses.joinToString(",","[","]"),p.maxAuthorityStalenessMs.toString(),
      p.maxReceiptIssuanceAgeMs.toString(),p.maxProofValidityMs.toString(),strings(p.qualifiedTimeSourceIds),
      quote(p.disseminationAudience),quote(p.providerConflictHandling),quote(p.resolvedHandling),p.maxReplayRecords.toString()).joinToString(",","[","]")
    return digest(tuple.toByteArray(Charsets.UTF_8))
  }
}

/** Full cryptographic evaluation only. A durable owner must atomically commit replay and projection. */
object OfflineRootSnapshotVerifier {
  fun verifyRevocation(bytes:ByteArray,config:OfflineRootConfig):OfflineRootSignedObject {
    val p=OfflineRootSnapshotCodec.decodeRevocation(bytes)
    require(p["policyDigest"]==OfflineRootSnapshotCodec.policyDigest(config.policy) && p["authorityDomainId"]==config.policy.authorityDomainId)
    require(config.policy.signerBindings.any { it.checkpointSignerKeyId==p["checkpointSignerKeyId"] &&
      (if(p["targetKind"]=="KEY") p["targetId"] in setOf(it.checkpointSignerKeyId,it.receiptRootKeyId) else p["targetId"]==it.issuerProviderId) })
    val key=config.checkpointSignerKeys[p["checkpointSignerKeyId"]] ?: error("UNKNOWN_CHECKPOINT_SIGNER")
    require(OfflineRootSnapshotCodec.digest(key)==p["checkpointSignerKeyId"] && OfflineRootSnapshotCodec.verifySignature(p,key))
    return p
  }
  fun verify(bytes: ByteArray, c: VerificationContext): ReceiptVerification = try {
    val snapshot = c.offlineRoot ?: error("OFFLINE_ROOT_DISABLED")
    val p = OfflineRootSnapshotCodec.decodeProof(snapshot.proofBytes)
    val policy = snapshot.configuration.policy
    val d = ReceiptV2Codec.decode(bytes)
    val r = d.fields as? ReceiptFields.Responder ?: error("ROOT_RECEIPT_PROFILE")
    require(r.providerKind == 1 && r.grantId == "00000000-0000-0000-0000-000000000000" && r.note.isEmpty()) { "ROOT_RECEIPT_PRIVACY" }
    val signer = snapshot.configuration.checkpointSignerKeys[p["checkpointSignerKeyId"]] ?: error("UNKNOWN_CHECKPOINT_SIGNER")
    val root = c.roots[p["receiptRootKeyId"]] ?: error("UNKNOWN_ROOT")
    require(OfflineRootSnapshotCodec.digest(signer) == p["checkpointSignerKeyId"] && OfflineRootSnapshotCodec.digest(root) == p["receiptRootKeyId"]) { "KEY_BINDING" }
    require(OfflineRootSnapshotCodec.verifySignature(p,signer) && ReceiptV2Codec.verifySignature(d,root)) { "SNAPSHOT_SIGNATURE" }
    fun hex(v:ByteArray) = OfflineRootSnapshotCodec.hex(v)
    require(p["receiptDigest"] == OfflineRootSnapshotCodec.digest(bytes) && p["eventId"] == r.actionId &&
      p["actionDigest"] == hex(r.actionDigest) && p["receiptRootKeyId"] == hex(r.issuerKeyId) &&
      p["issuerProviderId"] == hex(r.issuerProviderId) &&
      MessageDigest.isEqual(ReceiptAuthority.actionDigest(r),r.actionDigest) &&
      MessageDigest.isEqual(ReceiptAuthority.issuerProviderId(1,r.issuerKeyId,r.grantId),r.issuerProviderId)) { "RECEIPT_BINDING" }
    require(p["reportId"] == r.reportId && p.number("reportProtocolVersion") == r.reportProtocolVersion.toLong() &&
      p.number("revision") == r.revision.toLong() && p["payloadDigest"] == hex(r.payloadDigest) &&
      p["originKeyId"] == hex(r.originKeyId) && p.number("status") == r.status.toLong()) { "PROOF_REPORT_BINDING" }
    require(p["authorityState"] == "ACTIVE_AT_CHECKPOINT" && p["checkpointSignerKeyId"] !in snapshot.revokedKeyIds &&
      p["receiptRootKeyId"] !in snapshot.revokedKeyIds && p["issuerProviderId"] !in snapshot.revokedProviderIds) { "KNOWN_REVOKED" }
    require(OfflineRootSnapshotCodec.policyDigest(policy) == p["policyDigest"] && policy.authorityDomainId == p["authorityDomainId"] &&
      policy.signerBindings.any { it == OfflineRootSignerBinding(p["checkpointSignerKeyId"],p["receiptRootKeyId"],p["issuerProviderId"]) } &&
      p["scope"] in policy.allowedScopes && p.number("status").toInt() in policy.allowedStatuses) { "POLICY_MISMATCH" }
    val report = c.report ?: error("REPORT_LINKAGE")
    require(report.reportId == r.reportId && report.reportProtocolVersion == r.reportProtocolVersion && report.revision == r.revision &&
      MessageDigest.isEqual(report.payloadDigest,r.payloadDigest) && MessageDigest.isEqual(report.originKeyId,r.originKeyId) &&
      OfflineRootSnapshotCodec.digest(report.originPublicKeyDer) == p["originKeyId"] && snapshot.activeReportRevision >= r.revision) { "REPORT_LINKAGE" }
    val lower = p.number("authorityCheckedAtMs") - p.number("authorityTimeUncertaintyMs")
    val upper = p.number("authorityCheckedAtMs") + p.number("authorityTimeUncertaintyMs")
    require(r.issuedAtMs <= lower && p.number("expiresAtMs") <= r.forwardingExpiresAtMs &&
      p.number("expiresAtMs")-p.number("notBeforeMs") <= policy.maxProofValidityMs) { "PROOF_LIFETIME" }
    val time = c.trustedTime ?: error("QUALIFIED_TIME_MISSING")
    require(time.earliestMs in 0..OfflineRootSnapshotCodec.MAX_TIME && time.latestMs in time.earliestMs..OfflineRootSnapshotCodec.MAX_TIME &&
      time.earliestMs >= p.number("notBeforeMs") && time.earliestMs >= upper && time.latestMs < p.number("expiresAtMs") &&
      time.latestMs < r.forwardingExpiresAtMs) { "TIME_OUTSIDE_PROOF" }
    require(time.latestMs-lower < policy.maxAuthorityStalenessMs &&
      time.latestMs-r.issuedAtMs < policy.maxReceiptIssuanceAgeMs) { "SNAPSHOT_STALE" }
    ReceiptVerification.Verified(r.actionId,r.revision,p.number("authorityCheckedAtMs"),true,true)
  } catch(e:Exception) { ReceiptVerification.Unverified(e.message ?: "MALFORMED_SNAPSHOT") }
}
