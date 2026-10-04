package com.sagip.survival

import android.content.Context
import android.database.sqlite.SQLiteDatabase as FrameworkSQLiteDatabase
import java.io.File
import net.zetetic.database.sqlcipher.SQLiteDatabase

object SqlCipherDatabaseMigrator {
  private const val DATABASE_NAME = "sagip.db"
  private const val TEMP_SUFFIX = ".sqlcipher-migrating"
  private const val BACKUP_SUFFIX = ".plaintext-backup"

  fun existingDatabaseIsPlaintext(context: Context): Boolean {
    val databaseFile = context.getDatabasePath(DATABASE_NAME)
    return databaseFile.exists() && isPlaintextSqlite(databaseFile)
  }

  fun migrateIfNeeded(context: Context, key: ByteArray) {
    require(key.size == 32) { "SQLCipher key must be 32 bytes" }
    System.loadLibrary("sqlcipher")

    val databaseFile = context.getDatabasePath(DATABASE_NAME)
    val tempFile = File(databaseFile.parentFile, databaseFile.name + TEMP_SUFFIX)
    val backupFile = File(databaseFile.parentFile, databaseFile.name + BACKUP_SUFFIX)
    databaseFile.parentFile?.mkdirs()

    recoverInterruptedReplacement(databaseFile, tempFile, backupFile, key)
    if (!databaseFile.exists()) return
    if (!isPlaintextSqlite(databaseFile)) {
      verifyEncryptedDatabase(databaseFile, key)
      return
    }

    deleteDatabaseArtifacts(tempFile)
    val plaintextVersion = readPlaintextVersion(databaseFile)
    exportPlaintextToEncrypted(databaseFile, tempFile, key, plaintextVersion)
    verifyEncryptedDatabase(tempFile, key, expectedVersion = plaintextVersion)

    deleteDatabaseArtifacts(backupFile)
    check(databaseFile.renameTo(backupFile)) { "Could not preserve plaintext database during SQLCipher replacement" }
    try {
      check(tempFile.renameTo(databaseFile)) { "Could not install encrypted SQLCipher database" }
      verifyEncryptedDatabase(databaseFile, key, expectedVersion = plaintextVersion)
      deleteDatabaseArtifacts(backupFile)
    } catch (error: Exception) {
      deleteDatabaseArtifacts(databaseFile)
      backupFile.renameTo(databaseFile)
      throw IllegalStateException("SQLCipher migration replacement failed; plaintext database restored", error)
    } finally {
      deleteDatabaseArtifacts(tempFile)
    }
  }

  private fun recoverInterruptedReplacement(
    databaseFile: File,
    tempFile: File,
    backupFile: File,
    key: ByteArray,
  ) {
    if (!databaseFile.exists() && backupFile.exists()) {
      check(backupFile.renameTo(databaseFile)) { "Could not restore interrupted plaintext database migration" }
    }

    if (databaseFile.exists() && backupFile.exists()) {
      val encryptedFinalIsValid = runCatching {
        verifyEncryptedDatabase(databaseFile, key)
      }.isSuccess
      if (encryptedFinalIsValid) {
        deleteDatabaseArtifacts(backupFile)
      } else {
        deleteDatabaseArtifacts(databaseFile)
        check(backupFile.renameTo(databaseFile)) { "Could not restore plaintext backup after failed SQLCipher migration" }
      }
    }

    if (tempFile.exists()) {
      deleteDatabaseArtifacts(tempFile)
    }
  }

  private fun isPlaintextSqlite(file: File): Boolean = try {
    FrameworkSQLiteDatabase.openDatabase(
      file.absolutePath,
      null,
      FrameworkSQLiteDatabase.OPEN_READONLY,
    ).use { database ->
      database.rawQuery("SELECT count(*) FROM sqlite_master", null).use { cursor ->
        cursor.moveToFirst()
      }
    }
  } catch (_: Exception) {
    false
  }

  private fun readPlaintextVersion(file: File): Int =
    FrameworkSQLiteDatabase.openDatabase(
      file.absolutePath,
      null,
      FrameworkSQLiteDatabase.OPEN_READONLY,
    ).use { it.version }

  private fun exportPlaintextToEncrypted(
    source: File,
    destination: File,
    key: ByteArray,
    userVersion: Int,
  ) {
    val destinationDb = SQLiteDatabase.openDatabase(
      destination.absolutePath,
      key,
      null,
      SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY,
      null,
      null,
    )
    try {
      destinationDb.execSQL(
        "ATTACH DATABASE ? AS plaintext KEY ''",
        arrayOf(source.absolutePath),
      )
      try {
        destinationDb.rawExecSQL("SELECT sqlcipher_export('main', 'plaintext')")
        destinationDb.execSQL("PRAGMA user_version = $userVersion")
      } finally {
        destinationDb.execSQL("DETACH DATABASE plaintext")
      }
    } finally {
      destinationDb.close()
    }
  }

  private fun verifyEncryptedDatabase(file: File, key: ByteArray, expectedVersion: Int? = null) {
    val database = SQLiteDatabase.openDatabase(
      file.absolutePath,
      key,
      null,
      SQLiteDatabase.OPEN_READONLY,
      null,
      null,
    )
    try {
      database.rawQuery("PRAGMA integrity_check", emptyArray()).use { cursor ->
        check(cursor.moveToFirst() && cursor.getString(0).equals("ok", ignoreCase = true)) {
          "Encrypted database integrity check failed"
        }
      }
      expectedVersion?.let {
        check(database.version == it) {
          "Encrypted database user_version mismatch: expected $it, found ${database.version}"
        }
      }
    } finally {
      database.close()
    }
  }

  private fun deleteDatabaseArtifacts(file: File) {
    listOf(
      file,
      File(file.absolutePath + "-wal"),
      File(file.absolutePath + "-shm"),
      File(file.absolutePath + "-journal"),
    ).forEach { artifact ->
      if (artifact.exists() && !artifact.delete()) {
        throw IllegalStateException("Could not delete database migration artifact: ${artifact.name}")
      }
    }
  }
}
