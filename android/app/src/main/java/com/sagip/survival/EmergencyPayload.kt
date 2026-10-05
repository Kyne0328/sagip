package com.sagip.survival

object EmergencyPayload {
  /** Plaintext SRP1 payload versions only; encrypted SGP2 envelopes remain separate. */
  fun decode(bytes: ByteArray): DecodedEmergencyPayload {
    require(bytes.size >= 5) { "truncated emergency payload" }
    return when (bytes[4].toInt() and 0xff) {
      1 -> EmergencyPayloadV1.decode(bytes)
      2 -> EmergencyPayloadV2.decode(bytes).let {
        DecodedEmergencyPayload(it.emergencyType, it.urgency, it.location, it.message)
      }
      else -> throw IllegalArgumentException("unsupported payload version")
    }
  }

  // Append input owns trimming/clear-to-null normalization. Never discard non-null wire text.
  fun encode(type: EmergencyType, urgency: Urgency, location: LocationSnapshot?, message: String?): ByteArray =
    if (message == null) EmergencyPayloadV1.encode(type, urgency, location)
    else EmergencyPayloadV2.encode(type, urgency, location, message)
}
