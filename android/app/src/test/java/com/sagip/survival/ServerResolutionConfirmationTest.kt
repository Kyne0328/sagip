package com.sagip.survival

import org.junit.Assert.*
import org.junit.Test

class ServerResolutionConfirmationTest {
  private val id="22222222-2222-2222-2222-222222222222"
  private val event="33333333-3333-4333-8333-333333333333"
  private val nil="00000000-0000-0000-0000-000000000000"
  private val receipt=ReceiptFields.Responder(1,ByteArray(32),event,ByteArray(32),id,1,2,
    ByteArray(32),ByteArray(32),ByteArray(32),nil,"44444444-4444-4444-8444-444444444444","TEAM",1,4,2,1000,2000,"")
  private fun confirms(ack:String=event,status:String="RESOLVED",serverRevision:Int=2,checked:Long=1500,
    complete:Boolean=true,fields:ReceiptFields.Responder=receipt)=ServerResolutionConfirmation.matches(
      id,2,ack,status,serverRevision,checked,complete,fields)

  @Test fun exact_authenticated_current_resolution_supersedes_a_historical_snapshot() {
    assertTrue(confirms())
    // Receipt/proof expiry is not used to erase an independently confirmed online resolution.
    assertTrue(confirms(checked=5000))
  }
  @Test fun cached_history_partial_sync_and_stale_revision_do_not_confirm_closure() {
    assertFalse(confirms(complete=false));assertFalse(confirms(serverRevision=1))
    assertFalse(confirms(checked=999));assertFalse(confirms(status="EN_ROUTE"))
    assertFalse(confirms(ack="different-event"))
  }
  @Test fun mismatched_report_revision_provider_or_status_cannot_unlock_creation() {
    assertFalse(confirms(fields=receipt.copy(reportId="other-report")))
    assertFalse(confirms(fields=receipt.copy(revision=1)))
    assertFalse(confirms(fields=receipt.copy(status=2)))
    assertFalse(confirms(fields=receipt.copy(providerKind=2)))
    assertFalse(confirms(fields=receipt.copy(grantId=event)))
  }
}
