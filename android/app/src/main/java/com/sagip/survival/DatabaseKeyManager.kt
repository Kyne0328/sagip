package com.sagip.survival

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class DatabaseKeyUnavailableException(message: String, cause: Throwable? = null) :
  IllegalStateException(message, cause)

class DatabaseKeyManager(
  context: Context,
  private val secureRandom: SecureRandom = SecureRandom(),
) {
  private val appContext = context.applicationContext
  private val preferences = appContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

  @Synchronized
  fun getExistingDatabaseKey(): ByteArray {
    val wrappedRecord = readWrappedRecord()
      ?: throw DatabaseKeyUnavailableException("Wrapped database key metadata is missing")
    val keyStore = loadKeyStore()
    if (!keyStore.containsAlias(KEY_ALIAS)) {
      throw DatabaseKeyUnavailableException(
        "Encrypted database key metadata exists but its Android Keystore wrapping key is missing",
      )
    }
    return unwrap(wrappedRecord, keyStore)
  }

  @Synchronized
  fun getOrCreateDatabaseKey(): ByteArray {
    val wrappedRecord = readWrappedRecord()
    val keyStore = loadKeyStore()
    val hasWrappingKey = keyStore.containsAlias(KEY_ALIAS)

    if (wrappedRecord != null && !hasWrappingKey) {
      throw DatabaseKeyUnavailableException(
        "Encrypted database key metadata exists but its Android Keystore wrapping key is missing",
      )
    }
    if (wrappedRecord == null && hasWrappingKey) {
      throw DatabaseKeyUnavailableException(
        "Android Keystore database wrapping key exists but wrapped database key metadata is missing",
      )
    }

    if (wrappedRecord != null) {
      return unwrap(wrappedRecord, keyStore)
    }

    val wrappingKey = generateWrappingKey()
    val databaseKey = ByteArray(DATABASE_KEY_BYTES).also(secureRandom::nextBytes)
    try {
      val record = wrap(databaseKey, wrappingKey)
      check(
        preferences.edit()
          .putInt(PREF_VERSION, RECORD_VERSION)
          .putString(PREF_NONCE, Base64.encodeToString(record.nonce, Base64.NO_WRAP))
          .putString(PREF_CIPHERTEXT, Base64.encodeToString(record.ciphertext, Base64.NO_WRAP))
          .commit(),
      ) { "Failed to persist wrapped database key metadata" }
      return databaseKey.copyOf()
    } catch (error: Exception) {
      runCatching { loadKeyStore().deleteEntry(KEY_ALIAS) }
      throw DatabaseKeyUnavailableException("Failed to initialize encrypted database key", error)
    } finally {
      databaseKey.fill(0)
    }
  }

  private fun generateWrappingKey(): SecretKey {
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setKeySize(256)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setUserAuthenticationRequired(false)
        .build(),
    )
    return generator.generateKey()
  }

  private fun wrap(databaseKey: ByteArray, wrappingKey: SecretKey): WrappedRecord {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, wrappingKey)
    return WrappedRecord(
      nonce = cipher.iv.copyOf(),
      ciphertext = cipher.doFinal(databaseKey),
    )
  }

  private fun unwrap(record: WrappedRecord, keyStore: KeyStore): ByteArray {
    val key = keyStore.getKey(KEY_ALIAS, null) as? SecretKey
      ?: throw DatabaseKeyUnavailableException("Database wrapping key is unavailable")
    return try {
      Cipher.getInstance(TRANSFORMATION).run {
        init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, record.nonce))
        doFinal(record.ciphertext)
      }.also {
        if (it.size != DATABASE_KEY_BYTES) {
          it.fill(0)
          throw DatabaseKeyUnavailableException("Unwrapped database key has invalid length")
        }
      }
    } catch (error: DatabaseKeyUnavailableException) {
      throw error
    } catch (error: Exception) {
      throw DatabaseKeyUnavailableException("Wrapped database key could not be decrypted", error)
    }
  }

  private fun readWrappedRecord(): WrappedRecord? {
    val hasAny = preferences.contains(PREF_VERSION) ||
      preferences.contains(PREF_NONCE) ||
      preferences.contains(PREF_CIPHERTEXT)
    if (!hasAny) return null

    val version = preferences.getInt(PREF_VERSION, -1)
    val nonce = preferences.getString(PREF_NONCE, null)
    val ciphertext = preferences.getString(PREF_CIPHERTEXT, null)
    if (version != RECORD_VERSION || nonce == null || ciphertext == null) {
      throw DatabaseKeyUnavailableException("Wrapped database key metadata is incomplete or unsupported")
    }
    return try {
      WrappedRecord(
        nonce = Base64.decode(nonce, Base64.NO_WRAP),
        ciphertext = Base64.decode(ciphertext, Base64.NO_WRAP),
      )
    } catch (error: IllegalArgumentException) {
      throw DatabaseKeyUnavailableException("Wrapped database key metadata is corrupt", error)
    }
  }

  private fun loadKeyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

  private data class WrappedRecord(
    val nonce: ByteArray,
    val ciphertext: ByteArray,
  )

  companion object {
    const val KEY_ALIAS = "sagip.database.wrapping.v1"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val PREFERENCES_NAME = "sagip.database.key.v1"
    private const val PREF_VERSION = "version"
    private const val PREF_NONCE = "nonce"
    private const val PREF_CIPHERTEXT = "ciphertext"
    private const val RECORD_VERSION = 1
    private const val DATABASE_KEY_BYTES = 32
  }
}
