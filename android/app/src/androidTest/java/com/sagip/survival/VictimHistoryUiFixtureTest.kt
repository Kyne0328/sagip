package com.sagip.survival

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Synthetic, isolated-package fixture only. Never operates on a production app or backend. */
@RunWith(AndroidJUnit4::class)
class VictimHistoryUiFixtureTest {
  @Test fun seedSyntheticCachedHistoryForWalkthrough() {
    val context=ApplicationProvider.getApplicationContext<Context>()
    check(context.packageName=="org.sagip.app.sosvalidation")
    check(BackendEndpointConfig.envelopeUrl().contains("10.0.2.2:18080"))
    System.loadLibrary("sqlcipher")
    SagipDatabase(context).use { database ->
      val repository=EmergencyRepository(database)
      val store=VictimStatusStore(database)
      val now=System.currentTimeMillis()
      val previous=repository.createReport(CreateEmergencyReportInput(),null,now-600_000)
      val resolved=ResponderAck(UUID.randomUUID().toString(),previous.reportId,"SERVER","TEST TEAM","RESOLVED",null,now-500_000)
      store.record(PrivateStatusPage(previous.reportId,1,now-400_000,listOf(resolved),resolved,null),now-400_000)
      val current=repository.createReport(CreateEmergencyReportInput(),null,now-300_000)
      repository.appendEmergencyDetails(AppendEmergencyDetailsInput(current.reportId,1,UUID.randomUUID().toString(),
        EmergencyType.FLOOD,"Synthetic test: need help upstairs"),now-290_000)
      val ack=ResponderAck(UUID.randomUUID().toString(),current.reportId,"SERVER","TEST TEAM","ACKNOWLEDGED",null,now-200_000)
      val route=ack.copy(ackId=UUID.randomUUID().toString(),status="EN_ROUTE",acknowledgedAt=now-100_000)
      store.record(PrivateStatusPage(current.reportId,1,now-90_000,listOf(ack,route),route,null),now-90_000)
      store.failed(current.reportId,now-10_000)
      assertTrue(repository.listReports().size>=2)
      assertEquals("EN_ROUTE",store.serverStatus(current.reportId)?.status)
      assertEquals("FAILED",store.syncState(current.reportId).state)
      assertEquals(4,store.history(current.reportId).size)
      assertEquals("DELIVERY_PENDING",repository.getReportSummary(current.reportId).latestDelivery?.deliveryState)
    }
  }
}
