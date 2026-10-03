package com.sagip.survival

import java.io.File
import org.junit.Assert.*
import org.junit.Test

class ReceiptAuthorityTest {
  private val fixture = listOf(File("../fixtures/receipts-v2/golden.json"), File("../../fixtures/receipts-v2/golden.json")).first { it.isFile }.readText()
  private val t = 1790812800000L
  private fun hex(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
  private fun value(name: String) = Regex("\\\"$name\\\": \\\"([0-9a-f-]+)\\\"").find(fixture)!!.groupValues[1]
  private fun bytes(name: String) = hex(Regex("\\\"name\\\": \\\"$name\\\",\\s*\\\"hex\\\": \\\"([0-9a-f]+)\\\"").find(fixture)!!.groupValues[1])
  private fun context() = VerificationContext(
    roots = mapOf(value("rootKeyId") to hex(value("rootPublicKeyDerHex"))),
    revokedGrants = emptySet(), allowedScopes = setOf("TAGUM_PILOT"),
    trustedTime = TimeInterval(t + 10000, t + 10100), authorityCheckedAtMs = t,
    currentAuthorityChecked = true,
    report = ReportIdentity("22222222-2222-4222-8222-222222222222", 1, 1, hex(value("payloadDigest")), hex(value("originKeyId")), hex(value("originPublicKeyDerHex"))),
    pairedTimeProviderId = value("gatewayProviderId"),
  )
  @Test fun authorityRevisionAndOriginalKeyMatrix() {
    assertEquals("VERIFIED_OFFLINE_AUTHORITY", ReceiptAuthority.verifyReceipt(bytes("valid_offline_ack"), context()).kind)
    assertEquals("VERIFIED_CURRENT", ReceiptAuthority.verifyReceipt(bytes("valid_cloud_ack"), context()).kind)
    assertEquals("UNVERIFIED_AUTHORITY", ReceiptAuthority.verifyReceipt(bytes("valid_offline_ack"), context().copy(roots = emptyMap())).kind)
    assertEquals("UNVERIFIED_AUTHORITY", ReceiptAuthority.verifyReceipt(bytes("valid_offline_ack"), context().copy(trustedTime = null)).kind)
    assertEquals("UNVERIFIED_AUTHORITY", ReceiptAuthority.verifyReceipt(bytes("valid_offline_ack"), context().copy(allowedScopes = emptySet())).kind)
    assertEquals("UNVERIFIED_AUTHORITY", ReceiptAuthority.verifyReceipt(bytes("valid_offline_ack"), context().copy(revokedGrants = setOf("11111111-1111-4111-8111-111111111111"))).kind)
    assertEquals("UNVERIFIED_AUTHORITY", ReceiptAuthority.verifyReceipt(bytes("valid_signature_wrong_revision"), context()).kind)
    assertEquals("REJECTED", ReceiptAuthority.verifyReceipt(bytes("valid_signature_ack_invalid_grant"), context()).kind)
    assertEquals("REJECTED", ReceiptAuthority.verifyReceipt(bytes("corrupted_signature"), context()).kind)
    assertEquals("UNVERIFIED_AUTHORITY", ReceiptAuthority.verifyReceipt(bytes("valid_offline_ack"), context().copy(trustedTime = TimeInterval(t + 604800000, t + 604800000))).kind)
    assertEquals("VERIFIED_OFFLINE_AUTHORITY", ReceiptAuthority.verifyReceipt(bytes("valid_requester_receipt"), context().copy(linkedAck = bytes("valid_offline_ack"))).kind)
    assertEquals("UNVERIFIED_AUTHORITY", ReceiptAuthority.verifyReceipt(bytes("valid_requester_receipt"), context()).kind)
  }
  @Test fun cryptographicFailuresPrecedeUnavailablePolicy() {
    val corrupted = bytes("valid_offline_ack")
    corrupted[corrupted.lastIndex] = (corrupted.last().toInt() xor 1).toByte()
    assertEquals("REJECTED", ReceiptAuthority.verifyReceipt(corrupted, context().copy(trustedTime = null)).kind)
    assertEquals("REJECTED", ReceiptAuthority.verifyReceipt(bytes("corrupted_signature"), context().copy(report = null)).kind)
  }
  @Test fun sharedTimeMatrixAndParentIsolation() {
    val q = TimeChallenge("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", hex(value("gatewayKeyId")), "66666666-6666-4666-8666-666666666666", hex(value("nonce")), 0, null, context(), { true })
    val clock = MonotonicClock(q.verifierBootSessionId, 0)
    val accepted = ReceiptAuthority.acceptTimeProof(bytes("valid_root_time_checkpoint"), q, clock).checkpoint!!
    val section = fixture.substring(fixture.indexOf("timePolicyCases"), fixture.indexOf("trustedContext"))
    val names = Regex("\\\"name\\\": \\\"([^\\\"]+)\\\"").findAll(section).toList()
    assertEquals(8, names.size)
    names.forEachIndexed { i, match ->
      val name = match.groupValues[1]
      val body = section.substring(match.range.last + 1, names.getOrNull(i + 1)?.range?.first ?: section.length)
      fun number(key: String, source: String = body) = Regex("\\\"$key\\\": ([0-9]+)").find(source)!!.groupValues[1].toLong()
      fun interval(key: String): TimeInterval {
        val block = Regex("\\\"$key\\\":\\s*\\{([^}]+)\\}").find(body)!!.groupValues[1]
        return TimeInterval(number("earliestMs", block), number("latestMs", block))
      }
      fun expected() = Regex("\\\"expected\\\": \\\"(ACCEPT|REJECT)\\\"").find(body)!!.groupValues[1]
      fun classification(result: TimeAcceptance) = if (result.kind == "ACCEPTED") "ACCEPT" else "REJECT"
      when (name) {
        "root_response_interval" -> {
          val cp = ReceiptAuthority.acceptTimeProof(bytes("valid_root_time_checkpoint"), q, clock.copy(elapsedMs = number("rttMs"))).checkpoint!!
          assertEquals(interval("expectedInterval"), TimeInterval(cp.earliestMs, cp.latestMs))
        }
        "gateway_same_boot_advance" -> {
          val base = interval("checkpoint")
          assertEquals(interval("expectedInterval"), ReceiptAuthority.advanceCheckpoint(accepted.copy(earliestMs = base.earliestMs, latestMs = base.latestMs), clock.copy(elapsedMs = number("elapsedMs"))))
        }
        "upper_equal_expiry_rejects" -> {
          val base = interval("interval")
          assertNull(ReceiptAuthority.advanceCheckpoint(accepted.copy(earliestMs = base.earliestMs, latestMs = base.latestMs, validUntilMs = number("expiresAtMs")), clock))
        }
        "lower_below_high_water_rejects", "same_lower_high_water_accepts" -> {
          val highWater = accepted.earliestMs + number("highWaterMs") - interval("interval").earliestMs
          assertEquals(expected(), classification(ReceiptAuthority.acceptTimeProof(bytes("valid_root_time_checkpoint"), q.copy(highWaterEarliestMs = highWater), clock)))
        }
        "changed_boot_rejects_elapsed" -> {
          val parent = Regex("\\\"checkpointBootId\\\": \\\"([^\\\"]+)\\\"").find(body)!!.groupValues[1]
          val current = Regex("\\\"currentBootId\\\": \\\"([^\\\"]+)\\\"").find(body)!!.groupValues[1]
          assertNull(ReceiptAuthority.advanceCheckpoint(accepted.copy(bootId = parent), clock.copy(bootId = current)))
        }
        "consumed_nonce_rejects" -> assertEquals(expected(), classification(ReceiptAuthority.acceptTimeProof(bytes("valid_root_time_checkpoint"), q.copy(commitCheckpoint = { false }), clock)))
        "old_response_rejects" -> assertEquals(expected(), classification(ReceiptAuthority.acceptTimeProof(bytes("valid_root_time_checkpoint"), q, clock.copy(elapsedMs = number("rttMs")))))
        else -> throw AssertionError("uncovered policy $name")
      }
    }
    assertEquals("ACCEPTED", ReceiptAuthority.acceptTimeProof(bytes("valid_root_time_checkpoint"), q, clock.copy(elapsedMs = 60000)).kind)
    val browser = q.copy(verifierId = hex(value("verifierId")), verifierBootSessionId = "77777777-7777-4777-8777-777777777777")
    val browserClock = MonotonicClock(browser.verifierBootSessionId, 10)
    assertEquals("REJECTED", ReceiptAuthority.acceptTimeProof(bytes("valid_gateway_time"), browser.copy(context = context().copy(pairedTimeProviderId = null)), browserClock).kind)
    assertEquals("REJECTED", ReceiptAuthority.acceptTimeProof(bytes("valid_signature_gateway_time_wrong_parent_verifier"), browser, browserClock).kind)
  }
  @Test fun rootChallengeAndExpiryBounds() {
    val q = TimeChallenge("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", hex(value("gatewayKeyId")), "66666666-6666-4666-8666-666666666666", hex(value("nonce")), 100, null, context(), { true })
    val clock = MonotonicClock(q.verifierBootSessionId, 120)
    val result = ReceiptAuthority.acceptTimeProof(bytes("valid_root_time_checkpoint"), q, clock)
    assertEquals("ACCEPTED", result.kind)
    val checkpoint = result.checkpoint!!
    assertEquals(t - 120, checkpoint.earliestMs)
    assertEquals(t + 120, checkpoint.latestMs)
    assertNull(ReceiptAuthority.advanceCheckpoint(checkpoint.copy(validUntilMs = checkpoint.latestMs), clock))
    assertEquals("REJECTED", ReceiptAuthority.acceptTimeProof(bytes("valid_root_time_checkpoint"), q.copy(highWaterEarliestMs = -1), clock).kind)
    assertEquals("VERIFIED_OFFLINE_AUTHORITY", ReceiptAuthority.verifyReceipt(bytes("valid_offline_ack"), context().copy(authorityCheckedAtMs = t - 2 * 86400000)).kind)
    assertEquals("UNVERIFIED_AUTHORITY", ReceiptAuthority.verifyReceipt(bytes("valid_offline_ack"), context().copy(roots = mapOf(value("rootKeyId") to hex(value("originPublicKeyDerHex"))))).kind)
  }
  @Test fun freshTimeConsumptionBootAndHighWaterMatrix() {
    var committed = false
    val challenge = TimeChallenge(
      id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", verifierId = hex(value("verifierId")),
      verifierBootSessionId = "77777777-7777-4777-8777-777777777777", nonce = hex(value("nonce")),
      sentElapsedMs = 100, highWaterEarliestMs = null, context = context(),
      commitCheckpoint = { if (committed) false else { committed = true; true } },
    )
    val clock = MonotonicClock(challenge.verifierBootSessionId, 110)
    val result = ReceiptAuthority.acceptTimeProof(bytes("valid_gateway_time"), challenge, clock)
    assertEquals("ACCEPTED", result.kind)
    val checkpoint = result.checkpoint!!
    assertEquals(t + 9889, checkpoint.earliestMs)
    assertEquals("REJECTED", ReceiptAuthority.acceptTimeProof(bytes("valid_gateway_time"), challenge, clock).kind)
    assertNull(ReceiptAuthority.advanceCheckpoint(checkpoint, clock.copy(bootId = "changed")))
    assertNull(ReceiptAuthority.advanceCheckpoint(checkpoint, clock.copy(elapsedMs = 109)))
    assertEquals(t + 19888, ReceiptAuthority.advanceCheckpoint(checkpoint, clock.copy(elapsedMs = 10110))!!.earliestMs)
    val fresh = challenge.copy(commitCheckpoint = { true })
    assertEquals("REJECTED", ReceiptAuthority.acceptTimeProof(bytes("valid_gateway_time"), fresh.copy(nonce = ByteArray(32)), clock).kind)
    assertEquals("REJECTED", ReceiptAuthority.acceptTimeProof(bytes("valid_gateway_time"), fresh, clock.copy(elapsedMs = 60101)).kind)
    assertEquals("REJECTED", ReceiptAuthority.acceptTimeProof(bytes("valid_gateway_time"), fresh.copy(highWaterEarliestMs = t + 9890), clock).kind)
    assertEquals("REJECTED", ReceiptAuthority.acceptTimeProof(bytes("valid_gateway_time"), fresh, clock.copy(bootId = "changed")).kind)
  }
}
