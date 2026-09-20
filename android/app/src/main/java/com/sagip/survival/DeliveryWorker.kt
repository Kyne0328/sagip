package com.sagip.survival

/**
 * Coordinates delivery attempts. SQLite remains the source of retry truth;
 * this class only executes due work.
 */
class DeliveryWorker(
    private val repository: OutboundDeliveryStore,
    private val sender: EnvelopeSender,
    private val transport: String = "INTERNET",
    private val relayStore: RelayDeliveryStore? = repository as? RelayDeliveryStore,
    private val ackStore: ResponderAckStore? = repository as? ResponderAckStore,
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

        relayStore?.let { store ->
            for (inbound in store.listDueInbound(now)) {
                val outbound = OutboundEnvelope(
                    messageId = inbound.messageId,
                    bytes = inbound.envelopeBytes,
                )
                when (sender.send(outbound)) {
                    is DeliveryTransportResult.Accepted -> {
                        store.markInboundServerAccepted(inbound.messageId, now = now)
                        completed++
                    }
                    is DeliveryTransportResult.RetryableFailure -> {
                        store.scheduleInboundRetry(inbound.messageId, now = now)
                    }
                    is DeliveryTransportResult.PermanentFailure -> {
                        store.markInboundServerAccepted(inbound.messageId, now = now)
                    }
                }
            }
        }

        ackStore?.let { store ->
            for (reportId in store.listReportsAwaitingAck(5)) {
                val ack = sender.checkReportStatus(reportId)
                if (ack != null) {
                    store.recordResponderAck(ack, now = now)
                }
            }
        }

        return completed
    }
}

