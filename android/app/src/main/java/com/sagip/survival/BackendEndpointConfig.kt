package com.sagip.survival

import java.net.URL
import org.sagip.app.BuildConfig

object BackendEndpointConfig {
  fun envelopeUrl(): String {
    return envelopeUrl(
      baseUrl = BuildConfig.SAGIP_BACKEND_BASE_URL,
      allowCleartext = BuildConfig.DEBUG,
    )
  }

  internal fun envelopeUrl(baseUrl: String, allowCleartext: Boolean): String {
    val normalized = baseUrl.trim().trimEnd('/')
    require(normalized.isNotEmpty()) {
      "SAGIP_BACKEND_BASE_URL must be configured"
    }

    val parsed = URL(normalized)
    val allowedScheme = parsed.protocol == "https" ||
      (allowCleartext && parsed.protocol == "http")
    require(allowedScheme) {
      "SAGIP backend must use HTTPS outside debug builds"
    }
    require(parsed.host.isNotBlank()) {
      "SAGIP_BACKEND_BASE_URL must include a host"
    }
    require(parsed.query == null && parsed.ref == null) {
      "SAGIP_BACKEND_BASE_URL must not include a query or fragment"
    }

    return "$normalized/v1/envelopes"
  }
}
