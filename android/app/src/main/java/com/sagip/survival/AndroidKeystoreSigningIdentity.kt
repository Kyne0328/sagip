package com.sagip.survival

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec

class AndroidKeystoreSigningIdentity(
  private val alias: String = DEFAULT_ALIAS,
) : SigningIdentity {
  private val entry: KeyStore.PrivateKeyEntry by lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
    getOrCreateEntry(alias)
  }

  override val publicKeyDer: ByteArray
    get() = entry.certificate.publicKey.encoded.copyOf()

  override val keyId: ByteArray
    get() = MessageDigest.getInstance("SHA-256").digest(publicKeyDer)

  override fun sign(data: ByteArray): ByteArray = Signature.getInstance("SHA256withECDSA").run {
    initSign(entry.privateKey)
    update(data)
    sign()
  }

  companion object {
    const val DEFAULT_ALIAS = "sagip.installation.signing.v1"
    private val keyCreationLock = Any()

    private fun getOrCreateEntry(alias: String): KeyStore.PrivateKeyEntry = synchronized(keyCreationLock) {
      val keyStore = loadKeyStore()
      if (!keyStore.containsAlias(alias)) {
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE).apply {
          initialize(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
              .setDigests(KeyProperties.DIGEST_SHA256)
              .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
              .setUserAuthenticationRequired(false)
              .build(),
          )
          generateKeyPair()
        }
      }

      val refreshed = loadKeyStore()
      refreshed.getEntry(alias, null) as? KeyStore.PrivateKeyEntry
        ?: throw IllegalStateException("SAGIP signing key is unavailable")
    }

    private fun loadKeyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
  }
}
