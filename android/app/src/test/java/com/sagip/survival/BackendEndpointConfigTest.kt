package com.sagip.survival

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class BackendEndpointConfigTest {
  @Test
  fun `debug configuration accepts emulator or LAN HTTP base URL`() {
    assertEquals(
      "http://10.0.2.2:8080/v1/envelopes",
      BackendEndpointConfig.envelopeUrl("http://10.0.2.2:8080/", allowCleartext = true),
    )
    assertEquals(
      "http://192.168.1.100:8080/v1/envelopes",
      BackendEndpointConfig.envelopeUrl("http://192.168.1.100:8080", allowCleartext = true),
    )
  }

  @Test
  fun `HTTPS base URL is accepted for production delivery`() {
    assertEquals(
      "https://api.sagip.example/v1/envelopes",
      BackendEndpointConfig.envelopeUrl("https://api.sagip.example/", allowCleartext = false),
    )
  }

  @Test
  fun `release configuration rejects cleartext backend URL`() {
    assertThrows(IllegalArgumentException::class.java) {
      BackendEndpointConfig.envelopeUrl("http://api.sagip.example", allowCleartext = false)
    }
  }

  @Test
  fun `empty backend configuration is rejected`() {
    assertThrows(IllegalArgumentException::class.java) {
      BackendEndpointConfig.envelopeUrl("   ", allowCleartext = false)
    }
  }

  @Test
  fun `query and fragment are rejected from backend base URL`() {
    assertThrows(IllegalArgumentException::class.java) {
      BackendEndpointConfig.envelopeUrl(
        "https://api.sagip.example?mode=test",
        allowCleartext = false,
      )
    }
    assertThrows(IllegalArgumentException::class.java) {
      BackendEndpointConfig.envelopeUrl(
        "https://api.sagip.example#fragment",
        allowCleartext = false,
      )
    }
  }
}
