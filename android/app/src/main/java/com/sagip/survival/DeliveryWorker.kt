package com.sagip.survival

/**
 * Coordinates delivery attempts. SQLite remains the source of retry truth;
 * this class only executes due work.
 */
class DeliveryWorker(
    private val repository: OutboundDeliveryStore,
    private val sender: EnvelopeSender,
    private val transport: String = "INTERNET",
) {
    suspend fun runOnce(now: Long = System.currentTimeMillis()): Int {
        var completed = 0
        for (envelope in repository.listDueOutbound(now)) {
            val attemptId = repository.recordAttemptStarted(
                messageId = envelope.messageId,
                transport = transport,
                now = now,
            )
            val outbound = OutboundEnvelope(
                messageId = envelope.messageId,
                bytes = envelope.envelopeBytes,
            )
            when (val result = sender.send(outbound)) {
                is DeliveryTransportResult.Accepted -> {
                    repository.recordAttemptCompleted(
                        attemptId = attemptId,
                        outcome = "SUCCESS",
                        now = now,
                    )
                    repository.markServerAccepted(result.receipt, now = now)
                    completed++
                }
                is DeliveryTransportResult.RetryableFailure -> {
                    repository.recordAttemptCompleted(
                        attemptId = attemptId,
                        outcome = "RETRYABLE_FAILURE",
                        retryClassification = result.reason,
                        now = now,
                    )
                    repository.scheduleRetry(envelope.messageId, now = now)
                }
                is DeliveryTransportResult.PermanentFailure -> {
                    repository.recordAttemptCompleted(
                        attemptId = attemptId,
                        outcome = "PERMANENT_FAILURE",
                        retryClassification = result.reason,
                        now = now,
                    )
                    repository.markDeliveryFailed(envelope.messageId, result.reason, now = now)
                }
            }
        }
        return completed
    }
}

