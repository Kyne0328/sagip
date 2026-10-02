package com.sagip.survival

import android.content.Context
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.math.BigInteger
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

@RunWith(AndroidJUnit4::class)
class GatewayActionApiTest {
  private val base = ApplicationProvider.getApplicationContext<Context>()
  private lateinit var context: IsolatedGatewayTestContext
  private lateinit var db: SagipDatabase
  private lateinit var tls: TestTls
  private lateinit var server: GatewayLocalServer
  private var elapsed = 10_000L
  private val boot = "11111111-1111-4111-8111-111111111111"
  private val authority = GatewaySessionAuthority(
    providerId = "ab".repeat(32),
    grantId = "22222222-2222-4222-8222-222222222222",
    grantExpiresAtMs = 1_000_000L,
    trustedTime = TimeInterval(100_000L, 100_100L),
  )

  @Before fun setUp() {
    context = IsolatedGatewayTestContext(base)
    db = SagipDatabase(context)
    tls = testTls()
  }

  @After fun tearDown() {
    if (::server.isInitialized) server.stop()
    db.close()
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
  }

  @Test fun action_routes_require_authorized_owner_before_lookup() {
    val port = freePort(); val origin = "https://gateway.test:$port"
    val pairing = GatewayPairingStore(db, origin, { true }, { authority }, { MonotonicClock(boot, elapsed) }, { false })
    server = GatewayLocalServer(pairing, GatewayAdmissionStore(db) { MonotonicClock(boot, elapsed) }, { authority }, GatewayTimeProofIssuer { TimeProofResult("TIME_UNAVAILABLE") })
    server.start(GatewayLocalConfig(InetAddress.getByName("127.0.0.1"), port, "gateway.test", origin, tls.server, tls.fingerprint))
    assertEquals(401, request(port, "GET", "/gateway/v1/actions/33333333-3333-4333-8333-333333333333", origin, ByteArray(0)).status)
  }
  private val root = ActionApiTestIdentity()
  private val signer = ActionApiTestIdentity()
  private val grantId = java.util.UUID.randomUUID().toString()
  private val responderId = java.util.UUID.randomUUID().toString()
  private lateinit var gateway: ResponderGatewayService
  private var failSigning = false
  private var deploymentQualified = true
  private fun setupGateway(qualification: () -> Boolean = {deploymentQualified}) {
    gateway = ResponderGatewayService(db, { object: SigningIdentity {
      override val keyId get() = signer.keyId
      override val publicKeyDer get() = signer.publicKeyDer
      override fun sign(data: ByteArray): ByteArray { check(!failSigning); org.junit.Assert.assertFalse("signing must follow committed work",db.writableDatabase.inTransaction()); return signer.sign(data) }
    } }, mapOf(hex(root.keyId) to root.publicKeyDer), setOf("TAGUM_TEST"), { true }, { MonotonicClock(boot, elapsed) }, { 100_000L }, qualification)
    if (gateway.authorityReady()) return
    val q = gateway.beginAuthorityTimeChallenge()
    val nil = "00000000-0000-0000-0000-000000000000"
    val codec = ReceiptRepository(db)
    assertEquals("ACCEPTED", gateway.acceptAuthorityTimeProof(q.id, codec.encodeFresh(ReceiptFields.Time(java.util.UUID.randomUUID().toString(), ReceiptAuthority.issuerProviderId(1, root.keyId, nil), root.keyId, nil, nil, q.verifierId, q.verifierBootSessionId, q.nonce, ByteArray(32), 100_000L, 0, 10, 3_000_000L), ByteArray(0), root)).kind)
    assertEquals("ACCEPTED", gateway.provisionGrant(codec.encodeFresh(ReceiptFields.Grant(root.keyId, grantId, signer.keyId, signer.publicKeyDer, ReceiptAuthority.issuerProviderId(2, signer.keyId, grantId), responderId, "TEST", 15, 9, "TAGUM_TEST", 90_000L, 2_000_000L), ByteArray(0), root)).state)
  }
  private fun newReport(): GatewayIncident {
    val repo = EmergencyRepository(db)
    repo.createReport(CreateEmergencyReportInput(EmergencyType.MEDICAL, Urgency.NEED_ASSISTANCE), null, 100_000L)
    EnvelopePreparationService(repo, ActionApiTestIdentity()).preparePending()
    return gateway.listGatewayIncidents().last()
  }
  private fun intent(incident: GatewayIncident, actionId: String = java.util.UUID.randomUUID().toString(), status: Int = 1): JSONObject {
    val provider = ReceiptAuthority.issuerProviderId(2, signer.keyId, grantId)
    val f = ReceiptFields.Responder(2, provider, actionId, ByteArray(32), incident.identity.reportId, 1, incident.identity.revision, incident.identity.payloadDigest, incident.identity.originKeyId, signer.keyId, grantId, responderId, "TEST", incident.observedIncidentVersion, status, 1, 100_000L, 900_000L, "")
    return JSONObject().put("actionId", actionId).put("providerKind", 2).put("issuerProviderId", hex(provider)).put("reportId", f.reportId).put("reportProtocolVersion", 1).put("revision", f.revision).put("payloadDigest", hex(f.payloadDigest)).put("originKeyId", hex(f.originKeyId)).put("responderId", responderId).put("observedIncidentVersion", f.observedIncidentVersion.toString()).put("status", listOf("ACKNOWLEDGED","EN_ROUTE","ON_SCENE","RESOLVED")[status-1]).put("note", JSONObject.NULL).put("actionDigest", hex(ReceiptAuthority.actionDigest(f)))
  }
  @Test fun schema_preserves_gateway_data_with_additive_g03_storage() {
    assertEquals(16, db.writableDatabase.version)
  }
  private fun api() = GatewayActionApi(db, gateway) { MonotonicClock(boot, elapsed) }
  private fun post(json: JSONObject, owner: String = "browser-a") = api().handle("POST", "/gateway/v1/actions", json.toString().toByteArray(), owner)
  private fun responseJson(r: GatewayApiResponse) = JSONObject(String(r.body))
  @Test fun lost_gateway_response_does_not_reissue() {
    setupGateway(); val json = intent(newReport())
    val first = post(json)
    assertEquals(201, first.status)
    val id = json.getString("actionId")
    val bytes = api().handle("GET", "/gateway/v1/actions/$id/receipt", ByteArray(0), "browser-a")
    assertEquals(200, bytes.status)
    val issuer = responseJson(first).getString("issuerProviderId")
    db.close(); db = SagipDatabase(context); setupGateway()
    assertEquals(200, post(json).status)
    assertEquals(issuer, responseJson(post(json)).getString("issuerProviderId"))
    assertArrayEquals(bytes.body, api().handle("GET", "/gateway/v1/actions/$id/receipt", ByteArray(0), "browser-a").body)
    assertEquals("SIGNED", responseJson(api().handle("GET", "/gateway/v1/actions/$id", ByteArray(0), "browser-a")).getString("state"))
    val altered = JSONObject(json.toString()).put("payloadDigest", "ff".repeat(32))
    assertEquals(400, post(altered).status)
    assertEquals(1, db.readableDatabase.rawQuery("SELECT count(*) FROM receipt_actions", null).use { it.moveToFirst(); it.getInt(0) })
  }
  @Test fun external_bindings_and_status_permissions_reject_before_allocation() {
    setupGateway(); val incident = newReport(); val json = intent(incident)
    assertEquals(400, post(JSONObject(json.toString()).put("actionDigest", "ff".repeat(32))).status)
    assertEquals(403, post(JSONObject(json.toString()).put("responderId", java.util.UUID.randomUUID().toString())).status)
    assertEquals(403, post(JSONObject(json.toString()).put("issuerProviderId", "ff".repeat(32))).status)
    assertEquals(400, post(JSONObject(json.toString()).put("surprise", true)).status)
    val truncated = json.toString().dropLast(1).toByteArray()
    assertEquals(400, api().handle("POST", "/gateway/v1/actions", truncated, "browser-a").status)
    assertEquals(0, db.readableDatabase.rawQuery("SELECT count(*) FROM gateway_work", null).use { it.moveToFirst(); it.getInt(0) })
  }
  @Test fun pending_signing_is_durable_and_never_reports_import_or_delivery() {
    setupGateway(); val json = intent(newReport()); failSigning = true
    val first = post(json); assertEquals(201, first.status)
    assertEquals("PREPARING", responseJson(first).getString("state"))
    val path = "/gateway/v1/actions/${json.getString("actionId")}/receipt"
    assertEquals(409, api().handle("GET", path, ByteArray(0), "browser-a").status)
    failSigning = false
    assertEquals("SIGNED", responseJson(post(json)).getString("state"))
    assertEquals("UNKNOWN", ReceiptRepository(db).projection(json.getString("reportId"))!!.requesterDeliveryState)
  }
  @Test fun complete_snapshot_over_one_hundred_is_immutable_owner_bound_and_expires() {
    setupGateway(); repeat(101) { newReport() }
    val descriptor = api().handle("POST", "/gateway/v1/snapshots", "{}".toByteArray(), "browser-a")
    assertEquals(201, descriptor.status)
    val d = responseJson(descriptor); assertEquals(101, d.getInt("total"))
    newReport()
    var token = d.getString("nextCursor"); var loaded = 0
    while (token != "null") {
      val path = "/gateway/v1/snapshots/${d.getString("snapshotId")}/pages?cursor=$token"
      assertEquals(404, api().handle("GET", path, ByteArray(0), "browser-b").status)
      assertEquals(404, api().handle("GET", path+"x", ByteArray(0), "browser-a").status)
      val page = api().handle("GET", path, ByteArray(0), "browser-a")
      assertEquals(200, page.status); val j = responseJson(page)
      assertEquals(101, j.getInt("total")); assertEquals(d.getLong("createdAtMs"), j.getLong("createdAtMs"))
      loaded += j.getJSONArray("entries").length(); token = j.optString("nextCursor", "null")
      assertTrue(page.body.size <= 4*1024*1024)
    }
    assertEquals(101, loaded)
    elapsed += 900_000L
    assertEquals(410, api().handle("GET", "/gateway/v1/snapshots/${d.getString("snapshotId")}/pages?cursor=${d.getString("nextCursor")}", ByteArray(0), "browser-a").status)
  }
  @Test fun sync_timeout_restart_retries_original_bytes_without_reissuing() {
    setupGateway(); val json=intent(newReport()); assertEquals(201,post(json).status)
    val id=json.getString("actionId");val original=api().handle("GET","/gateway/v1/actions/$id/receipt",ByteArray(0),"browser-a").body
    val first=syncWorker({ bytes -> assertArrayEquals(original,bytes); throw java.io.IOException("lost response") }).runOnce(100_000L)
    assertEquals(1,first.unknown)
    db.close();db=SagipDatabase(context)
    val next=syncWorker({ bytes -> assertArrayEquals(original,bytes); GatewayCloudResult("DUPLICATE",id,json.getString("issuerProviderId"),hex(MessageDigest.getInstance("SHA-256").digest(bytes))) },{true},{MonotonicClock(boot,200_000L)}).runOnce(200_000L)
    assertEquals(1,next.committed)
    assertEquals(0,syncWorker({ error("must not resend") }).runOnce(300_000L).committed)
    assertEquals(1,db.readableDatabase.rawQuery("SELECT count(*) FROM receipt_records",null).use { it.moveToFirst();it.getInt(0) })
    assertEquals("UNKNOWN",ReceiptRepository(db).projection(json.getString("reportId"))!!.requesterDeliveryState)
  }
  @Test fun sync_rejects_fabricated_ack_and_has_no_default_cloud_acceptance() {
    setupGateway();val json=intent(newReport());post(json)
    assertEquals(false,GatewaySyncWorker(db,{ null }).runOnce(100_000L).enabled)
    val result=syncWorker({ GatewayCloudResult("IMPORTED",json.getString("actionId"),json.getString("issuerProviderId"),"ff".repeat(32)) }).runOnce(100_000L)
    assertEquals(1,result.unknown)
    assertEquals("UNKNOWN",db.readableDatabase.rawQuery("SELECT state FROM gateway_sync",null).use { it.moveToFirst();it.getString(0) })
  }
  @Test fun durable_wire_work_commits_before_signer_and_lease_blocks_parallel_sender() {
    setupGateway(); val json=intent(newReport());failSigning=true;post(json)
    assertEquals(1,db.readableDatabase.rawQuery("SELECT count(*) FROM gateway_api_actions a JOIN gateway_work w ON a.action_id=w.action_id",null).use {it.moveToFirst();it.getInt(0)})
    failSigning=false;post(json)
    val entered=java.util.concurrent.CountDownLatch(1);val release=java.util.concurrent.CountDownLatch(1)
    val pool=Executors.newSingleThreadExecutor()
    val first=pool.submit<SyncBatchResult> { syncWorker({ entered.countDown();release.await(5,TimeUnit.SECONDS);GatewayCloudResult("UNKNOWN") }).runOnce(100_000L) }
    assertTrue(entered.await(5,TimeUnit.SECONDS))
    val second=syncWorker({ error("lease overlap") }).runOnce(100_001L)
    assertEquals(0,second.unknown)
    release.countDown();assertEquals(1,first.get(5,TimeUnit.SECONDS).unknown);pool.shutdownNow()
  }
  @Test fun imports_are_durable_bounded_and_never_infer_return_custody_as_delivery() {
    setupGateway();val incoming=TransportEnvelopeV1.create(EnvelopeUnsignedInput(java.util.UUID.randomUUID().toString(),java.util.UUID.randomUUID().toString(),1,100_000L,null,100,EmergencyPayloadV1.encode(EmergencyType.FLOOD,Urgency.IMMEDIATE_DANGER,null)),ActionApiTestIdentity())
    val route="/gateway/v1/envelopes/import"
    assertEquals(201,api().handle("POST",route,incoming,"browser-a").status)
    assertEquals(200,api().handle("POST",route,incoming,"browser-a").status)
    assertEquals(413,api().handle("POST",route,ByteArray(8193),"browser-a").status)
    assertEquals(422,api().handle("POST",route,incoming.copyOf().apply { this[lastIndex]=(this[lastIndex].toInt() xor 1).toByte() },"browser-a").status)
    val json=intent(gateway.listGatewayIncidents().single());post(json)
    val original=api().handle("GET","/gateway/v1/actions/${json.getString("actionId")}/receipt",ByteArray(0),"browser-a").body
    val imported=api().handle("POST","/gateway/v1/receipts/import",original,"browser-a")
    assertEquals("DUPLICATE",responseJson(imported).getString("state"))
    assertEquals(1,db.readableDatabase.rawQuery("SELECT count(*) FROM relay_objects WHERE object_kind=2",null).use {it.moveToFirst();it.getInt(0)})
    assertEquals("UNKNOWN",ReceiptRepository(db).projection(json.getString("reportId"))!!.requesterDeliveryState)
  }
  @Test fun expired_transport_completion_retains_unknown_original_work() {
    setupGateway();val json=intent(newReport());post(json)
    var tick=MonotonicClock(boot,1000L)
    val worker=syncWorker({ bytes -> tick=MonotonicClock(boot,62000L);GatewayCloudResult("IMPORTED",json.getString("actionId"),json.getString("issuerProviderId"),hex(MessageDigest.getInstance("SHA-256").digest(bytes))) },{true},{tick})
    assertEquals(1,worker.runOnce(100000L).unknown)
    assertEquals("UNKNOWN",db.readableDatabase.rawQuery("SELECT state FROM gateway_sync",null).use {it.moveToFirst();it.getString(0)})
  }
  @Test fun snapshot_capacity_is_per_responder_across_browser_sessions() {
    setupGateway();newReport()
    assertEquals(201,api().handle("POST","/gateway/v1/snapshots","{}".toByteArray(),"browser-a").status)
    assertEquals(201,api().handle("POST","/gateway/v1/snapshots","{}".toByteArray(),"browser-b").status)
    assertEquals(429,api().handle("POST","/gateway/v1/snapshots","{}".toByteArray(),"browser-c").status)
  }
  @Test fun normal_runtime_has_no_inferred_authority_server_or_cloud_acceptance() {
    val runtime=SurvivalCoreRuntime.get(context)
    assertEquals(false,runtime.gatewaySyncWorker.runOnce(100_000L).enabled)
    assertEquals(null,runtime.resumeGatewayServer())
  }
  @Test fun actual_https_action_routes_bind_pairing_possession_and_csrf() {
    setupGateway();val json=intent(newReport());val port=freePort();val origin="https://gateway.test:$port"
    val pairing=GatewayPairingStore(db,origin,{deploymentQualified},{gateway.sessionAuthority()},{MonotonicClock(boot,elapsed)},{gateway.hasPendingWork()})
    server=GatewayLocalServer(pairing,GatewayAdmissionStore(db){MonotonicClock(boot,elapsed)},{gateway.sessionAuthority()},GatewayTimeProofIssuer{gateway.issueTimeProof(it)},api())
    server.start(GatewayLocalConfig(InetAddress.getByName("127.0.0.1"),port,"gateway.test",origin,tls.server,tls.fingerprint,approvalWaitMs=5000))
    val key=browserKey();val code=server.startPairing()
    val pairBody=JSONObject().put("code",code.code).put("browserPublicKeyDerBase64",b64(key.public.encoded)).put("browserSignatureBase64",b64(signP1363(key,GatewayBrowserCredential.pairingInput(code.pairingId,code.code,origin)))).toString().toByteArray()
    val pool=Executors.newSingleThreadExecutor();val confirm=pool.submit<HttpResponse>{request(port,"POST","/gateway/v1/pairing/${code.pairingId}/confirm",origin,pairBody,mapOf("Content-Type" to "application/json"))}
    Thread.sleep(150);assertTrue(server.approveNative(code.pairingId,GatewayBrowserCredential.binding(key.public.encoded)))
    val paired=confirm.get(5,TimeUnit.SECONDS);pool.shutdownNow();assertEquals(200,paired.status)
    val cookie=paired.headers.getValue("set-cookie").substringBefore(';');val csrf=JSONObject(String(paired.body)).getString("csrf")
    val path="/gateway/v1/actions";val body=json.toString().toByteArray()
    fun headers(method: String,p: String,nonce: String,b: ByteArray,token: String)=signedHeaders(key,method,p,origin,token,nonce,b)+mapOf("Cookie" to cookie,"X-Sagip-CSRF" to token,"Content-Type" to "application/json")
    assertEquals(403,request(port,"POST",path,origin,body,headers("POST",path,"10".repeat(32),body,"bad")).status)
    assertEquals(201,request(port,"POST",path,origin,body,headers("POST",path,"11".repeat(32),body,csrf)).status)
    val receiptPath="$path/${json.getString("actionId")}/receipt"
    val original=request(port,"GET",receiptPath,origin,ByteArray(0),signedHeaders(key,"GET",receiptPath,origin,"","12".repeat(32),ByteArray(0))+mapOf("Cookie" to cookie),includeOrigin=false)
    assertEquals(200,original.status)
    assertEquals("application/octet-stream",original.headers["content-type"])
    assertEquals(200,request(port,"POST",path,origin,body,headers("POST",path,"13".repeat(32),body,csrf)).status)
    assertArrayEquals(original.body,gateway.getGatewayAction(json.getString("actionId")).bytes)
    val nonce="14".repeat(32);val h=headers("POST",path,nonce,body,csrf)
    assertEquals(200,request(port,"POST",path,origin,body,h).status)
    assertEquals(403,request(port,"POST",path,origin,body,h).status)
    val next=intent(gateway.listGatewayIncidents().single(),status=2).toString().toByteArray()
    deploymentQualified=false
    assertEquals(403,request(port,"POST",path,origin,next,headers("POST",path,"15".repeat(32),next,csrf)).status)
    val challenge=JSONObject().put("challengeId",java.util.UUID.randomUUID().toString()).put("verifierId","31".repeat(32)).put("verifierBootSessionId",java.util.UUID.randomUUID().toString()).put("nonce","32".repeat(32)).toString().toByteArray()
    assertEquals(403,request(port,"POST","/gateway/v1/time",origin,challenge,headers("POST","/gateway/v1/time","16".repeat(32),challenge,csrf)).status)
    assertTrue(runCatching {server.startPairing()}.isFailure)
    assertEquals(1,db.readableDatabase.rawQuery("SELECT count(*) FROM gateway_work",null).use {it.moveToFirst();it.getInt(0)})
  }
  @Test fun sgp2_cannot_be_accepted_by_the_sgp1_local_import_contract() {
    setupGateway()
    val encrypted=TransportEnvelopeV2.create(EnvelopeUnsignedInputV2(java.util.UUID.randomUUID().toString(),java.util.UUID.randomUUID().toString(),1,100_000L,null,100,EncryptedEmergencyPayloadV2.encode(listOf(EncryptedRecipientEntryV2(ByteArray(32){1},ByteArray(64))))),ActionApiTestIdentity())
    assertEquals(422,api().handle("POST","/gateway/v1/envelopes/import",encrypted,"browser-a").status)
  }
  @Test fun g03_additive_migration_preserves_native_signed_event_bytes() {
    setupGateway();val i=newReport();val intent=ActionIntent(java.util.UUID.randomUUID().toString(),i.identity.reportId,i.observedIncidentVersion,1,"")
    val original=gateway.recordGatewayAction(intent).bytes!!
    listOf("gateway_snapshot_pages","gateway_snapshots","gateway_api_actions","gateway_sync").forEach {db.writableDatabase.execSQL("DROP TABLE $it")}
    db.writableDatabase.version=15;db.close();db=SagipDatabase(context);setupGateway()
    assertEquals(16,db.readableDatabase.version)
    assertArrayEquals(original,gateway.getGatewayAction(intent.actionId).bytes)
  }
  @Test fun withdrawn_deployment_qualification_denies_native_work_time_and_api_before_write() {
    val configured=GatewayDeploymentConfig(mapOf(hex(root.keyId) to root.publicKeyDer),setOf("TAGUM_TEST"),{deploymentQualified})
    setupGateway(configured.qualified);val incident=newReport();val json=intent(incident)
    assertTrue(configured.qualified())
    val q=TimeChallenge(java.util.UUID.randomUUID().toString(),ByteArray(32){3},java.util.UUID.randomUUID().toString(),ByteArray(32){4},0,null,gateway.verificationContext(),{true})
    assertEquals("AVAILABLE",gateway.issueTimeProof(q).kind)
    deploymentQualified=false;assertEquals(false,configured.qualified())
    assertEquals(403,post(json).status)
    assertEquals(ActionCommitState.REJECTED,gateway.recordGatewayAction(ActionIntent(json.getString("actionId"),incident.identity.reportId,incident.observedIncidentVersion,1,"")).state)
    assertEquals("TIME_UNAVAILABLE",gateway.issueTimeProof(q.copy(id=java.util.UUID.randomUUID().toString())).kind)
    assertTrue(runCatching {gateway.listGatewayIncidents()}.isFailure)
    assertEquals(0,db.readableDatabase.rawQuery("SELECT count(*) FROM gateway_work",null).use {it.moveToFirst();it.getInt(0)})
    assertEquals(1,db.readableDatabase.rawQuery("SELECT count(*) FROM gateway_time_requests",null).use {it.moveToFirst();it.getInt(0)})
    org.junit.Assert.assertNotNull(EmergencyRepository(db).createReport(CreateEmergencyReportInput(EmergencyType.MEDICAL,Urgency.NEED_ASSISTANCE),null,100_000L))
  }
  @Test fun snapshot_dataset_over_ten_thousand_fails_with_explicit_capacity() {
    setupGateway();newReport()
    val source=ActionApiTestIdentity();val dbw=db.writableDatabase
    val payload=EmergencyPayloadV1.encode(EmergencyType.MEDICAL,Urgency.NEED_ASSISTANCE,null)
    dbw.beginTransaction()
    try {
      repeat(10000) {
        val report=java.util.UUID.randomUUID().toString();val message=java.util.UUID.randomUUID().toString()
        val bytes=TransportEnvelopeV1.create(EnvelopeUnsignedInput(message,report,1,100_000L,null,100,payload),source)
        dbw.execSQL("INSERT INTO inbound_envelopes(inbound_id,message_id,report_id,envelope_bytes,received_at,origin_key_id) VALUES(?,?,?,?,?,?)",arrayOf(java.util.UUID.randomUUID().toString(),message,report,bytes,100_000L,source.keyId))
      }
      dbw.setTransactionSuccessful()
    } finally {dbw.endTransaction()}
    val result=api().handle("POST","/gateway/v1/snapshots","{}".toByteArray(),"browser-a")
    assertEquals(429,result.status);assertEquals("CAPACITY_FULL",responseJson(result).getString("error"))
    assertEquals(0,db.readableDatabase.rawQuery("SELECT count(*) FROM gateway_snapshots",null).use {it.moveToFirst();it.getInt(0)})
  }
  private fun syncBatchWithdrawal(replaceTransport: Boolean) {
    setupGateway();post(intent(newReport()));post(intent(newReport()))
    val originals=mutableMapOf<String,ByteArray>()
    db.readableDatabase.rawQuery("SELECT event_id,object_bytes FROM receipt_records",null).use {c->while(c.moveToNext()) originals[c.getString(0)]=c.getBlob(1)}
    var allowed=true;var oldSends=0;var newSends=0
    fun accepted(bytes: ByteArray): GatewayCloudResult {
      val fields=ReceiptV2Codec.decode(bytes).fields as ReceiptFields.Responder
      assertArrayEquals(originals.getValue(fields.actionId),bytes)
      return GatewayCloudResult("IMPORTED",fields.actionId,hex(fields.issuerProviderId),hex(MessageDigest.getInstance("SHA-256").digest(bytes)))
    }
    val replacement=GatewayReceiptTransport { bytes -> newSends++;accepted(bytes) }
    lateinit var current: GatewayReceiptTransport
    val initial=GatewayReceiptTransport { bytes -> oldSends++;if(replaceTransport) current=replacement else allowed=false;accepted(bytes) }
    current=initial
    val first=GatewaySyncWorker(db,{current},{allowed},{MonotonicClock(boot,1000L)}).runOnce(100_000L)
    assertEquals(1,oldSends);assertEquals(1,first.committed)
    assertEquals(1,db.readableDatabase.rawQuery("SELECT count(*) FROM gateway_sync WHERE state='PENDING' AND lease_token IS NULL AND attempt_count=0",null).use {it.moveToFirst();it.getInt(0)})
    allowed=true;current=replacement
    val resumed=GatewaySyncWorker(db,{current},{allowed},{MonotonicClock(boot,2000L)}).runOnce(101_000L)
    assertEquals(1,resumed.committed);assertEquals(1,newSends)
    assertEquals(2,db.readableDatabase.rawQuery("SELECT count(*) FROM gateway_sync WHERE state='COMMITTED'",null).use {it.moveToFirst();it.getInt(0)})
  }
  @Test fun sync_stops_after_qualification_withdrawal_mid_batch() = syncBatchWithdrawal(false)
  @Test fun sync_stops_after_transport_replacement_mid_batch() = syncBatchWithdrawal(true)
  private fun syncWorker(send: (ByteArray) -> GatewayCloudResult,qualified: () -> Boolean = {true},leaseClock: (() -> MonotonicClock)? = null): GatewaySyncWorker {
    val registered=GatewayReceiptTransport(send)
    return if(leaseClock==null) GatewaySyncWorker(db,{registered},qualified) else GatewaySyncWorker(db,{registered},qualified,leaseClock)
  }
  private fun signedHeaders(key: KeyPair, method: String, path: String, origin: String, csrf: String, nonce: String, body: ByteArray): Map<String, String> {
    val host = origin.removePrefix("https://")
    return mapOf(
      "X-Sagip-Browser-Key" to b64(key.public.encoded),
      "X-Sagip-Request-Nonce" to nonce,
      "X-Sagip-Browser-Signature" to b64(signP1363(key, GatewayBrowserCredential.requestInput(method, path, host, origin, csrf, nonce, body))),
    )
  }

  private fun request(port: Int, method: String, path: String, origin: String, body: ByteArray, extra: Map<String, String> = emptyMap(), includeOrigin: Boolean = true): HttpResponse {
    val socket = tls.client.socketFactory.createSocket("127.0.0.1", port) as SSLSocket
    socket.soTimeout = 5_000
    socket.startHandshake()
    val headers = linkedMapOf("Host" to origin.removePrefix("https://"), "Connection" to "close")
    if (includeOrigin) headers["Origin"] = origin
    if (method == "POST") headers["Content-Length"] = body.size.toString()
    extra.forEach { (k, v) -> headers[k] = v }
    val head = buildString {
      append("$method $path HTTP/1.1\r\n")
      headers.forEach { (k, v) -> append("$k: $v\r\n") }
      append("\r\n")
    }.toByteArray(StandardCharsets.US_ASCII)
    socket.outputStream.write(head)
    if (body.isNotEmpty()) socket.outputStream.write(body)
    socket.outputStream.flush()
    val bytes = socket.inputStream.readBytes()
    socket.close()
    val split = indexOf(bytes, "\r\n\r\n".toByteArray(StandardCharsets.US_ASCII))
    assertTrue(split >= 0)
    val lines = String(bytes, 0, split, StandardCharsets.US_ASCII).split("\r\n")
    val status = lines.first().split(' ')[1].toInt()
    val responseHeaders = lines.drop(1).associate { line ->
      val i = line.indexOf(':')
      line.substring(0, i).lowercase() to line.substring(i + 1).trim()
    }
    return HttpResponse(status, responseHeaders, bytes.copyOfRange(split + 4, bytes.size))
  }

  private fun indexOf(haystack: ByteArray, needle: ByteArray): Int {
    outer@ for (i in 0..haystack.size - needle.size) {
      for (j in needle.indices) if (haystack[i + j] != needle[j]) continue@outer
      return i
    }
    return -1
  }

  private fun freePort(): Int = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
  private fun browserKey(): KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
  private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)
  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }

  private fun signP1363(key: KeyPair, bytes: ByteArray): ByteArray {
    val der = Signature.getInstance("SHA256withECDSA").run { initSign(key.private); update(bytes); sign() }
    var p = 2
    fun scalar(): BigInteger {
      assertEquals(2, der[p++].toInt() and 255)
      val n = der[p++].toInt() and 255
      return BigInteger(1, der.copyOfRange(p, p + n)).also { p += n }
    }
    fun fixed(v: BigInteger): ByteArray {
      val raw = v.toByteArray().let { if (it.size > 32) it.copyOfRange(it.size - 32, it.size) else it }
      return ByteArray(32 - raw.size) + raw
    }
    return fixed(scalar()) + fixed(scalar())
  }

  private fun testTls(): TestTls {
    val pass = "changeit".toCharArray()
    val store = KeyStore.getInstance("PKCS12")
    store.load(ByteArrayInputStream(Base64.decode(TEST_P12, Base64.DEFAULT)), pass)
    val cert = store.getCertificate("gateway-test") as X509Certificate
    val sans = cert.subjectAlternativeNames.orEmpty().mapNotNull { it.getOrNull(1) as? String }
    assertTrue(sans.contains("gateway.test"))
    val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
    kmf.init(store, pass)
    val serverContext = SSLContext.getInstance("TLS")
    serverContext.init(kmf.keyManagers, null, SecureRandom())
    val trust = object : X509TrustManager {
      override fun getAcceptedIssuers() = arrayOf(cert)
      override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
      override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        require(chain != null && chain.isNotEmpty() && chain[0].encoded.contentEquals(cert.encoded))
      }
    }
    val clientContext = SSLContext.getInstance("TLS")
    clientContext.init(null, arrayOf<TrustManager>(trust), SecureRandom())
    return TestTls(serverContext, clientContext, MessageDigest.getInstance("SHA-256").digest(cert.encoded))
  }

  private data class HttpResponse(val status: Int, val headers: Map<String, String>, val body: ByteArray)
  private data class TestTls(val server: SSLContext, val client: SSLContext, val fingerprint: ByteArray)

  companion object {
    private const val TEST_P12 = "MIIELAIBAzCCA9YGCSqGSIb3DQEHAaCCA8cEggPDMIIDvzCCATYGCSqGSIb3DQEHAaCCAScEggEjMIIBHzCCARsGCyqGSIb3DQEMCgECoIG9MIG6MGYGCSqGSIb3DQEFDTBZMDgGCSqGSIb3DQEFDDArBBQzV/CxuD6sWK/5Z74MhB6FAJRv9gICJxACASAwDAYIKoZIhvcNAgkFADAdBglghkgBZQMEASoEEEzZQpp7g8jJzimmwShVF8gEUAmeAT2UuShACBeXu/3Bqd1KOeaCcTTHVTK2s9+R8krObB4KTIP4xbjox2eILheQ6/s5Roq1I589C+Zl+jOuvzLvBATdbw4JNL2GQAg/JcxhMUwwJwYJKoZIhvcNAQkUMRoeGABnAGEAdABlAHcAYQB5AC0AdABlAHMAdDAhBgkqhkiG9w0BCRUxFAQSVGltZSAxNzkwOTExMTA5NDk1MIICgQYJKoZIhvcNAQcGoIICcjCCAm4CAQAwggJnBgkqhkiG9w0BBwEwZgYJKoZIhvcNAQUNMFkwOAYJKoZIhvcNAQUMMCsEFB8sPyXpUDie8B2PYYZdQcs4SfpLAgInEAIBIDAMBggqhkiG9w0CCQUAMB0GCWCGSAFlAwQBKgQQNU+3Ryq+e8dNRgscoB69dICCAfAVxlXrgmJkT6KI3pNjvOGfxKhGSwWyfIsSFE/VxYNr831UOcUv+/yA7Rp+VHWabw+b4bSfmt1RSV1bfcGQfoQXs/kn/Np1uTUyP0uEXgUnGBG9ud6m2z0LPxM1eZ29u7pEL870nAFGxbthtGi64mDb1aqwe342+Sb0RzI+GZlaaXnXMun3Yqh88PptwTIYAIJFfLR1sc2ejZGHUG3Y6x8AgifhVwgVx7GreZ0v7u7vtC10uQrwWUmw8lnXwzuS+EQzn0pP5mMa1IezIoUtIeylK9Ti687vC0kwUXp6HkRQAFqbQUEx0mLUE3wr9gWqokjzt8+nnxjqesXA5AM5WycDO/MWgU6gND2un57Ib5pvoSN7IJ5u+LiEdoxZkR82TdwJfVvs00HkG5F8scDk65vNmnSKGVgMWOyeU93U91wpGhab6g1dSAKiEImPeEFvao1KrFd6pAyDNrL0uPWQ07dzEkRWQorjcFNQyFCnKBGzvqJwDHG87hesM1JUTBjbAZ8DGmlaqqJicVlai6gOF4Lr0k2CZdsJbVpgeZNtQQ9zCT2wyaOcksP6SQ80swN14BfUWuuHdmBt0frKH84Q0mcP4S86R97WvRjArkZumjnMg1ubSuBeurWTHuzucgiCLUKZ0Py6OOpGeDsIuccCCFVWME0wMTANBglghkgBZQMEAgEFAAQgTKBxuhon3r10mKfAqyNlVF9PMvmlfALmYE7M9ROjqJkEFDv5y3ypK7LBDARpQWEeTWcq2IhlAgInEA=="
  }
}



private class ActionApiTestIdentity : SigningIdentity {
  private val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
  override val publicKeyDer get() = pair.public.encoded
  override val keyId get() = MessageDigest.getInstance("SHA-256").digest(publicKeyDer)
  override fun sign(data: ByteArray) = Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(data); sign() }
}





















