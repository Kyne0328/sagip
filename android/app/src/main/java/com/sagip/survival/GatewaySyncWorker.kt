package com.sagip.survival

import java.security.MessageDigest
import java.util.UUID

data class GatewayCloudResult(val state: String, val eventId: String? = null,
  val issuerProviderId: String? = null, val eventDigest: String? = null, val reason: String? = null)
/** Deployment supplies an authenticated bounded transport. No production cloud endpoint is inferred. */
fun interface GatewayReceiptTransport { fun importOriginal(bytes: ByteArray): GatewayCloudResult }
data class SyncBatchResult(val committed: Int = 0, val unknown: Int = 0, val retryable: Int = 0,
  val rejected: Int = 0, val enabled: Boolean = false)

/** Transport supplier returns the currently registered stable instance, not a transport factory. */
class GatewaySyncWorker(private val database: SagipDatabase, private val transport: () -> GatewayReceiptTransport?,
  private val qualified: () -> Boolean = { true },
  private val leaseClock: () -> MonotonicClock = { MonotonicClock(PROCESS_SESSION,android.os.SystemClock.elapsedRealtime()) }) {
  private data class Attempt(val id: String,val provider: String,val digest: String,val bytes: ByteArray,val token: String,val number: Int,val boot: String,val started: Long)
  fun runOnce(nowMs: Long): SyncBatchResult {
    require(nowMs>=0 && nowMs <= Long.MAX_VALUE-300000L)
    if(!runCatching(qualified).getOrDefault(false)) return SyncBatchResult()
    val sender=transport() ?: return SyncBatchResult()
    enqueue()
    var committed=0;var unknown=0;var retryable=0;var rejected=0
    repeat(16) {
      if (!currentSender(sender)) return SyncBatchResult(committed,unknown,retryable,rejected,false)
      val attempt=claim(leaseClock()) ?: return SyncBatchResult(committed,unknown,retryable,rejected,true)
      if (!currentSender(sender)) {
        database.writableDatabase.execSQL(
          "UPDATE gateway_sync SET lease_token=NULL,lease_until_ms=NULL,next_attempt_ms=0,last_reason='PRE_SEND_POLICY_CHANGED' WHERE event_id=? AND lease_token=?",
          arrayOf(attempt.id,attempt.token),
        )
        return SyncBatchResult(committed,unknown,retryable,rejected,false)
      }
      val result=try { sender.importOriginal(attempt.bytes.copyOf()) } catch (_: Exception) { GatewayCloudResult("UNKNOWN",reason="TRANSPORT_OUTCOME_UNKNOWN") }
      val exact=result.eventId==attempt.id && result.issuerProviderId==attempt.provider && result.eventDigest==attempt.digest
      val state=when {
        result.state in setOf("IMPORTED","DUPLICATE") && exact -> "COMMITTED"
        result.state in setOf("REJECTED","QUARANTINED") && exact -> "REJECTED"
        result.state=="RETRYABLE" -> "RETRYABLE"
        else -> "UNKNOWN"
      }
      val db=database.writableDatabase
      val finished=leaseClock()
      val live=finished.bootId==attempt.boot && finished.elapsedMs>=attempt.started && finished.elapsedMs<attempt.started+60000L
      db.beginTransaction()
      try {
        // A stalled/crashed worker cannot complete a newer worker's persisted lease.
        val valid=db.rawQuery("SELECT 1 FROM gateway_sync WHERE event_id=? AND lease_token=?",arrayOf(attempt.id,attempt.token)).use { it.moveToFirst() }
        if(valid) {
          val backoff=minOf(300000L,1000L shl minOf(attempt.number,8))
          val completion=if(live) state else "UNKNOWN"
          db.execSQL("UPDATE gateway_sync SET state=?,next_attempt_ms=?,clock_boot_id=?,lease_token=NULL,lease_until_ms=NULL,last_reason=? WHERE event_id=? AND lease_token=?",arrayOf(completion,finished.elapsedMs+backoff,finished.bootId,reason(result.reason),attempt.id,attempt.token))
          when(completion) { "COMMITTED" -> committed++;"REJECTED" -> rejected++;"RETRYABLE" -> retryable++;else -> unknown++ }
        } else unknown++
        db.setTransactionSuccessful()
      } finally { db.endTransaction() }
    }
    return SyncBatchResult(committed,unknown,retryable,rejected,true)
  }
  private fun enqueue() {
    val db=database.writableDatabase
    db.beginTransaction()
    try {
      val budget=db.rawQuery("SELECT count(*),coalesce(sum(length(object_bytes)),0) FROM gateway_sync",null).use { it.moveToFirst();Pair(it.getInt(0),it.getLong(1)) }
      var count=budget.first;var bytes=budget.second
      db.rawQuery("SELECT r.event_id,r.object_bytes FROM receipt_records r LEFT JOIN gateway_sync s ON s.event_id=r.event_id WHERE s.event_id IS NULL ORDER BY r.received_at_ms,r.event_id",null).use { c ->
        var enqueued=0
        while(c.moveToNext()) {
          val owned=c.getBlob(1);val fields=ReceiptV2Codec.decode(owned).fields
          val provider=when(fields) {
            is ReceiptFields.Responder -> hex(fields.issuerProviderId)
            is ReceiptFields.Requester -> ReceiptRepository(database).getReceipt(fields.ackEventId)?.let { (ReceiptV2Codec.decode(it).fields as? ReceiptFields.Responder)?.issuerProviderId?.let(::hex) }
            else -> null
          } ?: continue
          if(count>=10000 || bytes+owned.size>64L*1024*1024) break
          db.execSQL("INSERT INTO gateway_sync(event_id,provider_id,event_digest,object_bytes,state) VALUES(?,?,?,?,'PENDING')",arrayOf(c.getString(0),provider,hex(MessageDigest.getInstance("SHA-256").digest(owned)),owned))
          count++;bytes+=owned.size
          if(++enqueued>=16) break
        }
      }
      db.setTransactionSuccessful()
    } finally { db.endTransaction() }
  }
  private fun claim(clock: MonotonicClock): Attempt? {
    val now=clock.elapsedMs
    val db=database.writableDatabase
    db.beginTransaction()
    try {
      val row=db.rawQuery("SELECT event_id,provider_id,event_digest,object_bytes,attempt_count FROM gateway_sync WHERE state IN ('PENDING','UNKNOWN','RETRYABLE') AND (clock_boot_id IS NULL OR clock_boot_id!=? OR (next_attempt_ms<=? AND (lease_until_ms IS NULL OR lease_until_ms<=?))) ORDER BY next_attempt_ms,event_id LIMIT 1",arrayOf(clock.bootId,now.toString(),now.toString())).use { c ->
        if(!c.moveToFirst()) null else Attempt(c.getString(0),c.getString(1),c.getString(2),c.getBlob(3),UUID.randomUUID().toString(),minOf(c.getInt(4)+1,1_000_000),clock.bootId,now)
      }
      if(row!=null) db.execSQL("UPDATE gateway_sync SET lease_token=?,lease_until_ms=?,clock_boot_id=?,attempt_count=?,state='UNKNOWN' WHERE event_id=?",arrayOf(row.token,now+60000L,clock.bootId,row.number,row.id))
      db.setTransactionSuccessful();return row
    } finally { db.endTransaction() }
  }
  // Store diagnostic codes only, never arbitrary transport text or payload/certificates/credentials.
  private fun reason(s: String?)=s?.takeIf { it.matches(Regex("[A-Z0-9_]{1,64}")) } ?: "TRANSPORT_OUTCOME_UNKNOWN"
  private fun currentSender(sender: GatewayReceiptTransport) = runCatching { qualified() && transport() === sender }.getOrDefault(false)
  private fun hex(b: ByteArray)=b.joinToString("") { "%02x".format(it.toInt() and 255) }
  companion object { private val PROCESS_SESSION=UUID.randomUUID().toString() }
}
