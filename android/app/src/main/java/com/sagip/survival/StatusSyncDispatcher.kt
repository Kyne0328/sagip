package com.sagip.survival

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex

/** Single-flight status reads run independently of the emergency delivery lock. */
internal class StatusSyncDispatcher(
  private val scope: CoroutineScope,
  private val sync: suspend () -> Unit,
) {
  private val mutex = Mutex()
  fun trigger(): Boolean {
    if (!mutex.tryLock()) return false
    scope.launch {
      try { sync() } catch (_: Exception) {
        // Individual attempts persist their own failure; future network/job triggers retry.
      } finally { mutex.unlock() }
    }
    return true
  }
}
