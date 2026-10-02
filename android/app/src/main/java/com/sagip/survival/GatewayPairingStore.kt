package com.sagip.survival

import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import net.zetetic.database.sqlcipher.SQLiteDatabase

/** Supplied only after root/grant verification and a fresh same-boot time projection. */
data class GatewaySessionAuthority(
  val providerId: String,
  val grantId: String,
  val grantExpiresAtMs: Long,
  val trustedTime: TimeInterval,
)
data class GatewayPairingCode(val pairingId: String, val code: String)
data class GatewaySessionSecrets(val token: String, val csrf: String)

/**
 * Durable policy only. A TLS adapter must authenticate possession of browserBinding,
 * enforce HTTP admission limits, and deliver secrets in secure same-origin cookies.
 * This store is deliberately not exposed through the native bridge or an HTTP listener.
 */
class GatewayPairingStore(
  private val database: SagipDatabase,
  private val origin: String,
  private val nativeAccess: () -> Boolean,
  private val authority: () -> GatewaySessionAuthority?,
  private val clock: () -> MonotonicClock,
  private val hasPendingWork: () -> Boolean,
) {
  private val random = SecureRandom()
  init {
    val uri = URI(origin)
    require(uri.scheme == "https" && uri.host != null && uri.host == uri.host.lowercase() &&
      uri.rawUserInfo == null && uri.rawPath.isNullOrEmpty() && uri.rawQuery == null &&
      uri.rawFragment == null && (uri.port == -1 || uri.port in 1..65535) &&
      origin == "https://${uri.host}${if (uri.port == -1) "" else ":${uri.port}"}")
  }

  fun startPairing(): GatewayPairingCode = transaction { db ->
    check(nativeAccess()) { "DEVICE_ACCESS_REQUIRED" }
    val now = checkedClock(db) ?: error("TIME_UNAVAILABLE")
    val active = activeAuthority() ?: error("AUTHORITY_UNAVAILABLE")
    // Retain denial/revocation history; fail closed rather than grow without a bound.
    check(count(db, "gateway_pairings") < MAX_HISTORY) { "PAIRING_CAPACITY" }
    val id = UUID.randomUUID().toString()
    val code = random.nextInt(100_000_000).toString().padStart(8, '0')
    val salt = bytes()
    db.execSQL("INSERT INTO gateway_pairings(pairing_id,code_salt,code_hash,provider_id,grant_id,boot_id,expires_elapsed_ms,state) VALUES(?,?,?,?,?,?,?,'OPEN')",
      arrayOf(id, salt, digest(salt + code.toByteArray(Charsets.US_ASCII)), active.providerId, active.grantId,
        now.bootId, Math.addExact(now.elapsedMs, PAIRING_MS)))
    GatewayPairingCode(id, code)
  }

  fun confirmBrowser(id: String, code: String, binding: String, requestOrigin: String): String = transaction { db ->
    if (requestOrigin != origin) return@transaction "ORIGIN_DENIED"
    if (!validBinding(binding)) return@transaction "SESSION_REQUIRED"
    if (!nativeAccess()) return@transaction "DEVICE_ACCESS_REQUIRED"
    val now = checkedClock(db) ?: return@transaction "TIME_UNAVAILABLE"
    val active = activeAuthority() ?: return@transaction "AUTHORITY_UNAVAILABLE"
    val pair = pairing(db, id) ?: return@transaction "PAIRING_EXPIRED"
    if (!pair.valid(now, active) || pair.state != "OPEN") return@transaction "PAIRING_EXPIRED"
    val matches = code.matches(Regex("[0-9]{8}")) &&
      MessageDigest.isEqual(pair.codeHash, digest(pair.salt + code.toByteArray(Charsets.US_ASCII)))
    if (!matches) {
      db.execSQL("UPDATE gateway_pairings SET attempts=attempts+1 WHERE pairing_id=?", arrayOf(id))
      return@transaction if (pair.attempts + 1 >= 5) "PAIRING_EXPIRED" else "CODE_DENIED"
    }
    db.execSQL("UPDATE gateway_pairings SET browser_binding=?,state='CONFIRMED' WHERE pairing_id=?", arrayOf(binding, id))
    "AWAITING_NATIVE_CONFIRMATION"
  }

  /** Called only after the human verifies this exact browser credential identity on Android. */
  fun approveNative(id: String, binding: String): GatewaySessionSecrets? = transaction { db ->
    if (!nativeAccess() || !validBinding(binding)) return@transaction null
    val now = checkedClock(db) ?: return@transaction null
    val active = activeAuthority() ?: return@transaction null
    val pair = pairing(db, id) ?: return@transaction null
    if (!pair.valid(now, active) || pair.state != "CONFIRMED" || pair.binding != binding) return@transaction null
    if (count(db, "gateway_browser_sessions") >= MAX_HISTORY) return@transaction null
    val live = db.rawQuery("SELECT COUNT(*) FROM gateway_browser_sessions WHERE revoked=0 AND boot_id=? AND provider_id=? AND grant_id=? AND expires_elapsed_ms>?",
      arrayOf(now.bootId, active.providerId, active.grantId, now.elapsedMs.toString())).use { it.moveToFirst(); it.getInt(0) }
    if (live >= MAX_SESSIONS) return@transaction null
    val lifetime = minOf(SESSION_MS, active.grantExpiresAtMs - active.trustedTime.latestMs)
    val token = hex(bytes()); val csrf = hex(bytes())
    db.execSQL("INSERT INTO gateway_browser_sessions(token_hash,csrf_hash,browser_binding,provider_id,grant_id,boot_id,expires_elapsed_ms,window_elapsed_ms) VALUES(?,?,?,?,?,?,?,?)",
      arrayOf(hashSecret(token), hashSecret(csrf), binding, active.providerId, active.grantId, now.bootId,
        Math.addExact(now.elapsedMs, lifetime), now.elapsedMs))
    db.execSQL("UPDATE gateway_pairings SET state='ISSUED' WHERE pairing_id=?", arrayOf(id))
    GatewaySessionSecrets(token, csrf)
  }

  fun authorize(token: String, csrf: String, binding: String, requestOrigin: String, action: Boolean = false): String =
    transaction { db -> authorizeInTransaction(db, token, csrf, binding, requestOrigin, action) }

  fun logout(token: String, csrf: String, binding: String, requestOrigin: String): String = transaction { db ->
    val result = authorizeInTransaction(db, token, csrf, binding, requestOrigin, false)
    if (result != "AUTHORIZED") return@transaction result
    if (hasPendingWork()) return@transaction "BLOCKED_PENDING_ACTIONS"
    db.execSQL("UPDATE gateway_browser_sessions SET revoked=1 WHERE hex(token_hash)=?", arrayOf(hex(hashSecret(token)).uppercase()))
    "COMPLETE"
  }

  private fun authorizeInTransaction(db: SQLiteDatabase, token: String, csrf: String, binding: String, requestOrigin: String, action: Boolean): String {
    if (requestOrigin != origin) return "ORIGIN_DENIED"
    if (!nativeAccess()) return "DEVICE_ACCESS_REQUIRED"
    val now = checkedClock(db) ?: return "TIME_UNAVAILABLE"
    val active = activeAuthority() ?: return "AUTHORITY_UNAVAILABLE"
    if (!validBinding(binding) || !validBinding(token)) return "SESSION_REQUIRED"
    val session = session(db, token) ?: return "SESSION_REQUIRED"
    if (session.binding != binding) return "SESSION_REQUIRED"
    if (session.revoked || session.bootId != now.bootId || now.elapsedMs >= session.expires ||
      session.provider != active.providerId || session.grant != active.grantId) return "SESSION_EXPIRED"
    if (!validBinding(csrf) || !MessageDigest.isEqual(session.csrfHash, hashSecret(csrf))) return "CSRF_DENIED"
    if (action) {
      val reset = now.elapsedMs - session.window >= RATE_WINDOW_MS
      if (!reset && session.count >= 60) return "RATE_LIMITED"
      db.execSQL("UPDATE gateway_browser_sessions SET window_elapsed_ms=?,action_count=? WHERE hex(token_hash)=?",
        arrayOf(if (reset) now.elapsedMs else session.window, if (reset) 1 else session.count + 1, hex(hashSecret(token)).uppercase()))
    }
    return "AUTHORIZED"
  }

  private fun activeAuthority(): GatewaySessionAuthority? = authority()?.takeIf {
    validBinding(it.providerId) && runCatching { UUID.fromString(it.grantId).toString() == it.grantId }.getOrDefault(false) &&
      it.trustedTime.earliestMs >= 0 && it.trustedTime.latestMs >= it.trustedTime.earliestMs &&
      it.grantExpiresAtMs > it.trustedTime.latestMs
  }

  private fun checkedClock(db: SQLiteDatabase): MonotonicClock? {
    val now = clock()
    if (now.bootId.isEmpty() || now.elapsedMs < 0) return null
    val previous = db.rawQuery("SELECT boot_id,high_water_elapsed_ms FROM gateway_pairing_clock WHERE singleton=1", null).use {
      if (it.moveToFirst()) it.getString(0) to it.getLong(1) else null
    }
    if (previous != null && previous.first == now.bootId && now.elapsedMs < previous.second) return null
    db.execSQL("INSERT OR REPLACE INTO gateway_pairing_clock(singleton,boot_id,high_water_elapsed_ms) VALUES(1,?,?)", arrayOf(now.bootId, now.elapsedMs))
    return now
  }

  private data class Pairing(val salt: ByteArray, val codeHash: ByteArray, val provider: String, val grant: String,
    val boot: String, val expires: Long, val attempts: Int, val binding: String?, val state: String) {
    fun valid(now: MonotonicClock, active: GatewaySessionAuthority) = attempts < 5 && boot == now.bootId &&
      now.elapsedMs < expires && provider == active.providerId && grant == active.grantId
  }
  private fun pairing(db: SQLiteDatabase, id: String): Pairing? = db.rawQuery(
    "SELECT code_salt,code_hash,provider_id,grant_id,boot_id,expires_elapsed_ms,attempts,browser_binding,state FROM gateway_pairings WHERE pairing_id=?", arrayOf(id)).use {
    if (!it.moveToFirst()) null else Pairing(it.getBlob(0), it.getBlob(1), it.getString(2), it.getString(3), it.getString(4),
      it.getLong(5), it.getInt(6), if (it.isNull(7)) null else it.getString(7), it.getString(8))
  }
  private data class Session(val csrfHash: ByteArray, val binding: String, val provider: String, val grant: String,
    val bootId: String, val expires: Long, val revoked: Boolean, val window: Long, val count: Int)
  private fun session(db: SQLiteDatabase, token: String): Session? = db.rawQuery(
    "SELECT csrf_hash,browser_binding,provider_id,grant_id,boot_id,expires_elapsed_ms,revoked,window_elapsed_ms,action_count FROM gateway_browser_sessions WHERE hex(token_hash)=?",
    arrayOf(hex(hashSecret(token)).uppercase())).use {
    if (!it.moveToFirst()) null else Session(it.getBlob(0), it.getString(1), it.getString(2), it.getString(3), it.getString(4),
      it.getLong(5), it.getInt(6) != 0, it.getLong(7), it.getInt(8))
  }
  private fun <T> transaction(block: (SQLiteDatabase) -> T): T {
    val db = database.writableDatabase
    db.beginTransaction()
    try { val result = block(db); db.setTransactionSuccessful(); return result }
    finally { db.endTransaction() }
  }
  private fun count(db: SQLiteDatabase, table: String) = db.rawQuery("SELECT COUNT(*) FROM $table", null).use { it.moveToFirst(); it.getInt(0) }
  private fun bytes() = ByteArray(32).also(random::nextBytes)
  private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
  private fun hashSecret(secret: String) = digest(secret.toByteArray(Charsets.US_ASCII))
  private fun validBinding(value: String) = value.matches(Regex("[0-9a-f]{64}"))
  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }

  companion object {
    private const val PAIRING_MS = 300_000L
    private const val SESSION_MS = 43_200_000L
    private const val RATE_WINDOW_MS = 60_000L
    private const val MAX_SESSIONS = 8
    private const val MAX_HISTORY = 1024
  }
}
