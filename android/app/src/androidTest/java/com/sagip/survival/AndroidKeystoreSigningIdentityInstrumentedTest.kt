package com.sagip.survival

import androidx.test.ext.junit.runners.AndroidJUnit4
import java.security.KeyFactory
import java.security.KeyStore
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidKeystoreSigningIdentityInstrumentedTest {
  @Before
  fun setUp() {
    deleteTestAlias()
  }

  @After
  fun tearDown() {
    deleteTestAlias()
  }

  @Test
  fun installationKeyPersistsAndSignsAcrossIdentityRecreation() {
    val first = AndroidKeystoreSigningIdentity(TEST_ALIAS)
    val second = AndroidKeystoreSigningIdentity(TEST_ALIAS)

    assertArrayEquals(first.publicKeyDer, second.publicKeyDer)
    assertArrayEquals(first.keyId, second.keyId)

    val data = "sagip-keystore-test".toByteArray(Charsets.UTF_8)
    val signature = second.sign(data)
    val publicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(second.publicKeyDer))
    val verified = Signature.getInstance("SHA256withECDSA").run {
      initVerify(publicKey)
      update(data)
      verify(signature)
    }

    assertTrue(verified)
  }

  private fun deleteTestAlias() {
    KeyStore.getInstance("AndroidKeyStore").apply {
      load(null)
      if (containsAlias(TEST_ALIAS)) {
        deleteEntry(TEST_ALIAS)
      }
    }
  }

  companion object {
    private const val TEST_ALIAS = "sagip.test.installation.signing.v1"
  }
}
