package com.sagip.survival

import android.content.Context
import android.content.ContextWrapper
import java.io.File
import android.database.Cursor
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import net.zetetic.database.sqlcipher.SQLiteDatabase
import net.zetetic.database.sqlcipher.SQLiteOpenHelper
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class EmergencyRevisionMigrationInstrumentedTest {
  private val context = object : ContextWrapper(ApplicationProvider.getApplicationContext<Context>()) {
    override fun getApplicationContext(): Context = this
    override fun getDatabasePath(name: String): File = super.getDatabasePath("p07-$name")
    override fun deleteDatabase(name: String): Boolean = super.deleteDatabase("p07-$name")
  }
  private lateinit var key: ByteArray

  @Before fun setUp() {
    // This suite is destructive only within the separately built validation application.
    check(context.packageName == "org.sagip.app.sosvalidation")
    System.loadLibrary("sqlcipher")
    // Serialize initial key creation with the application JobService runtime.
    SurvivalCoreRuntime.get(ApplicationProvider.getApplicationContext())
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
    key = DatabaseKeyManager(context).getOrCreateDatabaseKey()
  }

  @After fun tearDown() {
    if (::key.isInitialized) {
      context.deleteDatabase(SagipDatabase.DATABASE_NAME)
      key.fill(0)
    }
  }

  @Test fun encryptedUpgradeAndReopenPreserveAllLegacyRowsBytesAndIndexes() {
    val before = seedVersion7()
    lateinit var afterUpgrade: Map<String, List<List<String>>>
    val indexes = openRaw().use { rows(it, "SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name") }
    SagipDatabase(context).use { helper ->
      val db = helper.writableDatabase
      assertEquals(8, db.version)
      assertEquals(before, legacySnapshot(db))
      assertEquals(indexes, rows(db, "SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name"))
      assertHealthy(db)
      assertEquals(listOf(listOf("D12.25", "D-34.5", "D9.0", "I77", "SGPS", "SFRESH")),
        rows(db, "SELECT latitude, longitude, accuracy_meters, captured_at, source, freshness FROM report_revisions WHERE report_id='r1'"))
      assertEquals(listOf(listOf("NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL")),
        rows(db, "SELECT message, latitude, longitude, accuracy_meters, captured_at, source, freshness FROM report_revisions WHERE report_id='r2'"))
      assertMultipleRevisions(db)
      afterUpgrade = legacySnapshot(db)
    }
    SagipDatabase(context).use { helper ->
      assertHealthy(helper.writableDatabase)
      assertEquals(afterUpgrade, legacySnapshot(helper.writableDatabase))
      assertEquals(2, scalar(helper.writableDatabase, "SELECT count(*) FROM outbound_envelopes WHERE report_id='r1'"))
      assertEquals(before["delivery_attempts"], legacySnapshot(helper.writableDatabase)["delivery_attempts"])
    }
    val header = context.getDatabasePath(SagipDatabase.DATABASE_NAME).inputStream().use { it.readNBytes(16) }
    assertFalse(header.contentEquals("SQLite format 3\u0000".toByteArray()))
    assertThrows(Exception::class.java) {
      SQLiteDatabase.openDatabase(context.getDatabasePath(SagipDatabase.DATABASE_NAME).absolutePath,
        ByteArray(32) { 42 }, null, SQLiteDatabase.OPEN_READONLY, null, null).use {
        scalar(it, "SELECT count(*) FROM sqlite_master")
      }
    }
  }

  @Test fun freshSchemaAllowsMultipleRevisionsAndEnforcesChildForeignKeys() {
    SagipDatabase(context).use { helper ->
      val db = helper.writableDatabase
      seedRows(db)
      assertMultipleRevisions(db)
      assertThrows(Exception::class.java) { db.execSQL("INSERT INTO delivery_events VALUES ('bad','r1','missing','X',1)") }
      db.execSQL("DELETE FROM outbound_envelopes WHERE message_id='m1'")
      listOf("delivery_events", "delivery_attempts", "server_receipts", "relay_receipts").forEach {
        assertEquals(0, scalar(db, "SELECT count(*) FROM $it WHERE message_id='m1'"))
      }
      assertHealthy(db)
    }
  }

  @Test fun freshAndUpgradedSchemasEnforceUtf8ByteBoundAndOperationIdentity() {
    repeat(2) { upgraded ->
      context.deleteDatabase(SagipDatabase.DATABASE_NAME)
      if (upgraded == 1) seedVersion7()
      SagipDatabase(context).use { helper ->
        val db = helper.writableDatabase
        if (upgraded == 0) seedRows(db)
        val boundary = "é".repeat(250)
        db.execSQL("UPDATE report_revisions SET message=? WHERE report_id='r1'", arrayOf(boundary))
        assertEquals(listOf(listOf("S$boundary")), rows(db, "SELECT message FROM report_revisions WHERE report_id='r1'"))
        assertThrows(Exception::class.java) {
          db.execSQL("UPDATE report_revisions SET message=? WHERE report_id='r1'", arrayOf(boundary + "a"))
        }
        db.execSQL("INSERT INTO detail_operations(operation_id,report_id,expected_revision,request_digest,result_revision) VALUES ('op','r1',1,'digest',1)")
        assertThrows(Exception::class.java) {
          db.execSQL("INSERT INTO detail_operations VALUES ('op','r1',1,'other',1)")
        }
        assertThrows(Exception::class.java) {
          db.execSQL("INSERT INTO detail_operations VALUES ('missing-report','missing',1,'digest',1)")
        }
        assertHealthy(db)
      }
    }
  }

  @Test fun interruptionAfterEveryMigrationStatementRollsBackEncryptedDataAndVersion() {
    // Reflection keeps this behavioral RED runnable before the migration exists.
    @Suppress("UNCHECKED_CAST")
    val statements = Schema.javaClass.getMethod("getMIGRATE_7_TO_8").invoke(Schema) as List<String>
    statements.indices.forEach { failureIndex ->
      context.deleteDatabase(SagipDatabase.DATABASE_NAME)
      val before = seedVersion7()
      val schemaBefore = openRaw().use { rows(it, "SELECT type,name,sql FROM sqlite_master ORDER BY type,name") }
      val interrupted = object : SQLiteOpenHelper(context, SagipDatabase.DATABASE_NAME, key.copyOf(), null, 8, 0, null, null, false) {
        override fun onConfigure(db: SQLiteDatabase) { db.setForeignKeyConstraintsEnabled(true) }
        override fun onCreate(db: SQLiteDatabase) { error("Expected seeded v7") }
        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
          statements.forEachIndexed { index, sql ->
            db.execSQL(sql)
            if (index == failureIndex) throw InterruptedMigration()
          }
        }
      }
      interrupted.use { assertThrows(InterruptedMigration::class.java) { it.writableDatabase } }
      openRaw().use { db ->
        assertEquals("failure after statement $failureIndex", 7, db.version)
        assertEquals(before, legacySnapshot(db))
        assertEquals(schemaBefore, rows(db, "SELECT type,name,sql FROM sqlite_master ORDER BY type,name"))
        assertHealthy(db)
      }
      SagipDatabase(context).use { helper ->
        assertEquals(8, helper.writableDatabase.version)
        assertEquals(before, legacySnapshot(helper.writableDatabase))
        assertHealthy(helper.writableDatabase)
      }
    }
  }

  private class InterruptedMigration : RuntimeException("Injected migration interruption")

  private fun assertMultipleRevisions(db: SQLiteDatabase) {
    db.execSQL("INSERT INTO report_revisions(report_id,revision,created_at,emergency_type,urgency) VALUES ('r1',2,200,'OTHER','IMMEDIATE_DANGER')")
    db.execSQL("INSERT INTO outbound_envelopes(message_id,report_id,revision,created_at,next_attempt_at,delivery_state) VALUES ('m3','r1',2,200,200,'DELIVERY_PENDING')")
    assertEquals(2, scalar(db, "SELECT count(*) FROM outbound_envelopes WHERE report_id='r1'"))
    assertThrows(Exception::class.java) {
      db.execSQL("INSERT INTO outbound_envelopes(message_id,report_id,revision,created_at,next_attempt_at,delivery_state) VALUES ('duplicate','r1',2,200,200,'DELIVERY_PENDING')")
    }
    assertHealthy(db)
  }

  private fun seedVersion7(): Map<String, List<List<String>>> = openRaw().use { db ->
    V7_CREATE_STATEMENTS.forEach(db::execSQL)
    db.version = 7
    seedRows(db)
    assertHealthy(db)
    legacySnapshot(db)
  }

  private fun openRaw(): SQLiteDatabase {
    context.getDatabasePath(SagipDatabase.DATABASE_NAME).parentFile?.mkdirs()
    return SQLiteDatabase.openDatabase(context.getDatabasePath(SagipDatabase.DATABASE_NAME).absolutePath,
      key, null, SQLiteDatabase.CREATE_IF_NECESSARY, null, null).apply { setForeignKeyConstraintsEnabled(true) }
  }

  private fun seedRows(db: SQLiteDatabase) {
    listOf("r1", "r2").forEach { id ->
      db.execSQL("INSERT INTO reports VALUES (?,100,'OTHER','IMMEDIATE_DANGER','LOCALLY_COMMITTED')", arrayOf(id))
      db.execSQL("INSERT INTO report_revisions(report_id,revision,created_at,emergency_type,urgency) VALUES (?,1,100,'OTHER','IMMEDIATE_DANGER')", arrayOf(id))
    }
    db.execSQL("INSERT INTO locations VALUES (9,'r1',12.25,-34.5,9,77,'GPS','FRESH')")
    db.execSQL("INSERT INTO outbound_envelopes VALUES ('m1','r1',1,X'0053475031FF807F',17,101,999,1234,4,'SERVER_ACCEPTED','READY')")
    db.execSQL("INSERT INTO outbound_envelopes VALUES ('m2','r2',1,NULL,100,102,NULL,102,0,'DELIVERY_PENDING','NEEDS_PREPARATION')")
    db.execSQL("INSERT INTO delivery_events VALUES ('e1','r1','m1','SERVER_ACCEPTED',555)")
    db.execSQL("INSERT INTO delivery_events VALUES ('e2','r2','m2','LOCALLY_COMMITTED',102)")
    db.execSQL("INSERT INTO delivery_attempts VALUES ('a1','m1','HTTP','peer',110,120,'SUCCESS','NONE')")
    db.execSQL("INSERT INTO delivery_attempts VALUES ('a2','m1','BLE',NULL,130,NULL,NULL,NULL)")
    db.execSQL("INSERT INTO server_receipts VALUES ('s1','m1','r1',1,'2026-10-03T00:00:00Z')")
    db.execSQL("INSERT INTO relay_receipts VALUES ('l1','m1','peer',140)")
    db.execSQL("INSERT INTO inbound_envelopes VALUES ('i1','remote','remote-report',X'0080FF',90,X'01FF',50,'DELIVERY_PENDING',444,3)")
    db.execSQL("INSERT INTO seen_messages VALUES ('remote',X'01FF',90)")
    db.execSQL("INSERT INTO responder_acks VALUES ('ack','r1','responder','CALL','RESPONDING','note',180)")
    db.execSQL("INSERT INTO relay_responder_acks VALUES ('rack','remote-report','responder',NULL,'RESOLVED',NULL,190)")
  }

  private fun legacySnapshot(db: SQLiteDatabase): Map<String, List<List<String>>> =
    listOf("reports", "report_revisions", "locations", "outbound_envelopes", "delivery_events",
      "delivery_attempts", "server_receipts", "inbound_envelopes", "seen_messages", "relay_receipts",
      "responder_acks", "relay_responder_acks").associateWith { table ->
      val columns = if (table == "report_revisions") "report_id,revision,created_at,emergency_type,urgency" else "*"
      rows(db, "SELECT $columns FROM $table ORDER BY 1,2")
    }

  private fun assertHealthy(db: SQLiteDatabase) {
    assertEquals(1, scalar(db, "PRAGMA foreign_keys"))
    assertEquals(emptyList<List<String>>(), rows(db, "PRAGMA foreign_key_check"))
    assertEquals(listOf(listOf("Sok")), rows(db, "PRAGMA integrity_check"))
  }

  private fun scalar(db: SQLiteDatabase, sql: String): Int = db.rawQuery(sql, emptyArray()).use { it.moveToFirst(); it.getInt(0) }

  private fun rows(db: SQLiteDatabase, sql: String): List<List<String>> = db.rawQuery(sql, emptyArray()).use { cursor ->
    buildList {
      while (cursor.moveToNext()) add((0 until cursor.columnCount).map { column ->
        when (cursor.getType(column)) {
          Cursor.FIELD_TYPE_NULL -> "NULL"
          Cursor.FIELD_TYPE_BLOB -> "B" + cursor.getBlob(column).joinToString("") { "%02x".format(it) }
          Cursor.FIELD_TYPE_INTEGER -> "I" + cursor.getLong(column)
          Cursor.FIELD_TYPE_FLOAT -> "D" + cursor.getDouble(column)
          else -> "S" + cursor.getString(column)
        }
      })
    }
  }

  companion object {
    // Frozen v7 fixture. Do not derive it from current production DDL: that hides upgrade regressions.
  private val V7_CREATE_STATEMENTS = listOf(
    """
      CREATE TABLE reports (
        report_id TEXT PRIMARY KEY NOT NULL,
        created_at INTEGER NOT NULL,
        emergency_type TEXT NOT NULL,
        urgency TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL
      )
    """.trimIndent(),
    """
      CREATE TABLE report_revisions (
        report_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        emergency_type TEXT NOT NULL,
        urgency TEXT NOT NULL,
        PRIMARY KEY (report_id, revision),
        FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE
      )
    """.trimIndent(),
    """
      CREATE TABLE locations (
        location_id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id TEXT NOT NULL UNIQUE,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        accuracy_meters REAL,
        captured_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        freshness TEXT NOT NULL,
        FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE
      )
    """.trimIndent(),
    """
      CREATE TABLE outbound_envelopes (
        message_id TEXT PRIMARY KEY NOT NULL,
        report_id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL,
        envelope_bytes BLOB,
        priority INTEGER NOT NULL DEFAULT 100,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        next_attempt_at INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        delivery_state TEXT NOT NULL,
        preparation_state TEXT NOT NULL DEFAULT 'NEEDS_PREPARATION',
        FOREIGN KEY (report_id, revision) REFERENCES report_revisions(report_id, revision) ON DELETE CASCADE
      )
    """.trimIndent(),
    """
      CREATE TABLE delivery_events (
        event_id TEXT PRIMARY KEY NOT NULL,
        report_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE,
        FOREIGN KEY (message_id) REFERENCES outbound_envelopes(message_id) ON DELETE CASCADE
      )
    """.trimIndent(),
    """
      CREATE TABLE delivery_attempts (
        attempt_id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL,
        transport TEXT NOT NULL,
        peer_identifier TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        outcome TEXT,
        retry_classification TEXT,
        FOREIGN KEY (message_id) REFERENCES outbound_envelopes(message_id) ON DELETE CASCADE
      )
    """.trimIndent(),
    """
      CREATE TABLE server_receipts (
        receipt_id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        report_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        accepted_at TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES outbound_envelopes(message_id) ON DELETE CASCADE
      )
    """.trimIndent(),
    """
      CREATE TABLE inbound_envelopes (
        inbound_id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        report_id TEXT,
        envelope_bytes BLOB NOT NULL,
        received_at INTEGER NOT NULL,
        origin_key_id BLOB NOT NULL,
        priority INTEGER NOT NULL DEFAULT 100,
        delivery_state TEXT NOT NULL DEFAULT 'DELIVERY_PENDING',
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0
      )
    """.trimIndent(),
    """
      CREATE TABLE seen_messages (
        message_id TEXT PRIMARY KEY NOT NULL,
        digest BLOB NOT NULL,
        first_seen_at INTEGER NOT NULL
      )
    """.trimIndent(),
    """
      CREATE TABLE relay_receipts (
        receipt_id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL,
        peer_identifier TEXT NOT NULL,
        acknowledged_at INTEGER NOT NULL,
        FOREIGN KEY (message_id) REFERENCES outbound_envelopes(message_id) ON DELETE CASCADE
      )
    """.trimIndent(),
    """
      CREATE TABLE responder_acks (
        ack_id TEXT PRIMARY KEY NOT NULL,
        report_id TEXT NOT NULL,
        responder_id TEXT NOT NULL,
        callsign TEXT,
        status TEXT NOT NULL,
        note TEXT,
        acknowledged_at INTEGER NOT NULL,
        FOREIGN KEY (report_id) REFERENCES reports(report_id) ON DELETE CASCADE
      )
    """.trimIndent(),
    """
      CREATE TABLE relay_responder_acks (
        ack_id TEXT PRIMARY KEY NOT NULL,
        report_id TEXT NOT NULL,
        responder_id TEXT NOT NULL,
        callsign TEXT,
        status TEXT NOT NULL,
        note TEXT,
        acknowledged_at INTEGER NOT NULL,
        UNIQUE(report_id, status, acknowledged_at)
      )
    """.trimIndent(),
    "CREATE INDEX idx_outbound_due ON outbound_envelopes(delivery_state, next_attempt_at, priority, created_at)",
    "CREATE INDEX idx_outbound_ready_due ON outbound_envelopes(preparation_state, delivery_state, next_attempt_at, priority, created_at)",
    "CREATE INDEX idx_delivery_attempts_message ON delivery_attempts(message_id, started_at)",
    "CREATE INDEX idx_server_receipts_report ON server_receipts(report_id)",
    "CREATE INDEX idx_inbound_due ON inbound_envelopes(delivery_state, next_attempt_at, priority, received_at)",
    "CREATE INDEX idx_inbound_report ON inbound_envelopes(report_id)",
    "CREATE INDEX idx_seen_messages_digest ON seen_messages(digest)",
    "CREATE INDEX idx_relay_receipts_message ON relay_receipts(message_id)",
    "CREATE INDEX idx_responder_acks_report ON responder_acks(report_id)",
    "CREATE INDEX idx_relay_responder_acks_report ON relay_responder_acks(report_id, acknowledged_at DESC)",
  )


  }
}
