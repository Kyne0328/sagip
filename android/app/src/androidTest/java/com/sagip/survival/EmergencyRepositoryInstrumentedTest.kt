package com.sagip.survival

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class EmergencyRepositoryInstrumentedTest {
  private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
  private lateinit var database: SagipDatabase
  private lateinit var repository: EmergencyRepository

  @Before
  fun setUp() {
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
    database = SagipDatabase(context)
    repository = EmergencyRepository(database)
  }

  @After
  fun tearDown() {
    database.close()
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
  }

  @Test
  fun createsAtomicPendingReportWithoutLocationAndRestoresAfterReopen() {
    val created = repository.createReport(
      CreateEmergencyReportInput(EmergencyType.MEDICAL, Urgency.IMMEDIATE_DANGER),
      location = null,
      now = 1234L,
    )

    assertEquals("LOCALLY_COMMITTED", created.lifecycleState)
    assertEquals("DELIVERY_PENDING", created.deliveryState)
    assertNull(created.location)
    assertTableCount("reports", 1)
    assertTableCount("report_revisions", 1)
    assertTableCount("locations", 0)
    assertTableCount("outbound_envelopes", 1)
    assertTableCount("delivery_events", 1)
    assertTableCount("delivery_attempts", 0)
    assertTrue(repository.listDueOutbound(now = 1234L).isEmpty())

    val preparation = repository.listEnvelopePreparationSources().single()
    assertEquals(created.reportId, preparation.reportId)
    assertEquals(EmergencyType.MEDICAL, preparation.emergencyType)
    assertEquals(Urgency.IMMEDIATE_DANGER, preparation.urgency)
    assertNull(preparation.location)

    database.close()
    database = SagipDatabase(context)
    repository = EmergencyRepository(database)

    val restored = repository.listReports()
    assertEquals(1, restored.size)
    assertEquals(created.reportId, restored.single().reportId)
    assertEquals("DELIVERY_PENDING", restored.single().deliveryState)
  }

  @Test
  fun persistsLocationWithReportAndPreparationSource() {
    val location = LocationSnapshot(14.5995, 120.9842, 8.0, 1200L, "GPS", "FRESH")
    val created = repository.createReport(
      CreateEmergencyReportInput(EmergencyType.FLOOD, Urgency.NEED_ASSISTANCE),
      location,
      now = 1234L,
    )

    assertTrue(created.location != null)
    assertTableCount("locations", 1)
    assertEquals(location, repository.listEnvelopePreparationSources().single().location)
  }

  @Test
  fun readyEnvelopeIsTransportEligibleImmutableAndPersistent() {
    repository.createReport(
      CreateEmergencyReportInput(EmergencyType.FIRE, Urgency.IMMEDIATE_DANGER),
      location = null,
      now = 2_000L,
    )
    val source = repository.listEnvelopePreparationSources().single()
    val envelopeBytes = byteArrayOf(0x53, 0x47, 0x50, 0x31, 0x01)

    repository.markEnvelopeReady(source.messageId, envelopeBytes, now = 2_050L)
    repository.markEnvelopeReady(source.messageId, envelopeBytes.copyOf(), now = 2_060L)

    val due = repository.listDueOutbound(now = 2_060L).single()
    assertEquals(source.messageId, due.messageId)
    assertArrayEquals(envelopeBytes, due.envelopeBytes)
    assertTableCount("delivery_events", 2)
    assertTrue(repository.listEnvelopePreparationSources().isEmpty())

    assertThrows(IllegalArgumentException::class.java) {
      repository.markEnvelopeReady(source.messageId, byteArrayOf(9, 9, 9), now = 2_070L)
    }

    database.close()
    database = SagipDatabase(context)
    repository = EmergencyRepository(database)

    val restoredDue = repository.listDueOutbound(now = 2_100L).single()
    assertEquals(source.messageId, restoredDue.messageId)
    assertArrayEquals(envelopeBytes, restoredDue.envelopeBytes)
  }

  @Test
  fun abandonedAttemptBecomesDueAgainAfterLease() {
    repository.createReport(
      CreateEmergencyReportInput(EmergencyType.FIRE, Urgency.IMMEDIATE_DANGER),
      location = null,
      now = 2_000L,
    )
    val source = repository.listEnvelopePreparationSources().single()
    repository.markEnvelopeReady(source.messageId, byteArrayOf(1), now = 2_000L)
    val initial = repository.listDueOutbound(now = 2_000L).single()

    repository.recordAttemptStarted(
      messageId = initial.messageId,
      transport = "BLE",
      now = 2_100L,
    )

    assertTrue(repository.listDueOutbound(now = 62_099L).isEmpty())
    val dueAfterLease = repository.listDueOutbound(now = 62_100L).single()
    assertEquals(initial.messageId, dueAfterLease.messageId)
    assertEquals(1, dueAfterLease.attemptCount)
    assertArrayEquals(byteArrayOf(1), dueAfterLease.envelopeBytes)
  }

  @Test
  fun retrySchedulePersistsAcrossDatabaseReopenWithoutChangingMessageIdentity() {
    repository.createReport(
      CreateEmergencyReportInput(EmergencyType.MEDICAL, Urgency.IMMEDIATE_DANGER),
      location = null,
      now = 1_000L,
    )
    val source = repository.listEnvelopePreparationSources().single()
    repository.markEnvelopeReady(source.messageId, byteArrayOf(2), now = 1_000L)
    val initial = repository.listDueOutbound(now = 1_000L).single()
    val attemptId = repository.recordAttemptStarted(
      messageId = initial.messageId,
      transport = "INTERNET",
      now = 1_100L,
    )
    repository.recordAttemptCompleted(
      attemptId = attemptId,
      outcome = "RETRYABLE_FAILURE",
      retryClassification = "NETWORK_UNREACHABLE",
      now = 1_200L,
    )
    val nextAttemptAt = repository.scheduleRetry(
      messageId = initial.messageId,
      now = 1_200L,
      jitterUnit = 0.5,
    )

    assertEquals(6_200L, nextAttemptAt)
    assertTrue(repository.listDueOutbound(now = 6_199L).isEmpty())

    database.close()
    database = SagipDatabase(context)
    repository = EmergencyRepository(database)

    val dueAfterReopen = repository.listDueOutbound(now = 6_200L).single()
    assertEquals(initial.messageId, dueAfterReopen.messageId)
    assertEquals(1, dueAfterReopen.attemptCount)
    assertArrayEquals(byteArrayOf(2), dueAfterReopen.envelopeBytes)
    assertTableCount("delivery_attempts", 1)
    assertTableCount("delivery_events", 4)
  }

  @Test
  fun migratesV2OutboundEnvelopeToNeedsPreparationWithoutChangingIdentity() {
    database.close()
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
    val path = context.getDatabasePath(SagipDatabase.DATABASE_NAME)
    path.parentFile?.mkdirs()

    SQLiteDatabase.openOrCreateDatabase(path, null).use { raw ->
      raw.execSQL(
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
            delivery_state TEXT NOT NULL
          )
        """.trimIndent(),
      )
      raw.insertOrThrow(
        "outbound_envelopes",
        null,
        ContentValues().apply {
          put("message_id", "legacy-message")
          put("report_id", "legacy-report")
          put("revision", 1)
          put("priority", 10)
          put("created_at", 100L)
          put("next_attempt_at", 100L)
          put("attempt_count", 0)
          put("delivery_state", "DELIVERY_PENDING")
        },
      )
      raw.version = 2
    }

    database = SagipDatabase(context)
    database.writableDatabase.rawQuery(
      "SELECT message_id, preparation_state FROM outbound_envelopes",
      null,
    ).use { cursor ->
      assertTrue(cursor.moveToFirst())
      assertEquals("legacy-message", cursor.getString(0))
      assertEquals("NEEDS_PREPARATION", cursor.getString(1))
    }
  }

  private fun assertTableCount(table: String, expected: Int) {
    database.readableDatabase.rawQuery("SELECT COUNT(*) FROM $table", null).use { cursor ->
      cursor.moveToFirst()
      assertEquals(expected, cursor.getInt(0))
    }
  }
}
