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

/** HTTP adapter must provide the socket peer address, never a browser-controlled header. */
@RunWith(AndroidJUnit4::class)
class GatewayAdmissionStoreTest {
  private val context = IsolatedGatewayTestContext(ApplicationProvider.getApplicationContext<Context>())
  private lateinit var db: SagipDatabase
  private var clock = MonotonicClock(UUID.randomUUID().toString(), 1000)
  @Before fun setup() { context.deleteDatabase(SagipDatabase.DATABASE_NAME); db = SagipDatabase(context) }
  @After fun cleanup() { db.close(); context.deleteDatabase(SagipDatabase.DATABASE_NAME) }
  private fun store() = GatewayAdmissionStore(db) { clock }
  private fun source(index: Int = 1) = byteArrayOf(192.toByte(), 0, 2, index.toByte())

  @Test fun source_quota_and_retry_deadline_survive_reopen() {
    val s = store()
    repeat(10) { assertEquals("ADMITTED", s.admit(source()).outcome) }
    db.close(); db = SagipDatabase(context)
    val denied = store().admit(source())
    assertEquals("RATE_LIMITED", denied.outcome); assertEquals(60_000L, denied.retryAfterMs)
    clock = clock.copy(elapsedMs = 60_999)
    assertEquals(1L, store().admit(source()).retryAfterMs)
    clock = clock.copy(elapsedMs = 61_000)
    assertEquals("ADMITTED", store().admit(source()).outcome)
  }

  @Test fun global_quota_charges_source_denials_and_cannot_be_bypassed_by_address_rotation() {
    val s = store()
    repeat(10) { assertEquals("ADMITTED", s.admit(source()).outcome) }
    repeat(10) { assertEquals("RATE_LIMITED", s.admit(source()).outcome) }
    (2..41).forEach { assertEquals("ADMITTED", s.admit(source(it)).outcome) }
    db.close(); db = SagipDatabase(context)
    assertEquals("RATE_LIMITED", store().admit(source(42)).outcome)
    clock = clock.copy(elapsedMs = 61_000)
    assertEquals("ADMITTED", store().admit(source(42)).outcome)
  }

  @Test fun mapped_ipv4_cannot_create_an_independent_source_budget_and_invalid_addresses_are_rejected() {
    val s = store(); repeat(10) { s.admit(source()) }
    val mapped = ByteArray(10) + byteArrayOf(255.toByte(), 255.toByte()) + source()
    assertEquals("RATE_LIMITED", s.admit(mapped).outcome)
    listOf(ByteArray(0), ByteArray(3), ByteArray(5), ByteArray(17)).forEach {
      assertEquals("INVALID_SOURCE", s.admit(it).outcome)
    }
  }

  @Test fun rollback_shared_with_pairing_fails_closed_and_new_boot_does_not_keep_old_quota() {
    val s = store(); assertEquals("ADMITTED", s.admit(source()).outcome)
    clock = clock.copy(elapsedMs = 999)
    db.close(); db = SagipDatabase(context)
    assertEquals("TIME_UNAVAILABLE", store().admit(source()).outcome)
    clock = clock.copy(elapsedMs = 2000)
    val authority = GatewaySessionAuthority("11".repeat(32), UUID.randomUUID().toString(), 900_000, TimeInterval(100_000, 100_010))
    GatewayPairingStore(db, "https://gateway.example", {true}, {authority}, {clock}, {false}).startPairing()
    clock = clock.copy(elapsedMs = 1500)
    assertEquals("TIME_UNAVAILABLE", store().admit(source()).outcome)
    clock = MonotonicClock(UUID.randomUUID().toString(), 500)
    assertEquals("ADMITTED", store().admit(source()).outcome)
  }

  @Test fun concurrent_source_requests_admit_ten_without_overflow() {
    val s = store(); val pool = Executors.newFixedThreadPool(4); val start = CountDownLatch(1)
    try {
      val futures = (1..20).map { pool.submit<String> { start.await(5, TimeUnit.SECONDS); s.admit(source()).outcome } }
      start.countDown()
      val results = futures.map { it.get(10, TimeUnit.SECONDS) }
      assertEquals(10, results.count { it == "ADMITTED" }); assertEquals(10, results.count { it == "RATE_LIMITED" })
    } finally { pool.shutdownNow() }
  }

  @Test fun additive_v14_migration_preserves_pairing_and_live_session() {
    val authority = GatewaySessionAuthority("11".repeat(32), UUID.randomUUID().toString(), 900_000, TimeInterval(100_000, 100_010))
    val binding = "22".repeat(32)
    fun pairing() = GatewayPairingStore(db, "https://gateway.example", {true}, {authority}, {clock}, {false})
    val pair = pairing().startPairing()
    assertEquals("AWAITING_NATIVE_CONFIRMATION", pairing().confirmBrowser(pair.pairingId, pair.code, binding, "https://gateway.example"))
    val secrets = pairing().approveNative(pair.pairingId, binding)!!
    db.writableDatabase.execSQL("DROP TABLE gateway_admission_global")
    db.writableDatabase.execSQL("DROP TABLE gateway_admission_sources")
    db.writableDatabase.execSQL("DROP TABLE gateway_time_requests")
    db.writableDatabase.execSQL("ALTER TABLE receipt_time_checkpoints DROP COLUMN proof_bytes")
    db.writableDatabase.version = 13
    db.close(); db = SagipDatabase(context)
    assertEquals(15, db.readableDatabase.version)
    assertEquals("AUTHORIZED", pairing().authorize(secrets.token, secrets.csrf, binding, "https://gateway.example"))
    assertEquals("ADMITTED", store().admit(source()).outcome)
  }

  @Test fun expired_source_hashes_are_pruned_and_storage_remains_bounded() {
    val s = store()
    repeat(3) { minute ->
      clock = clock.copy(elapsedMs = 1000L + minute * 60_000L)
      (1..60).forEach { index ->
        assertEquals("ADMITTED", s.admit(byteArrayOf(192.toByte(), 0, minute.toByte(), index.toByte())).outcome)
      }
      db.readableDatabase.rawQuery("SELECT source_hash FROM gateway_admission_sources", null).use {
        assertEquals(60, it.count)
        while (it.moveToNext()) assertTrue(it.getString(0).matches(Regex("[0-9a-f]{64}")))
      }
    }
  }
}
