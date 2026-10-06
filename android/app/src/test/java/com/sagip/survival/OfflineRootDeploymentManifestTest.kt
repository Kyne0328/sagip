package com.sagip.survival

import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import org.junit.Assert.*
import org.junit.Test

/** Synthetic in-memory keys and profiles only; no deployment configuration is packaged by these tests. */
class OfflineRootDeploymentManifestTest {
  private val boot = "11111111-1111-4111-8111-111111111111"
  private val profile = """{"buildFingerprint":"synthetic/test/device:1/build/user","sdkInt":35,"maximumDriftPpm":50,"maximumCheckpointAgeMs":60000,"evidenceId":"TEST_EVIDENCE_REFERENCE"}"""
  private data class Fixture(val json: String, val rootId: String, val signerId: String, val rootKey: ByteArray)
  private fun fixture(): Fixture {
    fun key(): ByteArray = KeyPairGenerator.getInstance("EC").apply {
      initialize(ECGenParameterSpec("secp256r1"))
    }.generateKeyPair().public.encoded
    val root = key();val signer = key()
    val rootId = OfflineRootSnapshotCodec.digest(root);val signerId = OfflineRootSnapshotCodec.digest(signer)
    val provider = OfflineRootSnapshotCodec.hex(ReceiptAuthority.issuerProviderId(1,OfflineRootSnapshotCodec.hash(root),
      "00000000-0000-0000-0000-000000000000"))
    val json = """{
      "format":"SAGIP_OFFLINE_ROOT_DEPLOYMENT","version":1,"mode":"BOUNDED_OFFLINE_ROOT_SNAPSHOT",
      "endpoint":"https://synthetic.invalid",
      "policy":{"mode":"BOUNDED_OFFLINE_ROOT_SNAPSHOT","authorityDomainId":"TEST_DOMAIN",
        "signerBindings":[{"checkpointSignerKeyId":"@SIGNER@","receiptRootKeyId":"@ROOT@","issuerProviderId":"@PROVIDER@"}],
        "allowedScopes":["TEST_SCOPE"],"allowedStatuses":[1,2,3],"maxAuthorityStalenessMs":900000,
        "maxReceiptIssuanceAgeMs":900000,"maxProofValidityMs":900000,"qualifiedTimeSourceIds":["TEST_TIME"],
        "disseminationAudience":"ORIGIN_AND_CUSTODY_RELAYS","providerConflictHandling":"KEEP_SEPARATE_NO_AUTOMATIC_CLOSURE",
        "resolvedHandling":"EXCLUDE","maxReplayRecords":1000},
      "rootPins":[{"keyId":"@ROOT@","publicKeyDerBase64":"@ROOT_BYTES@"}],
      "checkpointSignerPins":[{"keyId":"@SIGNER@","publicKeyDerBase64":"@SIGNER_BYTES@"}],
      "initialEpoch":"1","initialAuthorityStateDigest":"@STATE@",
      "timeSignerKeyId":"@ROOT@","timeSourceId":"TEST_TIME","qualifiedElapsedClockProfiles":[@PROFILE@]
    }""".replace("@ROOT@",rootId).replace("@SIGNER@",signerId).replace("@PROVIDER@",provider)
      .replace("@ROOT_BYTES@",StatusRequestProof.base64(root)).replace("@SIGNER_BYTES@",StatusRequestProof.base64(signer))
      .replace("@STATE@","3".repeat(64)).replace("@PROFILE@",profile)
    return Fixture(json,rootId,signerId,root)
  }
  private fun parse(json: String) = requireNotNull(OfflineRootDeploymentManifest.parse(json.toByteArray(Charsets.UTF_8)))
  private fun rejects(json: String) { assertThrows(Exception::class.java) { parse(json) } }

  @Test fun absent_content_is_disabled_and_only_the_fixed_asset_name_is_exposed() {
    assertNull(OfflineRootDeploymentManifest.parse(ByteArray(0)))
    assertNull(OfflineRootDeploymentManifest.parse(" \r\n\t".toByteArray()))
    assertEquals("offline-root-authority.json",OfflineRootDeploymentManifest.ASSET_NAME)
  }

  @Test fun valid_public_manifest_requires_exact_fingerprint_and_sdk() {
    val f=fixture();val deployment=parse(f.json)
    assertEquals(setOf(f.rootId),deployment.rootPins.keys)
    assertEquals(setOf(f.signerId),deployment.checkpointSignerPins.keys)
    assertEquals(1L,deployment.initialEpoch)
    val qualified=deployment.clockQualification("synthetic/test/device:1/build/user",35,boot)!!
    assertEquals("TEST_TIME",qualified.sourceId)
    assertEquals(f.rootId,qualified.timeSignerKeyId)
    assertEquals(boot,qualified.bootId)
    assertEquals(50,qualified.maximumDriftPpm)
    assertEquals(60000L,qualified.maximumCheckpointAgeMs)
    assertNull(deployment.clockQualification("different/device",35,boot))
    assertNull(deployment.clockQualification("synthetic/test/device:1/build/user",34,boot))
    assertNull(deployment.clockQualification("synthetic/test/device:1/build/user",35,"invalid"))
    assertNull(deployment.clockQualification("synthetic/test/device:1/build/user",35,"00000000-0000-0000-0000-000000000000"))
  }

  @Test fun no_profile_never_implies_an_approved_clock() {
    val f=fixture();val deployment=parse(f.json.replace(profile,""))
    assertTrue(deployment.qualifiedElapsedClockProfiles.isEmpty())
    assertNull(deployment.clockQualification("synthetic/test/device:1/build/user",35,boot))
  }

  @Test fun v2_android_policy_activates_without_a_device_whitelist_and_rejects_unbounded_clock_policy() {
    val f=fixture()
    val policy="\"androidClockPolicy\":{\"mode\":\"ANDROID_ELAPSED_REALTIME\",\"maximumDriftPpm\":1000,\"maximumCheckpointAgeMs\":86400000},"
    val json=f.json.replace("\"version\":1","\"version\":2").replace(profile,"").replaceFirst("{","{"+policy)
    val deployment=parse(json)
    val q=deployment.clockQualification("any/manufacturer/any-build",35,boot)!!
    assertEquals(1000,q.maximumDriftPpm);assertEquals(86400000L,q.maximumCheckpointAgeMs)
    assertNull(deployment.clockQualification("any",23,boot))
    assertNull(deployment.clockQualification("any",35,"00000000-0000-0000-0000-000000000000"))
    rejects(json.replace("\"maximumDriftPpm\":1000","\"maximumDriftPpm\":1001"))
    rejects(json.replace("ANDROID_ELAPSED_REALTIME","DEVICE_WALL_CLOCK"))
    rejects(json.replace("86400000","86400001"))
    rejects(json.replace("\"qualifiedElapsedClockProfiles\":[]","\"qualifiedElapsedClockProfiles\":["+profile+"]"))
  }

  @Test fun returned_pins_and_policy_lists_cannot_change_the_parsed_deployment() {
    val f=fixture();val deployment=parse(f.json)
    deployment.rootPins.getValue(f.rootId).fill(0)
    assertArrayEquals(f.rootKey,deployment.rootPins.getValue(f.rootId))
    assertThrows(UnsupportedOperationException::class.java) {
      (deployment.policy.allowedScopes as MutableList<String>).add("NEW_SCOPE")
    }
    assertThrows(UnsupportedOperationException::class.java) {
      (deployment.qualifiedElapsedClockProfiles as MutableList<OfflineRootElapsedClockProfile>).clear()
    }
  }

  @Test fun unknown_duplicate_or_mistyped_fields_are_rejected() {
    val f=fixture()
    rejects(f.json.replaceFirst("{","{\"unexpected\":1,"))
    rejects(f.json.replaceFirst("{","{\"version\":1,"))
    rejects(f.json.replace("\"version\":1","\"version\":2"))
    rejects(f.json.replace("\"version\":1","\"version\":1.0"))
    rejects(f.json.replace("\"version\":1","\"version\":\"1\""))
    rejects(f.json + "{}")
    rejects(f.json.replace("\"initialEpoch\":\"1\"","\"initialEpoch\":\"01\""))
    rejects(f.json.replace("\"initialEpoch\":\"1\"","\"initialEpoch\":\"9223372036854775808\""))
  }

  @Test fun mismatched_pins_provider_and_time_source_fail_closed() {
    val f=fixture()
    rejects(f.json.replace(f.rootId,"0".repeat(64)))
    rejects(f.json.replace(Regex("\"issuerProviderId\":\"[a-f0-9]{64}\""),"\"issuerProviderId\":\""+"0".repeat(64)+"\""))
    rejects(f.json.replace("\"timeSignerKeyId\":\""+f.rootId+"\"","\"timeSignerKeyId\":\""+f.signerId+"\""))
    rejects(f.json.replace("\"timeSourceId\":\"TEST_TIME\"","\"timeSourceId\":\"UNKNOWN_TIME\""))
  }

  @Test fun endpoint_credentials_queries_fragments_and_cleartext_are_rejected() {
    val f=fixture()
    for(endpoint in listOf("http://synthetic.invalid","https://user:pass@synthetic.invalid",
      "https://synthetic.invalid/path","https://synthetic.invalid?token=x","https://synthetic.invalid#x",
      "https://synthetic.invalid:99999")) rejects(f.json.replace("https://synthetic.invalid",endpoint))
  }

  @Test fun qualification_requires_bounded_explicit_profiles_and_references() {
    val f=fixture()
    rejects(f.json.replace("\"maximumDriftPpm\":50","\"maximumDriftPpm\":101"))
    rejects(f.json.replace("\"maximumCheckpointAgeMs\":60000","\"maximumCheckpointAgeMs\":86400001"))
    rejects(f.json.replace("\"evidenceId\":\"TEST_EVIDENCE_REFERENCE\"","\"evidenceId\":\"\""))
    rejects(f.json.replace(profile,profile+","+profile))
  }

  @Test fun malformed_utf8_oversized_and_nested_json_are_rejected() {
    assertThrows(Exception::class.java) { OfflineRootDeploymentManifest.parse(byteArrayOf(0xff.toByte())) }
    assertThrows(IllegalArgumentException::class.java) { OfflineRootDeploymentManifest.parse(ByteArray(32769)) }
    rejects("[".repeat(10)+"0"+"]".repeat(10))
    rejects("["+List(65) { "0" }.joinToString(",")+"]")
  }
}
