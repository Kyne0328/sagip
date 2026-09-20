package com.sagip.survival

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

class SagipDatabase(context: Context) :
  SQLiteOpenHelper(context, DATABASE_NAME, null, Schema.VERSION) {

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

    if (currentVersion != newVersion) {
      throw IllegalStateException("Unsupported SAGIP database migration: $oldVersion -> $newVersion")
    }
  }

  override fun onDowngrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    throw IllegalStateException("SAGIP database downgrade is not supported: $oldVersion -> $newVersion")
  }

  companion object {
    const val DATABASE_NAME = "sagip.db"
  }
}
