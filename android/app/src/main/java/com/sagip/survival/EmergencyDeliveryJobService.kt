package com.sagip.survival

import android.app.job.JobParameters
import android.app.job.JobService
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Android framework JobService that executes DeliveryWorker.runOnce()
 * whenever network connectivity is established, even if the app process is terminated.
 * Uses zero third-party dependencies, running purely on Android OS framework capabilities.
 */
class EmergencyDeliveryJobService : JobService() {
  private val supervisor = SupervisorJob()
  private val scope = CoroutineScope(supervisor + Dispatchers.IO)
  private var runningJob: Job? = null

  override fun onStartJob(params: JobParameters?): Boolean {
    runningJob = scope.launch {
      try {
        val repository = SurvivalCoreRuntime.get(applicationContext).repository
        val sender = HttpEnvelopeSender(BackendEndpointConfig.envelopeUrl())
        val worker = DeliveryWorker(
          repository = repository,
          sender = sender,
          relayStore = repository,
          ackStore = repository,
        )
        worker.runOnce()
        jobFinished(params, false)
      } catch (e: CancellationException) {
        throw e
      } catch (_: Exception) {
        jobFinished(params, true) // reschedule if failed
      } finally {
        runningJob = null
      }
    }
    return true // Work is running asynchronously
  }

  override fun onStopJob(params: JobParameters?): Boolean {
    runningJob?.cancel()
    runningJob = null
    return true // Reschedule if cancelled unexpectedly
  }

  override fun onDestroy() {
    scope.cancel()
    super.onDestroy()
  }
}
