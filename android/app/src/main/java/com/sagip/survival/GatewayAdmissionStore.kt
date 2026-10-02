package com.sagip.survival

import java.security.MessageDigest
import net.zetetic.database.sqlcipher.SQLiteDatabase

data class GatewayAdmissionResult(val outcome: String, val retryAfterMs: Long = 0)

/**
 * Shared unauthenticated pairing/time-challenge budget. The future HTTPS adapter must
 * call this before expensive parsing/crypto, passing InetAddress.address from the socket.
 * Headers, source ports, browser IDs and route names must never create fresh budgets.
 * This policy does not replace connection/thread/body/deadline limits or authorize access.
 */
class GatewayAdmissionStore(private val database: SagipDatabase, private val clock: () -> MonotonicClock) {
  fun admit(socketAddress: ByteArray): GatewayAdmissionResult {
    val address = canonicalAddress(socketAddress) ?: return GatewayAdmissionResult("INVALID_SOURCE")
    val sourceHash = MessageDigest.getInstance("SHA-256").digest(address)
      .joinToString("") { "%02x".format(it.toInt() and 255) }
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      val result = admitInTransaction(db, sourceHash)
      db.setTransactionSuccessful()
      return result
    } finally { db.endTransaction() }
  }

  private fun admitInTransaction(db: SQLiteDatabase, sourceHash: String): GatewayAdmissionResult {
    val now = GatewayPolicyClock.read(db, clock()) ?: return GatewayAdmissionResult("TIME_UNAVAILABLE")
    val old = db.rawQuery("SELECT boot_id,window_elapsed_ms,request_count FROM gateway_admission_global WHERE singleton=1", null).use {
      if (it.moveToFirst()) Triple(it.getString(0), it.getLong(1), it.getInt(2)) else null
    }
    if (old == null || old.first != now.bootId) db.execSQL("DELETE FROM gateway_admission_sources")
    // Only expired rate state is removed; pairing/session/intent evidence is untouched.
    if (now.elapsedMs >= WINDOW_MS) db.execSQL("DELETE FROM gateway_admission_sources WHERE window_elapsed_ms<=?", arrayOf(now.elapsedMs - WINDOW_MS))
    val reset = old == null || old.first != now.bootId || now.elapsedMs - old.second >= WINDOW_MS
    val globalWindow = if (reset) now.elapsedMs else old!!.second
    val globalCount = if (reset) 0 else old!!.third
    if (globalCount >= GLOBAL_LIMIT) return GatewayAdmissionResult("RATE_LIMITED", remaining(now.elapsedMs, globalWindow))
    // Every valid attempt consumes the global quota, including a source-level denial.
    db.execSQL("INSERT OR REPLACE INTO gateway_admission_global(singleton,boot_id,window_elapsed_ms,request_count) VALUES(1,?,?,?)",
      arrayOf(now.bootId, globalWindow, globalCount + 1))
    val source = db.rawQuery("SELECT window_elapsed_ms,request_count FROM gateway_admission_sources WHERE source_hash=?", arrayOf(sourceHash)).use {
      if (it.moveToFirst()) it.getLong(0) to it.getInt(1) else null
    }
    if (source != null && source.second >= SOURCE_LIMIT) return GatewayAdmissionResult("RATE_LIMITED", remaining(now.elapsedMs, source.first))
    if (source == null) {
      val count = db.rawQuery("SELECT COUNT(*) FROM gateway_admission_sources", null).use { it.moveToFirst(); it.getInt(0) }
      if (count >= MAX_SOURCES) return GatewayAdmissionResult("CAPACITY", WINDOW_MS)
    }
    db.execSQL("INSERT OR REPLACE INTO gateway_admission_sources(source_hash,window_elapsed_ms,request_count) VALUES(?,?,?)",
      arrayOf(sourceHash, source?.first ?: now.elapsedMs, (source?.second ?: 0) + 1))
    return GatewayAdmissionResult("ADMITTED")
  }

  private fun remaining(elapsed: Long, window: Long) = WINDOW_MS - (elapsed - window)
  private fun canonicalAddress(address: ByteArray): ByteArray? {
    if (address.size == 4) return address.copyOf()
    if (address.size != 16) return null
    if ((0..9).all { address[it] == 0.toByte() } && address[10] == (-1).toByte() && address[11] == (-1).toByte())
      return address.copyOfRange(12, 16)
    return address.copyOf()
  }

  companion object {
    private const val WINDOW_MS = 60_000L
    private const val SOURCE_LIMIT = 10
    private const val GLOBAL_LIMIT = 60
    // Accommodates two adjacent global windows without keeping unbounded address history.
    private const val MAX_SOURCES = 128
  }
}
