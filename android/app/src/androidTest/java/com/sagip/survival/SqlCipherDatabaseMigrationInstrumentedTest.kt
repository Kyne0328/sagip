package com.sagip.survival

import android.content.Context
import android.database.sqlite.SQLiteDatabase as FrameworkSQLiteDatabase
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.security.KeyStore
import java.security.SecureRandom
import net.zetetic.database.sqlcipher.SQLiteDatabase
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SqlCipherDatabaseMigrationInstrumentedTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()

  @Before
  fun setUp() {
    clearSecurityState()
    System.loadLibrary("sqlcipher")
  }

  @After
  fun tearDown() {
    clearSecurityState()
  }

  @Test
  fun databaseKeySurvivesManagerRecreationAndCorruptionFailsClosed() {
    val first = DatabaseKeyManager(context).getOrCreateDatabaseKey()
    val second = DatabaseKeyManager(context).getOrCreateDatabaseKey()
    assertArrayEquals(first, second)

    val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    val encodedCiphertext = requireNotNull(preferences.getString(PREF_CIPHERTEXT, null))
    val corrupted = Base64.decode(encodedCiphertext, Base64.NO_WRAP).also {
      it[it.lastIndex] = (it.last().toInt() xor 1).toByte()
    }
    preferences.edit()
      .putString(PREF_CIPHERTEXT, Base64.encodeToString(corrupted, Base64.NO_WRAP))
      .commit()

    assertThrows(DatabaseKeyUnavailableException::class.java) {
      DatabaseKeyManager(context).getOrCreateDatabaseKey()
    }

    first.fill(0)
    second.fill(0)
  }

  @Test
  fun migratesExistingPlaintextDatabaseToSqlCipherAndRejectsWrongKey() {
    val databaseFile = context.getDatabasePath(SagipDatabase.DATABASE_NAME)
    databaseFile.parentFile?.mkdirs()

    FrameworkSQLiteDatabase.openOrCreateDatabase(databaseFile, null).use { plaintext ->
      plaintext.execSQL("CREATE TABLE migration_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
      plaintext.execSQL("INSERT INTO migration_probe(id, value) VALUES (1, 'preserved')")
      plaintext.version = 7
    }

    val key = DatabaseKeyManager(context).getOrCreateDatabaseKey()
    try {
      SqlCipherDatabaseMigrator.migrateIfNeeded(context, key)

      assertThrows(Exception::class.java) {
        FrameworkSQLiteDatabase.openDatabase(
          databaseFile.absolutePath,
          null,
          FrameworkSQLiteDatabase.OPEN_READONLY,
        ).use { plaintext ->
          plaintext.rawQuery("SELECT value FROM migration_probe", null).use { it.moveToFirst() }
        }
      }

      SQLiteDatabase.openDatabase(
        databaseFile.absolutePath,
        key,
        null,
        SQLiteDatabase.OPEN_READONLY,
        null,
        null,
      ).use { encrypted ->
        assertEquals(7, encrypted.version)
        encrypted.rawQuery("SELECT value FROM migration_probe WHERE id = 1", emptyArray()).use { cursor ->
          assertTrue(cursor.moveToFirst())
          assertEquals("preserved", cursor.getString(0))
        }
      }

      val wrongKey = ByteArray(32).also(SecureRandom()::nextBytes)
      assertThrows(Exception::class.java) {
        SQLiteDatabase.openDatabase(
          databaseFile.absolutePath,
          wrongKey,
          null,
          SQLiteDatabase.OPEN_READONLY,
          null,
          null,
        ).use { encrypted ->
          encrypted.rawQuery("SELECT count(*) FROM sqlite_master", emptyArray()).use { cursor ->
            cursor.moveToFirst()
          }
        }
      }
      wrongKey.fill(0)
    } finally {
      key.fill(0)
    }
  }

  @Test
  fun encryptedDatabaseWithoutAnyKeyStateDoesNotGenerateReplacementKey() {
    val encryptedDatabase = SagipDatabase(context)
    try {
      encryptedDatabase.writableDatabase
        .rawQuery("SELECT count(*) FROM sqlite_master", emptyArray())
        .use { cursor -> assertTrue(cursor.moveToFirst()) }
    } finally {
      encryptedDatabase.close()
    }

    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE).edit().clear().commit()
    KeyStore.getInstance(ANDROID_KEYSTORE).apply {
      load(null)
      deleteEntry(DatabaseKeyManager.KEY_ALIAS)
    }

    assertThrows(DatabaseKeyUnavailableException::class.java) {
      SagipDatabase(context)
    }

    val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    assertTrue(!preferences.contains(PREF_CIPHERTEXT))
    val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    assertTrue(!keyStore.containsAlias(DatabaseKeyManager.KEY_ALIAS))
  }

  @Test
  fun missingKeystoreWrappingKeyDoesNotSilentlyReplaceDatabaseKey() {
    val original = DatabaseKeyManager(context).getOrCreateDatabaseKey()
    original.fill(0)

    KeyStore.getInstance(ANDROID_KEYSTORE).apply {
      load(null)
      deleteEntry(DatabaseKeyManager.KEY_ALIAS)
    }

    assertThrows(DatabaseKeyUnavailableException::class.java) {
      DatabaseKeyManager(context).getOrCreateDatabaseKey()
    }
  }

  private fun clearSecurityState() {
    context.deleteDatabase(SagipDatabase.DATABASE_NAME)
    listOf(
      context.getDatabasePath(SagipDatabase.DATABASE_NAME + ".sqlcipher-migrating"),
      context.getDatabasePath(SagipDatabase.DATABASE_NAME + ".plaintext-backup"),
    ).forEach { file ->
      listOf(file, java.io.File(file.absolutePath + "-wal"), java.io.File(file.absolutePath + "-shm"))
        .forEach { it.delete() }
    }
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE).edit().clear().commit()
    runCatching {
      KeyStore.getInstance(ANDROID_KEYSTORE).apply {
        load(null)
        if (containsAlias(DatabaseKeyManager.KEY_ALIAS)) deleteEntry(DatabaseKeyManager.KEY_ALIAS)
      }
    }
  }

  companion object {
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val PREFERENCES_NAME = "sagip.database.key.v1"
    private const val PREF_CIPHERTEXT = "ciphertext"
  }
}
