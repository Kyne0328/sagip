package com.sagip.survival

import android.content.ContentValues
import net.zetetic.database.sqlcipher.SQLiteDatabase

data class VictimHistoryEvent(
  val id: String, val kind: String, val occurredAt: Long, val revision: Int?,
  val status: String? = null, val provenance: String = "LOCAL",
  val callsign: String? = null, val note: String? = null,
)
data class VictimSyncState(val lastAttemptAt: Long?, val lastSuccessAt: Long?, val state: String, val historyPending: Boolean)
data class VictimServerStatus(val status: String, val updatedAt: Long, val callsign: String?, val note: String?)

/** The SQLCipher journal is authoritative even when JavaScript and the process disappear. */
class VictimStatusStore(private val database: SagipDatabase) {
  fun cursor(reportId: String): String? = database.readableDatabase.rawQuery(
    "SELECT cursor FROM victim_status_sync WHERE report_id=?", arrayOf(reportId),
  ).use { c -> if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null }

  fun due(now: Long, limit: Int = 5): List<String> {
    val db = database.readableDatabase
    return db.rawQuery("""
      SELECT r.report_id, MAX(rr.revision), s.cursor, s.last_success_at
      FROM reports r JOIN report_revisions rr ON rr.report_id=r.report_id
      LEFT JOIN victim_status_sync s ON s.report_id=r.report_id
      WHERE COALESCE(s.next_attempt_at,0)<=?
        AND EXISTS (SELECT 1 FROM outbound_envelopes o
          WHERE o.report_id=r.report_id AND o.preparation_state='READY')
      GROUP BY r.report_id ORDER BY COALESCE(s.next_attempt_at,0),r.created_at,r.report_id
    """.trimIndent(), arrayOf(now.toString())).use { c ->
      buildList {
        while (c.moveToNext() && size < limit) {
          if (c.isNull(3) || !c.isNull(2) || !isResolved(db, c.getString(0), c.getInt(1))) add(c.getString(0))
        }
      }
    }
  }

  fun failed(reportId: String, now: Long) {
    database.writableDatabase.execSQL("""
      INSERT INTO victim_status_sync(report_id,last_attempt_at,next_attempt_at,state) VALUES(?,?,?,'FAILED')
      ON CONFLICT(report_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,
        next_attempt_at=excluded.next_attempt_at,state='FAILED'
    """.trimIndent(), arrayOf<Any?>(reportId, now, now + 30_000))
  }

  fun record(page: PrivateStatusPage, now: Long) {
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      val previous = db.rawQuery("SELECT server_checked_at FROM victim_status_sync WHERE report_id=?",
        arrayOf(page.reportId)).use { c -> if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null }
      check(previous == null || page.checkedAt >= previous) { "Stale server status response" }
      for (ack in (page.acknowledgements + listOfNotNull(page.latestAck)).distinctBy { it.ackId }) {
        check(ack.reportId == page.reportId)
        val existing = db.rawQuery("""
          SELECT status,acknowledged_at,callsign,note FROM victim_server_acks WHERE report_id=? AND ack_id=?
        """.trimIndent(), arrayOf(page.reportId, ack.ackId)).use { c ->
          if (!c.moveToFirst()) false else {
            check(c.getString(0) == ack.status && c.getLong(1) == ack.acknowledgedAt &&
              (if(c.isNull(3)) null else c.getString(3)) == ack.note) { "Server event identity conflict" }
            true
          }
        }
        if (!existing) db.insertOrThrow("victim_server_acks", null, ContentValues().apply {
          put("report_id", page.reportId); put("ack_id", ack.ackId); put("callsign", ack.callsign)
          put("status", ack.status); put("note", ack.note); put("acknowledged_at", ack.acknowledgedAt)
          put("received_at", now)
        })
      }
      db.execSQL("""
        INSERT INTO victim_status_sync(report_id,last_attempt_at,last_success_at,next_attempt_at,state,cursor,server_checked_at,current_revision)
        VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(report_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,
          last_success_at=COALESCE(excluded.last_success_at,victim_status_sync.last_success_at),next_attempt_at=excluded.next_attempt_at,
          state=CASE WHEN excluded.cursor IS NULL THEN 'SUCCESS' ELSE victim_status_sync.state END,
          cursor=excluded.cursor,server_checked_at=excluded.server_checked_at,current_revision=excluded.current_revision
      """.trimIndent(), arrayOf<Any?>(page.reportId, now, if(page.nextCursor == null) now else null, now + 30_000,
        if(page.nextCursor == null) "SUCCESS" else "NEVER", page.nextCursor, page.checkedAt, page.currentRevision))
      db.setTransactionSuccessful()
    } finally { db.endTransaction() }
  }

  fun syncState(reportId: String): VictimSyncState = database.readableDatabase.rawQuery(
    "SELECT last_attempt_at,last_success_at,state,cursor FROM victim_status_sync WHERE report_id=?", arrayOf(reportId),
  ).use { c ->
    if (!c.moveToFirst()) VictimSyncState(null,null,"NEVER",true) else
      VictimSyncState(if(c.isNull(0)) null else c.getLong(0),if(c.isNull(1)) null else c.getLong(1),c.getString(2),c.isNull(1) || !c.isNull(3))
  }

  fun providerConflict(reportId: String, revision: Int): Boolean = providerConflict(database.readableDatabase, reportId, revision)

  fun serverStatus(reportId: String): VictimServerStatus? = serverStatus(database.readableDatabase, reportId)
  fun serverResolutionConfirmed(reportId: String, revision: Int): Boolean =
    !providerConflict(database.readableDatabase, reportId, revision) &&
      serverResolutionConfirmed(database.readableDatabase, reportId, revision)

  fun history(reportId: String): List<VictimHistoryEvent> {
    val db = database.readableDatabase
    val events = mutableListOf<VictimHistoryEvent>()
    db.rawQuery("""
      SELECT e.event_id,e.event_type,e.occurred_at,o.revision,rr.message
      FROM delivery_events e JOIN outbound_envelopes o ON o.message_id=e.message_id
      JOIN report_revisions rr ON rr.report_id=o.report_id AND rr.revision=o.revision
      WHERE e.report_id=? AND e.event_type IN ('LOCAL_COMMIT','SERVER_ACCEPTED','RELAYED_TO_PEER','DELIVERY_FAILED')
    """.trimIndent(), arrayOf(reportId)).use { c -> while(c.moveToNext()) {
      val details = c.getString(1) == "LOCAL_COMMIT" && c.getInt(3) > 1
      events += VictimHistoryEvent("delivery:" + c.getString(0), if(details) "DETAILS_SAVED" else c.getString(1),
        c.getLong(2),c.getInt(3),note=if(details && !c.isNull(4)) c.getString(4) else null)
    } }
    db.rawQuery("""
      SELECT ack_id,status,acknowledged_at,callsign,note FROM responder_acks a WHERE report_id=?
        AND NOT EXISTS(SELECT 1 FROM victim_server_acks s WHERE s.report_id=a.report_id AND s.ack_id=a.ack_id)
    """.trimIndent(), arrayOf(reportId)).use { c -> while(c.moveToNext()) {
      events += VictimHistoryEvent("legacy:" + c.getString(0),"RESPONDER_UPDATE",c.getLong(2),null,
        c.getString(1),"UNVERIFIED",if(c.isNull(3)) null else c.getString(3),if(c.isNull(4)) null else c.getString(4))
    } }
    db.rawQuery("SELECT ack_id,status,acknowledged_at,callsign,note FROM victim_server_acks WHERE report_id=?",
      arrayOf(reportId)).use { c -> while(c.moveToNext()) {
      events += VictimHistoryEvent("server:" + c.getString(0),"RESPONDER_UPDATE",c.getLong(2),null,
        c.getString(1),"SERVER_AUTHENTICATED",if(c.isNull(3)) null else c.getString(3),if(c.isNull(4)) null else c.getString(4))
    } }
    db.rawQuery("""
      SELECT event_id,object_bytes,revision,verification_kind,received_at_ms FROM receipt_records
      WHERE report_id=? AND object_kind='RESPONDER'
        AND verification_kind IN ('VERIFIED_CURRENT','VERIFIED_OFFLINE_AUTHORITY','VERIFIED_OFFLINE_ROOT_SNAPSHOT')
    """.trimIndent(), arrayOf(reportId)).use { c -> while(c.moveToNext()) {
      val f = runCatching { ReceiptV2Codec.decode(c.getBlob(1)).fields as? ReceiptFields.Responder }.getOrNull() ?: continue
      if(f.reportId != reportId || f.actionId != c.getString(0) || f.revision != c.getInt(2)) continue
      events += VictimHistoryEvent("receipt:" + f.actionId,"RESPONDER_UPDATE",f.issuedAtMs,f.revision,
        statusName(f.status),c.getString(3),f.callsign,f.note)
    } }
    return events.sortedWith(compareBy<VictimHistoryEvent> { it.occurredAt }.thenBy { it.id })
  }

  companion object {
    private const val SERVER_ORDER = "CASE status WHEN 'RESOLVED' THEN 4 WHEN 'ON_SCENE' THEN 3 WHEN 'EN_ROUTE' THEN 2 ELSE 1 END DESC, acknowledged_at DESC, ack_id DESC"
    internal fun serverStatus(db: SQLiteDatabase, reportId: String): VictimServerStatus? = db.rawQuery(
      "SELECT status,acknowledged_at,callsign,note FROM victim_server_acks WHERE report_id=? ORDER BY $SERVER_ORDER LIMIT 1",
      arrayOf(reportId),
    ).use { c -> if(!c.moveToFirst()) null else VictimServerStatus(c.getString(0),c.getLong(1),
      if(c.isNull(2)) null else c.getString(2),if(c.isNull(3)) null else c.getString(3)) }

    private fun currentProviderStatuses(db: SQLiteDatabase, reportId: String, revision: Int): List<Int> =
      db.rawQuery("""
        SELECT p.event_id,p.sequence,r.object_bytes,p.issuer_provider_id
        FROM receipt_projections p JOIN receipt_records r ON r.event_id=p.event_id
        WHERE p.report_id=? AND p.revision=?
          AND p.verification_kind IN ('VERIFIED_CURRENT','VERIFIED_OFFLINE_AUTHORITY','VERIFIED_OFFLINE_ROOT_SNAPSHOT')
          AND r.verification_kind IN ('VERIFIED_CURRENT','VERIFIED_OFFLINE_AUTHORITY','VERIFIED_OFFLINE_ROOT_SNAPSHOT')
      """.trimIndent(), arrayOf(reportId, revision.toString())).use { c ->
        if (!ReceiptRepository.hasConsistentReportOrigin(db, reportId)) return emptyList()
        buildList {
          while (c.moveToNext()) {
            val f = runCatching { ReceiptV2Codec.decode(c.getBlob(2)).fields as? ReceiptFields.Responder }.getOrNull() ?: continue
            if (f.reportId == reportId && f.revision == revision && f.actionId == c.getString(0) &&
              f.sequence == c.getLong(1) && java.security.MessageDigest.isEqual(f.issuerProviderId, c.getBlob(3))) add(f.status)
          }
        }
      }

    internal fun providerConflict(db: SQLiteDatabase, reportId: String, revision: Int): Boolean {
      if (ReceiptRepository.hasConflictingReportOrigins(db, reportId)) return true
      val statuses = currentProviderStatuses(db, reportId, revision).toMutableList()
      serverStatus(db, reportId)?.let { server ->
        statuses += if (server.status == "RESOLVED") 4 else 1
      }
      return statuses.any { it == 4 } && statuses.any { it in 1..3 }
    }

    internal fun serverResolutionConfirmed(db: SQLiteDatabase, reportId: String, revision: Int): Boolean {
      val observation=db.rawQuery("""
        SELECT a.ack_id,a.status,s.current_revision,s.server_checked_at,s.state,s.cursor,s.last_success_at
        FROM victim_status_sync s JOIN victim_server_acks a ON a.report_id=s.report_id
        WHERE s.report_id=? ORDER BY $SERVER_ORDER LIMIT 1
      """.trimIndent(),arrayOf(reportId)).use { c ->
        if(!c.moveToFirst() || c.isNull(2) || c.isNull(3) || c.isNull(6) ||
          c.getString(4)!="SUCCESS" || !c.isNull(5)) return false
        Triple(c.getString(0) to c.getString(1),c.getInt(2),c.getLong(3))
      }
      return db.rawQuery("""
        SELECT p.event_id,p.sequence,p.issuer_provider_id,r.object_bytes
        FROM receipt_projections p JOIN receipt_records r ON r.event_id=p.event_id
        WHERE p.report_id=? AND p.revision=?
          AND p.verification_kind='VERIFIED_OFFLINE_ROOT_SNAPSHOT'
          AND r.verification_kind='VERIFIED_OFFLINE_ROOT_SNAPSHOT'
      """.trimIndent(),arrayOf(reportId,revision.toString())).use { c ->
        if(!ReceiptRepository.hasConsistentReportOrigin(db,reportId)) return false
        while(c.moveToNext()) {
          val fields=runCatching {ReceiptV2Codec.decode(c.getBlob(3)).fields as? ReceiptFields.Responder}.getOrNull() ?: continue
          if(fields.actionId!=c.getString(0) || fields.sequence!=c.getLong(1) ||
            !java.security.MessageDigest.isEqual(fields.issuerProviderId,c.getBlob(2))) continue
          if(ServerResolutionConfirmation.matches(reportId,revision,observation.first.first,
              observation.first.second,observation.second,observation.third,true,fields)) return true
        }
        false
      }
    }

    internal fun isResolved(db: SQLiteDatabase, reportId: String, revision: Int): Boolean {
      // Independent provider streams have no shared ordering or implicit supersession.
      if (providerConflict(db, reportId, revision)) return false
      // A matching live server observation is closure evidence distinct from the saved snapshot.
      if (serverResolutionConfirmed(db, reportId, revision)) return true
      // Offline snapshots and unmatched/cached server rows alone still cannot authorize closure.
      if(db.rawQuery("SELECT 1 FROM receipt_projections WHERE report_id=? AND revision=? AND verification_kind='VERIFIED_OFFLINE_ROOT_SNAPSHOT' LIMIT 1",
        arrayOf(reportId,revision.toString())).use { it.moveToFirst() }) return false
      if (serverStatus(db, reportId)?.status == "RESOLVED") return true
      return currentProviderStatuses(db, reportId, revision).any { it == 4 }
    }
    internal fun statusName(status: Int) = when(status) {
      1 -> "ACKNOWLEDGED"; 2 -> "EN_ROUTE"; 3 -> "ON_SCENE"; 4 -> "RESOLVED"; else -> "UNKNOWN"
    }
  }
}

class VictimStatusWorker(
  private val store: VictimStatusStore,
  private val sender: PrivateReportStatusSender,
  private val clock: () -> Long = System::currentTimeMillis,
) {
  suspend fun runOnce(now: Long = clock()) {
    for (reportId in store.due(now)) {
      try {
        var cursor = store.cursor(reportId)
        val seen = mutableSetOf<String?>()
        for (pageNumber in 1..5) {
          check(seen.add(cursor)) { "Status pagination cycle" }
          val page = sender.fetchPrivateReportStatus(reportId,cursor)
          check(page.reportId == reportId)
          store.record(page,clock())
          cursor = page.nextCursor
          if(cursor == null) break
        }
      } catch (_: Exception) { store.failed(reportId,clock()) }
    }
  }
}
