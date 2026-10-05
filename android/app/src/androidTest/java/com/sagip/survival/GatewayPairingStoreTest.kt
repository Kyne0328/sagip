package com.sagip.survival

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Policy/storage evidence only: this class does not claim browser TLS acceptance. */
@RunWith(AndroidJUnit4::class)
class GatewayPairingStoreTest {
  private val context = IsolatedGatewayTestContext(ApplicationProvider.getApplicationContext<Context>())
  private lateinit var db: SagipDatabase
  private var clock = MonotonicClock(UUID.randomUUID().toString(), 1000)
  private var unlocked = true
  private var pending = false
  private var authority: GatewaySessionAuthority? = GatewaySessionAuthority("11".repeat(32), UUID.randomUUID().toString(), 900_000,
    TimeInterval(100_000, 100_010))
  private val origin = "https://gateway.example"
  private val binding = "22".repeat(32)
  @Before fun setup() { context.deleteDatabase(SagipDatabase.DATABASE_NAME); db = SagipDatabase(context) }
  @After fun cleanup() { db.close(); context.deleteDatabase(SagipDatabase.DATABASE_NAME) }
  private fun store() = GatewayPairingStore(db, origin, {unlocked}, {authority}, {clock}, {pending})
  private fun session(store: GatewayPairingStore = store()): GatewaySessionSecrets {
    val pair = store.startPairing()
    assertEquals("AWAITING_NATIVE_CONFIRMATION", store.confirmBrowser(pair.pairingId, pair.code, binding, origin))
    assertEquals("SESSION_REQUIRED", store.authorize("00".repeat(32), "00".repeat(32), binding, origin))
    return store.approveNative(pair.pairingId, binding)!!
  }

  @Test fun both_devices_must_confirm_exact_identity_and_session_secrets_are_not_persisted() {
    val s = store(); val pair = s.startPairing()
    assertTrue(pair.code.matches(Regex("[0-9]{8}")))
    assertNull(s.approveNative(pair.pairingId, binding))
    assertEquals("ORIGIN_DENIED", s.confirmBrowser(pair.pairingId, pair.code, binding, "https://evil.example"))
    assertEquals("AWAITING_NATIVE_CONFIRMATION", s.confirmBrowser(pair.pairingId, pair.code, binding, origin))
    assertNull(s.approveNative(pair.pairingId, "33".repeat(32)))
    val secrets = s.approveNative(pair.pairingId, binding)!!
    assertNull(s.approveNative(pair.pairingId, binding))
    assertEquals("AUTHORIZED", s.authorize(secrets.token, secrets.csrf, binding, origin))
    assertEquals("ORIGIN_DENIED", s.authorize(secrets.token, secrets.csrf, binding, "https://evil.example"))
    assertEquals("CSRF_DENIED", s.authorize(secrets.token, "00".repeat(32), binding, origin))
    assertEquals("SESSION_REQUIRED", s.authorize(secrets.token, secrets.csrf, "33".repeat(32), origin))
    db.readableDatabase.rawQuery("SELECT token_hash,csrf_hash FROM gateway_browser_sessions", null).use {
      assertTrue(it.moveToFirst()); assertFalse(hex(it.getBlob(0)) == secrets.token); assertFalse(hex(it.getBlob(1)) == secrets.csrf)
    }
  }

  @Test fun failed_attempts_expiry_and_replay_rejection_survive_reopen() {
    var s = store(); val pair = s.startPairing()
    val wrong = if (pair.code == "00000000") "00000001" else "00000000"
    repeat(4) { assertEquals("CODE_DENIED", s.confirmBrowser(pair.pairingId, wrong, binding, origin)) }
    db.close(); db = SagipDatabase(context); s = store()
    assertEquals("PAIRING_EXPIRED", s.confirmBrowser(pair.pairingId, wrong, binding, origin))
    assertEquals("PAIRING_EXPIRED", s.confirmBrowser(pair.pairingId, pair.code, binding, origin))
    val next = s.startPairing(); clock = clock.copy(elapsedMs = clock.elapsedMs + 300_000)
    assertEquals("PAIRING_EXPIRED", s.confirmBrowser(next.pairingId, next.code, binding, origin))
    assertNull(s.approveNative(next.pairingId, binding))
  }

  @Test fun authority_access_reboot_rollback_and_logout_never_upgrade_access() {
    val s = store(); val secrets = session(s)
    unlocked = false
    assertEquals("DEVICE_ACCESS_REQUIRED", s.authorize(secrets.token, secrets.csrf, binding, origin))
    assertTrue(runCatching { s.startPairing() }.isFailure)
    unlocked = true; authority = null
    assertEquals("AUTHORITY_UNAVAILABLE", s.authorize(secrets.token, secrets.csrf, binding, origin))
    authority = GatewaySessionAuthority("11".repeat(32), UUID.randomUUID().toString(), 900_000, TimeInterval(100_000, 100_010))
    assertEquals("SESSION_EXPIRED", s.authorize(secrets.token, secrets.csrf, binding, origin))
    val current = session(s)
    pending = true
    assertEquals("BLOCKED_PENDING_ACTIONS", s.logout(current.token, current.csrf, binding, origin))
    assertEquals("AUTHORIZED", s.authorize(current.token, current.csrf, binding, origin))
    pending = false
    assertEquals("COMPLETE", s.logout(current.token, current.csrf, binding, origin))
    db.close(); db = SagipDatabase(context)
    assertEquals("SESSION_EXPIRED", store().authorize(current.token, current.csrf, binding, origin))
    val beforeBoot = session()
    clock = clock.copy(elapsedMs = 999)
    assertEquals("TIME_UNAVAILABLE", store().authorize(beforeBoot.token, beforeBoot.csrf, binding, origin))
    clock = MonotonicClock(UUID.randomUUID().toString(), 1000)
    assertEquals("SESSION_EXPIRED", store().authorize(beforeBoot.token, beforeBoot.csrf, binding, origin))
  }

  @Test fun session_capacity_and_action_rate_are_bounded_and_persisted() {
    val s = store(); val sessions = (1..8).map { session(s) }
    val extra = s.startPairing()
    assertEquals("AWAITING_NATIVE_CONFIRMATION", s.confirmBrowser(extra.pairingId, extra.code, binding, origin))
    assertNull(s.approveNative(extra.pairingId, binding))
    val first = sessions.first()
    repeat(60) { assertEquals("AUTHORIZED", s.authorize(first.token, first.csrf, binding, origin, action = true)) }
    db.close(); db = SagipDatabase(context)
    assertEquals("RATE_LIMITED", store().authorize(first.token, first.csrf, binding, origin, action = true))
    assertEquals("AUTHORIZED", store().authorize(first.token, first.csrf, binding, origin))
    clock = clock.copy(elapsedMs = 61_000)
    assertEquals("AUTHORIZED", store().authorize(first.token, first.csrf, binding, origin, action = true))
  }

  @Test fun twelve_hour_cap_and_exact_https_origin_are_enforced() {
    authority = authority!!.copy(grantExpiresAtMs = 100_000_000)
    val s = store(); val secrets = session(s)
    clock = clock.copy(elapsedMs = 1000 + 43_200_000)
    assertEquals("SESSION_EXPIRED", s.authorize(secrets.token, secrets.csrf, binding, origin))
    listOf("https://gateway.example/", "https://gateway.example?x=1", "https://user@gateway.example",
      "https://*.example", "https://GATEWAY.example", "http://gateway.example").forEach { invalid ->
      assertTrue(invalid, runCatching { GatewayPairingStore(db, invalid, {true}, {authority}, {clock}, {false}) }.isFailure)
    }
  }

  @Test fun concurrent_approval_and_action_limits_commit_once() {
    val s = store(); val pair = s.startPairing()
    assertEquals("AWAITING_NATIVE_CONFIRMATION", s.confirmBrowser(pair.pairingId, pair.code, binding, origin))
    val approvals = compete { s.approveNative(pair.pairingId, binding) }
    assertEquals(1, approvals.count { it != null })
    val secrets = approvals.filterNotNull().single()
    repeat(59) { assertEquals("AUTHORIZED", s.authorize(secrets.token, secrets.csrf, binding, origin, true)) }
    assertEquals(listOf("AUTHORIZED", "RATE_LIMITED"), compete {
      s.authorize(secrets.token, secrets.csrf, binding, origin, true)
    }.sorted())
    repeat(6) { session(s) }
    val pairs = (1..2).map { s.startPairing().also {
      assertEquals("AWAITING_NATIVE_CONFIRMATION", s.confirmBrowser(it.pairingId, it.code, binding, origin))
    } }
    val nextIndex = java.util.concurrent.atomic.AtomicInteger()
    assertEquals(1, compete { s.approveNative(pairs[nextIndex.getAndIncrement()].pairingId, binding) }.count { it != null })
  }

  @Test fun history_capacity_fails_closed_after_reopen() {
    val s = store(); val secrets = session(s)
    val sql = db.writableDatabase
    sql.beginTransaction()
    try {
      repeat(1023) { index ->
        sql.execSQL("INSERT INTO gateway_pairings SELECT ?,code_salt,code_hash,provider_id,grant_id,boot_id,expires_elapsed_ms,attempts,browser_binding,state FROM gateway_pairings LIMIT 1", arrayOf(UUID.randomUUID().toString()))
        sql.execSQL("INSERT INTO gateway_browser_sessions SELECT CAST(? AS BLOB),csrf_hash,browser_binding,provider_id,grant_id,boot_id,expires_elapsed_ms,1,window_elapsed_ms,action_count FROM gateway_browser_sessions LIMIT 1", arrayOf("history-$index"))
      }
      sql.setTransactionSuccessful()
    } finally { sql.endTransaction() }
    db.close(); db = SagipDatabase(context)
    assertTrue(runCatching { store().startPairing() }.isFailure)
    assertEquals("AUTHORIZED", store().authorize(secrets.token, secrets.csrf, binding, origin))
    // Make room only in the pairing history to independently exercise session capacity.
    db.writableDatabase.execSQL("DELETE FROM gateway_pairings WHERE state='ISSUED'")
    val pair = store().startPairing()
    assertEquals("AWAITING_NATIVE_CONFIRMATION", store().confirmBrowser(pair.pairingId, pair.code, binding, origin))
    assertNull(store().approveNative(pair.pairingId, binding))
  }

  private fun <T> compete(action: () -> T): List<T> {
    val executor = Executors.newFixedThreadPool(2); val start = CountDownLatch(1)
    try {
      val futures = (1..2).map { executor.submit<T> { start.await(5, TimeUnit.SECONDS); action() } }
      start.countDown()
      return futures.map { it.get(10, TimeUnit.SECONDS) }
    } finally { executor.shutdownNow() }
  }

  @Test fun sessions_expire_at_grant_limit_and_v12_upgrade_preserves_existing_work() {
    val actionId = UUID.randomUUID().toString()
    db.writableDatabase.execSQL("INSERT INTO gateway_work(action_id,report_id,observed_version,status,note,saved_at_ms) VALUES(?,?,0,1,'preserve me',1000)",
      arrayOf(actionId, UUID.randomUUID().toString()))
    listOf("gateway_snapshot_pages","gateway_snapshots","gateway_api_actions","gateway_sync").forEach {
      db.writableDatabase.execSQL("DROP TABLE $it")
    }
    db.writableDatabase.execSQL("DROP TABLE gateway_pairings")
    db.writableDatabase.execSQL("DROP TABLE gateway_browser_sessions")
    db.writableDatabase.execSQL("DROP TABLE gateway_pairing_clock")
    db.writableDatabase.execSQL("DROP TABLE gateway_admission_global")
    db.writableDatabase.execSQL("DROP TABLE gateway_admission_sources")
    db.writableDatabase.execSQL("DROP TABLE gateway_time_requests")
    db.writableDatabase.execSQL("ALTER TABLE receipt_time_checkpoints DROP COLUMN proof_bytes")
    // Reconstruct pre-v17 fixture schema before replaying its actual upgrade path.
    db.writableDatabase.execSQL("DROP TABLE detail_operations")
    listOf("message", "latitude", "longitude", "accuracy_meters", "captured_at", "source", "freshness").forEach {
      db.writableDatabase.execSQL("ALTER TABLE report_revisions DROP COLUMN $it")
    }
    db.writableDatabase.execSQL("DROP TABLE victim_server_acks")
    db.writableDatabase.execSQL("DROP TABLE victim_status_sync")
    db.writableDatabase.execSQL("DROP TABLE receipt_return_sync")
    db.writableDatabase.execSQL("DROP TABLE receipt_return_replay_state")
    db.writableDatabase.version = 12
    db.close(); db = SagipDatabase(context)
    assertEquals(Schema.VERSION, db.readableDatabase.version)
    db.readableDatabase.rawQuery("SELECT note FROM gateway_work WHERE action_id=?", arrayOf(actionId)).use {
      assertTrue(it.moveToFirst()); assertEquals("preserve me", it.getString(0))
    }
    authority = authority!!.copy(grantExpiresAtMs = 100_110)
    val s = store(); val secrets = session(s)
    clock = clock.copy(elapsedMs = 1100)
    assertEquals("SESSION_EXPIRED", s.authorize(secrets.token, secrets.csrf, binding, origin))
    assertTrue(runCatching { GatewayPairingStore(db, "http://gateway.example", {true}, {authority}, {clock}, {false}) }.isFailure)
  }
  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
}
