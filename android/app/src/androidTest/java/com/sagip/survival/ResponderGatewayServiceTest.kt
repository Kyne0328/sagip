package com.sagip.survival

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.math.BigInteger
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

@RunWith(AndroidJUnit4::class)
class ResponderGatewayServiceTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private lateinit var db: SagipDatabase
  private val root = GatewayTestIdentity()
  private val gateway = GatewaySigningIdentity("sagip.test.gateway.g01")
  private var now = 100_000L
  private var elapsed = 1_000L
  private var boot = UUID.randomUUID().toString()
  private var unlocked = true
  private var failSigning = false
  private val grantId = UUID.randomUUID().toString()
  private val responderId = UUID.randomUUID().toString()

  @Before fun setUp() {
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
    db = SagipDatabase(context)
  }
  @After fun tearDown() { db.close(); context.deleteDatabase(SagipDatabase.DATABASE_NAME) }

  private fun service() = ResponderGatewayService(
    db, { object : SigningIdentity {
      override val keyId get() = gateway.keyId
      override val publicKeyDer get() = gateway.publicKeyDer
      override fun sign(data: ByteArray): ByteArray {
        if (failSigning) error("test signer unavailable")
        return gateway.sign(data)
      }
    } }, mapOf(hex(root.keyId) to root.publicKeyDer), setOf("TAGUM_PILOT"),
    { unlocked }, { MonotonicClock(boot, elapsed) }, { now },
  )
  private fun grant(key: SigningIdentity = gateway, statusMask: Int = 15) = sign(
    ReceiptFields.Grant(root.keyId, grantId, key.keyId, key.publicKeyDer,
      ReceiptAuthority.issuerProviderId(2, key.keyId, grantId), responderId,
      "TAGUM-TEST", statusMask, 9, "TAGUM_PILOT", 90_000L, 400_000L), root,
  )
  private fun trust(s: ResponderGatewayService) {
    val q = s.beginAuthorityTimeChallenge()
    val proof = sign(ReceiptFields.Time(UUID.randomUUID().toString(),
      ReceiptAuthority.issuerProviderId(1, root.keyId, NIL), root.keyId, NIL,
      NIL, q.verifierId, q.verifierBootSessionId, q.nonce,
      ByteArray(32), now, 0, 10, 500_000L), root)
    assertEquals("ACCEPTED", s.acceptAuthorityTimeProof(q.id, proof).kind)
    assertEquals("REJECTED", s.acceptAuthorityTimeProof(q.id, proof).kind)
  }
  private fun report(): String {
    val e = EmergencyRepository(db)
    val report = e.createReport(CreateEmergencyReportInput(EmergencyType.MEDICAL, Urgency.NEED_ASSISTANCE), null, now)
    EnvelopePreparationService(e, GatewayTestIdentity()).preparePending()
    return report.reportId
  }
  private fun count(table: String) = db.readableDatabase.rawQuery("SELECT count(*) FROM $table", null).use { it.moveToFirst(); it.getInt(0) }

  @Test fun native_authority_requires_provisioned_key_and_explicit_action() {
    assertFalse(gateway.privateKeyExportable)
    assertFalse(gateway.keyId.contentEquals(AndroidKeystoreSigningIdentity().keyId))
    val s = service()
    val id = report()
    assertEquals(1, s.listGatewayIncidents().size)
    assertEquals(0, count("receipt_actions"))
    val pending = ActionIntent(UUID.randomUUID().toString(), id, 1, 1, "Saved work")
    assertEquals(ActionCommitState.PREPARING, s.recordGatewayAction(pending).state)
    assertEquals(0, count("receipt_records"))
    trust(s)
    assertEquals("ACCEPTED", s.provisionGrant(grant()).state)
    failSigning = true
    val intent = ActionIntent(UUID.randomUUID().toString(), id, 1, 2, "Team en route")
    assertEquals(ActionCommitState.PREPARING, s.recordGatewayAction(intent).state)
    assertEquals(1, count("receipt_actions"))
    assertEquals(0, count("receipt_records"))
    failSigning = false
    val signed = s.recordGatewayAction(intent)
    assertEquals(ActionCommitState.SIGNED, signed.state)
    assertEquals("VERIFIED_OFFLINE_AUTHORITY", ReceiptAuthority.verifyReceipt(signed.bytes!!,
      s.verificationContext(s.listGatewayIncidents().single().identity)).kind)
    val original = signed.bytes!!.copyOf()
    db.close(); db = SagipDatabase(context)
    assertArrayEquals(original, service().getGatewayAction(intent.actionId).bytes)
    assertEquals(ActionCommitState.CONFLICT, service().recordGatewayAction(intent.copy(note = "changed")).state)
    assertEquals(1, count("receipt_records"))
  }

  @Test fun denied_access_wrong_key_expiry_and_reboot_never_issue_verified_receipts() {
    val s = service(); val id = report(); trust(s)
    assertEquals("REJECTED", s.provisionGrant(grant(GatewayTestIdentity())).state)
    assertEquals("ACCEPTED", s.provisionGrant(grant(statusMask = 1)).state)
    assertEquals(ActionCommitState.PREPARING, s.recordGatewayAction(ActionIntent(UUID.randomUUID().toString(), id, 1, 2, "")).state)
    unlocked = false
    assertEquals(ActionCommitState.REJECTED, s.recordGatewayAction(ActionIntent(UUID.randomUUID().toString(), id, 1, 1, "")).state)
    assertTrue(runCatching { s.listGatewayIncidents() }.isFailure)
    // The civilian commit is independent of gateway access, browser and authority.
    assertNotNull(EmergencyRepository(db).createReport(CreateEmergencyReportInput(EmergencyType.FLOOD, Urgency.IMMEDIATE_DANGER), null, now))
    unlocked = true; boot = UUID.randomUUID().toString()
    assertEquals(ActionCommitState.PREPARING, service().recordGatewayAction(ActionIntent(UUID.randomUUID().toString(), id, 1, 1, "")).state)
    assertEquals(0, count("receipt_records"))
    now = 400_000L; elapsed += 300_000L; trust(service())
    assertEquals(ActionCommitState.PREPARING, service().recordGatewayAction(ActionIntent(UUID.randomUUID().toString(), id, 1, 1, "")).state)
    assertEquals(0, count("receipt_records"))
  }

  @Test fun additive_v12_migration_preserves_sos_and_fixed_issuer_survives_revocation() {
    val id = report()
    db.writableDatabase.execSQL("DROP TABLE gateway_active_grant")
    db.writableDatabase.execSQL("DROP TABLE gateway_work")
    db.writableDatabase.execSQL("DROP TABLE gateway_pairings")
    db.writableDatabase.execSQL("DROP TABLE gateway_browser_sessions")
    db.writableDatabase.execSQL("DROP TABLE gateway_pairing_clock")
    db.writableDatabase.version = 11
    db.close(); db = SagipDatabase(context)
    assertEquals(13, db.readableDatabase.version)
    assertEquals(id, service().listGatewayIncidents().single().identity.reportId)
    val s = service(); trust(s); assertEquals("ACCEPTED", s.provisionGrant(grant()).state)
    failSigning = true
    val intent = ActionIntent(UUID.randomUUID().toString(), id, 1, 1, "Retain original issuer")
    assertEquals(ActionCommitState.PREPARING, s.recordGatewayAction(intent).state)
    db.writableDatabase.execSQL("UPDATE receipt_grants SET revoked_at_ms=? WHERE grant_id=?", arrayOf(now, grantId))
    failSigning = false
    assertEquals(ActionCommitState.PREPARING, s.recordGatewayAction(intent).state)
    assertEquals("REJECTED", s.provisionGrant(grant()).state)
    assertEquals(0, count("receipt_records"))
    assertEquals(1, count("gateway_work"))
  }

  @Test fun native_credential_prompt_has_required_permission_and_pending_work_survives_reopen() {
    assertEquals(android.content.pm.PackageManager.PERMISSION_GRANTED,
      context.checkSelfPermission(android.Manifest.permission.USE_BIOMETRIC))
    val id = report()
    val intent = ActionIntent(UUID.randomUUID().toString(), id, 1, 1, "Pending restart")
    assertEquals(ActionCommitState.PREPARING, service().recordGatewayAction(intent).state)
    db.close(); db = SagipDatabase(context)
    assertEquals(intent, service().listGatewayIncidents().single().pendingActions.single())
  }

  @Test fun stale_unallocated_work_is_a_conflict_and_never_rebinds_to_a_new_revision() {
    val id = report(); val s = service()
    val intent = ActionIntent(UUID.randomUUID().toString(), id, 1, 1, "Keep historical work")
    assertEquals(ActionCommitState.PREPARING, s.recordGatewayAction(intent).state)
    db.writableDatabase.execSQL("UPDATE receipt_report_state SET receipt_version=2 WHERE report_id=?", arrayOf(id))
    trust(s); assertEquals("ACCEPTED", s.provisionGrant(grant()).state)
    assertEquals(ActionCommitState.CONFLICT, s.recordGatewayAction(intent).state)
    assertEquals(0, count("receipt_actions"))
    assertEquals(intent, s.listGatewayIncidents().single().pendingActions.single())
    assertEquals(ActionCommitState.REJECTED, s.recordGatewayAction(intent.copy(actionId = UUID.randomUUID().toString(), observedIncidentVersion = 2, note = "😀".repeat(300))).state)
    assertEquals(1, count("gateway_work"))
    assertEquals(ActionCommitState.SIGNED, s.recordGatewayAction(intent.copy(actionId = UUID.randomUUID().toString(), observedIncidentVersion = 2)).state)
  }

  companion object {
    private const val NIL = "00000000-0000-0000-0000-000000000000"
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun sign(f: ReceiptFields, key: SigningIdentity): ByteArray {
      val unsigned = ReceiptV2Codec.encode(f, ByteArray(64).apply { this[31] = 1; this[63] = 1 }, ByteArray(0))
      val der = key.sign("SAGIP-SIGNED-V2\u0000".toByteArray(Charsets.US_ASCII) + unsigned.copyOfRange(0, unsigned.size - 64))
      var p = 2
      fun scalar(): BigInteger { check(der[p++].toInt() == 2); val n = der[p++].toInt() and 255; return BigInteger(1, der.copyOfRange(p, p + n)).also { p += n } }
      val r = scalar(); val s = scalar(); val order = BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)
      fun fixed(v: BigInteger) = v.toByteArray().takeLast(32).toByteArray().let { ByteArray(32 - it.size) + it }
      return ReceiptV2Codec.encode(f, fixed(r) + fixed(if (s > order.shiftRight(1)) order - s else s), ByteArray(0))
    }
  }
}

private class GatewayTestIdentity : SigningIdentity {
  private val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
  override val publicKeyDer get() = pair.public.encoded
  override val keyId get() = MessageDigest.getInstance("SHA-256").digest(publicKeyDer)
  override fun sign(data: ByteArray) = Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(data); sign() }
}
