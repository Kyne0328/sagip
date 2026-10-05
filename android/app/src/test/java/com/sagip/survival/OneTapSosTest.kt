package com.sagip.survival

import com.facebook.react.bridge.JavaOnlyMap
import org.junit.Assert.*
import org.junit.Test

class OneTapSosTest {
  @Test fun emptyBridgeInputIsUnspecifiedWithoutLocationOrFabricatedSeverity() {
    val input = EmergencyBridgeInput.parseCreate(JavaOnlyMap())
    assertEquals(CreateEmergencyReportInput(), input)
    assertEquals(EmergencyType.UNSPECIFIED, input.emergencyType)
    assertEquals(Urgency.UNSPECIFIED, input.urgency)
    val bytes = EmergencyPayloadV1.encode(input.emergencyType, input.urgency, null)
    assertArrayEquals(byteArrayOf(0x53, 0x52, 0x50, 0x31, 1, 0, 0, 0), bytes)
    val payload = EmergencyPayload.decode(bytes)
    assertEquals(input.emergencyType, payload.emergencyType)
    assertEquals(input.urgency, payload.urgency)
    assertNull(payload.location)
    assertNull(payload.message)
  }

  @Test fun eachMissingFieldDefaultsIndependentlyAndInvalidInputRejects() {
    assertEquals(Urgency.UNSPECIFIED, EmergencyBridgeInput.parseCreate(JavaOnlyMap.of("emergencyType", "MEDICAL")).urgency)
    assertEquals(EmergencyType.UNSPECIFIED, EmergencyBridgeInput.parseCreate(JavaOnlyMap.of("urgency", "IMMEDIATE_DANGER")).emergencyType)
    assertEquals(CreateEmergencyReportInput(), EmergencyBridgeInput.parseCreate(JavaOnlyMap.of("emergencyType", null, "urgency", null)))
    assertThrows(IllegalArgumentException::class.java) {
      EmergencyBridgeInput.parseCreate(JavaOnlyMap.of("emergencyType", "TYPO"))
    }
  }

  @Test fun codeZeroRoundTripsBothPayloadVersionsAndExistingCodesStayFixed() {
    for (type in EmergencyType.entries) for (urgency in Urgency.entries) {
      val bytes = EmergencyPayloadV2.encode(type, urgency, null, "Help")
      val decoded = EmergencyPayloadV2.decode(bytes)
      assertEquals(type, decoded.emergencyType)
      assertEquals(urgency, decoded.urgency)
      assertEquals("Help", decoded.message)
    }
    val legacy = EmergencyPayloadV1.encode(EmergencyType.OTHER, Urgency.NEED_ASSISTANCE, null)
    assertEquals(6, legacy[5].toInt())
    assertEquals(2, legacy[6].toInt())
    for (index in listOf(5, 6)) {
      val invalid = legacy.copyOf().also { it[index] = 127 }
      assertThrows(IllegalArgumentException::class.java) { EmergencyPayload.decode(invalid) }
    }
  }

  @Test fun appendParserRetainsAbsentFieldsAndValidatesOptimisticRevision() {
    val reportId = "00000000-0000-0000-0000-000000000001"
    val operationId = "00000000-0000-0000-0000-000000000002"
    val base = JavaOnlyMap.of("expectedRevision", 1.0, "operationId", operationId)
    val absent = EmergencyBridgeInput.parseDetails(reportId, base)
    assertNull(absent.emergencyType)
    assertNull(absent.urgency)
    val input = JavaOnlyMap.of("expectedRevision", 1.0, "operationId", operationId, "urgency", "NEED_ASSISTANCE")
    val urgency = EmergencyBridgeInput.parseDetails(reportId, input)
    assertEquals(Urgency.NEED_ASSISTANCE, urgency.urgency)
    assertNotEquals(EmergencyDetails.requestDigest(absent), EmergencyDetails.requestDigest(urgency))
    for (revision in listOf(0.0, 1.5, Double.NaN, 2147483648.0)) {
      assertThrows(IllegalArgumentException::class.java) {
        EmergencyBridgeInput.parseDetails(reportId, JavaOnlyMap.of("expectedRevision", revision, "operationId", operationId))
      }
    }
  }
}
