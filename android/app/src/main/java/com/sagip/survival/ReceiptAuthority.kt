package com.sagip.survival

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.UUID

data class TimeInterval(val earliestMs: Long, val latestMs: Long)
data class ReportIdentity(val reportId: String, val reportProtocolVersion: Int, val revision: Int, val payloadDigest: ByteArray, val originKeyId: ByteArray, val originPublicKeyDer: ByteArray)
data class VerificationContext(
  val roots: Map<String, ByteArray>, val revokedGrants: Set<String>, val allowedScopes: Set<String>,
  val trustedTime: TimeInterval?, val authorityCheckedAtMs: Long?, val currentAuthorityChecked: Boolean,
  val report: ReportIdentity?, val pairedTimeProviderId: String?, val linkedAck: ByteArray? = null,
  val offlineRoot: OfflineRootVerificationContext? = null,
)
sealed class ReceiptVerification {
  abstract val kind: String
  data class Rejected(val reason: String) : ReceiptVerification() { override val kind = "REJECTED" }
  data class Unverified(val reason: String) : ReceiptVerification() { override val kind = "UNVERIFIED_AUTHORITY" }
  data class Verified(val eventId: String, val revision: Int, val authorityCheckedAtMs: Long?, val revocationNotCheckedWhileOffline: Boolean, val historicalRootSnapshot: Boolean = false) : ReceiptVerification() {
    override val kind = if (historicalRootSnapshot) OfflineRootSnapshotCodec.KIND else if (revocationNotCheckedWhileOffline) "VERIFIED_OFFLINE_AUTHORITY" else "VERIFIED_CURRENT"
  }
}
data class MonotonicClock(val bootId: String, val elapsedMs: Long)
data class TimeCheckpoint(val earliestMs: Long, val latestMs: Long, val bootId: String, val receivedElapsedMs: Long, val validUntilMs: Long, val proofDigest: String)
data class TimeChallenge(
  val id: String, val verifierId: ByteArray, val verifierBootSessionId: String, val nonce: ByteArray,
  val sentElapsedMs: Long, val highWaterEarliestMs: Long?, val context: VerificationContext,
  // Trusted persistence owner must consume this exact challenge, recheck boot/high-water
  // and commit checkpoint atomically. An in-memory callback does not provide durable authority.
  val commitCheckpoint: (TimeCheckpoint) -> Boolean,
)
data class TimeAcceptance(val kind: String, val checkpoint: TimeCheckpoint? = null, val reason: String? = null)

object ReceiptAuthority {
  private const val NIL = "00000000-0000-0000-0000-000000000000"
  private const val WEEK = 604800000L
  private const val MAX_TIME = 9007199254740991L
  private class Unavailable(val reason: String) : Exception()
  private class Invalid(val reason: String) : Exception()
  private fun badIf(condition: Boolean, reason: String) { if (condition) throw Invalid(reason) }
  private fun unavailableIf(condition: Boolean, reason: String) { if (condition) throw Unavailable(reason) }
  private fun hash(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b)
  private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it.toInt() and 255) }
  private fun same(a: ByteArray, b: ByteArray) = MessageDigest.isEqual(a, b)
  private fun uuid(s: String): ByteArray { val id = UUID.fromString(s); return ByteBuffer.allocate(16).putLong(id.mostSignificantBits).putLong(id.leastSignificantBits).array() }
  private fun root(id: ByteArray, context: VerificationContext): ByteArray? = context.roots[hex(id)]?.takeIf { same(hash(it), id) }
  fun issuerProviderId(kind: Int, keyId: ByteArray, grantId: String) = hash("SAGIP-PROVIDER-V2\u0000".toByteArray(Charsets.US_ASCII) + byteArrayOf(kind.toByte()) + keyId + uuid(grantId))
  fun actionDigest(f: ReceiptFields.Responder): ByteArray {
    val bytes = ByteArrayOutputStream()
    DataOutputStream(bytes).use { w ->
      w.write("SAGIP-ACTION-V2\u0000".toByteArray(Charsets.US_ASCII)); w.write(uuid(f.actionId)); w.writeByte(f.providerKind)
      w.write(f.issuerProviderId); w.write(uuid(f.reportId)); w.writeByte(f.reportProtocolVersion); w.writeInt(f.revision)
      w.write(f.payloadDigest); w.write(f.originKeyId); w.write(uuid(f.responderId)); w.writeLong(f.observedIncidentVersion)
      w.writeByte(f.status); val note = f.note.toByteArray(Charsets.UTF_8); w.writeShort(note.size); w.write(note)
    }
    return hash(bytes.toByteArray())
  }
  private fun proofs(proof: ByteArray): List<DecodedReceipt> {
    if (proof.isEmpty()) return emptyList()
    val b = ByteBuffer.wrap(proof)
    val count = b.get().toInt() and 255
    return List(count) { val n = b.short.toInt() and 65535; val bytes = ByteArray(n); b.get(bytes); ReceiptV2Codec.decode(bytes) }
  }
  private fun grant(d: DecodedReceipt, c: VerificationContext, policy: Boolean = true): ReceiptFields.Grant {
    val g = d.fields as? ReceiptFields.Grant ?: throw Invalid("GRANT_PROFILE")
    val key = root(g.rootKeyId, c) ?: throw Unavailable("UNKNOWN_ROOT")
    badIf(!ReceiptV2Codec.verifySignature(d, key), "GRANT_SIGNATURE")
    badIf(!same(hash(g.issuerPublicKeyDer), g.issuerKeyId) || !same(issuerProviderId(2, g.issuerKeyId, g.grantId), g.issuerProviderId), "GRANT_KEY_BINDING")
    badIf(g.expiresAtMs <= g.notBeforeMs || g.expiresAtMs - g.notBeforeMs > WEEK, "GRANT_DURATION")
    unavailableIf(policy && g.grantId in c.revokedGrants, "REVOKED_GRANT")
    unavailableIf(policy && g.scope !in c.allowedScopes, "SCOPE_UNAVAILABLE")
    return g
  }
  private fun valid(t: TimeInterval) = t.earliestMs in 0..MAX_TIME && t.latestMs in t.earliestMs..MAX_TIME
  private fun within(t: TimeInterval, start: Long, end: Long) = valid(t) && t.earliestMs >= start && t.latestMs < end
  private fun matches(report: String, protocol: Int, revision: Int, origin: ByteArray, expected: ReportIdentity) =
    report == expected.reportId && protocol == expected.reportProtocolVersion && revision == expected.revision && same(origin, expected.originKeyId)
  fun verifyReceipt(bytes: ByteArray, c: VerificationContext): ReceiptVerification = try {
    val d = ReceiptV2Codec.decode(bytes)
    when (val f = d.fields) {
      is ReceiptFields.Requester -> {
        badIf(!same(hash(f.originPublicKeyDer), f.originKeyId), "ORIGIN_KEY_BINDING")
        badIf(!ReceiptV2Codec.verifySignature(d, f.originPublicKeyDer), "SIGNATURE_INVALID")
        val r = c.report ?: throw Unavailable("REPORT_LINKAGE")
        unavailableIf(!matches(f.reportId, f.reportProtocolVersion, f.revision, f.originKeyId, r), "REPORT_LINKAGE")
        badIf(!same(f.originPublicKeyDer, r.originPublicKeyDer), "ORIGIN_KEY_BINDING")
        val ackBytes = c.linkedAck ?: throw Unavailable("ACK_LINKAGE")
        val ack = ReceiptV2Codec.decode(ackBytes).fields as? ReceiptFields.Responder ?: throw Invalid("ACK_LINKAGE")
        badIf(ack.actionId != f.ackEventId || !same(hash(ackBytes), f.ackDigest) || ack.forwardingExpiresAtMs != f.forwardingExpiresAtMs, "ACK_LINKAGE")
        when (val result = verifyReceipt(ackBytes, c)) {
          is ReceiptVerification.Verified -> result.copy(eventId = f.eventId, revision = f.revision)
          else -> result
        }
      }
      is ReceiptFields.Responder -> {
        badIf(!same(issuerProviderId(f.providerKind, f.issuerKeyId, f.grantId), f.issuerProviderId) || !same(actionDigest(f), f.actionDigest), "ACTION_BINDING")
        var authorityGrant: ReceiptFields.Grant? = null
        val offline = f.providerKind == 2
        val key = if (!offline) root(f.issuerKeyId, c) ?: throw Unavailable("UNKNOWN_ROOT") else {
          val g = grant(proofs(d.proof)[0], c, false)
          authorityGrant = g
          badIf(f.grantId != g.grantId || !same(f.issuerKeyId, g.issuerKeyId) || !same(f.issuerProviderId, g.issuerProviderId) || f.responderId != g.responderId || f.callsign != g.callsign || (g.statusMask and (1 shl (f.status - 1))) == 0, "GRANT_BINDING")
          badIf(f.issuedAtMs < g.notBeforeMs || f.issuedAtMs >= g.expiresAtMs || f.forwardingExpiresAtMs > g.expiresAtMs, "GRANT_ISSUANCE")
          g.issuerPublicKeyDer
        }
        badIf(!ReceiptV2Codec.verifySignature(d, key), "SIGNATURE_INVALID")
        val r = c.report ?: throw Unavailable("REPORT_LINKAGE")
        unavailableIf(!matches(f.reportId, f.reportProtocolVersion, f.revision, f.originKeyId, r) || !same(f.payloadDigest, r.payloadDigest), "REPORT_LINKAGE")
        authorityGrant?.let { g ->
          unavailableIf(g.grantId in c.revokedGrants, "REVOKED_GRANT")
          unavailableIf(g.scope !in c.allowedScopes, "SCOPE_UNAVAILABLE")
          val time = c.trustedTime ?: throw Unavailable("GRANT_TIME_UNAVAILABLE")
          unavailableIf(!within(time, g.notBeforeMs, g.expiresAtMs), "GRANT_TIME_UNAVAILABLE")
        }
        val time = c.trustedTime ?: throw Unavailable("RECEIPT_TIME_UNAVAILABLE")
        unavailableIf(!valid(time) || time.latestMs >= f.forwardingExpiresAtMs, "RECEIPT_TIME_UNAVAILABLE")
        if (!offline && c.offlineRoot != null) OfflineRootSnapshotVerifier.verify(bytes, c) else {
          unavailableIf(!offline && !c.currentAuthorityChecked, "ROOT_AUTHORITY_UNCHECKED")
          ReceiptVerification.Verified(f.actionId, f.revision, c.authorityCheckedAtMs, offline)
        }
      }
      else -> throw Invalid("NOT_RECEIPT")
    }
  } catch (e: Unavailable) { ReceiptVerification.Unverified(e.reason) }
    catch (e: Invalid) { ReceiptVerification.Rejected(e.reason) }
    catch (_: Exception) { ReceiptVerification.Rejected("MALFORMED_OBJECT") }

  private fun rootTime(d: DecodedReceipt, c: VerificationContext): ReceiptFields.Time? {
    val f = d.fields as? ReceiptFields.Time ?: return null
    if (f.grantId != NIL) return null
    val key = root(f.signerKeyId, c) ?: return null
    if (!ReceiptV2Codec.verifySignature(d, key) || !same(issuerProviderId(1, f.signerKeyId, NIL), f.signerProviderId) ||
      f.elapsedSinceCheckpointMs != 0L || f.parentCheckpointDigest.any { it != 0.toByte() } || f.uncertaintyMs > 60000 ||
      f.validUntilMs <= f.signedTimeMs + f.uncertaintyMs || f.validUntilMs - f.signedTimeMs > WEEK) return null
    return f
  }
  fun acceptTimeProof(bytes: ByteArray, q: TimeChallenge, clock: MonotonicClock): TimeAcceptance = try {
    val d = ReceiptV2Codec.decode(bytes)
    val f = d.fields as? ReceiptFields.Time ?: throw Invalid("TIME_PROFILE")
    val c = q.context
    badIf(clock.elapsedMs !in 0..MAX_TIME || q.sentElapsedMs !in 0..MAX_TIME ||
      clock.bootId != q.verifierBootSessionId || f.verifierBootSessionId != q.verifierBootSessionId ||
      !same(f.verifierId, q.verifierId) || !same(f.nonce, q.nonce), "CHALLENGE_BINDING")
    val age = clock.elapsedMs - q.sentElapsedMs
    badIf(age !in 0..60000, "CHALLENGE_AGE")
    var start = 0L
    var end = f.validUntilMs
    if (f.grantId == NIL) {
      badIf(rootTime(d, c) == null, "ROOT_TIME_INVALID")
    } else {
      val members = proofs(d.proof)
      val g = grant(members[0], c)
      val parent = rootTime(members[1], c) ?: throw Invalid("PARENT_TIME_INVALID")
      badIf(c.pairedTimeProviderId != hex(f.signerProviderId) || f.grantId != g.grantId || !same(f.signerKeyId, g.issuerKeyId) ||
        !same(f.signerProviderId, g.issuerProviderId) || g.purposeMask and 8 == 0 || !same(parent.verifierId, g.issuerKeyId) ||
        f.signerBootSessionId != parent.verifierBootSessionId, "DELEGATED_TIME_BINDING")
      val parentBytes = ReceiptV2Codec.encode(members[1].fields, members[1].signature, members[1].proof)
      badIf(!same(hash(parentBytes), f.parentCheckpointDigest) || f.signedTimeMs != parent.signedTimeMs + f.elapsedSinceCheckpointMs ||
        f.uncertaintyMs < parent.uncertaintyMs + (f.elapsedSinceCheckpointMs + 9999) / 10000 ||
        f.uncertaintyMs > 86400000 || f.validUntilMs != minOf(g.expiresAtMs, parent.validUntilMs) ||
        !ReceiptV2Codec.verifySignature(d, g.issuerPublicKeyDer), "DELEGATED_TIME_INVALID")
      start = g.notBeforeMs
      end = minOf(g.expiresAtMs, parent.validUntilMs)
    }
    val uncertainty = f.uncertaintyMs + age
    val interval = TimeInterval(f.signedTimeMs - uncertainty, f.signedTimeMs + uncertainty)
    badIf(!within(interval, start, end), "TIME_INTERVAL")
    badIf(q.highWaterEarliestMs != null && (q.highWaterEarliestMs !in 0..MAX_TIME || interval.earliestMs < q.highWaterEarliestMs), "TIME_ROLLBACK")
    val checkpoint = TimeCheckpoint(interval.earliestMs, interval.latestMs, clock.bootId, clock.elapsedMs, end, hex(hash(bytes)))
    badIf(!q.commitCheckpoint(checkpoint), "CHALLENGE_COMMIT_CONFLICT")
    TimeAcceptance("ACCEPTED", checkpoint)
  } catch (e: Invalid) { TimeAcceptance("REJECTED", reason = e.reason) }
    catch (e: Unavailable) { TimeAcceptance("REJECTED", reason = e.reason) }
    catch (_: Exception) { TimeAcceptance("REJECTED", reason = "MALFORMED_TIME") }

  fun advanceCheckpoint(checkpoint: TimeCheckpoint, clock: MonotonicClock, maximumDriftPpm: Int = 100): TimeInterval? {
    if(maximumDriftPpm !in 100..1000) return null
    if (clock.bootId != checkpoint.bootId || clock.elapsedMs !in 0..MAX_TIME || checkpoint.receivedElapsedMs !in 0..MAX_TIME) return null
    val elapsed = clock.elapsedMs - checkpoint.receivedElapsedMs
    if (elapsed < 0) return null
    // Split multiplication to avoid overflowing for a malformed large elapsed value.
    val drift = (elapsed / 1_000_000L) * maximumDriftPpm +
      ((elapsed % 1_000_000L) * maximumDriftPpm + 999_999L) / 1_000_000L
    val interval = TimeInterval(checkpoint.earliestMs + elapsed - drift, checkpoint.latestMs + elapsed + drift)
    return interval.takeIf { within(it, 0, checkpoint.validUntilMs) }
  }
}
