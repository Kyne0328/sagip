package com.sagip.survival

import org.junit.Assert.*
import org.junit.Test

class EmergencyPayloadTest {
  @Test fun `legacy payload retains fields and absent message`() {
    val location = LocationSnapshot(14.5, 120.5, 8.0, 1200L, "GPS", "FRESH")
    val bytes = EmergencyPayloadV1.encode(EmergencyType.MEDICAL, Urgency.NEED_ASSISTANCE, location)
    assertEquals(DecodedEmergencyPayload(EmergencyType.MEDICAL, Urgency.NEED_ASSISTANCE, location), EmergencyPayload.decode(bytes))
  }

  @Test fun `details payload preserves exact Unicode whitespace and markup text`() {
    val text = "  Synthetic help 🆘\nUpper floor <script>literal</script>  "
    val bytes = EmergencyPayloadV2.encode(EmergencyType.TRAPPED, Urgency.IMMEDIATE_DANGER, null, text)
    // This was the gateway's old call site: valid format-2 data failed the whole list.
    assertThrows(IllegalArgumentException::class.java) {EmergencyPayloadV1.decode(bytes)}
    val result = EmergencyPayload.decode(bytes)
    assertEquals(EmergencyType.TRAPPED, result.emergencyType)
    assertEquals(Urgency.IMMEDIATE_DANGER, result.urgency)
    assertNull(result.location)
    assertEquals(text, result.message)
  }

  @Test fun `dispatch rejects malformed unknown and encrypted payloads`() {
    val valid = EmergencyPayloadV2.encode(EmergencyType.TRAPPED, Urgency.IMMEDIATE_DANGER, null, "Help")
    listOf(ByteArray(0), valid.copyOf(4), valid.copyOf().apply {this[4] = 3},
      valid.copyOf().apply {this[0] = 0}, valid + byteArrayOf(0), "SRE2".toByteArray()).forEach { bytes ->
      assertThrows(IllegalArgumentException::class.java) {EmergencyPayload.decode(bytes)}
    }
  }
}
