package com.sagip.survival

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class DeliveryPipelineIntegrationTest {

  private lateinit var server: TestSocketHttpServer
  private lateinit var serverUrl: String

  data class CapturedRequest(
    val method: String,
    val path: String,
    val headers: Map<String, String>,
    val body: ByteArray,
  )

  private class TestSocketHttpServer : AutoCloseable {
    private val serverSocket = ServerSocket(0)
    val port: Int get() = serverSocket.localPort

    @Volatile var responseCode: Int = 200
    @Volatile var responseBody: String = ""
    val capturedRequests = mutableListOf<CapturedRequest>()

    private val executor = Executors.newSingleThreadExecutor()
    @Volatile private var running = true

    init {
      executor.execute {
        while (running) {
          try {
            val socket = serverSocket.accept()
            handleConnection(socket)
          } catch (_: Exception) {
            break
          }
        }
      }
    }

    private fun handleConnection(socket: Socket) {
      socket.use {
        val input = BufferedInputStream(it.getInputStream())
        val line = readLine(input) ?: return
        val parts = line.split(" ")
        val method = parts.getOrNull(0) ?: ""
        val path = parts.getOrNull(1) ?: ""

        val headers = mutableMapOf<String, String>()
        while (true) {
          val headerLine = readLine(input) ?: break
          if (headerLine.isEmpty()) break
          val colon = headerLine.indexOf(':')
          if (colon != -1) {
            headers[headerLine.substring(0, colon).trim().lowercase()] =
              headerLine.substring(colon + 1).trim()
          }
        }

        val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
        val body = ByteArray(contentLength)
        var totalRead = 0
        while (totalRead < contentLength) {
          val read = input.read(body, totalRead, contentLength - totalRead)
          if (read == -1) break
          totalRead += read
        }

        synchronized(capturedRequests) {
          capturedRequests += CapturedRequest(method, path, headers, body)
        }

        val statusText = when (responseCode) {
          200 -> "OK"
          400 -> "Bad Request"
          503 -> "Service Unavailable"
          else -> "Error"
        }
        val bodyBytes = responseBody.toByteArray(Charsets.UTF_8)
        val output = it.getOutputStream()
        val responseHeader = "HTTP/1.1 $responseCode $statusText\r\n" +
          "Content-Type: application/json; charset=utf-8\r\n" +
          "Content-Length: ${bodyBytes.size}\r\n" +
          "Connection: close\r\n" +
          "\r\n"
        output.write(responseHeader.toByteArray(Charsets.US_ASCII))
        output.write(bodyBytes)
        output.flush()
      }
    }

    private fun readLine(input: InputStream): String? {
      val out = ByteArrayOutputStream()
      while (true) {
        val b = input.read()
        if (b == -1) {
          if (out.size() == 0) return null
          break
        }
        if (b == '\n'.code) {
          break
        }
        if (b != '\r'.code) {
          out.write(b)
        }
      }
      return out.toString("UTF-8")
    }

    override fun close() {
      running = false
      try {
        serverSocket.close()
      } catch (_: Exception) {
      }
      executor.shutdownNow()
    }
  }

  private class IntegrationDeliveryStore(
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

  @Before
  fun setUp() {
    server = TestSocketHttpServer()
    serverUrl = "http://127.0.0.1:${server.port}/v1/envelopes"
  }

  @After
  fun tearDown() {
    server.close()
  }

  private val sampleBytes = byteArrayOf(0x53, 0x47, 0x50, 0x31, 0x01, 0x02, 0x03)
  private val sampleEnvelope = OutboundEnvelopeWork(
    messageId = "msg-e2e-1",
    reportId = "rep-e2e-1",
    revision = 1,
    priority = 0,
    createdAt = 1000L,
    expiresAt = null,
    nextAttemptAt = 1000L,
    attemptCount = 0,
    deliveryState = "DELIVERY_PENDING",
    envelopeBytes = sampleBytes,
  )

  @Test
  fun `full pipeline delivers envelope over socket and records server accepted receipt`() = runBlocking {
    server.responseCode = 200
    server.responseBody = """
      {
        "receipt_version": 1,
        "state": "SERVER_ACCEPTED",
        "receipt_id": "rcpt-e2e-99",
        "message_id": "msg-e2e-1",
        "report_id": "rep-e2e-1",
        "revision": 1,
        "accepted_at": "2026-09-06T00:00:00.000Z"
      }
    """.trimIndent()

    val store = IntegrationDeliveryStore(mutableListOf(sampleEnvelope))
    val realSender = HttpEnvelopeSender(serverUrl)
    val worker = DeliveryWorker(store, realSender)

    val count = worker.runOnce(now = 2000L)

    assertEquals(1, count)
    val requests = synchronized(server.capturedRequests) { server.capturedRequests.toList() }
    assertEquals(1, requests.size)
    val req = requests.first()
    assertEquals("POST", req.method)
    assertEquals("/v1/envelopes", req.path)
    assertEquals("application/octet-stream", req.headers["content-type"])
    assertArrayEquals(sampleBytes, req.body)

    assertEquals(1, store.acceptedReceipts.size)
    val receipt = store.acceptedReceipts.first()
    assertEquals("rcpt-e2e-99", receipt.receiptId)
    assertEquals("msg-e2e-1", receipt.messageId)
    assertEquals("rep-e2e-1", receipt.reportId)
    assertEquals(1, receipt.revision)
    assertEquals("SERVER_ACCEPTED", receipt.state)

    assertEquals(1, store.completedAttempts.size)
    assertEquals("SUCCESS", store.completedAttempts.first().second)
    assertTrue(store.dueList.isEmpty())
  }

  @Test
  fun `server 503 unavailable schedules retry over socket`() = runBlocking {
    server.responseCode = 503
    server.responseBody = """{"error":"SERVICE_UNAVAILABLE"}"""

    val store = IntegrationDeliveryStore(mutableListOf(sampleEnvelope))
    val realSender = HttpEnvelopeSender(serverUrl)
    val worker = DeliveryWorker(store, realSender)

    val count = worker.runOnce(now = 2000L)

    assertEquals(0, count)
    assertEquals(1, store.startedAttempts.size)
    assertEquals(1, store.completedAttempts.size)
    assertEquals("RETRYABLE_FAILURE", store.completedAttempts.first().second)
    assertEquals(listOf("msg-e2e-1"), store.retriedMessages)
    assertTrue(store.acceptedReceipts.isEmpty())
  }

  @Test
  fun `server 400 bad request marks permanent failure over socket`() = runBlocking {
    server.responseCode = 400
    server.responseBody = """{"error":"INVALID_ENVELOPE"}"""

    val store = IntegrationDeliveryStore(mutableListOf(sampleEnvelope))
    val realSender = HttpEnvelopeSender(serverUrl)
    val worker = DeliveryWorker(store, realSender)

    val count = worker.runOnce(now = 2000L)

    assertEquals(0, count)
    assertEquals(1, store.startedAttempts.size)
    assertEquals(1, store.completedAttempts.size)
    assertEquals("PERMANENT_FAILURE", store.completedAttempts.first().second)
    assertEquals(1, store.failedMessages.size)
    assertEquals("msg-e2e-1", store.failedMessages.first().first)
    assertTrue(store.acceptedReceipts.isEmpty())
  }

  @Test
  fun `connection failure schedules retry`() = runBlocking {
    // Point sender to an unreachable local port
    val deadUrl = "http://127.0.0.1:1/v1/envelopes"
    val store = IntegrationDeliveryStore(mutableListOf(sampleEnvelope))
    val realSender = HttpEnvelopeSender(deadUrl)
    val worker = DeliveryWorker(store, realSender)

    val count = worker.runOnce(now = 2000L)

    assertEquals(0, count)
    assertEquals(1, store.startedAttempts.size)
    assertEquals(1, store.completedAttempts.size)
    assertEquals("RETRYABLE_FAILURE", store.completedAttempts.first().second)
    assertEquals(listOf("msg-e2e-1"), store.retriedMessages)
  }
}
