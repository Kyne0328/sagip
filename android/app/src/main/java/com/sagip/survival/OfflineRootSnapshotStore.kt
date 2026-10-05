package com.sagip.survival

import java.security.MessageDigest
import net.zetetic.database.sqlcipher.SQLiteDatabase

// Eligibility may run inside the queue's lease transaction. Never hide a failed nested
// transaction as an ordinary negative result, or the caller could return rolled-back leases.
internal class ReceiptEligibilityTransactionFailure(cause:Exception):RuntimeException(cause)
internal inline fun <T> receiptEligibilityTransaction(db:SQLiteDatabase, block:()->T):T {
  val nested=db.inTransaction()
  try {
    db.beginTransaction()
    try { return block() } finally { db.endTransaction() }
  } catch(error:Exception) {
    if(nested) throw ReceiptEligibilityTransactionFailure(error)
    throw error
  }
}
internal fun rethrowReceiptEligibilityFailure(error:Throwable,database:SagipDatabase) {
  if(error is ReceiptEligibilityTransactionFailure ||
    (error is android.database.SQLException && database.writableDatabase.inTransaction())) throw error
}

/**
 * SQLCipher is the only owner of snapshot replay/epoch/revocation state.
 * Caller context is reacquired inside the transaction and immediately before commit.
 * No successful custody result can escape a failed outer transaction.
 */
internal class OfflineRootSnapshotStore(
  private val database: SagipDatabase,
  private val queue: ReceiptQueue,
  private val configuration: OfflineRootConfig,
) {
  private val policy = configuration.policy
  private val domain = policy.authorityDomainId
  private val policyDigest = OfflineRootSnapshotCodec.policyDigest(policy)
  private data class State(val epoch: Long, val digest: String, val checked: Long, val time: Long, val generation: Long, val uncertain: Boolean, val policy: String)
  init { require(configuration.maxEvidenceBytes in 1..8L*1024L*1024L) }

  /** Explicit trusted provisioning only. Existing state, including uncertainty, is never reset. */
  fun enroll(epoch: Long, stateDigest: String): Boolean {
    require(epoch >= 0 && OfflineRootSnapshotCodec.HEX.matches(stateDigest))
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      val old = state(db)
      if (old != null) return old.policy == policyDigest && old.epoch == epoch && old.digest == stateDigest && !old.uncertain
      val count = db.rawQuery("SELECT COUNT(*) FROM offline_root_domains",null).use { it.moveToFirst(); it.getLong(0) }
      if(count >= 64) return false
      db.execSQL("INSERT INTO offline_root_domains(domain_id,policy_digest,epoch,state_digest) VALUES(?,?,?,?)",arrayOf(domain,policyDigest,epoch,stateDigest))
      db.setTransactionSuccessful()
      return true
    } finally { db.endTransaction() }
  }
  /** Packaged enrollment is bootstrap-only. Preserve newer same-policy state on restart. */
  fun ensureEnrolled(epoch:Long,stateDigest:String):Boolean {
    val existing=state(database.readableDatabase)
    return if(existing==null) enroll(epoch,stateDigest) else existing.policy==policyDigest
  }

  private fun state(db:SQLiteDatabase):State? = db.rawQuery(
    "SELECT epoch,state_digest,checked_high,time_high,generation,uncertain,policy_digest FROM offline_root_domains WHERE domain_id=?",arrayOf(domain),
  ).use { if(!it.moveToFirst()) null else State(it.getLong(0),it.getString(1),it.getLong(2),it.getLong(3),it.getLong(4),it.getInt(5)!=0,it.getString(6)) }

  fun revoked(kind:String):Set<String> = database.readableDatabase.rawQuery(
    "SELECT DISTINCT target_id FROM offline_root_revocations WHERE domain_id=? AND target_kind=?",arrayOf(domain,kind),
  ).use { c -> buildSet { while(c.moveToNext()) add(c.getString(0)) } }

  private fun markUncertain(db:SQLiteDatabase) {
    db.execSQL("UPDATE offline_root_domains SET uncertain=1,generation=generation+1 WHERE domain_id=?",arrayOf(domain))
  }
  private fun replayReason(db:SQLiteDatabase,p:OfflineRootSignedObject,receipt:ReceiptFields.Responder,time:TimeInterval,proofBytes:ByteArray):String? {
    val s=state(db) ?: return "DOMAIN_NOT_ENROLLED"
    if(s.policy!=policyDigest) return "POLICY_CHANGED_REQUIRES_REVIEW"
    if(s.uncertain) return "AUTHORITY_DOMAIN_CONFLICT"
    if(p.number("revocationEpoch") < s.epoch || (p.number("revocationEpoch") > s.epoch && p.number("authorityCheckedAtMs")-p.number("authorityTimeUncertaintyMs") < s.checked) ||
      time.earliestMs < s.time) return "SNAPSHOT_ROLLBACK"
    if(p.number("revocationEpoch")==s.epoch && p["authorityStateDigest"]!=s.digest) return "EPOCH_EQUIVOCATION"
    val oldProof=db.rawQuery("SELECT proof_digest FROM offline_root_evidence WHERE domain_id=? AND proof_id=?",
      arrayOf(domain,p["proofId"])).use { if(it.moveToFirst())it.getString(0) else null }
    // Complete proof bytes, not only signed body, form replay identity.
    if(oldProof!=null && oldProof!=OfflineRootSnapshotCodec.digest(proofBytes)) return "PROOF_ID_CONFLICT"
    val oldEvent=db.rawQuery("SELECT receipt_digest FROM offline_root_streams WHERE domain_id=? AND event_id=?",
      arrayOf(domain,p["eventId"])).use { if(it.moveToFirst())it.getString(0) else null }
    if(oldEvent!=null && oldEvent!=p["receiptDigest"]) return "EVENT_ID_CONFLICT"
    val oldSequence=db.rawQuery("SELECT event_id FROM offline_root_streams WHERE domain_id=? AND provider_id=? AND report_id=? AND sequence=?",
      arrayOf(domain,p["issuerProviderId"],p["reportId"],receipt.sequence.toString())).use { if(it.moveToFirst())it.getString(0) else null }
    if(oldSequence!=null && oldSequence!=p["eventId"]) return "SEQUENCE_CONFLICT"
    return null
  }
  fun admit(bytes:ByteArray, context:()->VerificationContext?):CustodyResult {
    val owned=bytes.copyOf()
    val bundle=runCatching { OfflineRootSnapshotCodec.decodeBundle(owned) }.getOrNull()
      ?: return CustodyResult(CustodyResultKind.REJECTED,reason="OFFLINE_ROOT_BUNDLE_INVALID")
    val p=OfflineRootSnapshotCodec.decodeProof(bundle.proof)
    val r=ReceiptV2Codec.decode(bundle.receipt).fields as ReceiptFields.Responder
    val db=database.writableDatabase
    db.beginTransaction()
    try {
      val c=context() ?: return CustodyResult(CustodyResultKind.PENDING_VERIFICATION,reason="QUALIFIED_TIME_MISSING")
      val verified=ReceiptAuthority.verifyReceipt(bundle.receipt,c) as? ReceiptVerification.Verified
        ?: return CustodyResult(CustodyResultKind.PENDING_VERIFICATION,reason="SNAPSHOT_VERIFICATION_UNAVAILABLE")
      if(verified.kind!=OfflineRootSnapshotCodec.KIND) return CustodyResult(CustodyResultKind.REJECTED,reason="SNAPSHOT_CLASS_REQUIRED")
      val reason=replayReason(db,p,r,requireNotNull(c.trustedTime),bundle.proof)
      if(reason!=null) {
        if(reason in setOf("EPOCH_EQUIVOCATION","PROOF_ID_CONFLICT","EVENT_ID_CONFLICT","SEQUENCE_CONFLICT")) {
          markUncertain(db); db.setTransactionSuccessful()
        }
        return CustodyResult(CustodyResultKind.PENDING_VERIFICATION,reason=reason)
      }
      val priorProof=db.rawQuery("SELECT 1 FROM offline_root_evidence WHERE domain_id=? AND proof_id=?",arrayOf(domain,p["proofId"])).use { it.moveToFirst() }
      val priorReceipt=db.rawQuery("SELECT 1 FROM offline_root_streams WHERE domain_id=? AND event_id=?",arrayOf(domain,p["eventId"])).use { it.moveToFirst() }
      val usage=db.rawQuery("SELECT (SELECT COUNT(*) FROM offline_root_evidence)+(SELECT COUNT(*) FROM offline_root_streams),"+
        "(SELECT COALESCE(SUM(length(bundle_bytes)+1024),0) FROM offline_root_evidence)+(SELECT COUNT(*)*1024 FROM offline_root_streams)",null)
        .use { it.moveToFirst(); it.getLong(0) to it.getLong(1) }
      val count=(if(priorProof)0 else 1)+(if(priorReceipt)0 else 1)
      val size=(if(priorProof)0L else owned.size+1024L)+(if(priorReceipt)0L else 1024L)
      if(usage.first+count>policy.maxReplayRecords || usage.second+size>configuration.maxEvidenceBytes)
        return CustodyResult(CustodyResultKind.CAPACITY_FULL,reason="PROTECTED_SNAPSHOT_CAPACITY")
      if(!priorProof) db.execSQL(
        "INSERT INTO offline_root_evidence(domain_id,proof_id,proof_digest,event_id,bundle_bytes,expires_at_ms) VALUES(?,?,?,?,?,?)",
        arrayOf(domain,p["proofId"],OfflineRootSnapshotCodec.digest(bundle.proof),p["eventId"],owned,OfflineRootSnapshotCodec.validUntil(p,r,policy)))
      if(!priorReceipt) db.execSQL(
        "INSERT INTO offline_root_streams(domain_id,event_id,receipt_digest,provider_id,report_id,revision,sequence) VALUES(?,?,?,?,?,?,?)",
        arrayOf(domain,p["eventId"],p["receiptDigest"],p["issuerProviderId"],p["reportId"],r.revision,r.sequence))
      db.execSQL("UPDATE offline_root_evidence SET expires_at_ms=MIN(expires_at_ms,?) WHERE domain_id=? AND proof_id=?",
        arrayOf(OfflineRootSnapshotCodec.validUntil(p,r,policy),domain,p["proofId"]))
      val expectedGeneration=requireNotNull(state(db)).generation
      val outcome=queue.admitOfflineRootBundle(owned,c,expectedGeneration)
      if(outcome.kind !in setOf(CustodyResultKind.COMMITTED,CustodyResultKind.DUPLICATE) &&
        !(outcome.kind==CustodyResultKind.CAPACITY_FULL && outcome.localApplication in setOf(ReceiptApplication.APPLIED,ReceiptApplication.HISTORICAL,ReceiptApplication.DUPLICATE)))
        return outcome
      val fresh=context() ?: error("AUTHORITY_CHANGED_DURING_COMMIT")
      check(ReceiptAuthority.verifyReceipt(bundle.receipt,fresh) is ReceiptVerification.Verified)
      check(fresh.offlineRoot?.configuration === c.offlineRoot?.configuration && fresh.trustedTime!!.earliestMs>=c.trustedTime!!.earliestMs)
      check(replayReason(db,p,r,fresh.trustedTime,bundle.proof)==null)
      val s=requireNotNull(state(db))
      check(s.generation < OfflineRootSnapshotCodec.MAX_TIME)
      db.execSQL("UPDATE offline_root_domains SET epoch=?,state_digest=?,checked_high=MAX(checked_high,?),time_high=MAX(time_high,?),generation=generation+1 WHERE domain_id=?",
        arrayOf(p.number("revocationEpoch"),p["authorityStateDigest"],p.number("authorityCheckedAtMs")-p.number("authorityTimeUncertaintyMs"),fresh.trustedTime.earliestMs,domain))
      db.setTransactionSuccessful()
      return outcome
    } catch(_:Exception) {
      return CustodyResult(CustodyResultKind.PENDING_VERIFICATION,reason="SNAPSHOT_ATOMIC_COMMIT_FAILED")
    } finally { db.endTransaction() }
  }

  fun canForward(bytes:ByteArray, forDissemination:Boolean = true, context:()->VerificationContext?):Boolean = runCatching {
    if(forDissemination && policy.disseminationAudience != "ORIGIN_AND_CUSTODY_RELAYS") return false
    val b=OfflineRootSnapshotCodec.decodeBundle(bytes); val p=OfflineRootSnapshotCodec.decodeProof(b.proof)
    val r=ReceiptV2Codec.decode(b.receipt).fields as ReceiptFields.Responder
    val db=database.writableDatabase
    receiptEligibilityTransaction(db) {
      val c=context()
      if(c==null) { db.setTransactionSuccessful(); return false }
      if(ReceiptAuthority.verifyReceipt(b.receipt,c) !is ReceiptVerification.Verified ||
        replayReason(db,p,r,requireNotNull(c.trustedTime),b.proof)!=null) {
        db.setTransactionSuccessful()
        return false
      }
      val held=db.rawQuery("SELECT 1 FROM offline_root_evidence WHERE domain_id=? AND proof_id=? AND proof_digest=?",
        arrayOf(domain,p["proofId"],OfflineRootSnapshotCodec.digest(b.proof))).use { it.moveToFirst() }
      if(held) db.execSQL("UPDATE offline_root_domains SET time_high=MAX(time_high,?) WHERE domain_id=?",arrayOf(c.trustedTime!!.earliestMs,domain))
      db.setTransactionSuccessful()
      held
    }
  }.getOrElse { rethrowReceiptEligibilityFailure(it,database); false }

  /** No report/time/queue prerequisite: a valid tombstone survives a refused ordinary receipt. */
  fun ingestRevocation(bytes:ByteArray):Boolean = runCatching {
    val owned=bytes.copyOf(); val p=OfflineRootSnapshotCodec.decodeRevocation(owned)
    require(p["policyDigest"]==policyDigest && p["authorityDomainId"]==domain)
    require(policy.signerBindings.any { it.checkpointSignerKeyId==p["checkpointSignerKeyId"] &&
      (if(p["targetKind"]=="KEY") p["targetId"] in setOf(it.checkpointSignerKeyId,it.receiptRootKeyId) else p["targetId"]==it.issuerProviderId) })
    val key=configuration.checkpointSignerKeys[p["checkpointSignerKeyId"]] ?: return false
    require(OfflineRootSnapshotCodec.digest(key)==p["checkpointSignerKeyId"] && OfflineRootSnapshotCodec.verifySignature(p,key))
    val db=database.writableDatabase; db.beginTransaction()
    try {
      val s=state(db) ?: return false
      val existing=db.rawQuery("SELECT digest FROM offline_root_revocations WHERE domain_id=? AND revocation_id=?",
        arrayOf(domain,p["revocationId"])).use { if(it.moveToFirst())it.getString(0) else null }
      if(existing!=null) {
        if(existing!=OfflineRootSnapshotCodec.digest(owned)) markUncertain(db)
        db.setTransactionSuccessful(); return existing==OfflineRootSnapshotCodec.digest(owned)
      }
      if(p["checkpointSignerKeyId"] in revoked("KEY")) return false
      // A lower epoch cannot undo anything, but an authenticated older revocation is still retained.
      val usage=db.rawQuery("SELECT COUNT(*),COALESCE(SUM(length(object_bytes)+1024),0) FROM offline_root_revocations",null)
        .use { it.moveToFirst(); it.getLong(0) to it.getLong(1) }
      if(usage.first>=10000 || usage.second+owned.size+1024>8L*1024L*1024L) {
        markUncertain(db); db.setTransactionSuccessful(); return false
      }
      db.execSQL("INSERT INTO offline_root_revocations(domain_id,revocation_id,digest,target_kind,target_id,epoch,object_bytes) VALUES(?,?,?,?,?,?,?)",
        arrayOf(domain,p["revocationId"],OfflineRootSnapshotCodec.digest(owned),p["targetKind"],p["targetId"],p.number("revocationEpoch"),owned))
      if(p.number("revocationEpoch")==s.epoch && p["authorityStateDigest"]!=s.digest) markUncertain(db)
      if(p.number("revocationEpoch")>s.epoch) db.execSQL("UPDATE offline_root_domains SET epoch=?,state_digest=?,generation=generation+1 WHERE domain_id=?",
        arrayOf(p.number("revocationEpoch"),p["authorityStateDigest"],domain))
      db.setTransactionSuccessful(); true
    } finally { db.endTransaction() }
  }.getOrDefault(false)


  companion object {
    /** Queue/repository internal entrypoints require exact evidence already written in this outer transaction. */
    internal fun preparedEvidenceExists(database:SagipDatabase,receipt:ByteArray,c:VerificationContext,expectedGeneration:Long?=null):Boolean = runCatching {
      val db=database.writableDatabase
      if(!db.inTransaction()) return false
      val snapshot=c.offlineRoot ?: return false
      val p=OfflineRootSnapshotCodec.decodeProof(snapshot.proofBytes)
      if(p["receiptDigest"]!=OfflineRootSnapshotCodec.digest(receipt)) return false
      val d=db.rawQuery("SELECT policy_digest,generation,uncertain,epoch,state_digest FROM offline_root_domains WHERE domain_id=?",
        arrayOf(p["authorityDomainId"])).use { x ->
          x.moveToFirst() && x.getString(0)==OfflineRootSnapshotCodec.policyDigest(snapshot.configuration.policy) &&
            (expectedGeneration==null || x.getLong(1)==expectedGeneration) && x.getInt(2)==0 &&
            x.getLong(3)<=p.number("revocationEpoch") && (x.getLong(3)!=p.number("revocationEpoch") || x.getString(4)==p["authorityStateDigest"])
        }
      if(!d) return false
      val revoked=db.rawQuery("SELECT 1 FROM offline_root_revocations WHERE "+
        "(target_kind='KEY' AND target_id IN (?,?)) OR (domain_id=? AND target_kind='PROVIDER' AND target_id=?) LIMIT 1",
        arrayOf(p["receiptRootKeyId"],p["checkpointSignerKeyId"],p["authorityDomainId"],p["issuerProviderId"])).use { it.moveToFirst() }
      if(revoked) return false
      val bundle=db.rawQuery("SELECT bundle_bytes FROM offline_root_evidence WHERE domain_id=? AND proof_id=? AND proof_digest=? AND event_id=?",
        arrayOf(p["authorityDomainId"],p["proofId"],OfflineRootSnapshotCodec.digest(snapshot.proofBytes),p["eventId"])).use { if(it.moveToFirst())it.getBlob(0) else null } ?: return false
      val decoded=OfflineRootSnapshotCodec.decodeBundle(bundle)
      if(!MessageDigest.isEqual(decoded.receipt,receipt) || !MessageDigest.isEqual(decoded.proof,snapshot.proofBytes)) return false
      db.rawQuery("SELECT 1 FROM offline_root_streams WHERE domain_id=? AND event_id=? AND receipt_digest=?",
        arrayOf(p["authorityDomainId"],p["eventId"],p["receiptDigest"])).use { it.moveToFirst() }
    }.getOrDefault(false)
  }



  fun canForwardRevocation(bytes:ByteArray):Boolean = runCatching {
    val p=OfflineRootSnapshotVerifier.verifyRevocation(bytes,configuration)
    database.readableDatabase.rawQuery("SELECT 1 FROM offline_root_revocations WHERE domain_id=? AND revocation_id=? AND digest=?",
      arrayOf(domain,p["revocationId"],OfflineRootSnapshotCodec.digest(bytes))).use { it.moveToFirst() }
  }.getOrElse { rethrowReceiptEligibilityFailure(it,database); false }

  fun revocationsForRelay(limit:Int):List<ByteArray> {
    require(limit in 1..32)
    val db=database.writableDatabase
    db.beginTransaction()
    try {
      val after=db.rawQuery("SELECT row_id FROM offline_root_relay_scan WHERE domain_id=?",arrayOf(domain)).use { if(it.moveToFirst())it.getLong(0) else 0L }
      val rows=db.rawQuery("SELECT rowid,object_bytes FROM offline_root_revocations WHERE domain_id=? ORDER BY CASE WHEN rowid>? THEN 0 ELSE 1 END,rowid LIMIT ?",
        arrayOf(domain,after.toString(),limit.toString())).use { c -> buildList { while(c.moveToNext()) add(c.getLong(0) to c.getBlob(1)) } }
      rows.lastOrNull()?.let { db.execSQL("INSERT INTO offline_root_relay_scan(domain_id,row_id) VALUES(?,?) ON CONFLICT(domain_id) DO UPDATE SET row_id=excluded.row_id",arrayOf(domain,it.first)) }
      db.setTransactionSuccessful()
      return rows.map { it.second }
    } finally { db.endTransaction() }
  }

  fun evidenceState(eventId:String,context:(ByteArray)->VerificationContext?):String {
    val db=database.readableDatabase
    val bytes=db.rawQuery("SELECT bundle_bytes FROM offline_root_evidence WHERE domain_id=? AND event_id=? ORDER BY expires_at_ms DESC,proof_id LIMIT 1",
      arrayOf(domain,eventId)).use { if(it.moveToFirst())it.getBlob(0) else null } ?: return "TIME_UNAVAILABLE"
    val state=state(db) ?: return "TIME_UNAVAILABLE"
    if(state.uncertain) return "CONFLICT"
    val bundle=runCatching { OfflineRootSnapshotCodec.decodeBundle(bytes) }.getOrNull() ?: return "CONFLICT"
    val p=OfflineRootSnapshotCodec.decodeProof(bundle.proof)
    if(p["checkpointSignerKeyId"] in revoked("KEY") || p["receiptRootKeyId"] in revoked("KEY") || p["issuerProviderId"] in revoked("PROVIDER")) return "REVOKED"
    val c=context(bytes) ?: return "TIME_UNAVAILABLE"
    val receipt=ReceiptV2Codec.decode(bundle.receipt).fields as ReceiptFields.Responder
    if(c.trustedTime!!.latestMs>=OfflineRootSnapshotCodec.validUntil(p,receipt,policy)) return "EXPIRED"
    return if(canForward(bytes,false) { context(bytes) }) "VALID_AT_LAST_CHECK" else "TIME_UNAVAILABLE"
  }
}
