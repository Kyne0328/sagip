package com.sagip.survival

import android.content.ContentValues
import net.zetetic.database.sqlcipher.SQLiteDatabase
import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.UUID

enum class ReceiptApplication { APPLIED, HISTORICAL, PENDING_AUTHORITY, REJECTED, DUPLICATE }
enum class ActionCommitState { PREPARING, SIGNED, FAILED, CONFLICT, REJECTED }
data class ActionIntent(val actionId:String,val reportId:String,val observedIncidentVersion:Long,val status:Int,val note:String)
data class ResponderSignerProfile(val identity:SigningIdentity,val providerKind:Int,val grantId:String,val responderId:String,val callsign:String,val proof:ByteArray)
data class AllocatedAction(val fields:ReceiptFields.Responder,val allocatedAtMs:Long,val preparationState:String)
data class ActionCommitResult(val actionId:String,val state:ActionCommitState,val bytes:ByteArray?=null,val reason:String?=null)
data class ReceiptProjection(val issuerProviderId:ByteArray,val reportId:String,val eventId:String,val revision:Int,val sequence:Long,val verificationKind:String,val authorityCheckedAtMs:Long?,val notificationEligible:Boolean,val requesterDeliveryState:String)

class ReceiptRepository(
  private val database:SagipDatabase,
  private val responderSigner:ResponderSignerProfile?=null,
  private val requesterSigner:SigningIdentity?=null,
  private val verificationContextProvider:((ReportIdentity,ByteArray?)->VerificationContext)?=null,
  private val clock:()->Long=System::currentTimeMillis,
) {
  private data class StoredAction(val fields:ReceiptFields.Responder,val allocatedAtMs:Long,val state:String,val proof:ByteArray,val leaseToken:String?,val leaseUntilMs:Long?)
  private data class RequesterAction(val eventId:String,val reportId:String,val protocol:Int,val revision:Int,val originKeyId:ByteArray,val originKey:ByteArray,val ackDigest:ByteArray,val receivedAt:Long,val expiry:Long,val state:String,val leaseToken:String?,val leaseUntil:Long?)
  private data class ChallengeRow(val verifierId:ByteArray,val nonce:ByteArray,val consumedAt:Long?,val highWater:Long?,val bootId:String)

  fun recordReportEnvelope(bytes: ByteArray, now: Long = clock()) {
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      persistReportIdentity(db, bytes, now)
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  fun currentReceiptVersion(reportId:String)=currentVersion(database.readableDatabase,reportId)

  fun allocateAction(intent: ActionIntent, expectedReport: ReportIdentity? = null): AllocatedAction {
    require(intent.status in 1..4) { "status out of range" }
    require(intent.note.toByteArray(Charsets.UTF_8).size <= 1024 && !intent.note.contains('\u0000')) {
      "note out of range"
    }
    UUID.fromString(intent.actionId)
    UUID.fromString(intent.reportId)

    val profile = responderSigner ?: error("responder signer unavailable")
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      readAction(db, intent.actionId)?.let { existing ->
        check(
          existing.fields.reportId == intent.reportId &&
            existing.fields.observedIncidentVersion == intent.observedIncidentVersion &&
            existing.fields.status == intent.status &&
            existing.fields.note == intent.note &&
            existing.fields.responderId == profile.responderId,
        ) { "action conflict" }
        db.setTransactionSuccessful()
        return AllocatedAction(existing.fields, existing.allocatedAtMs, existing.state)
      }

      check(currentVersion(db, intent.reportId) == intent.observedIncidentVersion) {
        "incident version conflict"
      }
      val report = latestIdentity(db, intent.reportId) ?: error("report identity unavailable")
      check(expectedReport == null || (report.reportProtocolVersion == expectedReport.reportProtocolVersion &&
        report.revision == expectedReport.revision && MessageDigest.isEqual(report.payloadDigest,expectedReport.payloadDigest) &&
        MessageDigest.isEqual(report.originKeyId,expectedReport.originKeyId))) { "report binding conflict" }
      val issuedAt = now()
      val forwardingExpiry = responderForwardingExpiry(profile, issuedAt)
      val providerId = ReceiptAuthority.issuerProviderId(
        profile.providerKind,
        profile.identity.keyId,
        profile.grantId,
      )
      val draft = ReceiptFields.Responder(
        providerKind = profile.providerKind,
        issuerProviderId = providerId,
        actionId = intent.actionId,
        actionDigest = ByteArray(32),
        reportId = report.reportId,
        reportProtocolVersion = report.reportProtocolVersion,
        revision = report.revision,
        payloadDigest = report.payloadDigest,
        originKeyId = report.originKeyId,
        issuerKeyId = profile.identity.keyId,
        grantId = profile.grantId,
        responderId = profile.responderId,
        callsign = profile.callsign,
        observedIncidentVersion = intent.observedIncidentVersion,
        status = intent.status,
        sequence = 1L,
        issuedAtMs = issuedAt,
        forwardingExpiresAtMs = forwardingExpiry,
        note = intent.note,
      )
      val fields = draft.copy(
        sequence = nextSequence(db, profile.identity.keyId, profile.grantId, intent.reportId),
        actionDigest = ReceiptAuthority.actionDigest(draft),
      )
      db.insertOrThrow("receipt_actions", null, ContentValues().apply {
        put("action_id", fields.actionId)
        put("issuer_provider_id", fields.issuerProviderId)
        put("action_digest", fields.actionDigest)
        put("issuer_key_id", fields.issuerKeyId)
        put("grant_id", fields.grantId)
        put("report_id", fields.reportId)
        put("report_protocol_version", fields.reportProtocolVersion)
        put("revision", fields.revision)
        put("payload_digest", fields.payloadDigest)
        put("origin_key_id", fields.originKeyId)
        put("responder_id", fields.responderId)
        put("callsign", fields.callsign)
        put("observed_incident_version", fields.observedIncidentVersion)
        put("status", fields.status)
        put("sequence", fields.sequence)
        put("issued_at_ms", fields.issuedAtMs)
        put("forwarding_expires_at_ms", fields.forwardingExpiresAtMs)
        put("note", fields.note)
        put("proof_bytes", profile.proof)
        put("allocated_at_ms", issuedAt)
        put("preparation_state", "PREPARING")
      })
      db.setTransactionSuccessful()
      return AllocatedAction(fields, issuedAt, "PREPARING")
    } finally {
      db.endTransaction()
    }
  }

  fun prepareReceipt(actionId: String): ActionCommitResult {
    val profile = responderSigner
      ?: return ActionCommitResult(actionId, ActionCommitState.FAILED, reason = "SIGNER_UNAVAILABLE")
    val verifier = verificationContextProvider
      ?: return ActionCommitResult(actionId, ActionCommitState.REJECTED, reason = "VERIFIER_UNAVAILABLE")
    getReceipt(actionId)?.let { return ActionCommitResult(actionId, ActionCommitState.SIGNED, it) }

    val db = database.writableDatabase
    val token = UUID.randomUUID().toString()
    val started = now()
    val action: StoredAction
    db.beginTransaction()
    try {
      action = readAction(db, actionId)
        ?: return ActionCommitResult(actionId, ActionCommitState.REJECTED, reason = "ACTION_NOT_FOUND")
      if (action.state == "SIGNED") {
        val existing = getReceiptLocked(db, actionId)
        db.setTransactionSuccessful()
        return if (existing != null) {
          ActionCommitResult(actionId, ActionCommitState.SIGNED, existing.copyOf())
        } else {
          ActionCommitResult(actionId, ActionCommitState.REJECTED, reason = "SIGNED_RECEIPT_MISSING")
        }
      }
      if (!MessageDigest.isEqual(action.fields.issuerKeyId, profile.identity.keyId)) {
        db.setTransactionSuccessful()
        return ActionCommitResult(actionId, ActionCommitState.FAILED, reason = "SIGNER_UNAVAILABLE")
      }
      if (started >= action.fields.forwardingExpiresAtMs) {
        db.setTransactionSuccessful()
        return ActionCommitResult(actionId, ActionCommitState.REJECTED, reason = "FORWARDING_EXPIRED")
      }
      if (action.leaseUntilMs != null && action.leaseUntilMs > started) {
        db.setTransactionSuccessful()
        return ActionCommitResult(actionId, ActionCommitState.PREPARING)
      }
      db.execSQL(
        "UPDATE receipt_actions SET lease_token=?,lease_until_ms=? WHERE action_id=?",
        arrayOf<Any?>(token, Math.addExact(started, LEASE_MS), actionId),
      )
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }

    val signed = try {
      encodeFresh(action.fields, action.proof, profile.identity)
    } catch (_: Exception) {
      clearActionLease(actionId, token)
      return ActionCommitResult(actionId, ActionCommitState.FAILED, reason = "SIGNER_UNAVAILABLE")
    }
    val reportIdentity = reportIdentity(action.fields.reportId, action.fields.revision)
    if (reportIdentity == null) {
      clearActionLease(actionId, token)
      return ActionCommitResult(actionId, ActionCommitState.REJECTED, reason = "REPORT_IDENTITY_MISSING")
    }
    val context = try {
      verifier(reportIdentity, null)
    } catch (_: Exception) {
      clearActionLease(actionId, token)
      return ActionCommitResult(actionId, ActionCommitState.REJECTED, reason = "VERIFIER_UNAVAILABLE")
    }
    val verification = ReceiptAuthority.verifyReceipt(signed, context)
    val verified = verification as? ReceiptVerification.Verified
    if (verified == null) {
      clearActionLease(actionId, token)
      return ActionCommitResult(actionId, ActionCommitState.REJECTED, reason = "VERIFICATION_FAILED")
    }

    db.beginTransaction()
    try {
      getReceiptLocked(db, actionId)?.let {
        db.setTransactionSuccessful()
        return ActionCommitResult(actionId, ActionCommitState.SIGNED, it.copyOf())
      }
      val fresh = readAction(db, actionId)
        ?: return ActionCommitResult(actionId, ActionCommitState.REJECTED, reason = "ACTION_NOT_FOUND")
      if (fresh.state == "SIGNED") {
        db.setTransactionSuccessful()
        return ActionCommitResult(actionId, ActionCommitState.REJECTED, reason = "SIGNED_RECEIPT_MISSING")
      }
      if (fresh.leaseToken != token || fresh.leaseUntilMs == null || fresh.leaseUntilMs <= now()) {
        return ActionCommitResult(actionId, ActionCommitState.PREPARING)
      }
      if (!hasReceiptCapacity(
          db = db,
          eventId = action.fields.actionId,
          objectKind = "RESPONDER",
          objectBytes = signed,
          reportId = action.fields.reportId,
          issuerProviderId = action.fields.issuerProviderId,
          hasSequence = true,
          verificationKind = verified.kind,
          hasAuthorityCheckedAt = verified.authorityCheckedAtMs != null,
        )) {
        db.execSQL(
          "UPDATE receipt_actions SET lease_token=NULL,lease_until_ms=NULL WHERE action_id=? AND lease_token=?",
          arrayOf(actionId, token),
        )
        db.setTransactionSuccessful()
        return ActionCommitResult(actionId, ActionCommitState.REJECTED, reason = "CAPACITY_EXCEEDED")
      }
      insertResponderRecord(
        db,
        signed,
        action.fields,
        verified.kind,
        verified.authorityCheckedAtMs,
        started,
      )
      if (projectResponder(
          db,
          action.fields,
          verified.kind,
          verified.authorityCheckedAtMs,
          started,
          notify = false,
        )) {
        incrementVersion(db, action.fields.reportId)
      }
      db.execSQL(
        "UPDATE receipt_actions SET preparation_state='SIGNED',lease_token=NULL,lease_until_ms=NULL WHERE action_id=?",
        arrayOf(actionId),
      )
      db.setTransactionSuccessful()
      return ActionCommitResult(actionId, ActionCommitState.SIGNED, signed.copyOf())
    } finally {
      db.endTransaction()
    }
  }

  fun getReceipt(actionId:String):ByteArray?=getReceiptLocked(database.readableDatabase,actionId)?.copyOf()

  fun applyToReport(bytes:ByteArray, context:VerificationContext):ReceiptApplication {
    if(bytes.size !in 1..8192)return ReceiptApplication.REJECTED
    val decoded=try{ReceiptV2Codec.decode(bytes)}catch(_:Exception){return ReceiptApplication.REJECTED}
    val reportId:String;val revision:Int;val eventId:String;val expiry:Long
    when(val f=decoded.fields){
      is ReceiptFields.Responder->{reportId=f.reportId;revision=f.revision;eventId=f.actionId;expiry=f.forwardingExpiresAtMs}
      is ReceiptFields.Requester->{reportId=f.reportId;revision=f.revision;eventId=f.eventId;expiry=f.forwardingExpiresAtMs}
      else->return ReceiptApplication.REJECTED
    }
    val identity = reportIdentity(reportId, revision)
    if (identity == null) {
      quarantineReceipt(bytes, eventId, reportId, revision, "REPORT_IDENTITY_UNAVAILABLE")
      return ReceiptApplication.PENDING_AUTHORITY
    }
    val linked=if(decoded.fields is ReceiptFields.Requester)getReceipt((decoded.fields as ReceiptFields.Requester).ackEventId) else context.linkedAck
    val verification=ReceiptAuthority.verifyReceipt(bytes,context.copy(report=identity,linkedAck=linked))
    if(verification is ReceiptVerification.Rejected)return ReceiptApplication.REJECTED
    if (verification is ReceiptVerification.Unverified) {
      quarantineReceipt(bytes, eventId, reportId, revision, verification.reason)
      return ReceiptApplication.PENDING_AUTHORITY
    }
    val verified=verification as ReceiptVerification.Verified;val digest=sha256(bytes);val db=database.writableDatabase
    db.beginTransaction();try{
      val old=db.rawQuery("SELECT event_digest FROM receipt_records WHERE event_id=?",arrayOf(eventId)).use{c->if(c.moveToFirst())c.getBlob(0) else null}
      if(old!=null){
        if (MessageDigest.isEqual(old, digest)) {
          db.delete("receipt_quarantine", "lower(hex(object_digest))=?", arrayOf(hex(digest)))
          db.setTransactionSuccessful()
          return ReceiptApplication.DUPLICATE
        }
        insertQuarantine(db, bytes, eventId, reportId, revision, "EVENT_ID_CONFLICT")
        trimQuarantine(db)
        db.setTransactionSuccessful()
        return ReceiptApplication.REJECTED
      }
      val sameDigest=db.rawQuery("SELECT event_id FROM receipt_records WHERE lower(hex(event_digest))=?",arrayOf(hex(digest))).use{c->if(c.moveToFirst())c.getString(0) else null}
      if(sameDigest!=null&&sameDigest!=eventId){
        insertQuarantine(db, bytes, eventId, reportId, revision, "DIGEST_CONFLICT")
        trimQuarantine(db)
        db.setTransactionSuccessful()
        return ReceiptApplication.REJECTED
      }
      db.delete("receipt_quarantine", "lower(hex(object_digest))=?", arrayOf(hex(digest)))
      val responderFields = decoded.fields as? ReceiptFields.Responder
      if (responderFields != null) {
        val collision = db.rawQuery(
          "SELECT 1 FROM receipt_records WHERE object_kind='RESPONDER' AND report_id=? AND lower(hex(issuer_provider_id))=? AND sequence=? AND event_id!=? LIMIT 1",
          arrayOf(reportId,hex(responderFields.issuerProviderId),responderFields.sequence.toString(),eventId),
        ).use { it.moveToFirst() }
        if (collision) {
          insertQuarantine(db,bytes,eventId,reportId,revision,"PROVIDER_SEQUENCE_CONFLICT")
          trimQuarantine(db)
          db.setTransactionSuccessful()
          return ReceiptApplication.REJECTED
        }
      }
      if (!hasReceiptCapacity(
          db = db,
          eventId = eventId,
          objectKind = if (responderFields != null) "RESPONDER" else "REQUESTER",
          objectBytes = bytes,
          reportId = reportId,
          issuerProviderId = responderFields?.issuerProviderId,
          hasSequence = responderFields != null,
          verificationKind = verified.kind,
          hasAuthorityCheckedAt = verified.authorityCheckedAtMs != null,
        )) {
        db.setTransactionSuccessful()
        return ReceiptApplication.REJECTED
      }
      when (val f = decoded.fields) {
        is ReceiptFields.Responder -> db.insertOrThrow("receipt_records", null, ContentValues().apply {
          put("event_id", eventId)
          put("object_kind", "RESPONDER")
          put("event_digest", digest)
          put("object_bytes", bytes)
          put("report_id", reportId)
          put("revision", revision)
          put("issuer_provider_id", f.issuerProviderId)
          put("sequence", f.sequence)
          put("verification_kind", verified.kind)
          verified.authorityCheckedAtMs?.let { put("authority_checked_at_ms", it) }
          put("forwarding_expires_at_ms", expiry)
          put("received_at_ms", now())
        })
        is ReceiptFields.Requester -> db.insertOrThrow("receipt_records", null, ContentValues().apply {
          put("event_id", eventId)
          put("object_kind", "REQUESTER")
          put("event_digest", digest)
          put("object_bytes", bytes)
          put("report_id", reportId)
          put("revision", revision)
          put("verification_kind", verified.kind)
          verified.authorityCheckedAtMs?.let { put("authority_checked_at_ms", it) }
          put("forwarding_expires_at_ms", expiry)
          put("received_at_ms", now())
        })
        else -> error("unreachable")
      }
      if(revision<latestRevision(db,reportId)){db.setTransactionSuccessful();return ReceiptApplication.HISTORICAL}
      when(val f=decoded.fields){
        is ReceiptFields.Responder->{val applied=projectResponder(db,f,verified.kind,verified.authorityCheckedAtMs,now(),true);if(applied)incrementVersion(db,reportId);db.setTransactionSuccessful();return if(applied)ReceiptApplication.APPLIED else ReceiptApplication.HISTORICAL}
        is ReceiptFields.Requester -> {
          db.execSQL(
            "UPDATE receipt_projections SET requester_delivery_state='RECEIVED',updated_at_ms=? WHERE report_id=? AND event_id=?",
            arrayOf<Any?>(now(), reportId, f.ackEventId),
          )
          db.setTransactionSuccessful()
          return ReceiptApplication.APPLIED
        }
        else->error("unreachable")
      }
    }finally{db.endTransaction()}
  }

  fun prepareRequesterReceipt(ackEventId: String): ActionCommitResult {
    val signer = requesterSigner
      ?: return ActionCommitResult(ackEventId, ActionCommitState.FAILED, reason = "SIGNER_UNAVAILABLE")
    val db = database.writableDatabase
    var action = readRequesterAction(db, ackEventId)

    if (action == null) {
      val ackBytes = getReceipt(ackEventId)
        ?: return ActionCommitResult(ackEventId, ActionCommitState.REJECTED, reason = "ACK_NOT_FOUND")
      val ack = try {
        ReceiptV2Codec.decode(ackBytes).fields as ReceiptFields.Responder
      } catch (_: Exception) {
        return ActionCommitResult(ackEventId, ActionCommitState.REJECTED, reason = "ACK_INVALID")
      }
      val identity = reportIdentity(ack.reportId, ack.revision)
        ?: return ActionCommitResult(ackEventId, ActionCommitState.REJECTED, reason = "REPORT_IDENTITY_MISSING")
      if (!MessageDigest.isEqual(signer.keyId, identity.originKeyId) ||
        !MessageDigest.isEqual(signer.publicKeyDer, identity.originPublicKeyDer)) {
        return ActionCommitResult(ackEventId, ActionCommitState.FAILED, reason = "ORIGIN_SIGNER_MISMATCH")
      }
      val created = now()
      if (created >= ack.forwardingExpiresAtMs) {
        return ActionCommitResult(ackEventId, ActionCommitState.REJECTED, reason = "FORWARDING_EXPIRED")
      }
      db.beginTransaction()
      try {
        action = readRequesterAction(db, ackEventId)
        if (action == null) {
          db.insertOrThrow("requester_receipt_actions", null, ContentValues().apply {
            put("ack_event_id", ackEventId)
            put("event_id", UUID.randomUUID().toString())
            put("report_id", ack.reportId)
            put("report_protocol_version", ack.reportProtocolVersion)
            put("revision", ack.revision)
            put("origin_key_id", identity.originKeyId)
            put("origin_public_key_der", identity.originPublicKeyDer)
            put("ack_digest", sha256(ackBytes))
            put("received_at_ms", created)
            put("forwarding_expires_at_ms", ack.forwardingExpiresAtMs)
            put("preparation_state", "PREPARING")
          })
          action = readRequesterAction(db, ackEventId)
        }
        db.setTransactionSuccessful()
      } finally {
        db.endTransaction()
      }
    }

    val fixed = requireNotNull(action)
    getReceipt(fixed.eventId)?.let {
      return ActionCommitResult(fixed.eventId, ActionCommitState.SIGNED, it)
    }
    if (fixed.state == "SIGNED") {
      return ActionCommitResult(fixed.eventId, ActionCommitState.REJECTED, reason = "SIGNED_RECEIPT_MISSING")
    }
    if (!MessageDigest.isEqual(signer.keyId, fixed.originKeyId) ||
      !MessageDigest.isEqual(signer.publicKeyDer, fixed.originKey)) {
      return ActionCommitResult(fixed.eventId, ActionCommitState.FAILED, reason = "ORIGIN_SIGNER_MISMATCH")
    }
    val linkedAck = getReceipt(ackEventId)
      ?: return ActionCommitResult(fixed.eventId, ActionCommitState.REJECTED, reason = "ACK_NOT_FOUND")
    if (!MessageDigest.isEqual(sha256(linkedAck), fixed.ackDigest)) {
      return ActionCommitResult(fixed.eventId, ActionCommitState.REJECTED, reason = "ACK_DIGEST_MISMATCH")
    }

    val started = now()
    if (started >= fixed.expiry) {
      return ActionCommitResult(fixed.eventId, ActionCommitState.REJECTED, reason = "FORWARDING_EXPIRED")
    }
    val token = UUID.randomUUID().toString()
    db.beginTransaction()
    try {
      val fresh = readRequesterAction(db, ackEventId)
        ?: return ActionCommitResult(fixed.eventId, ActionCommitState.REJECTED, reason = "ACTION_NOT_FOUND")
      if (fresh.state == "SIGNED") {
        val existing = getReceiptLocked(db, fresh.eventId)
        db.setTransactionSuccessful()
        return if (existing != null) {
          ActionCommitResult(fresh.eventId, ActionCommitState.SIGNED, existing.copyOf())
        } else {
          ActionCommitResult(fresh.eventId, ActionCommitState.REJECTED, reason = "SIGNED_RECEIPT_MISSING")
        }
      }
      if (fresh.leaseUntil != null && fresh.leaseUntil > started) {
        db.setTransactionSuccessful()
        return ActionCommitResult(fresh.eventId, ActionCommitState.PREPARING)
      }
      db.execSQL(
        "UPDATE requester_receipt_actions SET lease_token=?,lease_until_ms=? WHERE ack_event_id=?",
        arrayOf<Any?>(token, Math.addExact(started, LEASE_MS), ackEventId),
      )
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }

    val fields = ReceiptFields.Requester(
      eventId = fixed.eventId,
      reportId = fixed.reportId,
      reportProtocolVersion = fixed.protocol,
      revision = fixed.revision,
      originKeyId = fixed.originKeyId,
      originPublicKeyDer = fixed.originKey,
      ackEventId = ackEventId,
      ackDigest = fixed.ackDigest,
      receivedAtMs = fixed.receivedAt,
      forwardingExpiresAtMs = fixed.expiry,
    )
    val signed = try {
      encodeFresh(fields, ByteArray(0), signer)
    } catch (_: Exception) {
      clearRequesterLease(ackEventId, token)
      return ActionCommitResult(fixed.eventId, ActionCommitState.FAILED, reason = "SIGNER_UNAVAILABLE")
    }
    val decoded = try {
      ReceiptV2Codec.decode(signed)
    } catch (_: Exception) {
      clearRequesterLease(ackEventId, token)
      return ActionCommitResult(fixed.eventId, ActionCommitState.REJECTED, reason = "VERIFICATION_FAILED")
    }
    if (!ReceiptV2Codec.verifySignature(decoded, fixed.originKey)) {
      clearRequesterLease(ackEventId, token)
      return ActionCommitResult(fixed.eventId, ActionCommitState.REJECTED, reason = "VERIFICATION_FAILED")
    }

    db.beginTransaction()
    try {
      getReceiptLocked(db, fixed.eventId)?.let {
        db.setTransactionSuccessful()
        return ActionCommitResult(fixed.eventId, ActionCommitState.SIGNED, it.copyOf())
      }
      val fresh = readRequesterAction(db, ackEventId)
        ?: return ActionCommitResult(fixed.eventId, ActionCommitState.REJECTED, reason = "ACTION_NOT_FOUND")
      if (fresh.state == "SIGNED") {
        db.setTransactionSuccessful()
        return ActionCommitResult(fixed.eventId, ActionCommitState.REJECTED, reason = "SIGNED_RECEIPT_MISSING")
      }
      if (fresh.leaseToken != token || fresh.leaseUntil == null || fresh.leaseUntil <= now()) {
        return ActionCommitResult(fixed.eventId, ActionCommitState.PREPARING)
      }
      if (!hasReceiptCapacity(
          db = db,
          eventId = fields.eventId,
          objectKind = "REQUESTER",
          objectBytes = signed,
          reportId = fields.reportId,
          issuerProviderId = null,
          hasSequence = false,
          verificationKind = "LOCALLY_SIGNED",
          hasAuthorityCheckedAt = false,
        )) {
        db.execSQL(
          "UPDATE requester_receipt_actions SET lease_token=NULL,lease_until_ms=NULL WHERE ack_event_id=? AND lease_token=?",
          arrayOf(ackEventId, token),
        )
        db.setTransactionSuccessful()
        return ActionCommitResult(fixed.eventId, ActionCommitState.REJECTED, reason = "CAPACITY_EXCEEDED")
      }
      db.insertOrThrow("receipt_records", null, ContentValues().apply {
        put("event_id", fields.eventId)
        put("object_kind", "REQUESTER")
        put("event_digest", sha256(signed))
        put("object_bytes", signed)
        put("report_id", fields.reportId)
        put("revision", fields.revision)
        put("verification_kind", "LOCALLY_SIGNED")
        put("forwarding_expires_at_ms", fields.forwardingExpiresAtMs)
        put("received_at_ms", started)
      })
      db.execSQL(
        "UPDATE requester_receipt_actions SET preparation_state='SIGNED',lease_token=NULL,lease_until_ms=NULL WHERE ack_event_id=?",
        arrayOf(ackEventId),
      )
      db.setTransactionSuccessful()
      return ActionCommitResult(fixed.eventId, ActionCommitState.SIGNED, signed.copyOf())
    } finally {
      db.endTransaction()
    }
  }

  fun projection(reportId: String): ReceiptProjection? = database.readableDatabase.rawQuery(
    """SELECT p.issuer_provider_id,p.report_id,p.event_id,p.revision,p.sequence,p.verification_kind,
      p.authority_checked_at_ms,p.notification_eligible,p.requester_delivery_state,r.object_bytes
      FROM receipt_projections p JOIN receipt_records r ON r.event_id=p.event_id WHERE p.report_id=?""",
    arrayOf(reportId),
  ).use { c ->
    val candidates = mutableListOf<Pair<ReceiptProjection,Int>>()
    while(c.moveToNext()) {
      val fields = runCatching { ReceiptV2Codec.decode(c.getBlob(9)).fields as? ReceiptFields.Responder }.getOrNull() ?: continue
      if(fields.reportId != reportId || fields.actionId != c.getString(2) ||
        fields.revision != c.getInt(3) || fields.sequence != c.getLong(4) ||
        !MessageDigest.isEqual(fields.issuerProviderId,c.getBlob(0))) continue
      candidates += ReceiptProjection(c.getBlob(0),c.getString(1),c.getString(2),c.getInt(3),c.getLong(4),
        c.getString(5),if(c.isNull(6)) null else c.getLong(6),c.getInt(7)!=0,c.getString(8)) to fields.status
    }
    // Provider sequences and local arrival times are not a shared global order.
    candidates.maxWithOrNull(compareBy<Pair<ReceiptProjection,Int>> { it.first.revision }
      .thenBy { it.second }.thenBy { hex(it.first.issuerProviderId) }
      .thenBy { it.first.sequence }.thenBy { it.first.eventId })?.first
  }

  fun claimVerifiedReceiptNotification(reportId: String, eventId: String): Boolean {
    UUID.fromString(reportId)
    UUID.fromString(eventId)
    val updated = database.writableDatabase.update(
      "receipt_projections",
      ContentValues().apply { put("notification_eligible", 0) },
      "report_id=? AND event_id=? AND notification_eligible=1",
      arrayOf(reportId, eventId),
    )
    return updated == 1
  }

  fun recordTimeChallenge(
    challengeId: String,
    verifierId: ByteArray,
    verifierBootSessionId: String,
    nonce: ByteArray,
    sentElapsedMs: Long,
    createdAtMs: Long,
  ) {
    require(verifierId.size == 32 && nonce.size == 32)
    val highWater = database.readableDatabase.rawQuery(
      "SELECT earliest_ms FROM receipt_time_high_water WHERE lower(hex(verifier_id))=?",
      arrayOf(hex(verifierId)),
    ).use { cursor -> if (cursor.moveToFirst()) cursor.getLong(0) else null }
    database.writableDatabase.insertOrThrow(
      "receipt_time_challenges",
      null,
      ContentValues().apply {
        put("challenge_id", challengeId)
        put("verifier_id", verifierId)
        put("verifier_boot_session_id", verifierBootSessionId)
        put("nonce", nonce)
        put("sent_elapsed_ms", sentElapsedMs)
        highWater?.let { put("high_water_earliest_ms", it) }
        put("created_at_ms", createdAtMs)
      },
    )
  }

  fun commitTimeCheckpoint(
    challengeId: String,
    verifierId: ByteArray,
    nonce: ByteArray,
    checkpoint: TimeCheckpoint,
    proofBytes: ByteArray? = null,
  ): Boolean {
    require(proofBytes == null || proofBytes.size <= ReceiptV2Codec.MAX_RECEIPT_BYTES) { "time proof size" }
    require(proofBytes == null || hex(sha256(proofBytes)) == checkpoint.proofDigest) { "time proof digest" }
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      val challenge = db.rawQuery(
        "SELECT verifier_id,nonce,consumed_at_ms,high_water_earliest_ms,verifier_boot_session_id FROM receipt_time_challenges WHERE challenge_id=?",
        arrayOf(challengeId),
      ).use { cursor ->
        if (!cursor.moveToFirst()) null else ChallengeRow(
          cursor.getBlob(0),
          cursor.getBlob(1),
          if (cursor.isNull(2)) null else cursor.getLong(2),
          if (cursor.isNull(3)) null else cursor.getLong(3),
          cursor.getString(4),
        )
      } ?: return false
      if (
        challenge.consumedAt != null ||
        !MessageDigest.isEqual(challenge.verifierId, verifierId) ||
        !MessageDigest.isEqual(challenge.nonce, nonce) ||
        challenge.bootId != checkpoint.bootId ||
        (challenge.highWater != null && checkpoint.earliestMs < challenge.highWater)
      ) return false

      val storedHighWater = db.rawQuery(
        "SELECT earliest_ms FROM receipt_time_high_water WHERE lower(hex(verifier_id))=?",
        arrayOf(hex(verifierId)),
      ).use { cursor -> if (cursor.moveToFirst()) cursor.getLong(0) else null }
      if (storedHighWater != null && checkpoint.earliestMs < storedHighWater) return false

      db.insertOrThrow("receipt_time_checkpoints", null, ContentValues().apply {
        put("challenge_id", challengeId)
        put("verifier_id", verifierId)
        put("earliest_ms", checkpoint.earliestMs)
        put("latest_ms", checkpoint.latestMs)
        put("boot_id", checkpoint.bootId)
        put("received_elapsed_ms", checkpoint.receivedElapsedMs)
        put("valid_until_ms", checkpoint.validUntilMs)
        put("proof_digest", checkpoint.proofDigest)
        if (proofBytes != null) put("proof_bytes", proofBytes)
        put("committed_at_ms", now())
      })
      db.execSQL(
        "UPDATE receipt_time_challenges SET consumed_at_ms=? WHERE challenge_id=? AND consumed_at_ms IS NULL",
        arrayOf<Any?>(now(), challengeId),
      )
      db.execSQL(
        "INSERT INTO receipt_time_high_water(verifier_id,earliest_ms,updated_at_ms) VALUES(?,?,?) " +
          "ON CONFLICT(verifier_id) DO UPDATE SET " +
          "earliest_ms=MAX(earliest_ms,excluded.earliest_ms),updated_at_ms=excluded.updated_at_ms",
        arrayOf<Any?>(verifierId, checkpoint.earliestMs, now()),
      )
      db.setTransactionSuccessful()
      return true
    } finally {
      db.endTransaction()
    }
  }

  fun latestTimeCheckpoint(verifierId: ByteArray): TimeCheckpoint? = database.readableDatabase.rawQuery(
    "SELECT earliest_ms,latest_ms,boot_id,received_elapsed_ms,valid_until_ms,proof_digest " +
      "FROM receipt_time_checkpoints WHERE lower(hex(verifier_id))=? ORDER BY checkpoint_id DESC LIMIT 1",
    arrayOf(hex(verifierId)),
  ).use { cursor ->
    if (!cursor.moveToFirst()) null else TimeCheckpoint(
      cursor.getLong(0),
      cursor.getLong(1),
      cursor.getString(2),
      cursor.getLong(3),
      cursor.getLong(4),
      cursor.getString(5),
    )
  }

  fun latestTimeProof(verifierId: ByteArray): ByteArray? = database.readableDatabase.rawQuery(
    "SELECT proof_bytes FROM receipt_time_checkpoints WHERE lower(hex(verifier_id))=? AND proof_bytes IS NOT NULL ORDER BY checkpoint_id DESC LIMIT 1",
    arrayOf(hex(verifierId)),
  ).use { cursor -> if (cursor.moveToFirst()) cursor.getBlob(0) else null }

  private fun responderForwardingExpiry(profile: ResponderSignerProfile, issuedAt: Long): Long {
    val receiptExpiry = Math.addExact(issuedAt, WEEK_MS)
    if (profile.providerKind != 2) return receiptExpiry

    val proof = ByteBuffer.wrap(profile.proof)
    require(proof.remaining() >= 3) { "grant proof missing" }
    require((proof.get().toInt() and 0xff) == 1) { "grant proof count" }
    val memberLength = proof.short.toInt() and 0xffff
    require(memberLength == proof.remaining()) { "grant proof length" }
    val member = ByteArray(memberLength)
    proof.get(member)
    val grant = ReceiptV2Codec.decode(member).fields as? ReceiptFields.Grant
      ?: throw IllegalArgumentException("grant proof profile")
    require(grant.grantId == profile.grantId) { "grant id mismatch" }
    require(MessageDigest.isEqual(grant.issuerKeyId, profile.identity.keyId)) { "grant key mismatch" }
    require(
      MessageDigest.isEqual(
        grant.issuerProviderId,
        ReceiptAuthority.issuerProviderId(profile.providerKind, profile.identity.keyId, profile.grantId),
      ),
    ) { "grant provider mismatch" }
    require(grant.responderId == profile.responderId && grant.callsign == profile.callsign) {
      "grant responder mismatch"
    }
    val expiry = minOf(receiptExpiry, grant.expiresAtMs)
    require(issuedAt >= grant.notBeforeMs && issuedAt < expiry) { "grant not active" }
    return expiry
  }

  private fun readAction(db: SQLiteDatabase, actionId: String): StoredAction? = db.rawQuery(
    "SELECT issuer_provider_id,action_digest,issuer_key_id,grant_id,report_id,report_protocol_version,revision,payload_digest,origin_key_id,responder_id,callsign,observed_incident_version,status,sequence,issued_at_ms,forwarding_expires_at_ms,note,proof_bytes,allocated_at_ms,preparation_state,lease_token,lease_until_ms FROM receipt_actions WHERE action_id=?",
    arrayOf(actionId),
  ).use { c ->
    if (!c.moveToFirst()) null else {
      val key = c.getBlob(2)
      val grant = c.getString(3)
      val provider = c.getBlob(0)
      StoredAction(
        ReceiptFields.Responder(
          providerKind(provider, key, grant), provider, actionId, c.getBlob(1), c.getString(4), c.getInt(5), c.getInt(6),
          c.getBlob(7), c.getBlob(8), key, grant, c.getString(9), c.getString(10), c.getLong(11), c.getInt(12),
          c.getLong(13), c.getLong(14), c.getLong(15), c.getString(16),
        ),
        c.getLong(18), c.getString(19), c.getBlob(17), if (c.isNull(20)) null else c.getString(20), if (c.isNull(21)) null else c.getLong(21),
      )
    }
  }

  private fun readRequesterAction(db: SQLiteDatabase, ackId: String): RequesterAction? = db.rawQuery(
    "SELECT event_id,report_id,report_protocol_version,revision,origin_key_id,origin_public_key_der,ack_digest,received_at_ms,forwarding_expires_at_ms,preparation_state,lease_token,lease_until_ms FROM requester_receipt_actions WHERE ack_event_id=?",
    arrayOf(ackId),
  ).use { c ->
    if (!c.moveToFirst()) null else RequesterAction(
      c.getString(0), c.getString(1), c.getInt(2), c.getInt(3), c.getBlob(4), c.getBlob(5), c.getBlob(6), c.getLong(7), c.getLong(8), c.getString(9),
      if (c.isNull(10)) null else c.getString(10), if (c.isNull(11)) null else c.getLong(11),
    )
  }

  private fun providerKind(provider: ByteArray, key: ByteArray, grant: String): Int = when {
    MessageDigest.isEqual(provider, ReceiptAuthority.issuerProviderId(1, key, grant)) -> 1
    MessageDigest.isEqual(provider, ReceiptAuthority.issuerProviderId(2, key, grant)) -> 2
    else -> error("provider binding corrupt")
  }

  private fun nextSequence(db: SQLiteDatabase, key: ByteArray, grant: String, report: String): Long {
    val old = db.rawQuery(
      "SELECT sequence FROM receipt_sequences WHERE lower(hex(issuer_key_id))=? AND grant_id=? AND report_id=?",
      arrayOf(hex(key), grant, report),
    ).use { c -> if (c.moveToFirst()) c.getLong(0) else 0L }
    val next = Math.addExact(old, 1L)
    db.execSQL(
      "INSERT INTO receipt_sequences(issuer_key_id,grant_id,report_id,sequence) VALUES(?,?,?,?) ON CONFLICT(issuer_key_id,grant_id,report_id) DO UPDATE SET sequence=excluded.sequence",
      arrayOf<Any?>(key, grant, report, next),
    )
    return next
  }

  private fun reportIdentity(db: SQLiteDatabase, reportId: String, revision: Int): ReportIdentity? = db.rawQuery(
    "SELECT report_protocol_version,payload_digest,origin_key_id,origin_public_key_der FROM receipt_report_identities WHERE report_id=? AND revision=?",
    arrayOf(reportId, revision.toString()),
  ).use { c -> if (!c.moveToFirst()) null else ReportIdentity(reportId, c.getInt(0), revision, c.getBlob(1), c.getBlob(2), c.getBlob(3)) }

  private fun reportIdentity(reportId: String, revision: Int) = reportIdentity(database.readableDatabase, reportId, revision)

  private fun latestIdentity(db: SQLiteDatabase, reportId: String): ReportIdentity? = db.rawQuery(
    "SELECT revision,report_protocol_version,payload_digest,origin_key_id,origin_public_key_der FROM receipt_report_identities WHERE report_id=? ORDER BY revision DESC LIMIT 1",
    arrayOf(reportId),
  ).use { cursor ->
    if (!cursor.moveToFirst()) null else ReportIdentity(
      reportId,
      cursor.getInt(1),
      cursor.getInt(0),
      cursor.getBlob(2),
      cursor.getBlob(3),
      cursor.getBlob(4),
    )
  }

  private fun latestRevision(db: SQLiteDatabase, reportId: String): Int = db.rawQuery(
    "SELECT MAX(revision) FROM receipt_report_identities WHERE report_id=?", arrayOf(reportId),
  ).use { c -> if (!c.moveToFirst() || c.isNull(0)) 0 else c.getInt(0) }

  private fun currentVersion(db: SQLiteDatabase, reportId: String): Long = db.rawQuery(
    "SELECT receipt_version FROM receipt_report_state WHERE report_id=?", arrayOf(reportId),
  ).use { c -> if (c.moveToFirst()) c.getLong(0) else 0L }

  private fun incrementVersion(db: SQLiteDatabase, reportId: String) {
    db.execSQL("INSERT INTO receipt_report_state(report_id,receipt_version) VALUES(?,1) ON CONFLICT(report_id) DO UPDATE SET receipt_version=receipt_version+1", arrayOf(reportId))
  }

  private fun insertResponderRecord(
    db: SQLiteDatabase,
    bytes: ByteArray,
    fields: ReceiptFields.Responder,
    kind: String,
    authorityCheckedAt: Long?,
    receivedAt: Long,
  ) {
    db.insertOrThrow("receipt_records", null, ContentValues().apply {
      put("event_id", fields.actionId)
      put("object_kind", "RESPONDER")
      put("event_digest", sha256(bytes))
      put("object_bytes", bytes)
      put("report_id", fields.reportId)
      put("revision", fields.revision)
      put("issuer_provider_id", fields.issuerProviderId)
      put("sequence", fields.sequence)
      put("verification_kind", kind)
      authorityCheckedAt?.let { put("authority_checked_at_ms", it) }
      put("forwarding_expires_at_ms", fields.forwardingExpiresAtMs)
      put("received_at_ms", receivedAt)
    })
  }

  private fun projectResponder(
    db: SQLiteDatabase,
    fields: ReceiptFields.Responder,
    kind: String,
    authorityCheckedAt: Long?,
    updatedAt: Long,
    notify: Boolean,
  ): Boolean {
    val old = db.rawQuery(
      """SELECT p.sequence,p.revision,r.object_bytes FROM receipt_projections p
        JOIN receipt_records r ON r.event_id=p.event_id
        WHERE lower(hex(p.issuer_provider_id))=? AND p.report_id=?""",
      arrayOf(hex(fields.issuerProviderId), fields.reportId),
    ).use { c ->
      if(!c.moveToFirst()) null else Triple(c.getLong(0),c.getInt(1),
        (ReceiptV2Codec.decode(c.getBlob(2)).fields as ReceiptFields.Responder).status)
    }
    if (old != null && (old.first >= fields.sequence || old.second > fields.revision ||
      (old.second == fields.revision && old.third > fields.status))) return false
    db.delete("receipt_projections", "lower(hex(issuer_provider_id))=? AND report_id=?", arrayOf(hex(fields.issuerProviderId), fields.reportId))
    db.insertOrThrow("receipt_projections", null, ContentValues().apply {
      put("issuer_provider_id", fields.issuerProviderId)
      put("report_id", fields.reportId)
      put("event_id", fields.actionId)
      put("revision", fields.revision)
      put("sequence", fields.sequence)
      put("verification_kind", kind)
      authorityCheckedAt?.let { put("authority_checked_at_ms", it) }
      put("notification_eligible", if (notify) 1 else 0)
      put("requester_delivery_state", "UNKNOWN")
      put("updated_at_ms", updatedAt)
    })
    return true
  }

  private fun hasReceiptCapacity(
    db: SQLiteDatabase,
    eventId: String,
    objectKind: String,
    objectBytes: ByteArray,
    reportId: String,
    issuerProviderId: ByteArray?,
    hasSequence: Boolean,
    verificationKind: String,
    hasAuthorityCheckedAt: Boolean,
  ): Boolean {
    val (count, usedBytes) = db.rawQuery(
      """
        SELECT COUNT(*), COALESCE(SUM(
          length(CAST(event_id AS BLOB)) +
          length(CAST(object_kind AS BLOB)) +
          length(event_digest) +
          length(object_bytes) +
          length(CAST(report_id AS BLOB)) +
          8 +
          COALESCE(length(issuer_provider_id), 0) +
          CASE WHEN sequence IS NULL THEN 0 ELSE 8 END +
          length(CAST(verification_kind AS BLOB)) +
          CASE WHEN authority_checked_at_ms IS NULL THEN 0 ELSE 8 END +
          8 + 8 +
          CASE WHEN cloud_archived_at_ms IS NULL THEN 0 ELSE 8 END
        ), 0)
        FROM receipt_records
      """.trimIndent(),
      null,
    ).use { cursor ->
      cursor.moveToFirst()
      cursor.getLong(0) to cursor.getLong(1)
    }
    val newBytes =
      eventId.toByteArray(Charsets.UTF_8).size.toLong() +
        objectKind.toByteArray(Charsets.UTF_8).size +
        32L +
        objectBytes.size +
        reportId.toByteArray(Charsets.UTF_8).size +
        8L +
        (issuerProviderId?.size ?: 0) +
        (if (hasSequence) 8L else 0L) +
        verificationKind.toByteArray(Charsets.UTF_8).size +
        (if (hasAuthorityCheckedAt) 8L else 0L) +
        16L
    return count < RECEIPT_MAX_OBJECTS && usedBytes + newBytes <= RECEIPT_MAX_BYTES
  }

  private fun quarantineReceipt(
    bytes: ByteArray,
    eventId: String,
    reportId: String,
    revision: Int,
    reason: String,
  ) {
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      insertQuarantine(db, bytes, eventId, reportId, revision, reason)
      trimQuarantine(db)
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  private fun insertQuarantine(
    db: SQLiteDatabase,
    bytes: ByteArray,
    eventId: String,
    reportId: String,
    revision: Int,
    reason: String,
  ) {
    db.insertWithOnConflict(
      "receipt_quarantine",
      null,
      ContentValues().apply {
        put("object_digest", sha256(bytes))
        put("claimed_event_id", eventId)
        put("object_bytes", bytes)
        put("report_id", reportId)
        put("revision", revision)
        put("reason", reason)
        put("received_at_ms", now())
      },
      SQLiteDatabase.CONFLICT_IGNORE,
    )
  }

  private fun trimQuarantine(db: SQLiteDatabase) {
    while (true) {
      val (count, bytes) = db.rawQuery(
        "SELECT COUNT(*), COALESCE(SUM(length(object_bytes)),0) FROM receipt_quarantine",
        null,
      ).use { cursor ->
        cursor.moveToFirst()
        cursor.getLong(0) to cursor.getLong(1)
      }
      if (count <= QUARANTINE_MAX_OBJECTS && bytes <= QUARANTINE_MAX_BYTES) return
      val oldestDigest = db.rawQuery(
        "SELECT lower(hex(object_digest)) FROM receipt_quarantine ORDER BY received_at_ms ASC, rowid ASC LIMIT 1",
        null,
      ).use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null } ?: return
      db.delete("receipt_quarantine", "lower(hex(object_digest))=?", arrayOf(oldestDigest))
    }
  }

  private fun getReceiptLocked(db: SQLiteDatabase, eventId: String): ByteArray? = db.rawQuery(
    "SELECT object_bytes FROM receipt_records WHERE event_id=?", arrayOf(eventId),
  ).use { c -> if (c.moveToFirst()) c.getBlob(0) else null }

  private fun clearActionLease(actionId: String, token: String) {
    database.writableDatabase.execSQL("UPDATE receipt_actions SET lease_token=NULL,lease_until_ms=NULL WHERE action_id=? AND lease_token=?", arrayOf(actionId, token))
  }

  private fun clearRequesterLease(ackId: String, token: String) {
    database.writableDatabase.execSQL("UPDATE requester_receipt_actions SET lease_token=NULL,lease_until_ms=NULL WHERE ack_event_id=? AND lease_token=?", arrayOf(ackId, token))
  }

  internal fun encodeFresh(fields: ReceiptFields, proof: ByteArray, identity: SigningIdentity): ByteArray {
    val one = ByteArray(32).also { it[31] = 1 }
    val placeholder = one + one
    val encoded = ReceiptV2Codec.encode(fields, placeholder, proof)
    val input = SIGNING_DOMAIN + encoded.copyOfRange(0, encoded.size - 64)
    return ReceiptV2Codec.encode(fields, derToP1363LowS(identity.sign(input)), proof)
  }

  private fun derToP1363LowS(der: ByteArray): ByteArray {
    var offset = 0
    require((der[offset++].toInt() and 0xff) == 0x30)
    val sequenceLength = readLength(der, offset)
    offset += sequenceLength.second
    require(offset + sequenceLength.first == der.size)
    require((der[offset++].toInt() and 0xff) == 0x02)
    val rLength = readLength(der, offset)
    offset += rLength.second
    val r = BigInteger(1, der.copyOfRange(offset, offset + rLength.first))
    offset += rLength.first
    require((der[offset++].toInt() and 0xff) == 0x02)
    val sLength = readLength(der, offset)
    offset += sLength.second
    var s = BigInteger(1, der.copyOfRange(offset, offset + sLength.first))
    offset += sLength.first
    require(offset == der.size)
    require(r.signum() > 0 && r < P256_ORDER && s.signum() > 0 && s < P256_ORDER)
    if (s > P256_ORDER.shiftRight(1)) s = P256_ORDER - s
    return scalar32(r) + scalar32(s)
  }

  private fun readLength(bytes: ByteArray, offset: Int): Pair<Int, Int> {
    val first = bytes[offset].toInt() and 0xff
    if (first < 128) return first to 1
    val count = first and 0x7f
    require(count in 1..2 && offset + count < bytes.size)
    var value = 0
    repeat(count) { value = (value shl 8) or (bytes[offset + 1 + it].toInt() and 0xff) }
    return value to (count + 1)
  }

  private fun scalar32(value: BigInteger): ByteArray {
    val source = value.toByteArray()
    val raw = if (source.size == 33 && source[0] == 0.toByte()) source.copyOfRange(1, 33) else source
    require(raw.size <= 32)
    return ByteArray(32 - raw.size) + raw
  }

  private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }
  private fun now(): Long = clock().also { require(it >= 0) }

  companion object {
    private const val WEEK_MS = 604_800_000L
    private const val LEASE_MS = 60_000L
    private const val RECEIPT_MAX_OBJECTS = 10_000L
    private const val RECEIPT_MAX_BYTES = 67_108_864L
    private const val QUARANTINE_MAX_OBJECTS = 128L
    private const val QUARANTINE_MAX_BYTES = 1_048_576L
    private val SIGNING_DOMAIN = "SAGIP-SIGNED-V2\u0000".toByteArray(Charsets.US_ASCII)
    private val P256_ORDER = BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)

    internal fun persistReportIdentity(db: SQLiteDatabase, bytes: ByteArray, now: Long): Boolean {
      val identity = decodeReportIdentity(bytes)
      val existing = db.rawQuery(
        "SELECT report_protocol_version,payload_digest,origin_key_id,origin_public_key_der FROM receipt_report_identities WHERE report_id=? AND revision=?",
        arrayOf(identity.reportId, identity.revision.toString()),
      ).use { cursor ->
        if (!cursor.moveToFirst()) null else ReportIdentity(
          identity.reportId,
          cursor.getInt(0),
          identity.revision,
          cursor.getBlob(1),
          cursor.getBlob(2),
          cursor.getBlob(3),
        )
      }
      if (existing != null) {
        check(
          existing.reportProtocolVersion == identity.reportProtocolVersion &&
            MessageDigest.isEqual(existing.payloadDigest, identity.payloadDigest) &&
            MessageDigest.isEqual(existing.originKeyId, identity.originKeyId) &&
            MessageDigest.isEqual(existing.originPublicKeyDer, identity.originPublicKeyDer),
        ) { "report identity conflict" }
        return false
      }
      db.insertOrThrow("receipt_report_identities", null, ContentValues().apply {
        put("report_id", identity.reportId)
        put("revision", identity.revision)
        put("report_protocol_version", identity.reportProtocolVersion)
        put("payload_digest", identity.payloadDigest)
        put("origin_key_id", identity.originKeyId)
        put("origin_public_key_der", identity.originPublicKeyDer)
        put("recorded_at_ms", now)
      })
      db.execSQL(
        "INSERT INTO receipt_report_state(report_id,receipt_version) VALUES(?,1) ON CONFLICT(report_id) DO UPDATE SET receipt_version=receipt_version+1",
        arrayOf(identity.reportId),
      )
      return true
    }

    private fun decodeReportIdentity(bytes: ByteArray): ReportIdentity {
      require(bytes.size >= 4)
      return when (String(bytes.copyOfRange(0, 4), Charsets.US_ASCII)) {
        "SGP1" -> {
          val decoded = TransportEnvelopeV1.decode(bytes)
          require(TransportEnvelopeV1.verify(decoded))
          ReportIdentity(decoded.reportId, 1, decoded.revision, decoded.payloadDigest, decoded.originKeyId, decoded.originPublicKeyDer)
        }
        "SGP2" -> {
          val decoded = TransportEnvelopeV2.decode(bytes)
          require(TransportEnvelopeV2.verify(decoded))
          ReportIdentity(decoded.reportId, 2, decoded.revision, decoded.payloadDigest, decoded.originKeyId, decoded.originPublicKeyDer)
        }
        else -> throw IllegalArgumentException("unsupported envelope")
      }
    }
  }
}
