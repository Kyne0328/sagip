package com.sagip.survival

import java.security.KeyStore

/** Separate from the civilian installation identity; provisioning exports public material only. */
class GatewaySigningIdentity(private val alias: String = KEY_ALIAS) : SigningIdentity {
  private val delegate = AndroidKeystoreSigningIdentity(alias)
  override val keyId get() = delegate.keyId
  override val publicKeyDer get() = delegate.publicKeyDer
  override fun sign(data: ByteArray) = delegate.sign(data)
  val privateKeyExportable: Boolean get() {
    // Force creation, then inspect the actual Keystore entry rather than claiming an attribute.
    delegate.publicKeyDer
    return KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey(alias, null).encoded != null
  }

  fun exportProvisioningRequest(grantId: String, responderId: String, callsign: String,
    statusMask: Int, purposeMask: Int, scope: String): GatewayGrantRequest = GatewayGrantRequest(
      java.util.UUID.randomUUID().toString(), keyId, publicKeyDer,
      ReceiptAuthority.issuerProviderId(2, keyId, grantId), grantId, responderId,
      callsign, statusMask, purposeMask, scope,
    )

  companion object { const val KEY_ALIAS = "sagip.gateway.signing.v2" }
}

data class GatewayGrantRequest(val requestId: String, val issuerKeyId: ByteArray,
  val issuerPublicKeyDer: ByteArray, val issuerProviderId: ByteArray, val grantId: String,
  val responderId: String, val callsign: String, val statusMask: Int, val purposeMask: Int, val scope: String)
