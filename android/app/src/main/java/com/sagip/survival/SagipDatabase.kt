package com.sagip.survival

import android.content.Context
import net.zetetic.database.sqlcipher.SQLiteDatabase
import net.zetetic.database.sqlcipher.SQLiteOpenHelper

private fun prepareEncryptedDatabase(context: Context): ByteArray {
  val appContext = context.applicationContext
  val databaseFile = appContext.getDatabasePath(SagipDatabase.DATABASE_NAME)
  val keyManager = DatabaseKeyManager(appContext)
  val key = if (databaseFile.exists() && !SqlCipherDatabaseMigrator.existingDatabaseIsPlaintext(appContext)) {
    keyManager.getExistingDatabaseKey()
  } else {
    keyManager.getOrCreateDatabaseKey()
  }
  try {
    SqlCipherDatabaseMigrator.migrateIfNeeded(appContext, key)
    return key
  } catch (error: Exception) {
    key.fill(0)
    throw error
  }
}

class SagipDatabase(context: Context) :
  SQLiteOpenHelper(
    context.applicationContext,
    DATABASE_NAME,
    prepareEncryptedDatabase(context),
    null,
    Schema.VERSION,
    0,
    null,
    null,
    false,
  ) {

  override fun onConfigure(db: SQLiteDatabase) {
    super.onConfigure(db)
    db.setForeignKeyConstraintsEnabled(true)
  }

  override fun onCreate(db: SQLiteDatabase) {
    Schema.CREATE_STATEMENTS.forEach(db::execSQL)
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    if (oldVersion == newVersion) return

    var currentVersion = oldVersion
    if (currentVersion == 1 && newVersion >= 2) {
      Schema.MIGRATE_1_TO_2.forEach(db::execSQL)
      currentVersion = 2
    }
    if (currentVersion == 2 && newVersion >= 3) {
      Schema.MIGRATE_2_TO_3.forEach(db::execSQL)
      currentVersion = 3
    }
    if (currentVersion == 3 && newVersion >= 4) {
      Schema.MIGRATE_3_TO_4.forEach(db::execSQL)
      currentVersion = 4
    }
    if (currentVersion == 4 && newVersion >= 5) {
      Schema.MIGRATE_4_TO_5.forEach(db::execSQL)
      currentVersion = 5
    }
    if (currentVersion == 5 && newVersion >= 6) {
      Schema.MIGRATE_5_TO_6.forEach(db::execSQL)
      currentVersion = 6
    }
    if (currentVersion == 6 && newVersion >= 7) {
      Schema.MIGRATE_6_TO_7.forEach(db::execSQL)
      currentVersion = 7
    }
    if (currentVersion == 7 && newVersion >= 8) {
      Schema.MIGRATE_7_TO_8.forEach(db::execSQL)
      backfillReceiptIdentities(db)
      currentVersion = 8
    }
    if (currentVersion == 8 && newVersion >= 9) {
      Schema.MIGRATE_8_TO_9.forEach(db::execSQL)
      currentVersion = 9
    }
    if (currentVersion == 9 && newVersion >= 10) {
      Schema.MIGRATE_9_TO_10.forEach(db::execSQL)
      currentVersion = 10
    }
    if (currentVersion == 10 && newVersion >= 11) {
      Schema.MIGRATE_10_TO_11.forEach(db::execSQL)
      currentVersion = 11
    }

    if (currentVersion == 11 && newVersion >= 12) {
      Schema.MIGRATE_11_TO_12.forEach(db::execSQL)
      currentVersion = 12
    }

    if (currentVersion == 12 && newVersion >= 13) {
      Schema.MIGRATE_12_TO_13.forEach(db::execSQL)
      currentVersion = 13
    }

    if (currentVersion == 13 && newVersion >= 14) {
      Schema.MIGRATE_13_TO_14.forEach(db::execSQL)
      currentVersion = 14
    }

    if (currentVersion == 14 && newVersion >= 15) {
      Schema.MIGRATE_14_TO_15.forEach(db::execSQL)
      currentVersion = 15
    }

    if (currentVersion == 15 && newVersion >= 16) {
      Schema.MIGRATE_15_TO_16.forEach(db::execSQL)
      currentVersion = 16
    }

    if (currentVersion == 16 && newVersion >= 17) {
      check(db.inTransaction()) { "SAGIP revision migration requires an atomic upgrade transaction" }
      Schema.MIGRATE_16_TO_17.forEach(db::execSQL)
      db.rawQuery("PRAGMA foreign_key_check", emptyArray()).use { cursor ->
        check(!cursor.moveToFirst()) { "SAGIP revision migration violated foreign-key integrity" }
      }
      currentVersion = 17
    }

    if (currentVersion == 17 && newVersion >= 18) {
      Schema.MIGRATE_17_TO_18.forEach(db::execSQL)
      currentVersion = 18
    }

    if (currentVersion == 18 && newVersion >= 19) {
      Schema.MIGRATE_18_TO_19.forEach(db::execSQL)
      currentVersion = 19
    }

    if (currentVersion != newVersion) {
      throw IllegalStateException("Unsupported SAGIP database migration: $oldVersion -> $newVersion")
    }
  }

  private fun backfillReceiptIdentities(db: SQLiteDatabase) {
    fun tableExists(name: String): Boolean = db.rawQuery(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
      arrayOf(name),
    ).use { cursor -> cursor.moveToFirst() }

    if (tableExists("outbound_envelopes")) {
      db.rawQuery(
        "SELECT envelope_bytes, created_at FROM outbound_envelopes WHERE envelope_bytes IS NOT NULL AND preparation_state='READY'",
        null,
      ).use { cursor ->
        while (cursor.moveToNext()) {
          runCatching {
            ReceiptRepository.persistReportIdentity(db, cursor.getBlob(0), cursor.getLong(1))
          }
        }
      }
    }

    if (tableExists("inbound_envelopes")) {
      db.rawQuery(
        "SELECT envelope_bytes, received_at FROM inbound_envelopes",
        null,
      ).use { cursor ->
        while (cursor.moveToNext()) {
          runCatching {
            ReceiptRepository.persistReportIdentity(db, cursor.getBlob(0), cursor.getLong(1))
          }
        }
      }
    }
  }

  override fun onDowngrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    throw IllegalStateException("SAGIP database downgrade is not supported: $oldVersion -> $newVersion")
  }

  companion object {
    const val DATABASE_NAME = "sagip.db"
  }
}
