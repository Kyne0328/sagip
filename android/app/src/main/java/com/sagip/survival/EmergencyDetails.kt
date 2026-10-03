package com.sagip.survival

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.nio.CharBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest

class EmergencyDetailsException(val code: String, message: String) : IllegalArgumentException(message)

/** Normalization and request identity shared by the repository and future bridge parser. */
object EmergencyDetails {
  private val canonicalUuid = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

  fun normalize(input: AppendEmergencyDetailsInput): AppendEmergencyDetailsInput {
    if (!canonicalUuid.matches(input.reportId) || !canonicalUuid.matches(input.operationId) || input.expectedRevision < 1) {
      throw EmergencyDetailsException("DETAILS_INVALID", "Canonical report/operation UUIDs and a positive revision are required")
    }
    val message = input.message?.trim()
    if (message != null) {
      if (message.length > EmergencyPayloadV2.MAX_MESSAGE_BYTES) invalidMessage()
      val bytes = try {
        Charsets.UTF_8.newEncoder()
          .onMalformedInput(CodingErrorAction.REPORT)
          .onUnmappableCharacter(CodingErrorAction.REPORT)
          .encode(CharBuffer.wrap(message)).remaining()
      } catch (_: CharacterCodingException) {
        throw EmergencyDetailsException("DETAILS_INVALID", "Message contains malformed Unicode")
      }
      if (bytes > EmergencyPayloadV2.MAX_MESSAGE_BYTES) invalidMessage()
    }
    // Keep empty distinct from absent until the request digest has been computed.
    return input.copy(message = message)
  }

  fun requestDigest(input: AppendEmergencyDetailsInput): String {
    val bytes = ByteArrayOutputStream()
    DataOutputStream(bytes).use { output ->
      output.writeInt(1) // Local request digest format, independent of the wire payload.
      output.writeUTF(input.reportId)
      output.writeInt(input.expectedRevision)
      output.writeBoolean(input.emergencyType != null)
      input.emergencyType?.let { output.writeUTF(it.name) }
      output.writeBoolean(input.message != null)
      input.message?.toByteArray(Charsets.UTF_8)?.let {
        output.writeInt(it.size)
        output.write(it)
      }
    }
    return MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray())
      .joinToString("") { "%02x".format(it) }
  }

  private fun invalidMessage(): Nothing =
    throw EmergencyDetailsException("DETAILS_INVALID", "Message exceeds 500 UTF-8 bytes")
}
