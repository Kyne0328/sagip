package com.sagip.survival

import android.content.Context
import android.content.ContextWrapper
import java.io.File
import java.util.UUID

/** Keep fixture migrations/deletion away from the application's background delivery database. */
internal class IsolatedGatewayTestContext(base: Context) : ContextWrapper(base) {
  private val directory = File(base.cacheDir, "gateway-test-${UUID.randomUUID()}")
  override fun getApplicationContext(): Context = this
  override fun getDatabasePath(name: String): File {
    directory.mkdirs()
    return File(directory, name)
  }
  override fun deleteDatabase(name: String): Boolean {
    val deleted = android.database.sqlite.SQLiteDatabase.deleteDatabase(getDatabasePath(name))
    directory.delete() // Only remove an empty fixture directory.
    return deleted
  }
}
