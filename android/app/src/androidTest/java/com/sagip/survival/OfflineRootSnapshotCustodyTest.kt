package com.sagip.survival

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.nio.ByteBuffer
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** SQLCipher logical-node tests. Compiling these is not execution or physical-radio qualification. */
@RunWith(AndroidJUnit4::class)
class OfflineRootSnapshotCustodyTest {
  private val base:Context=ApplicationProvider.getApplicationContext()
  private val nodes=mutableListOf<Node>()
  private lateinit var root:TestIdentity
  private lateinit var checkpointSigner:TestIdentity
  @Before fun setup() {
    check(base.packageName=="org.sagip.app.sosvalidation")
    System.loadLibrary("sqlcipher")
    root=TestIdentity();checkpointSigner=TestIdentity()
  }
  @After fun cleanup() { nodes.forEach { it.close() };nodes.clear() }

  @Test fun feed_bundle_crosses_three_sql_nodes_reopens_and_keeps_original_receipt_and_proof() {
    val origin=node();val gateway=node();val relay=node()
    val report=report(origin,gateway,relay)
    val bundle=snapshot(gateway,report)
    val b=OfflineRootSnapshotCodec.decodeBundle(bundle)
    val p=OfflineRootSnapshotCodec.decodeProof(b.proof)
    var fetches=0
    val feed=ReceiptReturnFeedConfig("snapshot-feed",setOf(p["reportId"]),ReceiptReturnTransport { id,cursor ->
      assertEquals(p["reportId"],id);assertNull(cursor);fetches++
      ReceiptReturnPage(listOf(ReceiptReturnEntry(p["eventId"],digest(b.receipt),b.receipt,bundle)),null)
    })
    val worker=ReceiptReturnWorker(gateway.db,{gateway.service},{feed},{gateway.clock()})
    assertEquals(1,worker.runOnce().stored)
    assertEquals(1,fetches)
    assertArrayEquals(bundle,gateway.queue.getObject(p["proofId"],hash(bundle))!!.bytes)
    assertEquals(BleCustodyCode.ACCEPTED_DURABLE,transfer(gateway,relay,p["proofId"]))
    relay.reopen()
    assertEquals(BleCustodyCode.ACCEPTED_DURABLE,transfer(relay,origin,p["proofId"]))
    origin.reopen()
    val projection=ReceiptRepository(origin.db).projection(p["reportId"])!!
    assertEquals(OfflineRootSnapshotCodec.KIND,projection.verificationKind)
    assertEquals(p.number("authorityCheckedAtMs"),projection.authorityCheckedAtMs)
    assertArrayEquals(b.receipt,ReceiptRepository(origin.db).getReceipt(p["eventId"]))
    assertArrayEquals(bundle,origin.queue.getObject(p["proofId"],hash(bundle))!!.bytes)
    assertEquals(CustodyResultKind.DUPLICATE,origin.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,bundle).kind)
    assertEquals(1,count(origin,"offline_root_evidence"));assertEquals(1,count(origin,"offline_root_streams"))
    assertEquals("VALID_AT_LAST_CHECK",origin.service.offlineEvidenceState(p["eventId"]))
    assertFalse(VictimStatusStore.isResolved(origin.db.readableDatabase,p["reportId"],1))
  }

  @Test fun raw_pending_custody_retries_after_linkage_and_recovers_legacy_pending_peer_rows() {
    val sender=node();val recipient=node()
    val env=report(sender) // The receiver has time, but does not yet have this signed report.
    val bytes=snapshot(sender,env)
    val p=OfflineRootSnapshotCodec.decodeProof(OfflineRootSnapshotCodec.decodeBundle(bytes).proof)
    assertEquals(CustodyResultKind.COMMITTED,sender.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,bytes).kind)
    val peer="peer-"+hex(recipient.identity.keyId).take(8)
    fun leaseBundle(at:Long)=sender.queue.leaseContactWork(peer,at,maxObjects=1,
      eligible={kind,held -> kind==ObjectKind.OFFLINE_ROOT_BUNDLE && sender.service.canForward(kind,held)},
      custodyTimeMs=sender.service.trustedTime()!!.latestMs)
    fun retryAt(peerId:String,kind:ObjectKind,id:String)=sender.db.readableDatabase.rawQuery(
      "SELECT terminal_outcome,next_attempt_at_ms FROM relay_peer_object_state WHERE peer_id=? AND object_kind=? AND object_id=?",
      arrayOf(peerId,kind.wireCode.toString(),id)).use {
        assertTrue(it.moveToFirst());assertTrue("Pending must not make this peer terminal",it.isNull(0));it.getLong(1)
      }
    val lease=leaseBundle(100_000L).single()
    assertEquals(p["proofId"],lease.objectId)
    val entry=sender.queue.inventoryEntry(lease.objectId,lease.digest)!!
    var at=100_002L
    var admission:CustodyResult?=null
    val receiver=BleReceiptExchangeReceiver(admit={kind,received -> recipient.service.admit(kind,received).also { admission=it }},
      alreadyHaveVerified={false},nowProvider={at})
    assertEquals(BleDecisionCode.ACCEPT_TRANSFER,
      receiver.beginOffer("pending-peer",BleReceiptExchangeCodec.encodeOffer(entry,lease.bytes.size)).decision)
    var response:BleCustodyResult?=null
    BleReceiptExchangeCodec.encodeObjectChunks(lease.bytes,64).forEach { chunk ->
      at++;receiver.addChunk("pending-peer",chunk)?.let { response=it }
    }
    assertEquals(CustodyResultKind.PENDING_VERIFICATION,admission!!.kind)
    assertEquals(BleCustodyCode.UNVERIFIED_AUTHORITY,response!!.result)
    assertNull(response!!.custodyReceiptId)
    assertNull(response!!.acceptedAtMs)
    assertEquals(0,count(recipient,"offline_root_evidence"))
    assertEquals(0,count(recipient,"receipt_records"))
    assertNull(recipient.queue.getObject(p["proofId"],hash(bytes)))
    // Exercise the production normalization with the raw peer result, without a retry-mapping helper.
    sender.queue.finishTransfer(lease.leaseId,TransferOutcome.PENDING_VERIFICATION,at+1)
    sender.queue.finishTransfer(lease.leaseId,TransferOutcome.PENDING_VERIFICATION,at+1)
    val after=retryAt(peer,ObjectKind.OFFLINE_ROOT_BUNDLE,p["proofId"])
    assertTrue("retry=" + after + ", completion=" + (at+1), after in (at+1)..(at+1+ReceiptTransferScheduler.BASE_RETRY_MS))
    assertTrue(leaseBundle(after-1).isEmpty())
    sender.db.readableDatabase.rawQuery("SELECT outcome FROM relay_transfer_leases WHERE lease_id=?",arrayOf(lease.leaseId))
      .use { assertTrue(it.moveToFirst());assertEquals("RETRYABLE",it.getString(0)) }
    // Old releases persisted this terminal marker. A reopened sender must recover it too.
    sender.db.writableDatabase.execSQL(
      "UPDATE relay_peer_object_state SET terminal_outcome='PENDING_VERIFICATION' WHERE peer_id=? AND object_kind=4 AND object_id=?",
      arrayOf(peer,p["proofId"]))
    sender.reopen()
    reportTo(recipient,env)
    assertEquals(BleCustodyCode.ACCEPTED_DURABLE,transfer(sender,recipient,p["proofId"],atMs=after))
    recipient.reopen()
    assertArrayEquals(bytes,recipient.queue.getObject(p["proofId"],hash(bytes))!!.bytes)
    assertEquals(1,count(recipient,"offline_root_evidence"))

    val tombstone=revocation(sender.policy,"PROVIDER",hex(provider),2,"b".repeat(64))
    val revocationId=OfflineRootSnapshotCodec.decodeRevocation(tombstone)["revocationId"]
    assertEquals(CustodyResultKind.COMMITTED,sender.service.admit(ObjectKind.OFFLINE_ROOT_REVOCATION,tombstone).kind)
    val revPeer="pending-revocation-peer"
    fun leaseRevocation(now:Long)=sender.queue.leaseContactWork(revPeer,now,maxObjects=1,
      eligible={kind,held -> kind==ObjectKind.OFFLINE_ROOT_REVOCATION && sender.service.canForward(kind,held)},
      custodyTimeMs=sender.service.trustedTime()!!.latestMs)
    val revLease=leaseRevocation(200_000L).single()
    assertEquals(revocationId,revLease.objectId)
    sender.queue.finishTransfer(revLease.leaseId,TransferOutcome.PENDING_VERIFICATION,200_001L)
    val revAfter=retryAt(revPeer,ObjectKind.OFFLINE_ROOT_REVOCATION,revocationId)
    assertTrue("revocation retry=" + revAfter, revAfter in 200_001L..(200_001L+ReceiptTransferScheduler.BASE_RETRY_MS))
    assertTrue(leaseRevocation(revAfter-1).isEmpty())
    sender.db.writableDatabase.execSQL(
      "UPDATE relay_peer_object_state SET terminal_outcome='PENDING_VERIFICATION' WHERE peer_id=? AND object_kind=5 AND object_id=?",
      arrayOf(revPeer,revocationId))
    sender.reopen()
    val recovered=leaseRevocation(revAfter).single()
    assertArrayEquals(tombstone,recovered.bytes)
    sender.queue.releaseTransferLease(recovered.leaseId,revAfter+1)
  }

  @Test fun eligibility_scan_skips_poison_without_phantom_leases_and_aborts_database_faults() {
    fun proofId(bytes:ByteArray)=OfflineRootSnapshotCodec.decodeProof(OfflineRootSnapshotCodec.decodeBundle(bytes).proof)["proofId"]
    fun cursor(n:Node)=n.db.readableDatabase.rawQuery(
      "SELECT lease_row_id FROM receipt_return_replay_state WHERE singleton=1",null)
      .use { if(it.moveToFirst())it.getLong(0) else 0L }
    fun active(n:Node)=n.db.readableDatabase.rawQuery(
      "SELECT COUNT(*) FROM relay_transfer_leases WHERE state='ACTIVE'",null).use { it.moveToFirst();it.getInt(0) }
    val scanner=node();val env=report(scanner)
    val malformed=snapshot(scanner,env,sequence=1)
    val stale=snapshot(scanner,env,sequence=2)
    val receipt=OfflineRootSnapshotCodec.decodeBundle(stale).receipt
    val renewed=bundle(receipt,proof(receipt,scanner.policy,epoch=2,state="b".repeat(64),checked=99_100L))
    for(bytes in listOf(malformed,stale,renewed))
      assertEquals(CustodyResultKind.COMMITTED,scanner.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,bytes).kind)
    scanner.db.writableDatabase.execSQL("UPDATE relay_objects SET object_bytes=? WHERE object_id=?",
      arrayOf(ByteArray(12),proofId(malformed)))
    val seen=mutableListOf<String>()
    val leases=scanner.queue.leaseContactWork("bounded-scan-peer",100_000L,maxObjects=1,
      eligible={kind,held ->
        if(kind!=ObjectKind.OFFLINE_ROOT_BUNDLE) false else {
          seen.add(if(held.size==12)"malformed" else proofId(held))
          scanner.service.canForward(kind,held)
        }
      },custodyTimeMs=scanner.service.trustedTime()!!.latestMs)
    assertEquals(listOf("malformed",proofId(stale),proofId(renewed)),seen)
    val selected=leases.single()
    assertEquals(proofId(renewed),selected.objectId)
    val finalRow=scanner.db.readableDatabase.rawQuery("SELECT rowid FROM relay_objects WHERE object_id=?",
      arrayOf(selected.objectId)).use { assertTrue(it.moveToFirst());it.getLong(0) }
    scanner.reopen()
    scanner.db.readableDatabase.rawQuery("SELECT state,object_id FROM relay_transfer_leases WHERE lease_id=?",
      arrayOf(selected.leaseId)).use {
      assertTrue("A returned lease must actually be committed",it.moveToFirst())
      assertEquals("ACTIVE",it.getString(0));assertEquals(selected.objectId,it.getString(1))
    }
    assertEquals(finalRow,cursor(scanner))
    scanner.queue.releaseTransferLease(selected.leaseId,100_001L)

    val fault=node();val faultEnv=report(fault)
    val first=snapshot(fault,faultEnv,sequence=1)
    val second=snapshot(fault,faultEnv,sequence=2)
    for(bytes in listOf(first,second))
      assertEquals(CustodyResultKind.COMMITTED,fault.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,bytes).kind)
    val beforeCount=count(fault,"relay_transfer_leases")
    val beforeCursor=cursor(fault)
    var earlierCandidateAccepted=false
    var exceptionInjected=false
    val injectedStore=OfflineRootSnapshotStore(fault.db,fault.queue,fault.offline)
    assertThrows(Exception::class.java) {
      fault.queue.leaseContactWork("callback-fault-peer",100_000L,maxObjects=2,
        eligible={kind,held ->
          if(kind!=ObjectKind.OFFLINE_ROOT_BUNDLE) false
          else if(proofId(held)==proofId(second)) injectedStore.canForward(held) {
            exceptionInjected=true
            throw android.database.sqlite.SQLiteException("synthetic eligibility database failure")
          }
          else fault.service.canForward(kind,held).also { earlierCandidateAccepted=it }
        },custodyTimeMs=fault.service.trustedTime()!!.latestMs)
    }
    assertTrue(earlierCandidateAccepted);assertTrue(exceptionInjected)
    fault.reopen()
    assertEquals(0,active(fault))
    assertEquals(beforeCount,count(fault,"relay_transfer_leases"))
    assertEquals(beforeCursor,cursor(fault))

    // Abort the second actual lease INSERT, after the first row exists in the outer transaction.
    fault.db.writableDatabase.execSQL("""
      CREATE TRIGGER test_abort_second_lease BEFORE INSERT ON relay_transfer_leases
      WHEN NEW.peer_id='insertion-fault-peer' AND
        (SELECT COUNT(*) FROM relay_transfer_leases WHERE peer_id='insertion-fault-peer' AND state='ACTIVE')=1
      BEGIN SELECT RAISE(ABORT,'synthetic second lease insert'); END
    """.trimIndent())
    try {
      val failure=assertThrows(Exception::class.java) {
        fault.queue.leaseContactWork("insertion-fault-peer",100_000L,maxObjects=2,
          eligible={kind,held -> kind==ObjectKind.OFFLINE_ROOT_BUNDLE && fault.service.canForward(kind,held)},
          custodyTimeMs=fault.service.trustedTime()!!.latestMs)
      }
      assertTrue(failure.toString().contains("synthetic second lease insert"))
      fault.reopen()
      assertEquals(0,active(fault))
      assertEquals(beforeCount,count(fault,"relay_transfer_leases"))
      assertEquals(beforeCursor,cursor(fault))
    } finally {
      fault.db.writableDatabase.execSQL("DROP TRIGGER IF EXISTS test_abort_second_lease")
    }
    val control=fault.queue.leaseContactWork("control-peer",100_000L,maxObjects=2,
      eligible={kind,held -> kind==ObjectKind.OFFLINE_ROOT_BUNDLE && fault.service.canForward(kind,held)},
      custodyTimeMs=fault.service.trustedTime()!!.latestMs)
    assertEquals(setOf(proofId(first),proofId(second)),control.map { it.objectId }.toSet())
    assertEquals(2,active(fault))
    control.forEach { fault.queue.releaseTransferLease(it.leaseId,100_001L) }
  }

  @Test fun renewal_uses_new_proof_custody_identity_without_resigning_or_reapplying_event() {
    val source=node();val receiver=node();val env=report(source,receiver)
    val first=snapshot(source,env,expires=200_000L)
    val original=OfflineRootSnapshotCodec.decodeBundle(first)
    val renewed=bundle(original.receipt,proof(original.receipt,source.policy,checked=99_100L,expires=300_000L))
    val oldId=OfflineRootSnapshotCodec.decodeProof(original.proof)["proofId"]
    val newId=OfflineRootSnapshotCodec.decodeProof(OfflineRootSnapshotCodec.decodeBundle(renewed).proof)["proofId"]
    assertNotEquals(oldId,newId)
    assertEquals(CustodyResultKind.COMMITTED,source.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,first).kind)
    assertEquals(CustodyResultKind.COMMITTED,source.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,renewed).kind)
    assertEquals(2,count(source,"offline_root_evidence"))
    assertEquals(1,count(source,"offline_root_streams"));assertEquals(1,count(source,"receipt_records"))
    assertTrue(source.service.canForward(ObjectKind.OFFLINE_ROOT_BUNDLE,first))
    assertEquals(BleCustodyCode.ACCEPTED_DURABLE,transfer(source,receiver,newId))
    receiver.reopen()
    assertArrayEquals(original.receipt,ReceiptRepository(receiver.db).getReceipt(OfflineRootSnapshotCodec.decodeProof(original.proof)["eventId"]))
    assertTrue(receiver.service.canForward(ObjectKind.OFFLINE_ROOT_BUNDLE,renewed))
  }

  @Test fun unknown_key_missing_policy_missing_enrollment_and_unqualified_clock_never_create_custody() {
    val n=node();val env=report(n);val bytes=snapshot(n,env)
    n.config=n.config.copy(offlineRoot=null);n.rebind()
    assertPending(n,bytes)
    n.config=n.config.copy(offlineRoot=n.offline.copy(checkpointSignerKeys=emptyMap()));n.rebind()
    assertPending(n,bytes)
    n.config=n.config.copy(offlineRoot=n.offline);n.rebind()
    val valid=n.clockQualification
    val bad=listOf<OfflineRootClockQualification?>(
      null,valid!!.copy(sourceId="UNQUALIFIED"),valid.copy(timeSignerKeyId="0".repeat(64)),
      valid.copy(bootId=UUID.randomUUID().toString()),valid.copy(maximumDriftPpm=101),
      valid.copy(maximumDriftPpm=-1),valid.copy(maximumCheckpointAgeMs=86_400_001),
      valid.copy(maximumCheckpointAgeMs=0),valid.copy(maximumCheckpointAgeMs=1))
    for(q in bad) { n.clockQualification=q;assertPending(n,bytes) }
    n.clockQualification=valid
    val unprovisioned=node(enroll=false);reportTo(unprovisioned,env)
    assertEquals("DOMAIN_NOT_ENROLLED",unprovisioned.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,bytes).reason)
    assertEquals(0,count(unprovisioned,"offline_root_evidence"))
    assertEquals(0,count(n,"offline_root_evidence"));assertEquals(0,count(n,"receipt_records"))
  }

  @Test fun reboot_and_expiry_disable_inventory_forwarding_and_keep_historical_evidence() {
    val n=node();val env=report(n);val bytes=snapshot(n,env,expires=110_000L)
    val p=OfflineRootSnapshotCodec.decodeProof(OfflineRootSnapshotCodec.decodeBundle(bytes).proof)
    assertEquals(CustodyResultKind.COMMITTED,n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,bytes).kind)
    n.reopen()
    assertTrue(n.service.canForward(ObjectKind.OFFLINE_ROOT_BUNDLE,bytes))
    n.boot=UUID.randomUUID().toString();n.elapsed=0
    assertNull(n.service.trustedTime())
    assertFalse(n.service.canForward(ObjectKind.OFFLINE_ROOT_BUNDLE,bytes))
    assertEquals("TIME_UNAVAILABLE",n.service.offlineEvidenceState(p["eventId"]))
    assertFalse(n.queue.contactInventory(eligible=n.service::canForward).any { it.objectId==p["proofId"] })
    n.qualifyTime(serverTime=120_000L)
    assertFalse(n.service.canForward(ObjectKind.OFFLINE_ROOT_BUNDLE,bytes))
    assertEquals("EXPIRED",n.service.offlineEvidenceState(p["eventId"]))
    assertEquals(1,count(n,"offline_root_evidence"))
    assertNotNull(ReceiptRepository(n.db).projection(p["reportId"]))
  }

  @Test fun tamper_wrong_report_private_note_and_forged_signature_do_not_commit_projection() {
    val n=node();val env=report(n);val bytes=snapshot(n,env)
    val b=OfflineRootSnapshotCodec.decodeBundle(bytes)
    val forged=bundle(b.receipt,b.proof.copyOf().also { it[it.size-64]=(it[it.size-64].toInt() xor 1).toByte() })
    assertNotEquals(CustodyResultKind.COMMITTED,n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,forged).kind)
    val r=ReceiptV2Codec.decode(b.receipt).fields as ReceiptFields.Responder
    val note=signedReceipt(n,r.copy(note="Sensitive private note"))
    assertNotEquals(CustodyResultKind.COMMITTED,n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,bundle(note,proof(note,n.policy))).kind)
    val wrong=signedReceipt(n,r.copy(reportId=UUID.randomUUID().toString()))
    assertPending(n,bundle(wrong,proof(wrong,n.policy)))
    assertEquals(0,count(n,"offline_root_evidence"));assertEquals(0,count(n,"receipt_records"))
    assertNull(ReceiptRepository(n.db).projection(r.reportId))
  }

  @Test fun authenticated_revocation_is_durable_without_report_time_or_free_receipt_capacity() {
    val n=node();val env=report(n);val bytes=snapshot(n,env)
    val p=OfflineRootSnapshotCodec.decodeProof(OfflineRootSnapshotCodec.decodeBundle(bytes).proof)
    assertEquals(CustodyResultKind.COMMITTED,n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,bytes).kind)
    n.boot=UUID.randomUUID().toString()
    val revocation=revocation(n.policy,"KEY",hex(root.keyId),epoch=2,state="b".repeat(64))
    assertTrue(n.service.ingestOfflineRootRevocation(revocation))
    assertTrue(n.service.ingestOfflineRootRevocation(revocation))
    n.reopen()
    assertEquals(1,count(n,"offline_root_revocations"))
    assertEquals("REVOKED",n.service.offlineEvidenceState(p["eventId"]))
    assertFalse(n.service.canForward(ObjectKind.OFFLINE_ROOT_BUNDLE,bytes))
    assertFalse(n.service.enrollOfflineRootDomain(1,STATE))
    val empty=node(maxRecords=1)
    assertTrue(empty.service.ingestOfflineRootRevocation(revocation(empty.policy,"PROVIDER",hex(provider),epoch=2,state="b".repeat(64))))
    assertEquals(0,count(empty,"receipt_records"));assertEquals(1,count(empty,"offline_root_revocations"))
  }

  @Test fun signed_revocation_crosses_three_nodes_after_reboot_without_time_or_report_linkage_on_relay() {
    val source=node();val relay=node();val origin=node()
    val env=report(origin,source)
    val snapshot=snapshot(source,env)
    val p=OfflineRootSnapshotCodec.decodeProof(OfflineRootSnapshotCodec.decodeBundle(snapshot).proof)
    assertEquals(CustodyResultKind.COMMITTED,origin.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,snapshot).kind)
    val revocation=revocation(source.policy,"KEY",hex(root.keyId),2,"b".repeat(64))
    val revocationId=OfflineRootSnapshotCodec.decodeRevocation(revocation)["revocationId"]
    for(n in listOf(source,relay,origin)) {
      n.boot=UUID.randomUUID().toString();n.elapsed=0;n.reopen()
      assertNull(n.service.trustedTime())
    }
    assertNull(ReceiptRepository(relay.db).reportIdentity(p["reportId"]))
    assertEquals(CustodyResultKind.COMMITTED,source.service.admit(ObjectKind.OFFLINE_ROOT_REVOCATION,revocation).kind)
    assertTrue(source.service.canForward(ObjectKind.OFFLINE_ROOT_REVOCATION,revocation))
    assertTrue(source.queue.contactInventory(eligible=source.service::canForward).any {
      it.objectKind==ObjectKind.OFFLINE_ROOT_REVOCATION && it.objectId==revocationId
    })
    assertEquals(BleCustodyCode.ACCEPTED_DURABLE,transfer(source,relay,revocationId,ObjectKind.OFFLINE_ROOT_REVOCATION))
    relay.reopen()
    assertEquals(BleCustodyCode.ACCEPTED_DURABLE,transfer(relay,origin,revocationId,ObjectKind.OFFLINE_ROOT_REVOCATION))
    origin.reopen()
    assertEquals(1,count(origin,"offline_root_revocations"))
    assertEquals("REVOKED",origin.service.offlineEvidenceState(p["eventId"]))
    assertFalse(origin.service.canForward(ObjectKind.OFFLINE_ROOT_BUNDLE,snapshot))
    assertEquals(CustodyResultKind.DUPLICATE,origin.service.admit(ObjectKind.OFFLINE_ROOT_REVOCATION,revocation).kind)
    assertArrayEquals(revocation,origin.queue.getObject(revocationId,hash(revocation))!!.bytes)
    val forged=revocation.copyOf().also { it[it.size-64]=(it[it.size-64].toInt() xor 1).toByte() }
    assertEquals(CustodyResultKind.REJECTED,origin.service.admit(ObjectKind.OFFLINE_ROOT_REVOCATION,forged).kind)
    assertEquals(1,count(origin,"offline_root_revocations"))
    assertEquals(CustodyResultKind.REJECTED,origin.queue.admitObject(revocation,ObjectKind.OFFLINE_ROOT_REVOCATION,
      VerificationContext(emptyMap(),emptySet(),emptySet(),null,null,false,null,null)).kind)
  }

  @Test fun epoch_rollback_rejects_and_equivocation_remains_blocked_after_reopen_and_reenrollment() {
    val n=node();val env=report(n);val first=snapshot(n,env)
    val receipt=OfflineRootSnapshotCodec.decodeBundle(first).receipt
    assertEquals(CustodyResultKind.COMMITTED,n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,first).kind)
    val advanced=bundle(receipt,proof(receipt,n.policy,epoch=2,state="b".repeat(64),checked=99_100L))
    assertEquals(CustodyResultKind.COMMITTED,n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,advanced).kind)
    n.reopen()
    assertEquals("SNAPSHOT_ROLLBACK",n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,first).reason)
    val equivocation=bundle(receipt,proof(receipt,n.policy,epoch=2,state="c".repeat(64),checked=99_200L))
    assertEquals("EPOCH_EQUIVOCATION",n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,equivocation).reason)
    n.reopen()
    assertFalse(n.service.enrollOfflineRootDomain(2,"b".repeat(64)))
    assertEquals("AUTHORITY_DOMAIN_CONFLICT",n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,advanced).reason)
    assertFalse(n.service.canForward(ObjectKind.OFFLINE_ROOT_BUNDLE,advanced))
    assertEquals("CONFLICT",n.service.offlineEvidenceState(OfflineRootSnapshotCodec.decodeProof(OfflineRootSnapshotCodec.decodeBundle(first).proof)["eventId"]))
  }

  @Test fun conflicting_proof_id_and_provider_sequence_poison_domain_without_replacing_first_receipt() {
    for(proofConflict in listOf(true,false)) {
      val n=node();val env=report(n);val first=snapshot(n,env)
      val b=OfflineRootSnapshotCodec.decodeBundle(first)
      val p=OfflineRootSnapshotCodec.decodeProof(b.proof)
      assertEquals(CustodyResultKind.COMMITTED,n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,first).kind)
      val other=if(proofConflict)
        bundle(b.receipt,proof(b.receipt,n.policy,id=p["proofId"],checked=99_100L))
      else snapshot(n,env,sequence=1)
      val result=n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,other)
      assertEquals(if(proofConflict)"PROOF_ID_CONFLICT" else "SEQUENCE_CONFLICT",result.reason)
      n.reopen()
      assertArrayEquals(b.receipt,ReceiptRepository(n.db).getReceipt(p["eventId"]))
      assertEquals(1,count(n,"offline_root_evidence"));assertEquals(1,count(n,"offline_root_streams"))
      assertFalse(n.service.canForward(ObjectKind.OFFLINE_ROOT_BUNDLE,first))
    }
  }

  @Test fun full_snapshot_capacity_preserves_evidence_and_does_not_ack_new_custody() {
    for(n in listOf(node(maxRecords=2),node(maxBytes=1))) {
      val env=report(n);val first=snapshot(n,env)
      val outcome=n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,first)
      if(n.offline.maxEvidenceBytes==1L) {
        assertEquals(CustodyResultKind.CAPACITY_FULL,outcome.kind)
        assertEquals(0,count(n,"receipt_records"))
      } else {
        assertEquals(CustodyResultKind.COMMITTED,outcome.kind)
        val second=snapshot(n,env,sequence=2)
        assertEquals(CustodyResultKind.CAPACITY_FULL,n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,second).kind)
        n.reopen()
        assertEquals(1,count(n,"offline_root_evidence"));assertEquals(1,count(n,"receipt_records"))
        assertTrue(n.service.canForward(ObjectKind.OFFLINE_ROOT_BUNDLE,first))
      }
    }
  }

  @Test fun generic_queue_cannot_bypass_durable_snapshot_state_owner() {
    val n=node();val env=report(n);val bytes=snapshot(n,env)
    val context=n.service.contextFor(ObjectKind.OFFLINE_ROOT_BUNDLE,bytes)!!
    val result=n.queue.admitObject(bytes,ObjectKind.OFFLINE_ROOT_BUNDLE,context)
    assertNotEquals(CustodyResultKind.COMMITTED,result.kind)
    assertNotEquals(CustodyResultKind.DUPLICATE,result.kind)
    assertEquals(0,count(n,"offline_root_evidence"));assertEquals(0,count(n,"receipt_records"))
    assertEquals(CustodyResultKind.COMMITTED,n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,bytes).kind)
  }

  @Test fun lost_authority_during_outer_commit_rolls_back_every_new_durable_claim() {
    val n=node();val env=report(n);val bytes=snapshot(n,env)
    val context=n.service.contextFor(ObjectKind.OFFLINE_ROOT_BUNDLE,bytes)!!
    val store=OfflineRootSnapshotStore(n.db,n.queue,n.offline)
    val before=count(n,"relay_objects")
    var calls=0
    val result=store.admit(bytes) { calls++;if(calls==1)context else null }
    assertEquals(2,calls)
    assertEquals("SNAPSHOT_ATOMIC_COMMIT_FAILED",result.reason)
    n.reopen()
    assertEquals(before,count(n,"relay_objects"))
    assertEquals(0,count(n,"offline_root_evidence"));assertEquals(0,count(n,"receipt_records"))
    assertEquals(CustodyResultKind.COMMITTED,n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,bytes).kind)
  }

  @Test fun failed_outer_commit_rolls_back_custody_tombstone_projection_and_replay_together() {
    val n=node();val env=report(n);val bytes=snapshot(n,env)
    val p=OfflineRootSnapshotCodec.decodeProof(OfflineRootSnapshotCodec.decodeBundle(bytes).proof)
    val tables=listOf("relay_objects","relay_object_tombstones","receipt_records","offline_root_evidence","offline_root_streams")
    val before=tables.associateWith { count(n,it) }
    n.db.writableDatabase.execSQL("CREATE TRIGGER reject_snapshot_insert BEFORE INSERT ON offline_root_evidence BEGIN SELECT RAISE(ABORT,'test atomic rollback'); END")
    val result=n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,bytes)
    assertEquals(CustodyResultKind.PENDING_VERIFICATION,result.kind)
    assertEquals("SNAPSHOT_ATOMIC_COMMIT_FAILED",result.reason)
    n.reopen()
    tables.forEach { assertEquals(it,before[it],count(n,it)) }
    assertNull(ReceiptRepository(n.db).projection(p["reportId"]))
    assertNull(n.queue.getObject(p["proofId"],hash(bytes)))
    n.db.writableDatabase.execSQL("DROP TRIGGER reject_snapshot_insert")
    assertEquals(CustodyResultKind.COMMITTED,n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,bytes).kind)
  }

  @Test fun snapshot_resolved_never_closes_and_keeps_server_resolved_history_after_reopen() {
    val n=node();val env=report(n);val id=TransportEnvelopeV1.decode(env).reportId
    n.db.writableDatabase.execSQL(
      "INSERT INTO reports(report_id,created_at,emergency_type,urgency,lifecycle_state) VALUES(?,100000,'MEDICAL','NEED_ASSISTANCE','LOCALLY_COMMITTED')",arrayOf(id))
    n.db.writableDatabase.execSQL(
      "INSERT INTO victim_server_acks(report_id,ack_id,status,acknowledged_at,received_at) VALUES(?,?,'RESOLVED',100000,100000)",
      arrayOf(id,UUID.randomUUID().toString()))
    assertEquals(CustodyResultKind.COMMITTED,n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,snapshot(n,env,status=4)).kind)
    n.reopen()
    assertEquals(OfflineRootSnapshotCodec.KIND,ReceiptRepository(n.db).projection(id)!!.verificationKind)
    assertFalse(VictimStatusStore.isResolved(n.db.readableDatabase,id,1))
    assertEquals("RESOLVED",VictimStatusStore(n.db).serverStatus(id)!!.status)
    assertEquals(1,count(n,"victim_server_acks"))
  }

  @Test fun older_same_epoch_report_survives_later_other_report_checkpoint_but_backward_new_epoch_does_not() {
    val n=node();val firstReport=report(n);val secondReport=report(n)
    val later=snapshot(n,firstReport,checked=99_200L)
    val older=snapshot(n,secondReport,checked=99_000L)
    assertEquals(CustodyResultKind.COMMITTED,n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,later).kind)
    assertEquals(CustodyResultKind.COMMITTED,n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,older).kind)
    assertTrue(n.service.canForward(ObjectKind.OFFLINE_ROOT_BUNDLE,older))
    val receipt=OfflineRootSnapshotCodec.decodeBundle(older).receipt
    val rollback=bundle(receipt,proof(receipt,n.policy,epoch=2,state="b".repeat(64),checked=99_100L))
    assertEquals("SNAPSHOT_ROLLBACK",n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,rollback).reason)
    n.reopen();assertEquals(2,count(n,"offline_root_evidence"))
  }

  private fun assertPending(n:Node,bytes:ByteArray) {
    assertEquals(CustodyResultKind.PENDING_VERIFICATION,n.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,bytes).kind)
    assertFalse(n.service.canForward(ObjectKind.OFFLINE_ROOT_BUNDLE,bytes))
  }
  private fun node(maxRecords:Int=100,maxBytes:Long=8L*1024*1024,enroll:Boolean=true)=
    Node(maxRecords,maxBytes,enroll).also(nodes::add)
  private val provider get()=ReceiptAuthority.issuerProviderId(1,root.keyId,NIL)
  private fun policy(maxRecords:Int)=OfflineRootPolicy("BOUNDED_OFFLINE_ROOT_SNAPSHOT","TEST_AUTHORITY",
    listOf(OfflineRootSignerBinding(hex(checkpointSigner.keyId),hex(root.keyId),hex(provider))),
    listOf("TEST"),listOf(1,2,3,4),900_000,86_400_000,900_000,listOf("TEST_QUALIFIED_CLOCK"),
    "ORIGIN_AND_CUSTODY_RELAYS","KEEP_SEPARATE_NO_AUTOMATIC_CLOSURE","REPORTED_STATUS_ONLY_NO_AUTOMATIC_CLOSURE",maxRecords)

  private inner class Node(maxRecords:Int,maxBytes:Long,enroll:Boolean) {
    val context=IsolatedGatewayTestContext(base)
    val identity=TestIdentity()
    var boot=UUID.randomUUID().toString()
    var elapsed=1_000L
    val policy=policy(maxRecords)
    var clockQualification:OfflineRootClockQualification?=null
    val offline=OfflineRootConfig(policy,mapOf(hex(checkpointSigner.keyId) to checkpointSigner.publicKeyDer),{clockQualification},maxBytes)
    var config=TrustedReceiptReturnConfig(identity.keyId,mapOf(hex(root.keyId) to root.publicKeyDer),setOf("TEST"),{true},offlineRoot=offline)
    var db=SagipDatabase(context)
    var queue=ReceiptQueue(db)
    lateinit var service:TrustedReceiptReturnService
    init { rebind();qualifyTime();if(enroll)assertTrue(service.enrollOfflineRootDomain(1,STATE)) }
    fun clock()=MonotonicClock(boot,elapsed)
    fun rebind() { service=TrustedReceiptReturnService(db,queue,config,::clock) }
    fun qualifyTime(serverTime:Long=100_000L) {
      clockQualification=OfflineRootClockQualification("TEST_QUALIFIED_CLOCK",hex(root.keyId),boot,100,86_400_000L)
      val q=service.beginTimeChallenge()
      val fields=ReceiptFields.Time(q.id,provider,root.keyId,NIL,NIL,q.verifierId,q.verifierBootSessionId,
        q.nonce,ByteArray(32),serverTime,0,10,serverTime+500_000L)
      val proof=ReceiptRepository(db).encodeFresh(fields,ByteArray(0),root)
      assertEquals("ACCEPTED",service.acceptTimeProof(q.id,proof).kind)
    }
    fun reopen() { db.close();db=SagipDatabase(context);queue=ReceiptQueue(db);rebind() }
    fun close() { db.close();context.deleteDatabase(SagipDatabase.DATABASE_NAME) }
  }
  private fun report(vararg owners:Node):ByteArray {
    val envelope=TransportEnvelopeV1.create(EnvelopeUnsignedInput(UUID.randomUUID().toString(),UUID.randomUUID().toString(),
      1,90_000L,550_000L,0,EmergencyPayloadV1.encode(EmergencyType.MEDICAL,Urgency.NEED_ASSISTANCE,null)),owners.first().identity)
    owners.forEach { reportTo(it,envelope) }
    return envelope
  }
  private fun reportTo(n:Node,envelope:ByteArray) {
    assertEquals(CustodyResultKind.COMMITTED,n.service.admit(ObjectKind.SOS,envelope).kind)
  }
  private fun signedReceipt(n:Node,draft:ReceiptFields.Responder)=ReceiptRepository(n.db).encodeFresh(
    draft.copy(actionDigest=ReceiptAuthority.actionDigest(draft)),ByteArray(0),root)
  private fun snapshot(n:Node,env:ByteArray,status:Int=2,sequence:Long=1,checked:Long=99_000L,expires:Long=300_000L):ByteArray {
    val report=TransportEnvelopeV1.decode(env)
    val draft=ReceiptFields.Responder(1,provider,UUID.randomUUID().toString(),ByteArray(32),report.reportId,1,report.revision,
      report.payloadDigest,report.originKeyId,root.keyId,NIL,UUID.nameUUIDFromBytes(root.keyId).toString(),"TEST",
      1,status,sequence,98_000L,400_000L,"")
    val receipt=signedReceipt(n,draft)
    return bundle(receipt,proof(receipt,n.policy,checked=checked,expires=expires))
  }
  private fun proof(receipt:ByteArray,p:OfflineRootPolicy,id:String=UUID.randomUUID().toString(),epoch:Long=1,state:String=STATE,
    checked:Long=99_000L,expires:Long=300_000L):ByteArray {
    val r=ReceiptV2Codec.decode(receipt).fields as ReceiptFields.Responder
    val fields=linkedMapOf<String,Any>("format" to "SAGIP_OFFLINE_ROOT_SNAPSHOT","version" to 1,"algorithm" to 1,
      "proofId" to id,"policyDigest" to OfflineRootSnapshotCodec.policyDigest(p),"authorityDomainId" to p.authorityDomainId,
      "checkpointSignerKeyId" to hex(checkpointSigner.keyId),"receiptRootKeyId" to hex(root.keyId),"issuerProviderId" to hex(provider),
      "receiptDigest" to digest(receipt),"eventId" to r.actionId,"actionDigest" to hex(r.actionDigest),"reportId" to r.reportId,
      "reportProtocolVersion" to r.reportProtocolVersion,"revision" to r.revision,"payloadDigest" to hex(r.payloadDigest),
      "originKeyId" to hex(r.originKeyId),"scope" to "TEST","status" to r.status,"authorityState" to "ACTIVE_AT_CHECKPOINT",
      "authorityStateDigest" to state,"revocationEpoch" to epoch.toString(),"notBeforeMs" to checked-10,
      "authorityCheckedAtMs" to checked,"authorityTimeUncertaintyMs" to 10,"expiresAtMs" to expires)
    return signedObject("SOR1","SAGIP-OFFLINE-ROOT-SNAPSHOT-V1",fields)
  }
  private fun revocation(p:OfflineRootPolicy,kind:String,target:String,epoch:Long,state:String):ByteArray {
    val fields=linkedMapOf<String,Any>("format" to "SAGIP_OFFLINE_ROOT_REVOCATION","version" to 1,"algorithm" to 1,
      "revocationId" to UUID.randomUUID().toString(),"policyDigest" to OfflineRootSnapshotCodec.policyDigest(p),
      "authorityDomainId" to p.authorityDomainId,"checkpointSignerKeyId" to hex(checkpointSigner.keyId),
      "targetKind" to kind,"targetId" to target,"revocationEpoch" to epoch.toString(),"authorityStateDigest" to state,"revokedAtMs" to 100_000)
    return signedObject("SOV1","SAGIP-OFFLINE-ROOT-REVOCATION-V1",fields)
  }
  private fun signedObject(magic:String,domain:String,fields:Map<String,Any>):ByteArray {
    val body=fields.entries.joinToString(",","{","}") {
      "\"" + it.key + "\":" + if(it.value is String) "\"" + it.value + "\"" else it.value.toString()
    }.toByteArray(Charsets.UTF_8)
    val unsigned=magic.toByteArray(Charsets.US_ASCII)+ByteBuffer.allocate(4).putInt(body.size).array()+body
    val signature=StatusRequestProof.canonicalSignature(checkpointSigner.sign(domain.toByteArray(Charsets.US_ASCII)+byteArrayOf(0)+unsigned))
    return unsigned+signature
  }
  private fun bundle(receipt:ByteArray,proof:ByteArray)=
    ByteBuffer.allocate(12).put("SGB1".toByteArray()).putInt(receipt.size).putInt(proof.size).array()+receipt+proof
  private fun count(n:Node,table:String)=n.db.readableDatabase.rawQuery("SELECT COUNT(*) FROM "+table,null).use { it.moveToFirst();it.getInt(0) }
  private fun transfer(from:Node,to:Node,id:String,expectedKind:ObjectKind=ObjectKind.OFFLINE_ROOT_BUNDLE,atMs:Long=100_000L):BleCustodyCode {
    val leases=from.queue.leaseContactWork("peer-"+hex(to.identity.keyId).take(8),atMs,
      eligible=from.service::canForward,custodyTimeMs=from.service.trustedTime()?.latestMs ?: 0L)
    val lease=leases.first { it.objectId==id }
    leases.filter { it.leaseId!=lease.leaseId }.forEach { from.queue.releaseTransferLease(it.leaseId,atMs+1) }
    val entry=from.queue.inventoryEntry(id,lease.digest)!!
    assertEquals(expectedKind,entry.objectKind)
    var at=atMs+2
    val receiver=BleReceiptExchangeReceiver(admit={kind,bytes->to.service.admit(kind,bytes)},alreadyHaveVerified={false},nowProvider={at})
    assertEquals(BleDecisionCode.ACCEPT_TRANSFER,receiver.beginOffer("snapshot-sender",BleReceiptExchangeCodec.encodeOffer(entry,lease.bytes.size)).decision)
    var result:BleCustodyResult?=null
    BleReceiptExchangeCodec.encodeObjectChunks(lease.bytes,64).forEach { chunk ->
      at++;receiver.addChunk("snapshot-sender",chunk)?.let { result=it }
    }
    val custody=result!!
    from.queue.finishTransfer(lease.leaseId,if(custody.result==BleCustodyCode.ACCEPTED_DURABLE)TransferOutcome.PEER_CUSTODY else TransferOutcome.RETRYABLE,at+1)
    return custody.result
  }
  private class TestIdentity:SigningIdentity {
    private val key=KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    override val publicKeyDer=key.public.encoded
    override val keyId=hash(publicKeyDer)
    override fun sign(data:ByteArray)=Signature.getInstance("SHA256withECDSA").run { initSign(key.private);update(data);sign() }
  }
  companion object {
    private const val NIL="00000000-0000-0000-0000-000000000000"
    private const val STATE="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    private fun hash(bytes:ByteArray)=OfflineRootSnapshotCodec.hash(bytes)
    private fun hex(bytes:ByteArray)=OfflineRootSnapshotCodec.hex(bytes)
    private fun digest(bytes:ByteArray)=OfflineRootSnapshotCodec.digest(bytes)
  }
}
