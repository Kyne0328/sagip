package com.sagip.survival

import kotlin.math.min

data class SchedulingCandidate(
  val reportId: String,
  val objectKind: ObjectKind,
  val objectId: String,
  val custodyAcceptedAtMs: Long,
  val initialResponderAck: Boolean,
)

class ReceiptTransferScheduler {
  fun select(
    candidates: List<SchedulingCandidate>,
    maxObjects: Int = MAX_CONTACT_OBJECTS,
  ): List<SchedulingCandidate> {
    require(maxObjects in 1..MAX_CONTACT_OBJECTS) {
      "maxObjects must be between 1 and $MAX_CONTACT_OBJECTS"
    }
    return order(candidates).take(maxObjects)
  }

  fun order(candidates: List<SchedulingCandidate>): List<SchedulingCandidate> {
    if (candidates.isEmpty()) return emptyList()

    val queueComparator = compareByDescending<SchedulingCandidate> { it.initialResponderAck }
      .thenBy { it.custodyAcceptedAtMs }
      .thenBy { it.objectKind.wireCode }
      .thenBy { it.objectId }
    val grouped = candidates
      .groupBy { it.reportId }
      .mapValues { (_, values) -> values.sortedWith(queueComparator).toMutableList() }
    val reportOrder = grouped.keys.sortedWith(
      compareBy<String> { reportId -> grouped.getValue(reportId).minOf { it.custodyAcceptedAtMs } }
        .thenBy { it },
    )
    val oldestReport = reportOrder.first()
    val target = candidates.size
    val selected = ArrayList<SchedulingCandidate>(target)
    var roundRobinIndex = if (reportOrder.size > 1) 1 else 0

    fun takeFrom(reportId: String): SchedulingCandidate? {
      val queue = grouped.getValue(reportId)
      return if (queue.isEmpty()) null else queue.removeAt(0)
    }

    fun takeRoundRobin(): SchedulingCandidate? {
      repeat(reportOrder.size) {
        val index = roundRobinIndex % reportOrder.size
        roundRobinIndex = (index + 1) % reportOrder.size
        takeFrom(reportOrder[index])?.let { return it }
      }
      return null
    }

    for (slot in 0 until target) {
      val candidate = if (slot % OLDEST_RESERVATION_INTERVAL == 0) {
        takeFrom(oldestReport) ?: takeRoundRobin()
      } else {
        takeRoundRobin()
      } ?: break
      selected += candidate
    }
    return selected
  }

  companion object {
    const val MAX_CONTACT_OBJECTS = 8
    const val BASE_RETRY_MS = 5_000L
    const val MAX_RETRY_MS = 15L * 60L * 1000L
    private const val OLDEST_RESERVATION_INTERVAL = 4

    fun retryDelayMs(attemptNumber: Int, jitterUnit: Double): Long {
      require(attemptNumber >= 1) { "attemptNumber must be positive" }
      require(jitterUnit in 0.0..1.0) { "jitterUnit must be between 0 and 1" }
      var ceiling = BASE_RETRY_MS
      repeat(attemptNumber - 1) {
        if (ceiling >= MAX_RETRY_MS) return@repeat
        ceiling = min(MAX_RETRY_MS, ceiling * 2L)
      }
      return (ceiling * jitterUnit).toLong().coerceIn(0L, MAX_RETRY_MS)
    }
  }
}
