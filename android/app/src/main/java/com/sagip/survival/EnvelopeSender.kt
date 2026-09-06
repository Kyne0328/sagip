package com.sagip.survival

import java.net.HttpURLConnection
import java.net.URL

/**
 * Sends an already prepared immutable transport envelope.
 * Implementations must never regenerate or mutate signed bytes.
 */
interface EnvelopeSender {
    suspend fun send(envelope: OutboundEnvelope): DeliveryTransportResult
}

data class OutboundEnvelope(
    val messageId: String,
    val bytes: ByteArray,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is OutboundEnvelope) return false
        return messageId == other.messageId && bytes.contentEquals(other.bytes)
    }

    override fun hashCode(): Int {
        var result = messageId.hashCode()
        result = 31 * result + bytes.contentHashCode()
        return result
    }
}

class HttpEnvelopeSender(
    private val endpointUrl: String,
    private val connectTimeoutMs: Int = 10_000,
    private val readTimeoutMs: Int = 10_000,
) : EnvelopeSender {

    override suspend fun send(envelope: OutboundEnvelope): DeliveryTransportResult {
        return try {
            val url = URL(endpointUrl)
            val connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = connectTimeoutMs
                readTimeout = readTimeoutMs
                setRequestProperty("Content-Type", "application/octet-stream")
                setFixedLengthStreamingMode(envelope.bytes.size)
            }

            connection.outputStream.use { it.write(envelope.bytes) }

            val responseCode = connection.responseCode
            if (responseCode == HttpURLConnection.HTTP_OK) {
                val responseBody = connection.inputStream.bufferedReader().use { it.readText() }
                val receipt = parseServerReceipt(responseBody)
                DeliveryTransportResult.Accepted(receipt)
            } else if (responseCode in 400..499 && responseCode != 408) {
                DeliveryTransportResult.PermanentFailure("HTTP_$responseCode")
            } else {
                DeliveryTransportResult.RetryableFailure("HTTP_$responseCode")
            }
        } catch (e: Exception) {
            DeliveryTransportResult.RetryableFailure(e.javaClass.simpleName)
        }
    }

    companion object {
        fun parseServerReceipt(jsonString: String): ServerReceipt {
            val receiptVersion = extractInt(jsonString, "receiptVersion", "receipt_version")
            val state = extractString(jsonString, "state")
            val receiptId = extractString(jsonString, "receiptId", "receipt_id")
            val messageId = extractString(jsonString, "messageId", "message_id")
            val reportId = extractString(jsonString, "reportId", "report_id")
            val revision = extractInt(jsonString, "revision")
            val acceptedAt = extractString(jsonString, "acceptedAt", "accepted_at")

            return ServerReceipt(
                receiptVersion = receiptVersion,
                state = state,
                receiptId = receiptId,
                messageId = messageId,
                reportId = reportId,
                revision = revision,
                acceptedAt = acceptedAt,
            )
        }

        private fun extractString(json: String, vararg keys: String): String {
            for (key in keys) {
                val regex = """"$key"\s*:\s*"([^"]+)"""".toRegex()
                val match = regex.find(json)
                if (match != null) return match.groupValues[1]
            }
            throw IllegalArgumentException("Missing field ${keys.joinToString(" or ")} in receipt")
        }

        private fun extractInt(json: String, vararg keys: String): Int {
            for (key in keys) {
                val regex = """"$key"\s*:\s*(\d+)""".toRegex()
                val match = regex.find(json)
                if (match != null) return match.groupValues[1].toInt()
            }
            throw IllegalArgumentException("Missing field ${keys.joinToString(" or ")} in receipt")
        }
    }
}

