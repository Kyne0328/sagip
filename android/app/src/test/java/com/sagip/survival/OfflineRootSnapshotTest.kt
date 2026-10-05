package com.sagip.survival

import java.io.File
import java.math.BigInteger
import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test

/** Cross-language fixtures are emitted by the real Node receipt, snapshot and feed services. */
class OfflineRootSnapshotTest {
  private val fixture by lazy {
    listOf(File("../fixtures/offline-root-v1/golden.json"),File("../../fixtures/offline-root-v1/golden.json"))
      .first { it.isFile }.readText()
  }
  // Only extract uniquely named fixture values; production canonical parsing is exercised below.
  private fun string(name:String)=Regex("\"" + name + "\"\\s*:\\s*\"([^\"]*)\"").find(fixture)!!.groupValues[1]
  private fun number(name:String)=Regex("\"" + name + "\"\\s*:\\s*([0-9]+)").find(fixture)!!.groupValues[1].toLong()
  private fun topLevelString(name:String)=Regex("(?m)^  \"" + name + "\"\\s*:\\s*\"([^\"]*)\"").find(fixture)!!.groupValues[1]
  private fun bytes(name:String)=hex(string(name))
  private fun hex(s:String)=s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
  private val proof get()=bytes("proofHex")
  private val receipt get()=bytes("receiptHex")
  private val fields get()=OfflineRootSnapshotCodec.decodeProof(proof)
  private fun strings(name:String):List<String> {
    val body=Regex("\"" + name + "\"\\s*:\\s*\\[([^]]*)]").find(fixture)!!.groupValues[1]
    return Regex("\"([^\"]+)\"").findAll(body).map { it.groupValues[1] }.toList()
  }
  private fun policy():OfflineRootPolicy {
    val statuses=Regex("\"allowedStatuses\"\\s*:\\s*\\[([^]]*)]").find(fixture)!!.groupValues[1]
    return OfflineRootPolicy(string("mode"),string("authorityDomainId"),
      listOf(OfflineRootSignerBinding(string("checkpointSignerKeyId"),string("receiptRootKeyId"),string("issuerProviderId"))),
      strings("allowedScopes"),Regex("[0-9]+").findAll(statuses).map { it.value.toInt() }.toList(),
      number("maxAuthorityStalenessMs"),number("maxReceiptIssuanceAgeMs"),number("maxProofValidityMs"),
      strings("qualifiedTimeSourceIds"),string("disseminationAudience"),string("providerConflictHandling"),
      string("resolvedHandling"),number("maxReplayRecords").toInt())
  }
  private fun context():VerificationContext {
    val p=fields
    val config=OfflineRootConfig(policy(),mapOf(p["checkpointSignerKeyId"] to bytes("checkpointPublicKeyDerHex")),{null})
    return VerificationContext(mapOf(p["receiptRootKeyId"] to bytes("rootPublicKeyDerHex")),emptySet(),setOf(p["scope"]),
      TimeInterval(number("earliestMs"),number("latestMs")),null,false,
      ReportIdentity(p["reportId"],p.number("reportProtocolVersion").toInt(),p.number("revision").toInt(),
        hex(p["payloadDigest"]),hex(p["originKeyId"]),bytes("originPublicKeyDerHex")),null,
      offlineRoot=OfflineRootVerificationContext(proof,config,emptySet(),emptySet(),number("activeReportRevision").toInt()))
  }
  private fun verify(c:VerificationContext=context(),r:ByteArray=receipt)=ReceiptAuthority.verifyReceipt(r,c)
  private fun unverified(c:VerificationContext,r:ByteArray=receipt) {
    assertFalse("Must never create trusted authority",verify(c,r) is ReceiptVerification.Verified)
  }
  private fun frame(body:ByteArray,original:ByteArray=proof)=
    original.copyOfRange(0,4)+ByteBuffer.allocate(4).putInt(body.size).array()+body+original.copyOfRange(original.size-64,original.size)
  private fun body(original:ByteArray=proof)=String(original.copyOfRange(8,original.size-64),Charsets.UTF_8)

  @Test fun node_service_fixture_matches_native_policy_signature_bundle_and_historical_class() {
    assertEquals(string("policyDigest"),OfflineRootSnapshotCodec.policyDigest(policy()))
    assertEquals(topLevelString("proofDigest"),OfflineRootSnapshotCodec.digest(proof))
    assertEquals(string("bundleDigest"),OfflineRootSnapshotCodec.digest(bytes("bundleHex")))
    assertEquals(string("receiptDigest"),OfflineRootSnapshotCodec.digest(receipt))
    val b=OfflineRootSnapshotCodec.decodeBundle(bytes("bundleHex"))
    assertArrayEquals(receipt,b.receipt);assertArrayEquals(proof,b.proof)
    assertTrue(OfflineRootSnapshotCodec.verifySignature(fields,bytes("checkpointPublicKeyDerHex")))
    assertTrue(ReceiptV2Codec.verifySignature(ReceiptV2Codec.decode(receipt),bytes("rootPublicKeyDerHex")))
    val result=verify() as ReceiptVerification.Verified
    assertEquals("VERIFIED_OFFLINE_ROOT_SNAPSHOT",result.kind)
    assertTrue(result.historicalRootSnapshot)
    assertTrue(result.revocationNotCheckedWhileOffline)
    assertEquals(fields.number("authorityCheckedAtMs"),result.authorityCheckedAtMs)
    assertEquals(fields["eventId"],result.eventId)
    assertNotEquals("VERIFIED_CURRENT",result.kind)
  }

  @Test fun node_renewed_resolved_and_equivocation_variants_keep_their_distinct_meanings() {
    val variantText=fixture.substringAfter("\"variants\":")
    val later=Regex("\"laterCheckpoint\"\\s*:\\s*\\{([^}]+)}").find(variantText)!!.groupValues[1]
    fun laterTime(name:String)=Regex("\""+name+"\"\\s*:\\s*([0-9]+)").find(later)!!.groupValues[1].toLong()
    val time=TimeInterval(laterTime("earliestMs"),laterTime("latestMs"))
    val c=context()
    unverified(c.copy(trustedTime=time))
    for(name in listOf("renewedBundleHex","resolvedBundleHex")) {
      val b=OfflineRootSnapshotCodec.decodeBundle(bytes(name))
      val p=OfflineRootSnapshotCodec.decodeProof(b.proof)
      assertTrue(OfflineRootSnapshotCodec.verifySignature(p,bytes("checkpointPublicKeyDerHex")))
      val result=verify(c.copy(trustedTime=time,offlineRoot=c.offlineRoot!!.copy(proofBytes=b.proof)),b.receipt)
      assertTrue(name,result is ReceiptVerification.Verified)
      assertEquals(OfflineRootSnapshotCodec.KIND,result.kind)
      assertTrue((result as ReceiptVerification.Verified).historicalRootSnapshot)
      if(name=="renewedBundleHex") {
        assertArrayEquals(receipt,b.receipt)
        assertNotEquals(fields["proofId"],p["proofId"])
        assertEquals(fields["eventId"],p["eventId"])
        assertTrue(p.number("expiresAtMs")>fields.number("expiresAtMs"))
      } else {
        assertEquals(4L,p.number("status"))
        assertEquals(4,(ReceiptV2Codec.decode(b.receipt).fields as ReceiptFields.Responder).status)
      }
    }
    // It is cryptographically authentic; the durable store must detect same-epoch state conflict.
    val equivocation=OfflineRootSnapshotCodec.decodeBundle(bytes("equivocationBundleHex"))
    val conflicting=OfflineRootSnapshotCodec.decodeProof(equivocation.proof)
    assertTrue(OfflineRootSnapshotCodec.verifySignature(conflicting,bytes("checkpointPublicKeyDerHex")))
    assertEquals(fields["revocationEpoch"],conflicting["revocationEpoch"])
    assertNotEquals(fields["authorityStateDigest"],conflicting["authorityStateDigest"])
  }

  @Test fun strict_canonical_body_rejects_alternate_order_whitespace_duplicate_keys_types_escapes_and_bounds() {
    val canonical=body()
    val malformed=listOf(
      canonical.replace("{","{ "),
      canonical.replace("\"version\":1","\"version\":01"),
      canonical.replace("\"version\":1","\"version\":1.0"),
      canonical.replace("\"version\":1","\"version\":\"1\""),
      canonical.replace("\"version\":1","\"version\":1,\"version\":1"),
      canonical.replace("\"version\":1,\"algorithm\":1","\"algorithm\":1,\"version\":1"),
      canonical.replace("\"version\":1","\"version\":2"),
      canonical.replace("\"algorithm\":1","\"algorithm\":2"),
      canonical.replace("\"revision\":1","\"revision\":0"),
      canonical.replace("\"status\":2","\"status\":0"),
      canonical.replace("\"revocationEpoch\":\"1\"","\"revocationEpoch\":1"),
      canonical.replace("\"revocationEpoch\":\"1\"","\"revocationEpoch\":\"01\""),
      canonical.replace("\"revocationEpoch\":\"1\"","\"revocationEpoch\":\"9223372036854775808\""),
      canonical.replace("SAGIP_OFFLINE_ROOT_SNAPSHOT","SAGIP\\u005fOFFLINE_ROOT_SNAPSHOT"),
      canonical.replace(fields["proofId"],"00000000-0000-0000-0000-000000000000"),
      canonical.replace(fields["receiptDigest"],fields["receiptDigest"].uppercase()),
      "\uFEFF"+canonical,
      canonical+" ",
      canonical.dropLast(1)+",\"unknown\":1}",
      canonical.replace("\"authorityCheckedAtMs\":"+fields["authorityCheckedAtMs"],"\"authorityCheckedAtMs\":9007199254740992")
    )
    malformed.forEachIndexed { index,value ->
      assertThrows("canonical mutation "+index,Exception::class.java) { OfflineRootSnapshotCodec.decodeProof(frame(value.toByteArray())) }
    }
    val invalidUtf8=canonical.toByteArray().also { it[10]=0xc0.toByte() }
    assertThrows(Exception::class.java) { OfflineRootSnapshotCodec.decodeProof(frame(invalidUtf8)) }
    assertThrows(Exception::class.java) { OfflineRootSnapshotCodec.decodeProof(proof+byteArrayOf(0)) }
    assertThrows(Exception::class.java) { OfflineRootSnapshotCodec.decodeProof(ByteArray(4097)) }
    assertThrows(Exception::class.java) { OfflineRootSnapshotCodec.decodeProof(proof.copyOf().also { it[7]=0 }) }
  }

  @Test fun low_s_raw_signature_and_domain_separation_are_mandatory() {
    assertFalse(OfflineRootSnapshotCodec.verifySignature(fields,bytes("rootPublicKeyDerHex")))
    assertFalse(OfflineRootSnapshotCodec.verifySignature(fields,ByteArray(91)))
    val zero=proof.copyOf().also { it.fill(0,it.size-64,it.size) }
    assertThrows(Exception::class.java) { OfflineRootSnapshotCodec.decodeProof(zero) }
    val order=BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",16)
    val high=order.subtract(BigInteger(1,proof.copyOfRange(proof.size-32,proof.size))).toByteArray()
    val highS=proof.copyOf().also {
      val fixed=ByteArray(32);val value=high.takeLast(32).toByteArray();value.copyInto(fixed,32-value.size)
      fixed.copyInto(it,it.size-32)
    }
    assertThrows(Exception::class.java) { OfflineRootSnapshotCodec.decodeProof(highS) }
    val forged=frame(body().replace("\"status\":2","\"status\":3").toByteArray())
    assertFalse(OfflineRootSnapshotCodec.verifySignature(OfflineRootSnapshotCodec.decodeProof(forged),bytes("checkpointPublicKeyDerHex")))
    unverified(context().let { it.copy(offlineRoot=it.offlineRoot!!.copy(proofBytes=forged)) })
  }

  @Test fun wrong_report_origin_revision_keys_policy_and_absent_proof_fail_closed() {
    val c=context();val s=c.offlineRoot!!;val report=c.report!!
    unverified(c.copy(offlineRoot=null))
    unverified(c.copy(roots=emptyMap()))
    unverified(c.copy(offlineRoot=s.copy(configuration=s.configuration.copy(checkpointSignerKeys=emptyMap()))))
    unverified(c.copy(report=null))
    unverified(c.copy(report=report.copy(reportId="99999999-9999-4999-8999-999999999999")))
    unverified(c.copy(report=report.copy(revision=report.revision+1)))
    unverified(c.copy(report=report.copy(payloadDigest=ByteArray(32))))
    unverified(c.copy(report=report.copy(originKeyId=ByteArray(32))))
    unverified(c.copy(report=report.copy(originPublicKeyDer=bytes("rootPublicKeyDerHex"))))
    unverified(c.copy(offlineRoot=s.copy(activeReportRevision=0)))
    unverified(c.copy(offlineRoot=s.copy(configuration=s.configuration.copy(policy=policy().copy(allowedScopes=listOf("OTHER"))))))
    val r=ReceiptV2Codec.decode(receipt)
    val privateNote=(r.fields as ReceiptFields.Responder).copy(note="Private medical detail")
    val withNote=ReceiptV2Codec.encode(privateNote,r.signature,r.proof)
    unverified(c,withNote)
    val bundle=ByteBuffer.allocate(12).put("SGB1".toByteArray()).putInt(withNote.size).putInt(proof.size).array()+withNote+proof
    assertThrows(Exception::class.java) { OfflineRootSnapshotCodec.decodeBundle(bundle) }
    assertThrows(Exception::class.java) { OfflineRootSnapshotCodec.decodeBundle(bytes("bundleHex")+byteArrayOf(0)) }
  }

  @Test fun expiry_equality_staleness_and_missing_time_fail_closed() {
    val c=context();val p=fields
    unverified(c.copy(trustedTime=null))
    unverified(c.copy(trustedTime=TimeInterval(p.number("expiresAtMs"),p.number("expiresAtMs"))))
    unverified(c.copy(trustedTime=TimeInterval(p.number("notBeforeMs")-1,p.number("notBeforeMs"))))
    unverified(c.copy(trustedTime=TimeInterval(p.number("authorityCheckedAtMs"),p.number("authorityCheckedAtMs"))))
    unverified(c.copy(trustedTime=TimeInterval(c.trustedTime!!.latestMs,c.trustedTime!!.earliestMs)))
    unverified(c.copy(trustedTime=TimeInterval(0,OfflineRootSnapshotCodec.MAX_TIME)))
    val s=c.offlineRoot!!
    // A tighter locally selected bound changes the digest, so it cannot reuse the signed policy.
    unverified(c.copy(offlineRoot=s.copy(configuration=s.configuration.copy(policy=policy().copy(maxAuthorityStalenessMs=1)))))
  }

  @Test fun authenticated_revocation_fixture_and_each_known_revocation_are_enforced() {
    val revocation=OfflineRootSnapshotCodec.decodeRevocation(bytes("revocationHex"))
    assertTrue(OfflineRootSnapshotCodec.verifySignature(revocation,bytes("checkpointPublicKeyDerHex")))
    assertEquals("KEY",revocation["targetKind"])
    assertEquals(fields["receiptRootKeyId"],revocation["targetId"])
    val c=context();val s=c.offlineRoot!!
    for(key in listOf(fields["receiptRootKeyId"],fields["checkpointSignerKeyId"]))
      unverified(c.copy(offlineRoot=s.copy(revokedKeyIds=setOf(key))))
    unverified(c.copy(offlineRoot=s.copy(revokedProviderIds=setOf(fields["issuerProviderId"]))))
    assertThrows(Exception::class.java) { OfflineRootSnapshotCodec.decodeProof(bytes("revocationHex")) }
    assertThrows(Exception::class.java) { OfflineRootSnapshotCodec.decodeRevocation(proof) }
  }

  @Test fun policy_rejects_unsafe_unbounded_unqualified_or_closing_configuration() {
    val p=policy()
    listOf(p.copy(maxAuthorityStalenessMs=900001),p.copy(maxProofValidityMs=0),
      p.copy(maxReceiptIssuanceAgeMs=86400001),p.copy(maxReplayRecords=0),
      p.copy(qualifiedTimeSourceIds=emptyList()),p.copy(allowedScopes=listOf("a space")),
      p.copy(allowedStatuses=listOf(2,2)),p.copy(resolvedHandling="EXCLUDE"),
      p.copy(providerConflictHandling="AUTO_CLOSE"),p.copy(disseminationAudience="EVERYONE"),
      p.copy(signerBindings=listOf(p.signerBindings.first().let { it.copy(checkpointSignerKeyId=it.receiptRootKeyId) })))
      .forEach { assertThrows(Exception::class.java) { OfflineRootSnapshotCodec.policyDigest(it) } }
  }
}
