package com.sagip.survival

import net.zetetic.database.sqlcipher.SQLiteDatabase

/** Shared by admission and session policy, inside the caller's SQLite transaction. */
internal object GatewayPolicyClock {
  fun read(db: SQLiteDatabase, now: MonotonicClock): MonotonicClock? {
    if (now.bootId.isEmpty() || now.elapsedMs < 0) return null
    val previous = db.rawQuery("SELECT boot_id,high_water_elapsed_ms FROM gateway_pairing_clock WHERE singleton=1", null).use {
      if (it.moveToFirst()) it.getString(0) to it.getLong(1) else null
    }
    if (previous != null && previous.first == now.bootId && now.elapsedMs < previous.second) return null
    db.execSQL("INSERT OR REPLACE INTO gateway_pairing_clock(singleton,boot_id,high_water_elapsed_ms) VALUES(1,?,?)", arrayOf(now.bootId, now.elapsedMs))
    return now
  }
}
