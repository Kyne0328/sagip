package com.sagip.survival

import org.junit.Assert.*
import org.junit.Test

/** The bootstrap adapter never interprets wall clock, HTTP success, or fetched bytes as authority. */
class ReceiptReturnTimeBootstrapTest {
  private fun challenge() = TimeChallenge(
    "11111111-1111-4111-8111-111111111111", ByteArray(32) { 1 },
    "22222222-2222-4222-8222-222222222222", ByteArray(32) { 2 }, 10L, null,
    VerificationContext(emptyMap(), emptySet(), emptySet(), null, null, false, null, null),
    { false },
  )

  @Test fun current_qualified_time_skips_the_network_and_challenge() {
    assertTrue(refreshReceiptReturnTime(
      ReceiptReturnTimeTransport { throw AssertionError("unexpected network") }, { true }, { TimeInterval(1, 2) },
      { throw AssertionError("unexpected challenge") }, { _, _ -> throw AssertionError("unexpected acceptance") },
    ))
  }

  @Test fun fresh_response_is_accepted_only_against_the_exact_local_challenge() {
    val local = challenge()
    val proof = byteArrayOf(1, 2, 3)
    val order = mutableListOf<String>()
    var time: TimeInterval? = null
    assertTrue(refreshReceiptReturnTime(
      ReceiptReturnTimeTransport { given ->
        order += "fetch"; assertSame(local, given); proof
      }, { true }, { time },
      { order += "challenge"; local },
      { id, bytes ->
        order += "durable-accept"; assertEquals(local.id, id); assertArrayEquals(proof, bytes)
        time = TimeInterval(100, 110); TimeAcceptance("ACCEPTED")
      },
    ))
    assertEquals(listOf("challenge", "fetch", "durable-accept"), order)
  }

  @Test fun transport_failure_does_not_claim_time_authority() {
    var accepted = false
    assertFalse(refreshReceiptReturnTime(
      ReceiptReturnTimeTransport { throw IllegalStateException("offline") }, { true }, { null }, ::challenge,
      { _, _ -> accepted = true; TimeAcceptance("ACCEPTED") },
    ))
    assertFalse(accepted)
  }

  @Test fun configuration_change_while_fetching_prevents_acceptance() {
    var active = true
    var accepted = false
    assertFalse(refreshReceiptReturnTime(
      ReceiptReturnTimeTransport { active = false; byteArrayOf(1) }, { active }, { null }, ::challenge,
      { _, _ -> accepted = true; TimeAcceptance("ACCEPTED") },
    ))
    assertFalse(accepted)
  }

  @Test fun oversized_or_empty_response_never_reaches_the_acceptance_owner() {
    for (proof in listOf(ByteArray(0), ByteArray(8193))) {
      assertFalse(refreshReceiptReturnTime(
        ReceiptReturnTimeTransport { proof }, { true }, { null }, ::challenge,
        { _, _ -> throw AssertionError("unbounded response reached acceptance") },
      ))
    }
  }

  @Test fun acceptance_failure_or_missing_durable_checkpoint_never_claims_success() {
    assertFalse(refreshReceiptReturnTime(
      ReceiptReturnTimeTransport { byteArrayOf(1) }, { true }, { null }, ::challenge,
      { _, _ -> TimeAcceptance("REJECTED", reason = "NONCE_MISMATCH") },
    ))
    assertFalse(refreshReceiptReturnTime(
      ReceiptReturnTimeTransport { byteArrayOf(1) }, { true }, { null }, ::challenge,
      { _, _ -> TimeAcceptance("ACCEPTED") },
    ))
  }
}
