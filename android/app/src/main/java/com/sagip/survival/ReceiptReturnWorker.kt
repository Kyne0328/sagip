package com.sagip.survival

import android.util.Base64
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.util.UUID

data class ReceiptReturnEntry(val eventId: String, val eventDigest: String, val bytes: ByteArray)
data class ReceiptReturnPage(val entries: List<ReceiptReturnEntry>, val nextCursor: String?)
fun interface ReceiptReturnTransport { fun fetch(reportId: String, cursor: String?): ReceiptReturnPage }
/** sourceId must change when the authenticated account or endpoint changes. Reports need explicit enrollment. */
data class ReceiptReturnFeedConfig(val sourceId: String, val reportIds: Set<String>, val transport: ReceiptReturnTransport)
data class ReceiptReturnBatch(val enabled: Boolean = false, val stored: Int = 0, val pending: Int = 0, val retryable: Int = 0)

/** HTTPS/system trust only; no redirects, credential persistence, root installation, or authority inference. */
class HttpReceiptReturnTransport(baseUrl: String, private val token: () -> String) : ReceiptReturnTransport {
  private val base = URI(baseUrl).also {
    require(it.scheme == "https" && it.host != null && it.rawUserInfo == null && it.rawQuery == null && it.rawFragment == null)
    require(it.rawPath.isNullOrEmpty() || it.rawPath == "/")
  }.toString().trimEnd('/')
  override fun fetch(reportId: String, cursor: String?): ReceiptReturnPage {
    require(UUID.fromString(reportId).toString() == reportId)
    require(cursor == null || cursor.matches(HEX))
    val auth = token()
    require(auth.length in 1..512 && auth.all { it.code in 33..126 })
    val endpoint = URI(base + "/v2/responder/reports/" + reportId + "/receipts" +
      (cursor?.let { "?cursor=" + it } ?: "")).toURL()
    val connection = endpoint.openConnection() as HttpURLConnection
    try {
      connection.instanceFollowRedirects = false
      connection.connectTimeout = 10_000
      connection.readTimeout = 10_000
      connection.requestMethod = "GET"
      connection.setRequestProperty("Authorization", "Bearer " + auth)
      connection.setRequestProperty("Accept", "application/json")
      connection.setRequestProperty("Accept-Encoding", "identity")
      check(connection.responseCode == 200) { "RECEIPT_FEED_UNAVAILABLE" }
      require(connection.contentLengthLong <= MAX_PAGE_BYTES)
      val raw = connection.inputStream.use { it.readBytesBounded(MAX_PAGE_BYTES) }
      return decodePage(raw, cursor)
    } finally { connection.disconnect() }
  }
  internal fun decodePage(raw: ByteArray, cursor: String? = null): ReceiptReturnPage {
    require(raw.size <= MAX_PAGE_BYTES)
    val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
      val page = JSONObject(decoder.decode(java.nio.ByteBuffer.wrap(raw)).toString())
      require(page.keys().asSequence().toSet() == setOf("entries", "nextCursor"))
      val entries = page.getJSONArray("entries")
      require(entries.length() <= 32)
      val parsed = (0 until entries.length()).map { index ->
        val row = entries.getJSONObject(index)
        require(row.keys().asSequence().toSet() == setOf("eventId", "eventDigest", "bytesBase64"))
        val id = row.getString("eventId"); val digest = row.getString("eventDigest")
        require(UUID.fromString(id).toString() == id && digest.matches(HEX))
        val encoded = row.getString("bytesBase64")
        require(encoded.length <= 10_924)
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        require(bytes.size in 1..ReceiptV2Codec.MAX_RECEIPT_BYTES && Base64.encodeToString(bytes, Base64.NO_WRAP) == encoded)
        ReceiptReturnEntry(id, digest, bytes)
      }
      require(parsed.map { it.eventId }.toSet().size == parsed.size)
      val next = if (page.isNull("nextCursor")) null else page.getString("nextCursor").also { require(it.matches(HEX)) }
      require(next == null || next != cursor)
      return ReceiptReturnPage(parsed, next)
  }

  private fun java.io.InputStream.readBytesBounded(max: Int): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(4096)
    while (true) {
      val count = read(buffer)
      if (count < 0) break
      require(out.size() + count <= max)
      out.write(buffer, 0, count)
    }
    return out.toByteArray()
  }
  companion object { private val HEX = Regex("[0-9a-f]{64}"); private const val MAX_PAGE_BYTES = 262_144 }
}

/** Persistent, bounded per-report cursor/lease. Cursor commits only after verified durable custody. */
class ReceiptReturnWorker(
  private val database: SagipDatabase,
  private val service: () -> TrustedReceiptReturnService?,
  private val configuration: () -> ReceiptReturnFeedConfig?,
  private val monotonicClock: () -> MonotonicClock,
) {
  private data class Attempt(val reportId: String, val cursor: String?, val lease: String, val boot: String, val started: Long)
  @Synchronized fun runOnce(): ReceiptReturnBatch {
    val config = configuration() ?: return ReceiptReturnBatch()
    val receiver = service() ?: return ReceiptReturnBatch()
    if (receiver.baseContext() == null) return ReceiptReturnBatch()
    require(config.sourceId.matches(Regex("[A-Za-z0-9_-]{1,64}")) && config.reportIds.size <= 10_000)
    config.reportIds.forEach { require(UUID.fromString(it).toString() == it) }
    enqueue(config)
    var stored = 0; var pending = 0; var retryable = 0
    repeat(16) {
      if (!current(config, receiver)) return ReceiptReturnBatch(false, stored, pending, retryable)
      val attempt = claim(config, checkedClock()) ?: return ReceiptReturnBatch(true, stored, pending, retryable)
      var next: String? = attempt.cursor
      var success = false
      var waiting = false
      try {
        check(current(config, receiver))
        val page = config.transport.fetch(attempt.reportId, attempt.cursor)
        check(page.entries.size <= 32 && page.entries.sumOf { it.bytes.size.toLong() } <= 262_144)
        check(page.nextCursor == null || (page.nextCursor.matches(Regex("[0-9a-f]{64}")) && page.nextCursor != attempt.cursor))
        check(page.entries.map { it.eventId }.toSet().size == page.entries.size)
        for (entry in page.entries) {
          check(current(config, receiver))
          check(TrustedReceiptReturnService.hex(TrustedReceiptReturnService.hash(entry.bytes)) == entry.eventDigest)
          val fields = ReceiptV2Codec.decode(entry.bytes).fields
          val kind = when (fields) {
            is ReceiptFields.Responder -> {
              check(fields.reportId == attempt.reportId && fields.actionId == entry.eventId)
              ObjectKind.RESPONDER_RECEIPT
            }
            is ReceiptFields.Requester -> {
              check(fields.reportId == attempt.reportId && fields.eventId == entry.eventId)
              ObjectKind.REQUESTER_RECEIPT
            }
            else -> error("NOT_RELAY_RECEIPT")
          }
          val admission = receiver.admit(kind, entry.bytes)
          if (admission.kind !in setOf(CustodyResultKind.COMMITTED, CustodyResultKind.DUPLICATE)) {
            waiting = true
            break // Retain cursor. Pending bytes must never be lost to bounded quarantine eviction.
          }
          stored++
        }
        if (!waiting) { success = true; next = page.nextCursor }
      } catch (_: Exception) { retryable++ }
      if (waiting) pending++
      complete(config, receiver, attempt, success, next)
    }
    return ReceiptReturnBatch(true, stored, pending, retryable)
  }
  private fun current(config: ReceiptReturnFeedConfig, receiver: TrustedReceiptReturnService) =
    configuration() === config && service() === receiver && receiver.baseContext() != null
  private fun enqueue(config: ReceiptReturnFeedConfig) {
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      var count = db.rawQuery("SELECT COUNT(*) FROM receipt_return_sync", null).use { it.moveToFirst(); it.getInt(0) }
      for (report in config.reportIds) {
        val exists = db.rawQuery("SELECT 1 FROM receipt_return_sync WHERE source_id=? AND report_id=?",
          arrayOf(config.sourceId, report)).use { it.moveToFirst() }
        if (exists) continue
        if (count >= 10_000) break
        val known = db.rawQuery("SELECT 1 FROM receipt_report_identities WHERE report_id=? LIMIT 1", arrayOf(report)).use { it.moveToFirst() }
        if (!known) continue
        db.execSQL("INSERT OR IGNORE INTO receipt_return_sync(source_id,report_id) VALUES(?,?)", arrayOf(config.sourceId, report))
        count++
      }
      db.setTransactionSuccessful()
    } finally { db.endTransaction() }
  }
  private fun checkedClock() = monotonicClock().also {
    require(UUID.fromString(it.bootId).toString() == it.bootId && it.elapsedMs in 0..9_007_199_194_991L)
  }
  private fun claim(config: ReceiptReturnFeedConfig, clock: MonotonicClock): Attempt? {
    val db = database.writableDatabase
    db.beginTransaction()
    try {
      val candidate = db.rawQuery(
        """SELECT report_id,cursor FROM receipt_return_sync WHERE source_id=?
          AND (boot_id IS NULL OR boot_id!=? OR (next_attempt_ms<=? AND (lease_until_ms IS NULL OR lease_until_ms<=?)))
          ORDER BY next_attempt_ms,report_id LIMIT 10000""".trimIndent(),
        arrayOf(config.sourceId, clock.bootId, clock.elapsedMs.toString(), clock.elapsedMs.toString()),
      ).use { c ->
        var found: Attempt? = null
        while (c.moveToNext()) {
          if (c.getString(0) !in config.reportIds) continue
          found = Attempt(c.getString(0), if (c.isNull(1)) null else c.getString(1), UUID.randomUUID().toString(), clock.bootId, clock.elapsedMs)
          break
        }
        found
      }
      candidate?.let { db.execSQL(
        "UPDATE receipt_return_sync SET lease_token=?,lease_until_ms=?,boot_id=? WHERE source_id=? AND report_id=?",
        arrayOf(it.lease, clock.elapsedMs + 60_000L, clock.bootId, config.sourceId, it.reportId),
      ) }
      db.setTransactionSuccessful()
      return candidate
    } finally { db.endTransaction() }
  }
  private fun complete(config: ReceiptReturnFeedConfig, receiver: TrustedReceiptReturnService, attempt: Attempt, success: Boolean, next: String?) {
    val clock = checkedClock()
    val valid = current(config, receiver) && clock.bootId == attempt.boot && clock.elapsedMs - attempt.started in 0 until 60_000L
    val accepted = success && valid
    database.writableDatabase.execSQL(
      """UPDATE receipt_return_sync SET cursor=?,next_attempt_ms=?,boot_id=?,lease_token=NULL,lease_until_ms=NULL
        WHERE source_id=? AND report_id=? AND lease_token=?""".trimIndent(),
      arrayOf<Any?>(if (accepted) next else attempt.cursor, clock.elapsedMs + (if (accepted && next != null) 0L else 30_000L),
        clock.bootId, config.sourceId, attempt.reportId, attempt.lease),
    )
  }
}
