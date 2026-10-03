package com.sagip.survival

object EmergencyPayload {
  // Append input owns trimming/clear-to-null normalization. Never discard non-null wire text.
  fun encode(type: EmergencyType, urgency: Urgency, location: LocationSnapshot?, message: String?): ByteArray =
    if (message == null) EmergencyPayloadV1.encode(type, urgency, location)
    else EmergencyPayloadV2.encode(type, urgency, location, message)
}
