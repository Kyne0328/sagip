package com.sagip.survival

import android.app.job.JobParameters
import android.app.job.JobService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Android framework JobService that executes DeliveryWorker.runOnce()
 * whenever network connectivity is established, even if the app process is terminated.
 * Uses zero third-party dependencies, running purely on Android OS framework capabilities.
 */
class EmergencyDeliveryJobService : JobService() {
  private val scope = CoroutineScope(Dispatchers.IO)

  override fun onStartJob(params: JobParameters?): Boolean {
    scope.launch {
      try {
        val database = SagipDatabase(applicationContext)
        val repository = EmergencyRepository(database)
        val sender = HttpEnvelopeSender(database = database)
        val worker = DeliveryWorker(
          repository = repository,
          sender = sender,
          relayStore = repository,
          ackStore = repository,
        )
        worker.runOnce()
        jobFinished(params, false)
      } catch (_: Exception) {
        jobFinished(params, true) // reschedule if failed
      }
    }
    return true // Work is running asynchronously
  }

  override fun onStopJob(params: JobParameters?): Boolean {
    scope.cancel()
    return true // Reschedule if cancelled unexpectedly
  }
}
