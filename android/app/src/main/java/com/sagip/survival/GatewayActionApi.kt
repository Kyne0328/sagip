package com.sagip.survival

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID

 data class GatewayApiResponse(val status: Int, val body: ByteArray, val contentType: String = "application/json")

/** Called only after TLS/session/possession authorization. Caller JSON never supplies authority. */
class GatewayActionApi(private val database: SagipDatabase, private val service: ResponderGatewayService,
  private val clock: () -> MonotonicClock) {
  private class Denied(val status: Int, val code: String): RuntimeException()
  private fun deny(status: Int, code: String): Nothing = throw Denied(status, code)
  private fun json(status: Int, value: JSONObject) = GatewayApiResponse(status, value.toString().toByteArray(Charsets.UTF_8))
  fun handle(method: String, path: String, body: ByteArray, owner: String): GatewayApiResponse = try {
    if (owner.isEmpty()) deny(401, "SESSION_REQUIRED")
    if (body.size > if(path.endsWith("/import")) 8192 else 4096) deny(413, "BODY_TOO_LARGE")
    when {
      method == "POST" && path == "/gateway/v1/actions" -> action(body)
      method == "GET" && path.startsWith("/gateway/v1/actions/") -> actionGet(path)
      method == "POST" && path == "/gateway/v1/snapshots" -> {
        if (StrictGatewayJson.parse(body).length() != 0) deny(400,"INVALID_FIELDS")
        snapshot(owner)
      }
      method == "GET" && path.startsWith("/gateway/v1/snapshots/") -> snapshotPage(path,owner)
      method == "POST" && path == "/gateway/v1/envelopes/import" -> envelopeImport(body)
      method == "POST" && path == "/gateway/v1/receipts/import" -> receiptImport(body)
      else -> deny(404,"NOT_FOUND")
    }
  } catch (e: Denied) { json(e.status, JSONObject().put("error", e.code)) }
    catch (_: IllegalArgumentException) { json(400,JSONObject().put("error","INVALID_JSON")) }
    catch (e: IllegalStateException) {
      if (e.message == "CAPACITY_FULL") json(429,JSONObject().put("error","CAPACITY_FULL"))
      else json(503,JSONObject().put("error","STORAGE_UNAVAILABLE"))
    }
    catch (_: Exception) { json(503,JSONObject().put("error","STORAGE_UNAVAILABLE")) }

  private fun action(body: ByteArray): GatewayApiResponse = synchronized(service) {
    val j = StrictGatewayJson.parse(body)
    if (j.keys().asSequence().toSet() != ACTION_FIELDS) deny(400,"INVALID_FIELDS")
    fun string(name: String): String = (j.opt(name) as? String) ?: deny(400,"INVALID_FIELDS")
    fun integer(name: String): Int = when (val n = j.opt(name)) { is Int -> n; else -> deny(400,"INVALID_FIELDS") }
    val id = string("actionId"); val reportId = string("reportId"); val responder = string("responderId")
    if (!uuid(id) || !uuid(reportId) || !uuid(responder)) deny(400,"INVALID_FIELDS")
    val providerKind = integer("providerKind"); val protocol = integer("reportProtocolVersion"); val revision = integer("revision")
    if (providerKind !in 1..2 || protocol !in 1..2 || revision < 1) deny(400,"INVALID_FIELDS")
    val provider = digest(string("issuerProviderId")); val payload = digest(string("payloadDigest")); val origin = digest(string("originKeyId")); val digest = digest(string("actionDigest"))
    val observedString = string("observedIncidentVersion")
    if (!observedString.matches(Regex("0|[1-9][0-9]{0,15}"))) deny(400,"INVALID_FIELDS")
    val observed = observedString.toLongOrNull() ?: deny(400,"INVALID_FIELDS")
    if (observed > 9007199254740991L) deny(400,"INVALID_FIELDS")
    val status = STATUSES.indexOf(string("status"))+1
    if(status !in 1..4) deny(400,"INVALID_FIELDS")
    val note = if(j.isNull("note")) "" else string("note")
    if (note.contains('\u0000') || note.toByteArray(Charsets.UTF_8).size > 1024) deny(400,"INVALID_FIELDS")
    if (runCatching { Charsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT).encode(java.nio.CharBuffer.wrap(note)) }.isFailure) deny(400,"INVALID_FIELDS")
    val grant = service.authorizedGrant() ?: deny(403,"AUTHORITY_UNAVAILABLE")
    if (providerKind != 2 || !MessageDigest.isEqual(provider,grant.issuerProviderId)) deny(403,"AUTHORITY_UNAVAILABLE")
    if (responder != grant.responderId || grant.statusMask and (1 shl(status-1)) == 0) deny(403,"ROLE_REQUIRED")
    val f = ReceiptFields.Responder(providerKind,provider,id,ByteArray(32),reportId,protocol,revision,payload,origin,grant.issuerKeyId,grant.grantId,responder,grant.callsign,observed,status,1,0,1,note)
    if (!MessageDigest.isEqual(ReceiptAuthority.actionDigest(f),digest)) deny(400,"INVALID_FIELDS")
    // Normalize semantic fields, including null/empty note, before immutable comparison.
    val canonical = JSONObject().apply { ACTION_FIELDS.sorted().forEach { put(it,j.get(it)) }; put("note",note) }.toString()
    val db = database.writableDatabase
    var existing = false
    var result: ActionCommitResult
    db.beginTransaction()
    try {
      db.rawQuery("SELECT responder_id,provider_id,action_digest,intent_json FROM gateway_api_actions WHERE action_id=?",arrayOf(id)).use { c ->
        if(c.moveToFirst()) {
          existing = true
          if(c.getString(0)!=responder || c.getString(1)!=hex(provider)) deny(404,"ACTION_NOT_FOUND")
          if(c.getString(2)!=hex(digest) || c.getString(3)!=canonical) deny(409,"ACTION_CONFLICT")
        }
      }
      if (!existing) {
        if (db.rawQuery("SELECT 1 FROM gateway_work WHERE action_id=?",arrayOf(id)).use { it.moveToFirst() }) deny(409,"ACTION_CONFLICT")
        val matches = db.rawQuery("SELECT report_protocol_version,payload_digest,origin_key_id FROM receipt_report_identities WHERE report_id=? AND revision=? AND revision=(SELECT MAX(revision) FROM receipt_report_identities WHERE report_id=?)",arrayOf(reportId,revision.toString(),reportId)).use { c ->
          c.moveToFirst() && c.getInt(0)==protocol && MessageDigest.isEqual(c.getBlob(1),payload) && MessageDigest.isEqual(c.getBlob(2),origin)
        }
        if(!matches) deny(422,"REPORT_BINDING_INVALID")
      }
      result = service.saveGatewayAction(ActionIntent(id,reportId,observed,status,note))
      if (result.state == ActionCommitState.CONFLICT) deny(409,result.reason ?: "ACTION_CONFLICT")
      if (result.state == ActionCommitState.REJECTED) deny(if(result.reason=="CAPACITY_FULL") 429 else 400,result.reason ?: "INVALID_FIELDS")
      if(!existing) db.execSQL("INSERT INTO gateway_api_actions(action_id,responder_id,provider_id,action_digest,intent_json) VALUES(?,?,?,?,?)",arrayOf(id,responder,hex(provider),hex(digest),canonical))
      db.setTransactionSuccessful()
    } finally { db.endTransaction() }
    if (result.state == ActionCommitState.PREPARING) result = service.prepareGatewayAction(ActionIntent(id,reportId,observed,status,note))
    json(if(existing) 200 else 201,actionResult(result,hex(provider),hex(digest)))
  }
  private fun actionResult(result: ActionCommitResult, provider: String, digest: String) = JSONObject()
    .put("actionId",result.actionId).put("issuerProviderId",provider).put("actionDigest",digest)
    .put("state",result.state.name).put("eventDigest",result.bytes?.let { hex(hash(it)) } ?: JSONObject.NULL)
    .put("reason",result.reason ?: JSONObject.NULL)
  private fun actionGet(path: String): GatewayApiResponse {
    val match = Regex("/gateway/v1/actions/([0-9a-f-]{36})(/receipt)?").matchEntire(path) ?: deny(404,"ACTION_NOT_FOUND")
    val id = match.groupValues[1]; if(!uuid(id)) deny(400,"INVALID_FIELDS")
    val grant = service.authorizedGrant() ?: deny(403,"AUTHORITY_UNAVAILABLE")
    val row = database.readableDatabase.rawQuery("SELECT provider_id,action_digest,responder_id FROM gateway_api_actions WHERE action_id=?",arrayOf(id)).use { c ->
      if(!c.moveToFirst()) null else Triple(c.getString(0),c.getString(1),c.getString(2))
    } ?: deny(404,"ACTION_NOT_FOUND")
    if(row.first!=hex(grant.issuerProviderId) || row.third!=grant.responderId) deny(404,"ACTION_NOT_FOUND")
    val result = service.getGatewayAction(id)
    if(match.groupValues[2].isNotEmpty()) {
      val bytes = result.bytes ?: deny(409,"RECEIPT_NOT_READY")
      return GatewayApiResponse(200,bytes.copyOf(),"application/octet-stream")
    }
    return json(200,actionResult(result,row.first,row.second))
  }
  private fun incidentJson(i: GatewayIncident): JSONObject {
    val envelopes = database.readableDatabase.rawQuery("SELECT envelope_bytes,received_at FROM inbound_envelopes WHERE report_id=? UNION ALL SELECT envelope_bytes,created_at FROM outbound_envelopes WHERE report_id=? AND envelope_bytes IS NOT NULL",arrayOf(i.identity.reportId,i.identity.reportId)).use { c ->
      var found: Pair<DecodedEnvelopeV1,Long>? = null
      while(c.moveToNext()) {
        val decoded=TransportEnvelopeV1.decode(c.getBlob(0))
        if(decoded.revision==i.identity.revision) { found=Pair(decoded,c.getLong(1));break }
      }
      requireNotNull(found)
    }
    val envelope = envelopes.first
    val evidence = JSONArray()
    i.receiptTimeline.forEach { bytes ->
      val d = ReceiptV2Codec.decode(bytes)
      val verification = ReceiptAuthority.verifyReceipt(bytes,service.verificationContext(i.identity))
      val f = d.fields
      val eventId = when(f) { is ReceiptFields.Responder -> f.actionId; is ReceiptFields.Requester -> f.eventId; else -> error("receipt profile") }
      evidence.put(JSONObject().put("eventId",eventId).put("eventDigest",hex(hash(bytes))).put("bytesBase64",Base64.encodeToString(bytes,Base64.NO_WRAP)).put("kind",if(f is ReceiptFields.Responder) "SGA2" else "SGR2").put("verification",verification.kind).put("issuerProviderId",(f as? ReceiptFields.Responder)?.issuerProviderId?.let(::hex) ?: JSONObject.NULL))
    }
    val location = i.location?.let { JSONObject().put("latitude",it.latitude).put("longitude",it.longitude).put("accuracyMeters",it.accuracyMeters ?: JSONObject.NULL).put("capturedAtMs",it.capturedAt).put("source",it.source).put("freshness",it.freshness) }
    val pending = JSONArray(); i.pendingActions.forEach { pending.put(JSONObject().put("actionId",it.actionId).put("observedIncidentVersion",it.observedIncidentVersion.toString()).put("status",STATUSES[it.status-1]).put("note",it.note)) }
    return JSONObject().put("reportId",i.identity.reportId).put("reportProtocolVersion",i.identity.reportProtocolVersion).put("revision",i.identity.revision).put("payloadDigest",hex(i.identity.payloadDigest)).put("originKeyId",hex(i.identity.originKeyId)).put("observedIncidentVersion",i.observedIncidentVersion.toString()).put("emergencyType",i.emergencyType.name).put("urgency",i.urgency.name).put("location",location ?: JSONObject.NULL).put("reportCreatedAtMs",envelope.createdAt).put("receivedAtMs",envelopes.second).put("syncedAtMs",JSONObject.NULL).put("receiptEvidence",evidence).put("pendingActions",pending)
  }
  private fun snapshot(owner: String): GatewayApiResponse = synchronized(service) {
    val authority = service.sessionAuthority() ?: deny(403,"AUTHORITY_UNAVAILABLE")
    val now = clock(); val db = database.writableDatabase
    db.beginTransaction()
    try {
      db.delete("gateway_snapshots","boot_id!=? OR expires_elapsed_ms<=?",arrayOf(now.bootId,now.elapsedMs.toString()))
      val ownerKey = "${authority.providerId}:$owner"
      val responderKey = requireNotNull(service.authorizedGrant()).responderId
      if(db.rawQuery("SELECT count(*) FROM gateway_snapshots WHERE responder_key=?",arrayOf(responderKey)).use { it.moveToFirst(); it.getInt(0) } >= 2) deny(429,"CAPACITY_FULL")
      val incidents = service.listGatewayIncidents().sortedBy { it.identity.reportId }
      if(incidents.size>10000) deny(429,"CAPACITY_FULL")
      val entries = incidents.map(::incidentJson)
      val id = UUID.randomUUID().toString(); val created = authority.trustedTime.latestMs
      val summary = JSONObject().put("total",entries.size).put("missingLocation",incidents.count { it.location==null })
      val metadata = JSONObject().put("snapshotId",id).put("createdAtMs",created).put("expiresAtMs",Math.addExact(created,900000L)).put("total",entries.size).put("summary",summary)
      val pages = mutableListOf<JSONArray>(); var current=JSONArray(); var estimated=metadata.toString().toByteArray().size+1024
      entries.forEach { entry ->
        val size=entry.toString().toByteArray(Charsets.UTF_8).size+1
        if(size+1024>4*1024*1024) deny(429,"CAPACITY_FULL")
        if(current.length()>=100 || estimated+size>4*1024*1024) { pages.add(current); current=JSONArray(); estimated=metadata.toString().toByteArray().size+1024 }
        current.put(entry); estimated+=size
      }
      if(current.length()>0 || pages.isEmpty()) pages.add(current)
      val tokens=pages.map { ByteArray(32).also(SecureRandom()::nextBytes).let { Base64.encodeToString(it,Base64.NO_WRAP or Base64.URL_SAFE or Base64.NO_PADDING) } }
      val serialized=pages.mapIndexed { index,page -> JSONObject(metadata.toString()).put("entries",page).put("nextCursor",tokens.getOrNull(index+1) ?: JSONObject.NULL).toString() }
      val bytes=serialized.sumOf { it.toByteArray(Charsets.UTF_8).size.toLong() }+metadata.toString().toByteArray().size
      val stored=db.rawQuery("SELECT coalesce(sum(byte_count),0) FROM gateway_snapshots",null).use { it.moveToFirst();it.getLong(0) }
      if(stored+bytes>128L*1024*1024 || serialized.any { it.toByteArray().size>4*1024*1024 }) deny(429,"CAPACITY_FULL")
      db.execSQL("INSERT INTO gateway_snapshots(snapshot_id,owner,responder_key,boot_id,expires_elapsed_ms,metadata_json,byte_count) VALUES(?,?,?,?,?,?,?)",arrayOf(id,ownerKey,responderKey,now.bootId,Math.addExact(now.elapsedMs,900000L),metadata.toString(),bytes))
      serialized.forEachIndexed { index,page -> db.execSQL("INSERT INTO gateway_snapshot_pages(snapshot_id,cursor_hash,page_json) VALUES(?,?,?)",arrayOf(id,hex(hash(tokens[index].toByteArray(Charsets.US_ASCII))),page)) }
      db.setTransactionSuccessful()
      json(201,metadata.put("nextCursor",tokens.first()))
    } finally { db.endTransaction() }
  }
  private fun snapshotPage(path: String,owner: String): GatewayApiResponse {
    val authority = service.sessionAuthority() ?: deny(403,"AUTHORITY_UNAVAILABLE")
    val match=Regex("/gateway/v1/snapshots/([0-9a-f-]{36})/pages\\?cursor=([A-Za-z0-9_-]{1,512})").matchEntire(path) ?: deny(404,"SNAPSHOT_NOT_FOUND")
    val now=clock()
    val row=database.readableDatabase.rawQuery("SELECT owner,boot_id,expires_elapsed_ms FROM gateway_snapshots WHERE snapshot_id=?",arrayOf(match.groupValues[1])).use { c -> if(!c.moveToFirst()) null else Triple(c.getString(0),c.getString(1),c.getLong(2)) } ?: deny(404,"SNAPSHOT_NOT_FOUND")
    if(row.first!="${authority.providerId}:$owner") deny(404,"SNAPSHOT_NOT_FOUND")
    if(row.second!=now.bootId || now.elapsedMs>=row.third) deny(410,"SNAPSHOT_EXPIRED")
    val page=database.readableDatabase.rawQuery("SELECT page_json FROM gateway_snapshot_pages WHERE snapshot_id=? AND cursor_hash=?",arrayOf(match.groupValues[1],hex(hash(match.groupValues[2].toByteArray(Charsets.US_ASCII))))).use { c -> if(c.moveToFirst()) c.getString(0) else null } ?: deny(404,"SNAPSHOT_NOT_FOUND")
    return GatewayApiResponse(200,page.toByteArray(Charsets.UTF_8))
  }
  private fun envelopeImport(bytes: ByteArray): GatewayApiResponse {
    service.authorizedGrant() ?: deny(403,"AUTHORITY_UNAVAILABLE")
    if (runCatching { TransportEnvelopeV1.decode(bytes) }.isFailure) deny(422,"REPORT_BINDING_INVALID")
    val result=ReceiptQueue(database).admitObject(bytes.copyOf(),ObjectKind.SOS,service.verificationContext())
    return when(result.kind) {
      CustodyResultKind.COMMITTED,CustodyResultKind.DUPLICATE -> json(if(result.kind==CustodyResultKind.COMMITTED) 201 else 200,JSONObject().put("messageId",result.objectId).put("eventDigest",result.digest?.let(::hex)).put("state",if(result.kind==CustodyResultKind.COMMITTED) "ACCEPTED_DURABLE" else "DUPLICATE_VERIFIED"))
      CustodyResultKind.CAPACITY_FULL -> deny(429,"CAPACITY_FULL")
      else -> deny(422,"SIGNATURE_INVALID")
    }
  }
  private fun receiptImport(bytes: ByteArray): GatewayApiResponse {
    service.authorizedGrant() ?: deny(403,"AUTHORITY_UNAVAILABLE")
    val d=runCatching { ReceiptV2Codec.decode(bytes) }.getOrNull() ?: deny(400,"MALFORMED_OBJECT")
    val f=d.fields
    val reportId: String; val eventId: String; val provider: String?
    when(f) {
      is ReceiptFields.Responder -> { reportId=f.reportId;eventId=f.actionId;provider=hex(f.issuerProviderId) }
      is ReceiptFields.Requester -> { reportId=f.reportId;eventId=f.eventId;provider=ReceiptRepository(database).getReceipt(f.ackEventId)?.let { (ReceiptV2Codec.decode(it).fields as? ReceiptFields.Responder)?.issuerProviderId?.let(::hex) } }
      else -> deny(400,"MALFORMED_OBJECT")
    }
    val owned=bytes.copyOf();val repo=ReceiptRepository(database);val db=database.writableDatabase
    db.beginTransaction()
    try {
      val revision=when(f) { is ReceiptFields.Responder -> f.revision;is ReceiptFields.Requester -> f.revision;else -> error("profile") }
      val report=db.rawQuery("SELECT report_protocol_version,payload_digest,origin_key_id,origin_public_key_der FROM receipt_report_identities WHERE report_id=? AND revision=?",arrayOf(reportId,revision.toString())).use { c ->
        if(!c.moveToFirst()) null else ReportIdentity(reportId,c.getInt(0),revision,c.getBlob(1),c.getBlob(2),c.getBlob(3))
      }
      val context=service.verificationContext(report).copy(linkedAck=(f as? ReceiptFields.Requester)?.let { repo.getReceipt(it.ackEventId) })
      val prior=db.rawQuery("SELECT event_digest FROM receipt_records WHERE event_id=?",arrayOf(eventId)).use { c -> if(c.moveToFirst()) c.getBlob(0) else null }
      // Custody, quarantine and projection commit as one unit; a capacity denial rolls the entire import back.
      val custody=ReceiptQueue(database).admitObject(owned,if(f is ReceiptFields.Responder) ObjectKind.RESPONDER_RECEIPT else ObjectKind.REQUESTER_RECEIPT,context)
      if(custody.kind==CustodyResultKind.CAPACITY_FULL) deny(429,"CAPACITY_FULL")
      val state=when(custody.kind) {
        CustodyResultKind.COMMITTED -> if(prior!=null && MessageDigest.isEqual(prior,hash(owned))) "DUPLICATE" else "IMPORTED"
        CustodyResultKind.DUPLICATE -> "DUPLICATE"
        CustodyResultKind.PENDING_VERIFICATION -> "QUARANTINED"
        else -> "REJECTED"
      }
      val projection=if(state=="IMPORTED") {
        val p=repo.projection(reportId)
        if(p?.eventId==eventId || (f is ReceiptFields.Requester && p?.eventId==f.ackEventId)) "APPLIED" else "HISTORICAL"
      } else "NONE"
      db.setTransactionSuccessful()
      return json(200,JSONObject().put("eventId",eventId).put("issuerProviderId",provider ?: JSONObject.NULL).put("eventDigest",hex(hash(owned))).put("state",state).put("projection",projection).put("reason",custody.reason ?: JSONObject.NULL))
    } finally { db.endTransaction() }
  }
  private fun digest(s: String): ByteArray { if(!s.matches(Regex("[0-9a-f]{64}"))) deny(400,"INVALID_FIELDS");return ByteArray(32) { s.substring(it*2,it*2+2).toInt(16).toByte() } }
  private fun uuid(s: String)=runCatching { UUID.fromString(s).toString()==s && s!="00000000-0000-0000-0000-000000000000" }.getOrDefault(false)
  private fun hash(b: ByteArray)=MessageDigest.getInstance("SHA-256").digest(b)
  private fun hex(b: ByteArray)=b.joinToString("") { "%02x".format(it.toInt() and 255) }
  companion object {
    private val ACTION_FIELDS=setOf("actionId","providerKind","issuerProviderId","reportId","reportProtocolVersion","revision","payloadDigest","originKeyId","responderId","observedIncidentVersion","status","note","actionDigest")
    private val STATUSES=listOf("ACKNOWLEDGED","EN_ROUTE","ON_SCENE","RESOLVED")
  }
}

/** Flat canonical request objects only: reject duplicate keys, coercion, trailing bytes and invalid UTF-8. */
internal object StrictGatewayJson {
  fun parse(bytes: ByteArray): JSONObject {
    val text=Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
    var i=0
    fun ws() { while(i<text.length && text[i] in " \t\r\n") i++ }
    fun string(): String {
      require(i<text.length && text[i]=='"');val start=i++
      while(i<text.length) {
        val ch=text[i++]
        if(ch=='"') return org.json.JSONTokener(text.substring(start,i)).nextValue() as String
        require(ch.code>=32)
        if(ch=='\\') { require(i<text.length); val escaped=text[i++]; require(escaped in "\"\\/bfnrtu"); if(escaped=='u') { require(i+4<=text.length && text.substring(i,i+4).matches(Regex("[0-9a-fA-F]{4}")));i+=4 } }
      }
      error("string")
    }
    ws();require(i<text.length && text[i++]=='{');ws();val j=JSONObject();val keys=mutableSetOf<String>()
    if(i<text.length && text[i]=='}') i++ else while(true) {
      val key=string();require(keys.add(key));ws();require(i<text.length && text[i++]==':');ws();require(i<text.length)
      val value:Any=if(text[i]=='"') string() else {
        val start=i;while(i<text.length && text[i] !in ",} \r\n\t") i++
        val raw=text.substring(start,i)
        if(raw=="null") JSONObject.NULL else {require(raw.matches(Regex("0|[1-9][0-9]*")));raw.toInt()}
      }
      j.put(key,value);ws();require(i<text.length)
      when(text[i++]) { '}' -> break; ',' -> ws();else -> error("delimiter") }
    }
    ws();require(i==text.length);return j
  }
}







