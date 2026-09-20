package com.sagip.survival

import android.app.job.JobInfo
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context

/**
 * Schedules background delivery synchronization with Android OS JobScheduler.
 * Ensures emergency delivery worker runs whenever network connectivity is regained.
 */
object EmergencyJobScheduler {
  const val EMERGENCY_SYNC_JOB_ID = 54420

  fun scheduleNetworkSync(context: Context): Int {
    val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler ?: return JobScheduler.RESULT_FAILURE
    val component = ComponentName(context, EmergencyDeliveryJobService::class.java)

    val jobInfo = JobInfo.Builder(EMERGENCY_SYNC_JOB_ID, component)
      .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
      .setPersisted(true) // Survives device reboot
      .setPeriodic(15 * 60 * 1000L) // Minimum periodic interval (15 mins)
      .build()

    return scheduler.schedule(jobInfo)
  }

  fun cancel(context: Context) {
    val scheduler = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as? JobScheduler
    scheduler?.cancel(EMERGENCY_SYNC_JOB_ID)
  }
}
