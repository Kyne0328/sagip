package com.sagip.survival

import android.content.Context
import android.content.ContextWrapper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.File
import java.lang.reflect.InvocationTargetException
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import net.zetetic.database.sqlcipher.SQLiteDatabase
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class EmergencyDetailsInstrumentedTest {
  private val context = object : ContextWrapper(ApplicationProvider.getApplicationContext<Context>()) {
    override fun getApplicationContext(): Context = this
    override fun getDatabasePath(name: String): File = super.getDatabasePath("p08-$name")
    override fun deleteDatabase(name: String): Boolean = super.deleteDatabase("p08-$name")
  }
  private lateinit var helper: SagipDatabase
  private lateinit var repository: EmergencyRepository
  private val initial = CreateEmergencyReportInput(EmergencyType.OTHER, Urgency.IMMEDIATE_DANGER)
  private val location = LocationSnapshot(12.25, -34.5, 9.0, 77, "GPS", "FRESH")

  @Before fun setUp() {
    check(context.packageName == "org.sagip.app.sosvalidation")
    System.loadLibrary("sqlcipher")
    SurvivalCoreRuntime.get(ApplicationProvider.getApplicationContext())
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
    open()
  }

  @After fun tearDown() {
    if (::helper.isInitialized) helper.close()
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
  }

  @Test fun simultaneousCreationAcrossConnectionsAndReopenReturnCanonicalActiveReport() {
    // Independent helpers/connections prove the SQLite boundary, not an object monitor.
    SagipDatabase(context).use { second ->
      second.writableDatabase
      helper.writableDatabase
      val results = simultaneously(
        { repository.createReport(initial, location, 100) },
        { EmergencyRepository(second).createReport(initial, null, 101) },
      )
      assertEquals(results[0].reportId, results[1].reportId)
      assertEquals(1, count("reports"))
      assertEquals(1, count("outbound_envelopes"))
      reopen()
      assertEquals(results[0].reportId, repository.createReport(initial, null, 200).reportId)
    }
  }

  @Test fun permanentFailureRemainsActiveAndResolvedAckIsTerminalDespiteLateLowerStatus() {
    val report = repository.createReport(initial, null, 100)
    repository.markDeliveryFailed(messageId(report.reportId, 1), "terminal", 110)
    assertEquals(report.reportId, repository.createReport(initial, null, 120).reportId)
    ack(report.reportId, "RESOLVED", 130)
    ack(report.reportId, "EN_ROUTE", 140)
    ack(report.reportId, "ACKNOWLEDGED", 145)
    assertEquals("RESOLVED", repository.getReportSummary(report.reportId).responderAck?.status)
    expectCode("DETAILS_CONFLICT") { append(report.reportId, 1, id(), message = "Too late") }
    val next = repository.createReport(initial, null, 150)
    assertNotEquals(report.reportId, next.reportId)
    assertEquals(2, count("reports"))
  }

  @Test fun multipleLegacyUnresolvedReportsChooseLatestWithDeterministicIdTieBreak() {
    val first = repository.createReport(initial, null, 100)
    ack(first.reportId, "RESOLVED", 101)
    val second = repository.createReport(initial, null, 200)
    db().execSQL("DELETE FROM responder_acks")
    db().execSQL("DELETE FROM victim_server_acks")
    assertEquals(second.reportId, repository.createReport(initial, null, 300).reportId)
    db().execSQL("UPDATE reports SET created_at=100")
    assertEquals(maxOf(first.reportId, second.reportId), repository.createReport(initial, null, 400).reportId)
    assertEquals(2, count("reports"))
  }

  @Test fun initialAndAppendedSnapshotsPreserveOriginalLocationTimeAndOutboundEvidence() {
    val report = repository.createReport(initial, location, 100)
    assertEquals(listOf(listOf("12.25", "-34.5", "9", "77", "GPS", "FRESH")),
      rows("SELECT latitude,longitude,accuracy_meters,captured_at,source,freshness FROM report_revisions"))
    val originalMessage = messageId(report.reportId, 1)
    repository.markEnvelopeReady(originalMessage, byteArrayOf(1, 2, 3), 105)
    val attempt = repository.recordAttemptStarted(originalMessage, "HTTP", now = 110)
    repository.recordAttemptCompleted(attempt, "FAILED", "RETRYABLE", 111)
    repository.scheduleRetry(originalMessage, 112, 0.5)
    val originalRows = snapshotOriginal(report.reportId)
    val details = append(report.reportId, 1, id(), EmergencyType.MEDICAL, "  Need water\nnow  ", 200)
    assertEquals(2, revision(details))
    assertEquals("Need water\nnow", message(details))
    assertEquals(EmergencyType.MEDICAL, details.emergencyType)
    assertEquals(report.createdAt, details.createdAt)
    assertEquals(location, details.location)
    assertEquals(originalRows, snapshotOriginal(report.reportId))
    assertEquals("200", rows("SELECT created_at FROM report_revisions WHERE revision=2").single().single())
    assertEquals("200", rows("SELECT created_at FROM outbound_envelopes WHERE revision=2").single().single())
    assertEquals(listOf(listOf("NEEDS_PREPARATION", "NULL", "0")),
      rows("SELECT preparation_state,envelope_bytes,attempt_count FROM outbound_envelopes WHERE revision=2"))
    assertEquals(originalMessage, deliveryMessage(details, "OriginalDelivery"))
    assertEquals(messageId(report.reportId, 2), deliveryMessage(details, "LatestDelivery"))
    assertEquals(2, count("delivery_events", "event_type='LOCAL_COMMIT'"))
  }

  @Test fun identicalOperationReplaysOriginalRevisionBeforeStaleAndResolutionChecksAfterReopen() {
    val report = repository.createReport(initial, null, 100)
    val operation = id()
    val original = append(report.reportId, 1, operation, EmergencyType.FIRE, " Help ", 200)
    append(report.reportId, 2, id(), EmergencyType.FLOOD, "Newer", 300)
    ack(report.reportId, "RESOLVED", 400)
    reopen()
    val replay = append(report.reportId, 1, operation, EmergencyType.FIRE, "Help", 500)
    assertEquals(2, revision(replay))
    assertEquals(message(original), message(replay))
    assertEquals(EmergencyType.FIRE, replay.emergencyType)
    assertEquals(deliveryMessage(original, "LatestDelivery"), deliveryMessage(replay, "LatestDelivery"))
    assertEquals(3, count("report_revisions"))
    assertEquals(2, count("detail_operations"))
    expectCode("DETAILS_CONFLICT") { append(report.reportId, 3, id(), message = "Late") }
  }

  @Test fun operationReuseGuardsContentIdentityExpectedRevisionAndFieldPresence() {
    val report = repository.createReport(initial, null, 100)
    val operation = id()
    append(report.reportId, 1, operation)
    expectCode("DETAILS_OPERATION_REUSED") { append(report.reportId, 1, operation, message = "") }
    expectCode("DETAILS_OPERATION_REUSED") { append(report.reportId, 1, operation, EmergencyType.OTHER) }
    expectCode("DETAILS_OPERATION_REUSED") { append(report.reportId, 2, operation) }
    expectCode("DETAILS_OPERATION_REUSED") { append(id(), 1, operation) }
    assertEquals(1, count("detail_operations"))
    assertEquals(1, count("report_revisions"))
  }

  @Test fun absentRetainsEmptyClearsExplicitOtherChangesAndNoOpPersistsReplay() {
    val report = repository.createReport(initial, null, 100)
    append(report.reportId, 1, id(), EmergencyType.FIRE, "Need help")
    val changed = append(report.reportId, 2, id(), EmergencyType.OTHER)
    assertEquals("Need help", message(changed))
    assertEquals(EmergencyType.OTHER, changed.emergencyType)
    val cleared = append(report.reportId, 3, id(), message = " \n ")
    assertNull(message(cleared))
    val noOp = id()
    val result = append(report.reportId, 4, noOp, EmergencyType.OTHER, "")
    assertEquals(4, revision(result))
    assertEquals(4, count("outbound_envelopes"))
    append(report.reportId, 4, id(), message = "Next")
    reopen()
    assertEquals(4, revision(append(report.reportId, 4, noOp, EmergencyType.OTHER, "")))
    expectCode("DETAILS_CONFLICT") { append(report.reportId, 4, id(), message = "Stale") }
    assertEquals(5, count("outbound_envelopes"))
    assertEquals(5, count("detail_operations"))
  }

  @Test fun validatesCanonicalIdentifiersStrictUnicodeAndTrimmedUtf8BudgetWithoutEffects() {
    val report = repository.createReport(initial, null, 100)
    for (bad in listOf("broken", "1-1-1-1-1", "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")) {
      expectCode("DETAILS_INVALID") { append(bad, 1, id()) }
      expectCode("DETAILS_INVALID") { append(report.reportId, 1, bad) }
    }
    expectCode("DETAILS_INVALID") { append(report.reportId, 0, id()) }
    expectCode("DETAILS_INVALID") { append(report.reportId, 1, id(), message = "😀".repeat(125) + "a") }
    expectCode("DETAILS_INVALID") { append(report.reportId, 1, id(), message = "\uD800") }
    assertEquals(0, count("detail_operations"))
    val boundary = append(report.reportId, 1, id(), message = "  " + "😀".repeat(125) + "  ")
    assertEquals("😀".repeat(125), message(boundary))
  }

  @Test fun concurrentIdenticalOperationsAllocateOneRevisionAndCompetingEditsConflict() {
    val report = repository.createReport(initial, null, 100)
    val operation = id()
    val identical = simultaneously(
      { append(report.reportId, 1, operation, message = "Help") },
      { append(report.reportId, 1, operation, message = "Help") },
    )
    assertEquals(deliveryMessage(identical[0], "LatestDelivery"), deliveryMessage(identical[1], "LatestDelivery"))
    assertEquals(2, count("report_revisions"))
    val competitors = simultaneously(
      { runCatching { append(report.reportId, 2, id(), message = "A") } },
      { runCatching { append(report.reportId, 2, id(), message = "B") } },
    )
    assertEquals(1, competitors.count { it.isSuccess })
    assertEquals("DETAILS_CONFLICT", errorCode(competitors.single { it.isFailure }.exceptionOrNull()!!))
    assertEquals(3, count("report_revisions"))
    assertEquals(2, count("detail_operations"))
  }

  @Test fun failureAfterEveryCreateInsertRollsBackAllRowsAndAllowsRetryAfterReopen() {
    for (table in listOf("reports", "report_revisions", "locations", "outbound_envelopes", "delivery_events")) {
      installFailure(table)
      assertThrows(Exception::class.java) { repository.createReport(initial, location, 100) }
      removeFailure()
      reopen()
      for (emptyTable in listOf("reports", "report_revisions", "locations", "outbound_envelopes", "delivery_events")) {
        assertEquals("after $table: $emptyTable", 0, count(emptyTable))
      }
    }
    repository.createReport(initial, location, 100)
    assertEquals(1, count("reports"))
  }

  @Test fun failureAfterEveryAppendInsertRollsBackSnapshotQueueEventAndOperation() {
    val report = repository.createReport(initial, location, 100)
    val original = snapshotAll()
    val operation = id()
    for (table in listOf("report_revisions", "outbound_envelopes", "delivery_events", "detail_operations")) {
      installFailure(table)
      assertThrows(Exception::class.java) { append(report.reportId, 1, operation, message = "Help") }
      removeFailure()
      reopen()
      assertEquals("after $table", original, snapshotAll())
    }
    assertEquals(2, revision(append(report.reportId, 1, operation, message = "Help")))
    assertEquals(1, count("detail_operations"))
  }

  // Reflection makes RED execute on the device before the P08 model/operation exists.
  private fun append(reportId: String, expected: Int, operationId: String, category: EmergencyType? = null,
    message: String? = null, now: Long = 200): EmergencyReportSummary {
    val inputClass = Class.forName("com.sagip.survival.AppendEmergencyDetailsInput")
    val input = inputClass.getConstructor(String::class.java, Int::class.javaPrimitiveType,
      String::class.java, EmergencyType::class.java, String::class.java)
      .newInstance(reportId, expected, operationId, category, message)
    try {
      return repository.javaClass.getMethod("appendEmergencyDetails", inputClass, Long::class.javaPrimitiveType)
        .invoke(repository, input, now) as EmergencyReportSummary
    } catch (failure: InvocationTargetException) { throw failure.targetException }
  }
  private fun revision(summary: EmergencyReportSummary) = summary.javaClass.getMethod("getLatestRevision").invoke(summary) as Int
  private fun message(summary: EmergencyReportSummary) = summary.javaClass.getMethod("getMessage").invoke(summary) as String?
  private fun deliveryMessage(summary: EmergencyReportSummary, name: String): String {
    val delivery = summary.javaClass.getMethod("get$name").invoke(summary)
    return delivery.javaClass.getMethod("getMessageId").invoke(delivery) as String
  }
  private fun expectCode(code: String, block: () -> Unit) {
    val failure = assertThrows(Exception::class.java, block)
    assertEquals(code, errorCode(failure))
  }
  private fun errorCode(failure: Throwable) = failure.javaClass.getMethod("getCode").invoke(failure)
  private fun open() { helper = SagipDatabase(context); repository = EmergencyRepository(helper) }
  private fun reopen() { helper.close(); open() }
  private fun db() = helper.writableDatabase
  private fun id() = UUID.randomUUID().toString()
  private fun count(table: String, where: String = "1=1") = rows("SELECT COUNT(*) FROM $table WHERE $where").single().single().toInt()
  private fun messageId(reportId: String, revision: Int) = rows("SELECT message_id FROM outbound_envelopes WHERE report_id='$reportId' AND revision=$revision").single().single()
  private fun ack(reportId: String, status: String, at: Long) {
    // Tests that require authoritative closure use an origin-authenticated server observation.
    val ack = ResponderAck(id(),reportId,"SERVER","TEST",status,null,at)
    VictimStatusStore(helper).record(PrivateStatusPage(reportId,1,at,listOf(ack),ack,null),at)
    db().execSQL("INSERT INTO responder_acks(ack_id,report_id,responder_id,status,acknowledged_at) VALUES (?,?,?,?,?)",
      arrayOf<Any>(id(), reportId, "test-responder", status, at))
  }
  private fun installFailure(table: String) {
    db().execSQL("CREATE TRIGGER p08_fail AFTER INSERT ON $table BEGIN SELECT RAISE(ABORT, 'p08 injected interruption'); END")
  }
  private fun removeFailure() { db().execSQL("DROP TRIGGER p08_fail") }
  private fun snapshotOriginal(reportId: String) = listOf(
    rows("SELECT *,hex(envelope_bytes) FROM outbound_envelopes WHERE report_id='$reportId' AND revision=1"),
    rows("SELECT * FROM report_revisions WHERE report_id='$reportId' AND revision=1"),
    rows("SELECT * FROM delivery_attempts ORDER BY attempt_id"),
  )
  private fun snapshotAll() = listOf("reports", "report_revisions", "locations", "outbound_envelopes", "delivery_events", "detail_operations")
    .associateWith { rows("SELECT * FROM $it ORDER BY 1") }
  private fun rows(sql: String): List<List<String>> = db().rawQuery(sql, null).use { cursor ->
    buildList { while (cursor.moveToNext()) add((0 until cursor.columnCount).map {
      if (cursor.isNull(it)) "NULL" else if (cursor.getType(it) == android.database.Cursor.FIELD_TYPE_BLOB)
        cursor.getBlob(it).joinToString(",") else cursor.getString(it)
    }) }
  }
  private fun <T> simultaneously(first: () -> T, second: () -> T): List<T> {
    val ready = CountDownLatch(2)
    val start = CountDownLatch(1)
    val executor = Executors.newFixedThreadPool(2)
    try {
      val futures = listOf(first, second).map { action -> executor.submit(Callable {
        ready.countDown(); check(start.await(10, TimeUnit.SECONDS)); action()
      }) }
      check(ready.await(10, TimeUnit.SECONDS)); start.countDown()
      return futures.map { it.get(30, TimeUnit.SECONDS) }
    } finally { executor.shutdownNow() }
  }
}
