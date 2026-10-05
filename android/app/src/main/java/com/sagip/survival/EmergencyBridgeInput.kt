package com.sagip.survival

import com.facebook.react.bridge.ReadableMap

/** Missing or null optional fields mean unspecified at creation and retain at append. */
internal object EmergencyBridgeInput {
  fun parseCreate(input: ReadableMap) = CreateEmergencyReportInput(
    optionalString(input, "emergencyType")?.let(EmergencyType::valueOf) ?: EmergencyType.UNSPECIFIED,
    optionalString(input, "urgency")?.let(Urgency::valueOf) ?: Urgency.UNSPECIFIED,
  )

  fun parseDetails(reportId: String, input: ReadableMap): AppendEmergencyDetailsInput {
    val revision = input.getDouble("expectedRevision")
    require(revision.isFinite() && revision >= 1 && revision <= Int.MAX_VALUE && revision == revision.toInt().toDouble()) {
      "Expected revision must be a positive integer"
    }
    return EmergencyDetails.normalize(AppendEmergencyDetailsInput(
      reportId = reportId,
      expectedRevision = revision.toInt(),
      operationId = requireNotNull(optionalString(input, "operationId")) { "Operation ID is required" },
      emergencyType = optionalString(input, "emergencyType")?.let(EmergencyType::valueOf),
      message = optionalString(input, "message"),
      urgency = optionalString(input, "urgency")?.let(Urgency::valueOf),
    ))
  }

  private fun optionalString(input: ReadableMap, key: String): String? =
    if (!input.hasKey(key) || input.isNull(key)) null else input.getString(key)
}
