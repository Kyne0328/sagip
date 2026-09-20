package com.sagip.survival

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeliveryWorkerTest {

  private class FakeOutboundDeliveryStore(
    var dueList: MutableList<OutboundEnvelopeWork> = mutableListOf(),
  ) : OutboundDeliveryStore {
    val startedAttempts = mutableListOf<Triple<String, String, Long>>()
    val completedAttempts = mutableListOf<Pair<String, String>>()
    val acceptedReceipts = mutableListOf<ServerReceipt>()
    val retriedMessages = mutableListOf<String>()
    val failedMessages = mutableListOf<Pair<String, String?>>()

    override fun listDueOutbound(now: Long, limit: Int): List<OutboundEnvelopeWork> = dueList.toList()

    override fun recordAttemptStarted(
      messageId: String,
      transport: String,
      peerIdentifier: String?,
      now: Long,
    ): String {
      startedAttempts += Triple(messageId, transport, now)
      return "attempt-$messageId"
    }

    override fun recordAttemptCompleted(
      attemptId: String,
      outcome: String,
      retryClassification: String?,
      now: Long,
    ) {
      completedAttempts += (attemptId to outcome)
    }

    override fun markServerAccepted(receipt: ServerReceipt, now: Long) {
      acceptedReceipts += receipt
      dueList.removeAll { it.messageId == receipt.messageId }
    }

    override fun scheduleRetry(messageId: String, now: Long, jitterUnit: Double): Long {
      retriedMessages += messageId
      dueList.removeAll { it.messageId == messageId }
      return now + 5000L
    }

    override fun markDeliveryFailed(messageId: String, reason: String?, now: Long) {
      failedMessages += (messageId to reason)
      dueList.removeAll { it.messageId == messageId }
    }
  }

  private class FakeEnvelopeSender(
    var result: DeliveryTransportResult,
  ) : EnvelopeSender {
    val sentEnvelopes = mutableListOf<OutboundEnvelope>()

    override suspend fun send(envelope: OutboundEnvelope): DeliveryTransportResult {
      sentEnvelopes += envelope
      return result
    }
  }

  private val sampleEnvelope = OutboundEnvelopeWork(
    messageId = "msg-1",
    reportId = "rep-1",
    revision = 1,
    priority = 0,
    createdAt = 1000L,
    expiresAt = null,
    nextAttemptAt = 1000L,
    attemptCount = 0,
    deliveryState = "DELIVERY_PENDING",
    envelopeBytes = byteArrayOf(0x53, 0x47, 0x50, 0x31),
  )

  @Test
  fun `runOnce successfully delivers and marks server accepted`() = runBlocking {
    val receipt = ServerReceipt(
      receiptVersion = 1,
      state = "SERVER_ACCEPTED",
      receiptId = "rcpt-1",
      messageId = "msg-1",
      reportId = "rep-1",
      revision = 1,
      acceptedAt = "2026-09-05T20:00:00.000Z",
    )
    val store = FakeOutboundDeliveryStore(mutableListOf(sampleEnvelope))
    val sender = FakeEnvelopeSender(DeliveryTransportResult.Accepted(receipt))
    val worker = DeliveryWorker(store, sender)

    val count = worker.runOnce(now = 2000L)

    assertEquals(1, count)
    assertEquals(1, sender.sentEnvelopes.size)
    assertEquals("msg-1", sender.sentEnvelopes.first().messageId)
    assertArrayEquals(sampleEnvelope.envelopeBytes, sender.sentEnvelopes.first().bytes)

    assertEquals(1, store.startedAttempts.size)
    assertEquals("msg-1", store.startedAttempts.first().first)
    assertEquals("INTERNET", store.startedAttempts.first().second)

    assertEquals(1, store.completedAttempts.size)
    assertEquals("SUCCESS", store.completedAttempts.first().second)

    assertEquals(1, store.acceptedReceipts.size)
    assertEquals("rcpt-1", store.acceptedReceipts.first().receiptId)
    assertTrue(store.dueList.isEmpty())
  }

  @Test
  fun `runOnce schedules retry on retryable failure`() = runBlocking {
    val store = FakeOutboundDeliveryStore(mutableListOf(sampleEnvelope))
    val sender = FakeEnvelopeSender(DeliveryTransportResult.RetryableFailure("HTTP_503"))
    val worker = DeliveryWorker(store, sender)

    val count = worker.runOnce(now = 2000L)

    assertEquals(0, count)
    assertEquals(1, store.startedAttempts.size)
    assertEquals(1, store.completedAttempts.size)
    assertEquals("RETRYABLE_FAILURE", store.completedAttempts.first().second)

    assertEquals(listOf("msg-1"), store.retriedMessages)
    assertTrue(store.acceptedReceipts.isEmpty())
  }

  @Test
  fun `runOnce marks permanent failure on permanent failure`() = runBlocking {
    val store = FakeOutboundDeliveryStore(mutableListOf(sampleEnvelope))
    val sender = FakeEnvelopeSender(DeliveryTransportResult.PermanentFailure("HTTP_400"))
    val worker = DeliveryWorker(store, sender)

    val count = worker.runOnce(now = 2000L)

    assertEquals(0, count)
    assertEquals(1, store.startedAttempts.size)
    assertEquals(1, store.completedAttempts.size)
    assertEquals("PERMANENT_FAILURE", store.completedAttempts.first().second)

    assertEquals(1, store.failedMessages.size)
    assertEquals("msg-1", store.failedMessages.first().first)
    assertEquals("HTTP_400", store.failedMessages.first().second)
    assertTrue(store.acceptedReceipts.isEmpty())
  }

  private class FakeRelayDeliveryStore(
    var inboundList: MutableList<InboundEnvelope> = mutableListOf(),
  ) : RelayDeliveryStore {
    val acceptedInbound = mutableListOf<String>()
    val retriedInbound = mutableListOf<String>()

    override fun listDueInbound(now: Long, limit: Int): List<InboundEnvelope> = inboundList.toList()

    override fun markInboundServerAccepted(messageId: String, now: Long) {
      acceptedInbound += messageId
      inboundList.removeAll { it.messageId == messageId }
    }

    override fun scheduleInboundRetry(messageId: String, now: Long, jitterUnit: Double): Long {
      retriedInbound += messageId
      inboundList.removeAll { it.messageId == messageId }
      return now + 5000L
    }
  }

  @Test
  fun `runOnce also delivers due inbound relay envelopes to server`() = runBlocking {
    val store = FakeOutboundDeliveryStore(mutableListOf())
    val inbound = InboundEnvelope(
      inboundId = "in-1",
      messageId = "msg-inbound-1",
      envelopeBytes = byteArrayOf(1, 2, 3),
      receivedAt = 1000L,
      originKeyId = byteArrayOf(4, 5, 6),
    )
    val relayStore = FakeRelayDeliveryStore(mutableListOf(inbound))
    val sender = FakeEnvelopeSender(
      DeliveryTransportResult.Accepted(
        ServerReceipt("rcpt-relay", "msg-inbound-1", "rep-inbound", 1, "2026-09-20T12:00:00Z"),
      ),
    )
    val worker = DeliveryWorker(store, sender, relayStore = relayStore)

    val count = worker.runOnce(now = 2000L)

    assertEquals(1, count)
    assertEquals(1, relayStore.acceptedInbound.size)
    assertEquals("msg-inbound-1", relayStore.acceptedInbound.first())
    assertEquals(1, sender.sentEnvelopes.size)
    assertEquals("msg-inbound-1", sender.sentEnvelopes.first().messageId)
  }

  private class FakeResponderAckStore : ResponderAckStore {
    val reportsAwaitingAck = mutableListOf<String>()
    val recordedAcks = mutableListOf<ResponderAck>()

    override fun listReportsAwaitingAck(limit: Int): List<String> = reportsAwaitingAck.take(limit)

    override fun recordResponderAck(ack: ResponderAck, now: Long): Boolean {
      recordedAcks += ack
      reportsAwaitingAck.remove(ack.reportId)
      return true
    }
  }

  @Test
  fun `runOnce checks and records responder acknowledgement for accepted reports`() = runBlocking {
    val store = FakeOutboundDeliveryStore(mutableListOf())
    val ackStore = FakeResponderAckStore().apply {
      reportsAwaitingAck += "rep-1"
    }
    val expectedAck = ResponderAck(
      ackId = "ack-1",
      reportId = "rep-1",
      responderId = "SERVER",
      callsign = "MEDIC-1",
      status = "ACKNOWLEDGED",
      note = "En route",
      acknowledgedAt = 2000L,
    )
    val sender = object : EnvelopeSender {
      override suspend fun send(envelope: OutboundEnvelope): DeliveryTransportResult {
        return DeliveryTransportResult.RetryableFailure("none")
      }
      override suspend fun checkReportStatus(reportId: String): ResponderAck? {
        return if (reportId == "rep-1") expectedAck else null
      }
    }
    val worker = DeliveryWorker(store, sender, ackStore = ackStore)

    worker.runOnce(now = 2000L)

    assertEquals(1, ackStore.recordedAcks.size)
    assertEquals("ack-1", ackStore.recordedAcks.first().ackId)
    assertEquals("MEDIC-1", ackStore.recordedAcks.first().callsign)
    assertEquals("ACKNOWLEDGED", ackStore.recordedAcks.first().status)
    assertTrue(ackStore.reportsAwaitingAck.isEmpty())
  }
}
