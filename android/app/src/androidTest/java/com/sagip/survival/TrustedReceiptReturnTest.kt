package com.sagip.survival

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.nio.ByteBuffer
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Logical nodes have separate SQLCipher stores. This does not claim physical BLE/radio qualification. */
@RunWith(AndroidJUnit4::class)
class TrustedReceiptReturnTest {
  private val base: Context = ApplicationProvider.getApplicationContext()
  private val nodes = mutableListOf<Node>()
  private lateinit var root: TestIdentity
  @Before fun setup() { check(base.packageName == "org.sagip.app.sosvalidation"); System.loadLibrary("sqlcipher"); root = TestIdentity() }
  @After fun cleanup() { nodes.forEach { it.close() }; nodes.clear() }

  @Test fun delegated_feed_crosses_three_nodes_and_survives_restart_without_reissuing() {
    val origin = node(); val gateway = node(); val relay = node()
    val envelope = envelope(origin.identity)
    listOf(origin, gateway, relay).forEach { assertEquals(CustodyResultKind.COMMITTED, it.service.admit(ObjectKind.SOS, envelope).kind) }
    val receipt = receipt(gateway, envelope)
    val fields = ReceiptV2Codec.decode(receipt).fields as ReceiptFields.Responder
    var fetches = 0
    val config = ReceiptReturnFeedConfig("test-feed", setOf(fields.reportId), ReceiptReturnTransport { report, cursor ->
      assertEquals(fields.reportId, report); assertNull(cursor); fetches++
      ReceiptReturnPage(listOf(entry(receipt)), null)
    })
    val worker = ReceiptReturnWorker(gateway.db, { gateway.service }, { config }, { gateway.clock() })
    assertEquals(1, worker.runOnce().stored)
    assertEquals(1, fetches)
    assertArrayEquals(receipt, gateway.queue.getObject(fields.actionId, hash(receipt))!!.bytes)
    assertEquals(BleCustodyCode.ACCEPTED_DURABLE, transfer(gateway, relay, fields.actionId))
    relay.reopen()
    assertEquals(BleCustodyCode.ACCEPTED_DURABLE, transfer(relay, origin, fields.actionId))
    origin.reopen()
    val projection = ReceiptRepository(origin.db).projection(fields.reportId)!!
    assertEquals("VERIFIED_OFFLINE_AUTHORITY", projection.verificationKind)
    assertNull(projection.authorityCheckedAtMs) // A fetched object is not a live revocation check.
    assertArrayEquals(receipt, ReceiptRepository(origin.db).getReceipt(fields.actionId))
    assertEquals(CustodyResultKind.DUPLICATE, origin.service.admit(ObjectKind.RESPONDER_RECEIPT, receipt).kind)
    assertFalse(VictimStatusStore.isResolved(origin.db.readableDatabase, fields.reportId, 1))
    gateway.elapsed += 31_000
    assertEquals(1, worker.runOnce().stored) // Exact replay after reconnect, not a new action.
    assertEquals(1, rowCount(origin, "receipt_records"))
  }

  @Test fun two_node_return_and_missing_path_do_not_fabricate_delivery() {
    val origin = node(); val gateway = node()
    val envelope = envelope(origin.identity)
    listOf(origin, gateway).forEach { it.service.admit(ObjectKind.SOS, envelope) }
    val bytes = receipt(gateway, envelope, status = 4)
    val f = ReceiptV2Codec.decode(bytes).fields as ReceiptFields.Responder
    assertEquals(CustodyResultKind.COMMITTED, gateway.service.admit(ObjectKind.RESPONDER_RECEIPT, bytes).kind)
    assertNull(ReceiptRepository(origin.db).projection(f.reportId)) // No contact, no immediate update.
    assertEquals(BleCustodyCode.ACCEPTED_DURABLE, transfer(gateway, origin, f.actionId))
    assertTrue(VictimStatusStore.isResolved(origin.db.readableDatabase, f.reportId, 1))
  }

  @Test fun queued_unknown_revision_retries_after_linkage_and_old_resolution_stays_historical() {
    val origin = node(); val signer = node()
    val reportId = UUID.randomUUID().toString()
    val revision1 = envelope(origin.identity, reportId, 1)
    val revision2 = envelope(origin.identity, reportId, 2)
    origin.service.admit(ObjectKind.SOS, revision1)
    val latest = receipt(signer, revision2, status = 2, sequence = 2)
    val oldResolution = receipt(signer, revision1, status = 4)
    assertEquals(CustodyResultKind.PENDING_VERIFICATION, origin.service.admit(ObjectKind.RESPONDER_RECEIPT, latest).kind)
    assertEquals(0, rowCount(origin, "receipt_records"))
    origin.service.admit(ObjectKind.SOS, revision2)
    assertEquals(1, origin.service.retryPending())
    assertEquals(2, ReceiptRepository(origin.db).projection(reportId)!!.revision)
    assertEquals(ReceiptApplication.HISTORICAL, origin.service.admit(ObjectKind.RESPONDER_RECEIPT, oldResolution).localApplication)
    assertFalse(VictimStatusStore.isResolved(origin.db.readableDatabase, reportId, 2))
    assertEquals(2, rowCount(origin, "receipt_records"))
  }

  @Test fun forgery_digest_scope_revocation_expiry_and_reboot_fail_closed() {
    val origin = node(); val signer = node()
    val envelope = envelope(origin.identity)
    origin.service.admit(ObjectKind.SOS, envelope)
    val valid = receipt(signer, envelope)
    var liveChecks=0
    origin.config = origin.config.copy(currentAuthorityCheck={ liveChecks++; null })
    origin.rebind()
    val f = ReceiptV2Codec.decode(valid).fields as ReceiptFields.Responder
    val forged = valid.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
    assertEquals(CustodyResultKind.REJECTED, origin.service.admit(ObjectKind.RESPONDER_RECEIPT, forged).kind)
    val wrong = f.copy(actionId=UUID.randomUUID().toString(), payloadDigest=ByteArray(32))
    val wrongBytes = signer.sign(wrong.copy(actionDigest=ReceiptAuthority.actionDigest(wrong)), ReceiptV2Codec.decode(valid).proof, signer.identity)
    assertEquals(CustodyResultKind.PENDING_VERIFICATION, origin.service.admit(ObjectKind.RESPONDER_RECEIPT, wrongBytes).kind)
    origin.revoked = setOf(f.grantId)
    assertEquals(CustodyResultKind.PENDING_VERIFICATION, origin.service.admit(ObjectKind.RESPONDER_RECEIPT, valid).kind)
    origin.revoked = emptySet()
    origin.config = origin.config.copy(scopes=setOf("OTHER_TEST")); origin.rebind()
    assertEquals(CustodyResultKind.PENDING_VERIFICATION, origin.service.admit(ObjectKind.RESPONDER_RECEIPT, valid).kind)
    origin.config = origin.config.copy(scopes=setOf("TEST")); origin.rebind()
    assertEquals(CustodyResultKind.COMMITTED, origin.service.admit(ObjectKind.RESPONDER_RECEIPT, valid).kind)
    assertTrue(origin.service.canForward(ObjectKind.RESPONDER_RECEIPT, valid))
    origin.revoked = setOf(f.grantId)
    assertFalse(origin.service.canForward(ObjectKind.RESPONDER_RECEIPT, valid))
    origin.revoked = emptySet()
    origin.elapsed += 301_000
    assertFalse(origin.service.canForward(ObjectKind.RESPONDER_RECEIPT, valid))
    origin.boot = UUID.randomUUID().toString()
    assertNull(origin.service.baseContext())
    assertFalse(origin.service.canForward(ObjectKind.RESPONDER_RECEIPT, valid))
    assertNotNull(ReceiptRepository(origin.db).getReceipt(f.actionId)) // Qualified saved history remains.
    assertEquals(0,liveChecks)
  }

  @Test fun root_receipt_is_pending_without_exact_current_authority_even_after_authenticated_fetch() {
    val origin = node(); val issuer = node()
    val envelope = envelope(origin.identity); origin.service.admit(ObjectKind.SOS, envelope)
    val bytes = receipt(issuer, envelope, cloud = true)
    val f = ReceiptV2Codec.decode(bytes).fields as ReceiptFields.Responder
    val config = ReceiptReturnFeedConfig("root-test", setOf(f.reportId), ReceiptReturnTransport { _, _ ->
      ReceiptReturnPage(listOf(entry(bytes)), null)
    })
    val result = ReceiptReturnWorker(origin.db, { origin.service }, { config }, { origin.clock() }).runOnce()
    assertEquals(1, result.pending)
    assertEquals(0, rowCount(origin, "receipt_records"))
    assertFalse(origin.service.canForward(ObjectKind.RESPONDER_RECEIPT, bytes))
    origin.config = origin.config.copy(currentAuthorityCheck={ candidate ->
      CurrentReceiptAuthorityEvidence(hash(candidate), origin.boot, origin.elapsed, 100_000L)
    })
    origin.rebind()
    assertEquals(CustodyResultKind.COMMITTED, origin.service.admit(ObjectKind.RESPONDER_RECEIPT, bytes).kind)
    origin.elapsed++
    origin.config = origin.config.copy(currentAuthorityCheck={ candidate ->
      CurrentReceiptAuthorityEvidence(hash(candidate), origin.boot, origin.elapsed - 1, 100_000L)
    }); origin.rebind()
    assertFalse(origin.service.canForward(ObjectKind.RESPONDER_RECEIPT, bytes))
  }

  @Test fun relay_capacity_reports_local_acceptance_and_storage_failure_rolls_back_projection() {
    val origin = node(); val signer = node()
    val envelope = envelope(origin.identity); origin.service.admit(ObjectKind.SOS, envelope)
    val bytes = receipt(signer, envelope)
    val fullQueue = ReceiptQueue(origin.db, ReceiptQueueLimits(activeObjects=0))
    val full = fullQueue.admitObject(bytes, ObjectKind.RESPONDER_RECEIPT, origin.service.contextFor(ObjectKind.RESPONDER_RECEIPT, bytes)!!)
    assertEquals(CustodyResultKind.CAPACITY_FULL, full.kind)
    assertEquals(ReceiptApplication.APPLIED, full.localApplication)
    assertNotNull(ReceiptRepository(origin.db).getReceipt(entry(bytes).eventId))
    val second = receipt(signer, envelope, sequence=2)
    origin.db.writableDatabase.execSQL("CREATE TRIGGER fail_return_insert BEFORE INSERT ON relay_objects BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    assertThrows(Exception::class.java) { origin.service.admit(ObjectKind.RESPONDER_RECEIPT, second) }
    assertNull(ReceiptRepository(origin.db).getReceipt(entry(second).eventId))
    assertEquals(entry(bytes).eventId, ReceiptRepository(origin.db).projection(TransportEnvelopeV1.decode(envelope).reportId)!!.eventId)
  }

  @Test fun conflicting_providers_and_online_status_cannot_silently_close_current_report() {
    val origin = node(); val a = node(); val b = node()
    val envelope = envelope(origin.identity); origin.service.admit(ObjectKind.SOS, envelope)
    val reportId = TransportEnvelopeV1.decode(envelope).reportId
    origin.service.admit(ObjectKind.RESPONDER_RECEIPT, receipt(a, envelope, status=4))
    origin.service.admit(ObjectKind.RESPONDER_RECEIPT, receipt(b, envelope, status=2))
    assertTrue(VictimStatusStore(origin.db).providerConflict(reportId,1))
    assertFalse(VictimStatusStore.isResolved(origin.db.readableDatabase,reportId,1))
    val other = node(); other.service.admit(ObjectKind.SOS,envelope)
    other.service.admit(ObjectKind.RESPONDER_RECEIPT,receipt(a,envelope,status=2,sequence=2))
    other.db.writableDatabase.execSQL(
      "INSERT INTO reports(report_id,created_at,emergency_type,urgency,lifecycle_state) VALUES(?,100000,'MEDICAL','NEED_ASSISTANCE','LOCALLY_COMMITTED')", arrayOf(reportId))
    other.db.writableDatabase.execSQL(
      "INSERT INTO victim_server_acks(report_id,ack_id,status,acknowledged_at,received_at) VALUES(?,?,'RESOLVED',100000,100000)",
      arrayOf(reportId,UUID.randomUUID().toString()))
    assertTrue(VictimStatusStore(other.db).providerConflict(reportId,1))
    assertFalse(VictimStatusStore.isResolved(other.db.readableDatabase,reportId,1))
    assertFalse(VictimStatusStore(other.db).providerConflict(reportId,2))
  }

  @Test fun poison_quarantine_does_not_starve_later_valid_or_locally_signed_work() {
    val origin=node();val signer=node()
    val envelope=envelope(origin.identity);origin.service.admit(ObjectKind.SOS,envelope)
    repeat(20) { index ->
      val invalid=byteArrayOf(1,2,index.toByte())
      origin.db.writableDatabase.execSQL(
        "INSERT INTO receipt_quarantine(object_digest,object_bytes,reason,received_at_ms) VALUES(?,?,'TEST_POISON',?)",
        arrayOf(hash(invalid),invalid,index))
    }
    val bytes=receipt(signer,envelope)
    origin.revoked=setOf((ReceiptV2Codec.decode(bytes).fields as ReceiptFields.Responder).grantId)
    origin.service.admit(ObjectKind.RESPONDER_RECEIPT,bytes)
    origin.revoked=emptySet()
    repeat(3) { origin.service.retryPending(8) }
    assertNotNull(origin.queue.getObject(entry(bytes).eventId,hash(bytes)))
  }

  @Test fun feed_cursor_survives_restart_and_mismatch_never_advances_it() {
    val node=node();val signer=node()
    val envelope=envelope(node.identity);node.service.admit(ObjectKind.SOS,envelope)
    val report=TransportEnvelopeV1.decode(envelope).reportId
    val one=receipt(signer,envelope);val two=receipt(signer,envelope,status=3,sequence=2)
    val cursor=entry(one).eventDigest
    var secondAttempts=0
    val config=ReceiptReturnFeedConfig("paged-test",setOf(report),ReceiptReturnTransport { _, after ->
      if(after==null) ReceiptReturnPage(listOf(entry(one)),cursor)
      else { assertEquals(cursor,after);secondAttempts++;throw IllegalStateException("synthetic disconnect") }
    })
    assertEquals(1,ReceiptReturnWorker(node.db,{node.service},{config},{node.clock()}).runOnce().stored)
    assertEquals(cursor,node.db.readableDatabase.rawQuery("SELECT cursor FROM receipt_return_sync",null).use { it.moveToFirst();it.getString(0) })
    node.reopen();node.elapsed+=31_000
    val resumed=config.copy(transport=ReceiptReturnTransport { _, after ->
      assertEquals(cursor,after);ReceiptReturnPage(listOf(entry(two).copy(eventDigest="0".repeat(64))),null)
    })
    assertEquals(1,ReceiptReturnWorker(node.db,{node.service},{resumed},{node.clock()}).runOnce().retryable)
    assertNull(ReceiptRepository(node.db).getReceipt(entry(two).eventId))
    node.elapsed+=31_000
    val correct=resumed.copy(transport=ReceiptReturnTransport { _, after ->
      assertEquals(cursor,after);ReceiptReturnPage(listOf(entry(two)),null)
    })
    assertEquals(1,ReceiptReturnWorker(node.db,{node.service},{correct},{node.clock()}).runOnce().stored)
    assertEquals(1,secondAttempts)
  }

  @Test fun inventory_filter_precedes_limit_and_default_runtime_remains_disabled() {
    val node=node();val signer=node()
    val envelope=envelope(node.identity);node.service.admit(ObjectKind.SOS,envelope)
    repeat(35) { node.service.admit(ObjectKind.RESPONDER_RECEIPT,receipt(signer,envelope,sequence=it+1L)) }
    val target=receipt(signer,envelope,sequence=36)
    node.service.admit(ObjectKind.RESPONDER_RECEIPT,target)
    val id=entry(target).eventId
    var checks=0
    val result=(1..2).flatMap { node.queue.contactInventory(1) { _, bytes -> checks++; hash(bytes).contentEquals(hash(target)) } }
    assertTrue(checks <= 64) // At most 32 expensive verification checks per contact request.
    assertEquals(id,result.single().objectId)
    withIsolatedRuntime { runtime ->
      assertNull(runtime.receiptReturn)
      assertFalse(runtime.receiptReturnWorker.runOnce().enabled)
    }
  }

  @Test fun authority_use_advances_persisted_high_water_before_a_new_challenge() {
    val node=node()
    node.elapsed += 60_000
    val advanced=node.service.trustedTime()!!
    node.reopen()
    val q=node.service.beginTimeChallenge()
    assertEquals(advanced.earliestMs,q.highWaterEarliestMs)
    val rollback=node.sign(ReceiptFields.Time(q.id,ReceiptAuthority.issuerProviderId(1,root.keyId,NIL),
      root.keyId,NIL,NIL,q.verifierId,q.verifierBootSessionId,q.nonce,ByteArray(32),
      110_000L,0,10,600_000L),ByteArray(0),root)
    assertEquals("REJECTED",node.service.acceptTimeProof(q.id,rollback).kind)
    assertTrue(node.service.trustedTime()!!.earliestMs >= advanced.earliestMs)
  }

  @Test fun additive_migration_preserves_signed_history_and_default_time_gate_never_blocks_sos() {
    val node=node();val signer=node()
    val envelope=envelope(node.identity);node.service.admit(ObjectKind.SOS,envelope)
    val receipt=receipt(signer,envelope);node.service.admit(ObjectKind.RESPONDER_RECEIPT,receipt)
    node.db.writableDatabase.execSQL("DROP TABLE receipt_return_sync")
    node.db.writableDatabase.execSQL("DROP TABLE receipt_return_replay_state")
    node.db.writableDatabase.version=18
    node.reopen()
    assertEquals(19,node.db.readableDatabase.version)
    assertArrayEquals(receipt,ReceiptRepository(node.db).getReceipt(entry(receipt).eventId))
    withIsolatedRuntime { runtime ->
    try {
      runtime.configureReceiptReturn(TrustedReceiptReturnConfig(node.identity.keyId,
        mapOf(hex(root.keyId) to root.publicKeyDer),setOf("TEST"),{false}))
      assertNull(runtime.receiptReturn!!.baseContext())
      assertTrue(runtime.receiptForwardAllowed(ObjectKind.SOS,envelope))
      assertFalse(runtime.receiptForwardAllowed(ObjectKind.RESPONDER_RECEIPT,receipt))
    } finally { runtime.disableReceiptReturn() }
    }
  }

  @Test fun actual_http_page_decoder_accepts_backend_shape_and_rejects_malformed_bounds() {
    val node=node();val bytes=receipt(node,envelope(node.identity))
    val item=entry(bytes)
    val transport=HttpReceiptReturnTransport("https://synthetic.invalid") { "UNUSED_TEST_TOKEN" }
    fun json(encoded:String=android.util.Base64.encodeToString(bytes,android.util.Base64.NO_WRAP))=
      org.json.JSONObject().put("entries",org.json.JSONArray().put(org.json.JSONObject()
        .put("eventId",item.eventId).put("eventDigest",item.eventDigest).put("bytesBase64",encoded)))
        .put("nextCursor",org.json.JSONObject.NULL)
    assertArrayEquals(bytes,transport.decodePage(json().toString().toByteArray()).entries.single().bytes)
    assertEquals(item.eventDigest,transport.decodePage(org.json.JSONObject().put("entries",org.json.JSONArray())
      .put("nextCursor",item.eventDigest).toString().toByteArray()).nextCursor)
    assertThrows(IllegalArgumentException::class.java) { transport.decodePage(ByteArray(262_145)) }
    assertThrows(Exception::class.java) { transport.decodePage(json("invalid-base64").toString().toByteArray()) }
    assertThrows(Exception::class.java) { transport.decodePage(json().put("verification","VERIFIED_CURRENT").toString().toByteArray()) }
    assertThrows(Exception::class.java) { transport.decodePage(byteArrayOf(0xff.toByte())) }
    assertThrows(IllegalArgumentException::class.java) { HttpReceiptReturnTransport("http://synthetic.invalid") { "UNUSED" } }
  }

  @Test fun outstanding_challenge_admission_is_bounded_and_does_not_evict_nonce_history() {
    val node=node()
    repeat(128) { node.service.beginTimeChallenge() }
    assertThrows(IllegalStateException::class.java) { node.service.beginTimeChallenge() }
    assertEquals(129,rowCount(node,"receipt_time_challenges")) // One consumed qualification proof.
  }

  @Test fun same_payload_identities_are_distinct_and_wrong_origin_or_revision_conflicts_roll_back() {
    val node=node();val other=TestIdentity();val report=UUID.randomUUID().toString()
    val first=envelope(node.identity,report,1)
    val second=envelope(node.identity,report,2)
    val independent=envelope(node.identity)
    listOf(first,second,independent).forEach {
      assertEquals(CustodyResultKind.COMMITTED,node.service.admit(ObjectKind.SOS,it).kind)
    }
    val repository=ReceiptRepository(node.db)
    assertNotNull(repository.reportIdentity(report,2))
    assertNotNull(repository.reportIdentity(TransportEnvelopeV1.decode(independent).reportId,1))
    assertEquals(2L,repository.currentReceiptVersion(report)) // No double increment from legacy persistence.
    val beforeObjects=rowCount(node,"relay_objects")
    val beforeTombstones=rowCount(node,"relay_object_tombstones")
    val beforeInbound=rowCount(node,"inbound_envelopes")
    val takeover=envelope(other,report,3)
    val changed=TransportEnvelopeV1.create(EnvelopeUnsignedInput(UUID.randomUUID().toString(),report,2,90_000L,550_000L,0,
      EmergencyPayloadV1.encode(EmergencyType.FIRE,Urgency.NEED_ASSISTANCE,null)),node.identity)
    listOf(takeover,changed).forEach {
      assertThrows(IllegalStateException::class.java) { node.service.admit(ObjectKind.SOS,it) }
      assertNull(node.queue.getObject(TransportEnvelopeV1.decode(it).messageId,hash(it)))
    }
    assertEquals(beforeObjects,rowCount(node,"relay_objects"))
    assertEquals(beforeTombstones,rowCount(node,"relay_object_tombstones"))
    assertEquals(beforeInbound,rowCount(node,"inbound_envelopes"))
    assertNull(repository.reportIdentity(report,3))
    assertArrayEquals(node.identity.keyId,repository.reportIdentity(report,2)!!.originKeyId)
    // A pre-existing inconsistent history is retained for inspection, never silently repaired or trusted.
    node.db.writableDatabase.execSQL(
      "INSERT INTO receipt_report_identities(report_id,revision,report_protocol_version,payload_digest,origin_key_id,origin_public_key_der,recorded_at_ms) VALUES(?,3,1,?,?,?,100000)",
      arrayOf(report,TransportEnvelopeV1.decode(takeover).payloadDigest,other.keyId,other.publicKeyDer))
    assertNull(repository.reportIdentity(report,1))
    assertNull(repository.reportIdentity(report,3))
    assertThrows(IllegalStateException::class.java) { repository.recordReportEnvelope(envelope(node.identity,report,4)) }
    assertFalse(VictimStatusStore.isResolved(node.db.readableDatabase,report,3))
    node.db.writableDatabase.execSQL(
      "INSERT INTO reports(report_id,created_at,emergency_type,urgency,lifecycle_state) VALUES(?,100000,'MEDICAL','NEED_ASSISTANCE','LOCALLY_COMMITTED')",arrayOf(report))
    node.db.writableDatabase.execSQL(
      "INSERT INTO victim_server_acks(report_id,ack_id,status,acknowledged_at,received_at) VALUES(?,?,'RESOLVED',100000,100000)",
      arrayOf(report,UUID.randomUUID().toString()))
    assertTrue(VictimStatusStore(node.db).providerConflict(report,3))
    assertFalse(VictimStatusStore.isResolved(node.db.readableDatabase,report,3))
    assertEquals("RESOLVED",VictimStatusStore(node.db).serverStatus(report)!!.status)
  }

  private fun withIsolatedRuntime(block: (SurvivalCoreRuntime) -> Unit) {
    val isolated=IsolatedGatewayTestContext(base)
    val constructor=SurvivalCoreRuntime::class.java.getDeclaredConstructor(Context::class.java).apply { isAccessible=true }
    val runtime=constructor.newInstance(isolated)
    try { block(runtime) } finally {
      runtime.disableReceiptReturn()
      runtime.database.close()
      isolated.deleteDatabase(SagipDatabase.DATABASE_NAME)
    }
  }

  private fun node()=Node().also(nodes::add)
  private inner class Node {
    val context=IsolatedGatewayTestContext(base)
    val identity=TestIdentity()
    var boot=UUID.randomUUID().toString()
    var elapsed=1_000L
    var revoked=emptySet<String>()
    var db=SagipDatabase(context)
    var queue=ReceiptQueue(db)
    var config=TrustedReceiptReturnConfig(identity.keyId,mapOf(hex(root.keyId) to root.publicKeyDer),setOf("TEST"),{true},
      authorityState={ReceiptAuthorityState(revoked)})
    lateinit var service:TrustedReceiptReturnService
    init { rebind(); qualifyTime() }
    fun clock()=MonotonicClock(boot,elapsed)
    fun rebind() { service=TrustedReceiptReturnService(db,queue,config,::clock) }
    fun qualifyTime() {
      val q=service.beginTimeChallenge()
      val proof=sign(ReceiptFields.Time(q.id,ReceiptAuthority.issuerProviderId(1,root.keyId,NIL),
        root.keyId,NIL,NIL,q.verifierId,q.verifierBootSessionId,q.nonce,ByteArray(32),
        100_000L,0,10,600_000L),ByteArray(0),root)
      assertEquals("ACCEPTED",service.acceptTimeProof(q.id,proof).kind)
    }
    fun sign(fields:ReceiptFields,proof:ByteArray,identity:SigningIdentity)=ReceiptRepository(db).encodeFresh(fields,proof,identity)
    fun reopen() { db.close();db=SagipDatabase(context);queue=ReceiptQueue(db);rebind() }
    fun close() { db.close();context.deleteDatabase(SagipDatabase.DATABASE_NAME) }
  }
  private fun envelope(identity:SigningIdentity,report:String=UUID.randomUUID().toString(),revision:Int=1)=
    TransportEnvelopeV1.create(EnvelopeUnsignedInput(UUID.randomUUID().toString(),report,revision,90_000L,550_000L,0,
      EmergencyPayloadV1.encode(EmergencyType.MEDICAL,Urgency.NEED_ASSISTANCE,null)),identity)

  private fun receipt(node:Node,envelope:ByteArray,status:Int=2,sequence:Long=1,cloud:Boolean=false):ByteArray {
    val report=TransportEnvelopeV1.decode(envelope)
    val grantId=if(cloud) NIL else UUID.nameUUIDFromBytes(node.identity.keyId).toString()
    val signer=if(cloud) root else node.identity
    val provider=ReceiptAuthority.issuerProviderId(if(cloud)1 else 2,signer.keyId,grantId)
    val responder=UUID.nameUUIDFromBytes(signer.keyId).toString()
    val grant=if(cloud) ByteArray(0) else node.sign(ReceiptFields.Grant(root.keyId,grantId,signer.keyId,signer.publicKeyDer,
      provider,responder,"TEST",15,9,"TEST",90_000L,500_000L),ByteArray(0),root)
    val proof=if(cloud) ByteArray(0) else ByteBuffer.allocate(3+grant.size).put(1.toByte()).putShort(grant.size.toShort()).put(grant).array()
    val draft=ReceiptFields.Responder(if(cloud)1 else 2,provider,UUID.randomUUID().toString(),ByteArray(32),
      report.reportId,1,report.revision,report.payloadDigest,report.originKeyId,signer.keyId,grantId,responder,"TEST",
      1,status,sequence,100_000L,400_000L,"Synthetic responder update")
    return node.sign(draft.copy(actionDigest=ReceiptAuthority.actionDigest(draft)),proof,signer)
  }
  private fun transfer(from:Node,to:Node,id:String):BleCustodyCode {
    val leases=from.queue.leaseContactWork("peer-"+to.identity.keyId[0],100_000L,eligible=from.service::canForward,custodyTimeMs=from.service.trustedTime()!!.latestMs)
    val lease=leases.first { it.objectId==id }
    leases.filter { it.leaseId!=lease.leaseId }.forEach { from.queue.releaseTransferLease(it.leaseId,100_001L) }
    val entry=from.queue.inventoryEntry(id,lease.digest)!!
    var at=100_002L
    val receiver=BleReceiptExchangeReceiver(admit={kind,bytes->to.service.admit(kind,bytes)},
      alreadyHaveVerified={false},nowProvider={at})
    assertEquals(BleDecisionCode.ACCEPT_TRANSFER,receiver.beginOffer("sender",BleReceiptExchangeCodec.encodeOffer(entry,lease.bytes.size)).decision)
    var result:BleCustodyResult?=null
    BleReceiptExchangeCodec.encodeObjectChunks(lease.bytes,64).forEach { chunk->at++;receiver.addChunk("sender",chunk)?.let { result=it } }
    val custody=result!!
    from.queue.finishTransfer(lease.leaseId,if(custody.result==BleCustodyCode.ACCEPTED_DURABLE) TransferOutcome.PEER_CUSTODY else TransferOutcome.RETRYABLE,at+1)
    return custody.result
  }
  private fun entry(bytes:ByteArray):ReceiptReturnEntry {
    val f=ReceiptV2Codec.decode(bytes).fields
    return ReceiptReturnEntry(if(f is ReceiptFields.Responder) f.actionId else (f as ReceiptFields.Requester).eventId,hex(hash(bytes)),bytes)
  }
  private fun rowCount(node:Node,table:String)=node.db.readableDatabase.rawQuery("SELECT COUNT(*) FROM "+table,null).use { it.moveToFirst();it.getInt(0) }
  private class TestIdentity:SigningIdentity {
    private val key=KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    override val publicKeyDer=key.public.encoded
    override val keyId=hash(publicKeyDer)
    override fun sign(data:ByteArray)=Signature.getInstance("SHA256withECDSA").run { initSign(key.private);update(data);sign() }
  }
  companion object {
    private const val NIL="00000000-0000-0000-0000-000000000000"
    private fun hash(bytes:ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes)
    private fun hex(bytes:ByteArray)=bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
  }
}
