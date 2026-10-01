package com.sagip.survival

import kotlin.math.ceil
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test

class ReceiptTransferSchedulerTest {
  @Test
  fun `twenty reports do not starve and oldest work keeps reserved slots`() {
    val scheduler = ReceiptTransferScheduler()
    val oldestReport = "report-00"
    val pending = mutableListOf<SchedulingCandidate>()

    repeat(20) { index ->
      pending += SchedulingCandidate(
        reportId = oldestReport,
        objectKind = ObjectKind.RESPONDER_RECEIPT,
        objectId = "hot-$index",
        custodyAcceptedAtMs = index.toLong(),
        initialResponderAck = index == 0,
      )
    }
    for (report in 1..19) {
      pending += SchedulingCandidate(
        reportId = "report-%02d".format(report),
        objectKind = ObjectKind.RESPONDER_RECEIPT,
        objectId = "report-$report-ack",
        custodyAcceptedAtMs = 1_000L + report,
        initialResponderAck = true,
      )
    }

    val progressed = linkedSetOf<String>()
    repeat(4) { contact ->
      val batch = scheduler.select(pending, maxObjects = 8)
      assertTrue(batch.size <= 8)
      if (contact == 0) {
        val oldestSlots = batch.count { it.reportId == oldestReport }
        assertTrue(oldestSlots >= ceil(batch.size / 4.0).toInt())
      }
      progressed += batch.map { it.reportId }
      val selected = batch.map { it.objectId }.toSet()
      pending.removeAll { it.objectId in selected }
    }

    assertEquals((0..19).map { "report-%02d".format(it) }.toSet(), progressed)
  }

  @Test
  fun `initial human acknowledgement wins within one report without changing report fairness`() {
    val scheduler = ReceiptTransferScheduler()
    val selected = scheduler.select(
      listOf(
        SchedulingCandidate("report-a", ObjectKind.REQUESTER_RECEIPT, "requester", 1L, false),
        SchedulingCandidate("report-a", ObjectKind.RESPONDER_RECEIPT, "later-initial-ack", 10L, true),
        SchedulingCandidate("report-b", ObjectKind.SOS, "sos", 2L, false),
      ),
      maxObjects = 2,
    )

    assertEquals("later-initial-ack", selected.first { it.reportId == "report-a" }.objectId)
    assertTrue(selected.any { it.reportId == "report-b" })
  }

  @Test
  fun `selection is deterministic and contact bounded`() {
    val scheduler = ReceiptTransferScheduler()
    val input = (0 until 40).map { index ->
      SchedulingCandidate(
        reportId = "report-" + (index % 10),
        objectKind = ObjectKind.SOS,
        objectId = "object-$index",
        custodyAcceptedAtMs = index.toLong(),
        initialResponderAck = false,
      )
    }

    val first = scheduler.select(input, maxObjects = 8).map { it.objectId }
    val second = scheduler.select(input.reversed(), maxObjects = 8).map { it.objectId }
    assertEquals(first, second)
    assertEquals(8, first.size)
  }

  @Test
  fun `receipt retry uses five-second fifteen-minute full jitter`() {
    assertEquals(0L, ReceiptTransferScheduler.retryDelayMs(1, 0.0))
    assertEquals(2_500L, ReceiptTransferScheduler.retryDelayMs(1, 0.5))
    assertEquals(5_000L, ReceiptTransferScheduler.retryDelayMs(1, 1.0))
    assertEquals(10_000L, ReceiptTransferScheduler.retryDelayMs(2, 1.0))
    assertEquals(900_000L, ReceiptTransferScheduler.retryDelayMs(20, 1.0))
    assertTrue(ReceiptTransferScheduler.retryDelayMs(20, 0.37) in 0L..900_000L)
    assertThrows(IllegalArgumentException::class.java) {
      ReceiptTransferScheduler.retryDelayMs(0, 0.5)
    }
    assertThrows(IllegalArgumentException::class.java) {
      ReceiptTransferScheduler.retryDelayMs(1, 1.1)
    }
  }
}
