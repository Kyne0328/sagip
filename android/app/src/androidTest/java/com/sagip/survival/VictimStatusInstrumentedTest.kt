package com.sagip.survival

import android.content.Context
import android.content.ContextWrapper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.ByteArrayInputStream
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class VictimStatusInstrumentedTest {
  private val context = object : ContextWrapper(ApplicationProvider.getApplicationContext<Context>()) {
    override fun getApplicationContext(): Context = this
    override fun getDatabasePath(name: String): File = super.getDatabasePath("victim-status-$name")
    override fun deleteDatabase(name: String): Boolean = super.deleteDatabase("victim-status-$name")
  }
  private lateinit var db: SagipDatabase
  private lateinit var repository: EmergencyRepository
  private lateinit var store: VictimStatusStore
  @Before fun before() {
    check(context.packageName == "org.sagip.app.sosvalidation")
    System.loadLibrary("sqlcipher")
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
    open()
  }
  @After fun after() { db.close();context.deleteDatabase(SagipDatabase.DATABASE_NAME) }
  private fun open() { db=SagipDatabase(context);repository=EmergencyRepository(db);store=VictimStatusStore(db) }
  private fun reopen() { db.close();open() }
  private fun id() = UUID.randomUUID().toString()
  private fun report() = repository.createReport(CreateEmergencyReportInput(),null,100)
  private fun ack(report: String,status: String,at: Long=1000) = ResponderAck(id(),report,"SERVER","TEAM-1",status,null,at)
  private fun page(report: String,acks: List<ResponderAck>,at:Long=2000,cursor:String?=null) =
    PrivateStatusPage(report,1,at,acks,acks.maxByOrNull { it.acknowledgedAt },cursor)

  @Test fun unsignedResolvedAckNeverClosesOrStopsUpload() {
    val r=report()
    repository.recordResponderAck(ack(r.reportId,"RESOLVED"),110)
    assertEquals(r.reportId,report().reportId)
    assertEquals("DELIVERY_PENDING",repository.getReportSummary(r.reportId).deliveryState)
    val details=repository.appendEmergencyDetails(AppendEmergencyDetailsInput(r.reportId,1,id(),message="Need water"),120)
    assertEquals(2,details.latestRevision)
    assertEquals(listOf("LOCAL_COMMIT","RESPONDER_UPDATE","DETAILS_SAVED").sorted(),
      store.history(r.reportId).map { it.kind }.sorted())
    assertEquals("UNVERIFIED",store.history(r.reportId).single { it.kind=="RESPONDER_UPDATE" }.provenance)
    assertNull(store.syncState(r.reportId).lastSuccessAt)
  }

  @Test fun authenticatedReportWideResolutionSurvivesReopenAndDoesNotAcknowledgeDetails() {
    val r=report()
    repository.appendEmergencyDetails(AppendEmergencyDetailsInput(r.reportId,1,id(),message="Need water"),120)
    val resolved=ack(r.reportId,"RESOLVED")
    store.record(page(r.reportId,listOf(resolved)),2100)
    reopen()
    assertEquals("RESOLVED",store.serverStatus(r.reportId)?.status)
    assertEquals("DELIVERY_PENDING",repository.getReportSummary(r.reportId).latestDelivery?.deliveryState)
    assertThrows(EmergencyDetailsException::class.java) {
      repository.appendEmergencyDetails(AppendEmergencyDetailsInput(r.reportId,2,id(),message="Late"),2200)
    }
    assertNotEquals(r.reportId,repository.createReport(CreateEmergencyReportInput(),null,2300).reportId)
    assertEquals(2,repository.listReports().size)
    assertEquals(2100L,store.syncState(r.reportId).lastSuccessAt)
    assertEquals("SERVER_AUTHENTICATED",store.history(r.reportId).single { it.kind=="RESPONDER_UPDATE" }.provenance)
  }

  @Test fun pagedHistoryRetryIsDurableDeduplicatedAndFreshOnlyWhenComplete() {
    val r=report();val first=ack(r.reportId,"ACKNOWLEDGED",1000);val second=ack(r.reportId,"EN_ROUTE",1100)
    store.record(page(r.reportId,listOf(first),2000,first.ackId),2100)
    reopen()
    assertEquals(first.ackId,store.cursor(r.reportId))
    assertNull(store.syncState(r.reportId).lastSuccessAt)
    store.failed(r.reportId,2200)
    assertEquals("FAILED",store.syncState(r.reportId).state)
    store.record(page(r.reportId,listOf(first,second),2300),2400)
    store.record(page(r.reportId,listOf(first,second),2400),2500)
    reopen()
    assertNull(store.cursor(r.reportId))
    assertEquals(2,store.history(r.reportId).count { it.provenance=="SERVER_AUTHENTICATED" })
    assertEquals("EN_ROUTE",store.serverStatus(r.reportId)?.status)
    assertEquals(2500L,store.syncState(r.reportId).lastSuccessAt)
    store.failed(r.reportId,2600)
    assertEquals(2500L,store.syncState(r.reportId).lastSuccessAt)
    assertEquals("FAILED",store.syncState(r.reportId).state)
  }

  @Test fun stalePagesAndConflictingEventsCannotAdvanceCursorOrRegressStatus() {
    val r=report();val enroute=ack(r.reportId,"EN_ROUTE",1000)
    store.record(page(r.reportId,listOf(enroute),2000),2100)
    assertThrows(IllegalStateException::class.java) { store.record(page(r.reportId,listOf(ack(r.reportId,"ACKNOWLEDGED")),1999),2200) }
    assertThrows(IllegalStateException::class.java) { store.record(page(r.reportId,listOf(enroute.copy(status="RESOLVED")),2300,id()),2400) }
    assertNull(store.cursor(r.reportId))
    assertEquals(2100L,store.syncState(r.reportId).lastSuccessAt)
    store.record(page(r.reportId,listOf(ack(r.reportId,"ACKNOWLEDGED",3000)),3000),3100)
    assertEquals("EN_ROUTE",store.serverStatus(r.reportId)?.status)
  }

  @Test fun migrationRecoversWorkSuppressedByLegacyUnsignedAckWithoutDeletingHistory() {
    val r=report();repository.recordResponderAck(ack(r.reportId,"RESOLVED"),110)
    db.writableDatabase.execSQL("UPDATE outbound_envelopes SET delivery_state='RESPONDER_ACKNOWLEDGED',next_attempt_at=99999")
    db.writableDatabase.execSQL("UPDATE reports SET lifecycle_state='RESPONDER_ACKNOWLEDGED'")
    db.writableDatabase.execSQL("DROP TABLE victim_server_acks")
    db.writableDatabase.execSQL("DROP TABLE victim_status_sync")
    db.writableDatabase.version=17
    reopen()
    assertEquals(18,db.readableDatabase.version)
    assertEquals("DELIVERY_PENDING",repository.getReportSummary(r.reportId).deliveryState)
    assertEquals(r.reportId,report().reportId)
    assertEquals(1,store.history(r.reportId).count { it.provenance=="UNVERIFIED" })
  }

  @Test fun migrationPreservesServerAcceptedTransportWithoutInventingLifecycleValue() {
    val r=report()
    val message=repository.listEnvelopePreparationSources().single().messageId
    repository.markEnvelopeReady(message,byteArrayOf(1),105)
    repository.markServerAccepted(ServerReceipt(1,"SERVER_ACCEPTED",id(),message,r.reportId,1,
      "2026-10-05T03:00:00.000Z"),110)
    repository.recordResponderAck(ack(r.reportId,"RESOLVED"),120)
    db.writableDatabase.execSQL("UPDATE outbound_envelopes SET delivery_state='RESPONDER_ACKNOWLEDGED'")
    db.writableDatabase.execSQL("UPDATE reports SET lifecycle_state='RESPONDER_ACKNOWLEDGED'")
    db.writableDatabase.execSQL("DROP TABLE victim_server_acks")
    db.writableDatabase.execSQL("DROP TABLE victim_status_sync")
    db.writableDatabase.version=17
    reopen()
    val restored=repository.listReports().single()
    assertEquals("LOCALLY_COMMITTED",restored.lifecycleState)
    assertEquals("SERVER_ACCEPTED",restored.deliveryState)
    assertEquals(r.reportId,report().reportId)
    assertEquals(1,store.history(r.reportId).count { it.provenance=="UNVERIFIED" })
  }

  @Test fun strictBoundedParserPreservesEscapesAndRejectsMismatchedReportOrStatus() {
    val r=id();val a=id()
    val json="""{"reportId":"$r","serverAccepted":true,"transport":"AUTHENTICATED_SERVER","statusScope":"REPORT","currentRevision":1,"checkedAt":"2026-10-05T03:00:00.000Z","latestAck":null,"nextCursor":null,"acknowledgements":[{"ackId":"$a","revision":null,"callsign":"TEAM-\"A\"","status":"EN_ROUTE","note":null,"acknowledgedAt":"2026-10-05T02:00:00.000Z"}]}"""
    val parsed=HttpPrivateReportStatusSender.parse(r,json)
    assertEquals("TEAM-\"A\"",parsed.acknowledgements.single().callsign)
    assertThrows(IllegalArgumentException::class.java) { HttpPrivateReportStatusSender.parse(id(),json) }
    assertThrows(IllegalArgumentException::class.java) { HttpPrivateReportStatusSender.parse(r,json.replace("EN_ROUTE","UNTRUSTED")) }
    assertThrows(IllegalArgumentException::class.java) { HttpPrivateReportStatusSender.parse(r,json+"{}") }
    assertThrows(IllegalArgumentException::class.java) {
      HttpPrivateReportStatusSender.readBounded(ByteArrayInputStream(ByteArray(HttpPrivateReportStatusSender.MAX_BYTES+1)))
    }
  }

  @Test fun workerResumesPersistedPageAndStopsAfterCompletePage() = runBlocking {
    val r=report();val first=ack(r.reportId,"RESOLVED")
    db.writableDatabase.execSQL("UPDATE outbound_envelopes SET preparation_state='READY',envelope_bytes=x'01'")
    store.record(page(r.reportId,listOf(first),2000,first.ackId),2100)
    reopen()
    var requests=0
    val sender=object:PrivateReportStatusSender {
      override suspend fun fetchPrivateReportStatus(reportId:String,cursor:String?):PrivateStatusPage {
        requests++
        assertEquals(first.ackId,cursor)
        return page(r.reportId,listOf(ack(r.reportId,"EN_ROUTE",3000)),34000)
      }
    }
    VictimStatusWorker(store,sender) { 35000 }.runOnce(35000)
    assertEquals(1,requests)
    assertNull(store.cursor(r.reportId))
    assertEquals("SUCCESS",store.syncState(r.reportId).state)
  }
}
