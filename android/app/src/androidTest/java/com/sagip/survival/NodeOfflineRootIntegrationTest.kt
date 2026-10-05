package com.sagip.survival

import android.content.Context
import android.os.Bundle
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Exact Node-produced objects through native SQLCipher custody. No Activity or physical radio claim. */
@RunWith(AndroidJUnit4::class)
class NodeOfflineRootIntegrationTest {
  private val base:Context=ApplicationProvider.getApplicationContext()
  private val nodes=mutableListOf<FixtureNode>()
  private lateinit var fixture:JSONObject
  private lateinit var fixtureBytes:ByteArray
  @Before fun setup() {
    check(base.packageName=="org.sagip.app.sosvalidation")
    System.loadLibrary("sqlcipher")
    fixtureBytes=InstrumentationRegistry.getInstrumentation().context.assets
      .open("offline-root-three-node.json").use { it.readBytes() }
    fixture=JSONObject(String(fixtureBytes,Charsets.UTF_8))
    assertTrue(fixture.getBoolean("syntheticOnly"))
    assertTrue(fixture.getBoolean("notLiveAssurance"))
  }
  @After fun cleanup() { nodes.forEach { it.close() };nodes.clear() }

  @Test fun exact_node_fixture_crosses_three_durable_nodes_and_exports_reopened_native_summary() {
    val bootstraps=fixture.getJSONArray("timeProofs")
    assertEquals(3,bootstraps.length())
    val byName=(0 until bootstraps.length()).map { bootstraps.getJSONObject(it) }.associateBy { it.getString("role") }
    assertEquals(setOf("gateway","relay","origin"),byName.keys)
    assertEquals(3,byName.values.map { it.getString("verifierIdHex") }.distinct().size)
    assertEquals(3,byName.values.map { it.getString("verifierBootSessionId") }.distinct().size)
    val gateway=node(byName.getValue("gateway"));val relay=node(byName.getValue("relay"));val origin=node(byName.getValue("origin"))
    val envelope=bytes("envelopeHex")
    val bundle=bytes("bundleHex")
    val decoded=OfflineRootSnapshotCodec.decodeBundle(bundle)
    val proof=OfflineRootSnapshotCodec.decodeProof(decoded.proof)
    assertArrayEquals(bytes("receiptHex"),decoded.receipt)
    assertArrayEquals(bytes("proofHex"),decoded.proof)
    assertEquals(fixture.getString("bundleDigest"),digest(bundle))
    assertEquals(fixture.getString("receiptDigest"),digest(decoded.receipt))
    assertEquals(fixture.getString("proofDigest"),digest(decoded.proof))
    for(n in listOf(gateway,relay,origin)) {
      assertEquals(CustodyResultKind.COMMITTED,n.service.admit(ObjectKind.SOS,envelope).kind)
      assertEquals(proof["reportId"],ReceiptRepository(n.db).reportIdentity(proof["reportId"])!!.reportId)
      assertTrue(n.service.enrollOfflineRootDomain(proof.number("revocationEpoch"),proof["authorityStateDigest"]))
    }
    val page=HttpReceiptReturnTransport("https://synthetic.invalid") { "UNUSED_TEST_TOKEN" }
      .decodePage(fixture.getJSONObject("feedPage").toString().toByteArray(Charsets.UTF_8))
    assertEquals(1,page.entries.size)
    assertArrayEquals(bundle,page.entries.single().offlineBundle)
    val feed=ReceiptReturnFeedConfig("node-golden-feed",setOf(proof["reportId"]),ReceiptReturnTransport { id,cursor ->
      assertEquals(proof["reportId"],id);assertNull(cursor);page
    })
    val worker=ReceiptReturnWorker(gateway.db,{gateway.service},{feed},{gateway.clock()})
    assertEquals(1,worker.runOnce().stored)
    assertArrayEquals(bundle,gateway.queue.getObject(proof["proofId"],hash(bundle))!!.bytes)
    assertEquals(BleCustodyCode.ACCEPTED_DURABLE,transfer(gateway,relay,proof["proofId"]))
    relay.reopen()
    assertEquals(BleCustodyCode.ACCEPTED_DURABLE,transfer(relay,origin,proof["proofId"]))
    origin.reopen()
    val repository=ReceiptRepository(origin.db)
    val projection=repository.projection(proof["reportId"])!!
    val stored=repository.getReceipt(projection.eventId)!!
    val receipt=ReceiptV2Codec.decode(stored).fields as ReceiptFields.Responder
    assertArrayEquals(decoded.receipt,stored)
    assertArrayEquals(bundle,origin.queue.getObject(proof["proofId"],hash(bundle))!!.bytes)
    assertEquals(OfflineRootSnapshotCodec.KIND,projection.verificationKind)
    assertEquals("VALID_AT_LAST_CHECK",origin.service.offlineEvidenceState(projection.eventId))
    assertEquals(CustodyResultKind.DUPLICATE,origin.service.admit(ObjectKind.OFFLINE_ROOT_BUNDLE,bundle).kind)
    assertFalse(VictimStatusStore.isResolved(origin.db.readableDatabase,receipt.reportId,receipt.revision))
    val revision=repository.reportIdentity(receipt.reportId)!!.revision
    val hold=origin.db.readableDatabase.rawQuery(
      "SELECT 1 FROM receipt_projections WHERE report_id=? AND revision=? AND verification_kind='VERIFIED_OFFLINE_ROOT_SNAPSHOT'",
      arrayOf(receipt.reportId,revision.toString())).use { it.moveToFirst() }
    assertTrue(hold)
    val expires=origin.db.readableDatabase.rawQuery(
      "SELECT MAX(expires_at_ms) FROM offline_root_evidence WHERE event_id=?",arrayOf(projection.eventId))
      .use { assertTrue(it.moveToFirst());assertFalse(it.isNull(0));it.getLong(0) }
    assertTrue(expires<=proof.number("expiresAtMs"))
    assertTrue(origin.service.trustedTime()!!.latestMs<expires)
    val summary=JSONObject()
      .put("reportId",receipt.reportId).put("latestRevision",revision).put("offlineSnapshotClosureHold",hold)
      .put("verifiedReceipt",JSONObject().put("eventId",projection.eventId)
        .put("status",when(receipt.status) { 1->"ACKNOWLEDGED";2->"EN_ROUTE";3->"ON_SCENE";4->"RESOLVED";else->error("status") })
        .put("revision",projection.revision).put("verificationKind",projection.verificationKind)
        .put("authorityCheckedAt",projection.authorityCheckedAtMs ?: JSONObject.NULL)
        .put("issuedAt",receipt.issuedAtMs).put("authorityExpiresAt",expires)
        .put("offlineEvidenceState",origin.service.offlineEvidenceState(projection.eventId))
        .put("callsign",receipt.callsign).put("note",receipt.note)
        .put("requesterDeliveryState",projection.requesterDeliveryState))
    val artifact=JSONObject().put("summary",summary).put("provenance",JSONObject()
      .put("kind","DIRECT_DURABLE_NATIVE_PROJECTION_EXPORT")
      .put("fixture","fixtures/offline-root-v1/three-node.json").put("fixtureSha256",digest(fixtureBytes))
      .put("generatedBy",fixture.getString("generatedBy"))
      .put("storageBackend",fixture.getString("storageBackend")).put("timeSource",fixture.getString("timeSource"))
      .put("syntheticOnly",true).put("notLiveAssurance",true)
      .put("receiptDigest",digest(stored)).put("proofDigest",digest(decoded.proof)).put("bundleDigest",digest(bundle))
      .put("threeIndependentSqlCipherStores",true).put("originReopened",true)
      .put("activityRendered",false).put("physicalRadioQualified",false))
    assertEquals("",receipt.note)
    File(base.filesDir,"offline-root-native-summary.json").writeText(artifact.toString(2),Charsets.UTF_8)
    InstrumentationRegistry.getInstrumentation().addResults(Bundle().apply {
      putString("offline_root_native_summary",artifact.toString())
    })
  }

  private fun node(bootstrap:JSONObject)=FixtureNode(bootstrap).also(nodes::add)
  private fun policy():OfflineRootPolicy {
    val p=fixture.getJSONObject("policy")
    fun strings(name:String)=p.getJSONArray(name).let { a -> (0 until a.length()).map(a::getString) }
    val bindings=p.getJSONArray("signerBindings").let { a -> (0 until a.length()).map {
      a.getJSONObject(it).let { b -> OfflineRootSignerBinding(b.getString("checkpointSignerKeyId"),b.getString("receiptRootKeyId"),b.getString("issuerProviderId")) }
    } }
    val statuses=p.getJSONArray("allowedStatuses").let { a -> (0 until a.length()).map(a::getInt) }
    return OfflineRootPolicy(p.getString("mode"),p.getString("authorityDomainId"),bindings,strings("allowedScopes"),statuses,
      p.getLong("maxAuthorityStalenessMs"),p.getLong("maxReceiptIssuanceAgeMs"),p.getLong("maxProofValidityMs"),
      strings("qualifiedTimeSourceIds"),p.getString("disseminationAudience"),p.getString("providerConflictHandling"),
      p.getString("resolvedHandling"),p.getInt("maxReplayRecords"))
  }
  private inner class FixtureNode(private val bootstrap:JSONObject) {
    val context=IsolatedGatewayTestContext(base)
    private val trusted=fixture.getJSONObject("trustedContext")
    private val root=hex(trusted.getString("rootPublicKeyDerHex"))
    private val checkpoint=hex(trusted.getString("checkpointPublicKeyDerHex"))
    private val verifier=hex(bootstrap.getString("verifierIdHex"))
    private val boot=bootstrap.getString("verifierBootSessionId")
    private val elapsed=bootstrap.getLong("elapsedMs")
    private val selectedPolicy=policy()
    private val offline=OfflineRootConfig(selectedPolicy,mapOf(digest(checkpoint) to checkpoint),{
      OfflineRootClockQualification(trusted.getString("qualifiedSourceId"),digest(root),boot,100,86_400_000L)
    })
    private val config=TrustedReceiptReturnConfig(verifier,mapOf(digest(root) to root),selectedPolicy.allowedScopes.toSet(),{true},offlineRoot=offline)
    var db=SagipDatabase(context)
    var queue=ReceiptQueue(db)
    lateinit var service:TrustedReceiptReturnService
    init {
      rebind()
      val challengeId=bootstrap.getString("challengeId")
      ReceiptRepository(db).recordTimeChallenge(challengeId,verifier,boot,hex(bootstrap.getString("nonceHex")),
        bootstrap.getLong("sentElapsedMs"),0L)
      assertEquals("ACCEPTED",service.acceptTimeProof(challengeId,hex(bootstrap.getString("timeProofHex"))).kind)
      assertNotNull(service.trustedTime())
    }
    fun clock()=MonotonicClock(boot,elapsed)
    private fun rebind() { service=TrustedReceiptReturnService(db,queue,config,::clock) }
    fun reopen() { db.close();db=SagipDatabase(context);queue=ReceiptQueue(db);rebind();assertNotNull(service.trustedTime()) }
    fun close() { db.close();context.deleteDatabase(SagipDatabase.DATABASE_NAME) }
  }
  private fun transfer(from:FixtureNode,to:FixtureNode,id:String):BleCustodyCode {
    val trusted=from.service.trustedTime()!!
    val leases=from.queue.leaseContactWork("fixture-peer-"+to.hashCode(),trusted.latestMs,
      eligible=from.service::canForward,custodyTimeMs=trusted.latestMs)
    val lease=leases.first { it.objectId==id }
    leases.filter { it.leaseId!=lease.leaseId }.forEach { from.queue.releaseTransferLease(it.leaseId,trusted.latestMs+1) }
    val entry=from.queue.inventoryEntry(id,lease.digest)!!
    assertEquals(ObjectKind.OFFLINE_ROOT_BUNDLE,entry.objectKind)
    var at=trusted.latestMs+2
    val receiver=BleReceiptExchangeReceiver(admit={kind,bytes->to.service.admit(kind,bytes)},alreadyHaveVerified={false},nowProvider={at})
    assertEquals(BleDecisionCode.ACCEPT_TRANSFER,receiver.beginOffer("node-golden-sender",BleReceiptExchangeCodec.encodeOffer(entry,lease.bytes.size)).decision)
    var result:BleCustodyResult?=null
    BleReceiptExchangeCodec.encodeObjectChunks(lease.bytes,64).forEach { chunk -> at++;receiver.addChunk("node-golden-sender",chunk)?.let { result=it } }
    val custody=result!!
    from.queue.finishTransfer(lease.leaseId,if(custody.result==BleCustodyCode.ACCEPTED_DURABLE)TransferOutcome.PEER_CUSTODY else TransferOutcome.RETRYABLE,at+1)
    return custody.result
  }
  private fun bytes(name:String)=hex(fixture.getString(name))
  private fun hex(value:String)=value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
  private fun hash(value:ByteArray)=OfflineRootSnapshotCodec.hash(value)
  private fun digest(value:ByteArray)=OfflineRootSnapshotCodec.digest(value)
}
