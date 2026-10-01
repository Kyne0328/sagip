package com.sagip.survival

import android.content.Context

/**
 * Process-level Survival Core dependencies.
 *
 * Keeping one repository and one BLE runtime per process prevents duplicate
 * scanners/GATT servers when React Native, JobService, and foreground-service
 * lifecycles overlap.
 */
class SurvivalCoreRuntime private constructor(context: Context) {
  private val appContext = context.applicationContext

  val database = SagipDatabase(appContext)
  val repository = EmergencyRepository(database)
  val receiptQueue = ReceiptQueue(database)
  val gatewayAccess = GatewayDeviceAccess(appContext)
  private val gatewayIdentity by lazy { GatewaySigningIdentity() }
  val gateway by lazy {
    ResponderGatewayService(database, { gatewayIdentity }, emptyMap(), emptySet(),
      gatewayAccess::isAllowed, {
        val bootCount = android.provider.Settings.Global.getInt(appContext.contentResolver,
          android.provider.Settings.Global.BOOT_COUNT, -1)
        check(bootCount >= 0) { "BOOT_ID_UNAVAILABLE" }
        MonotonicClock(java.util.UUID.nameUUIDFromBytes(gatewayIdentity.keyId +
          bootCount.toString().toByteArray(Charsets.US_ASCII)).toString(), android.os.SystemClock.elapsedRealtime())
      })
    // No pilot authority is selected automatically. Operator-pinned roots/scopes must be wired
    // before verified production issuance; test constructors supply only isolated test roots.
  }
  val bleRelay = BleRelayRuntime(
    readinessProvider = { BleRelayReadinessChecker.evaluate(appContext) },
    activityTimestampProvider = { repository.newestActiveRelayTimestamp() },
    central = BleCentralManager(appContext, repository, receiptQueue),
    // Receipt-v2 receive capability stays absent until a qualified runtime VerificationContext provider is wired.
    // Legacy SOS/SGA1 characteristics remain unchanged in that state.
    peripheral = BlePeripheralManager(appContext, repository, receiptQueue),
  )

  companion object {
    @Volatile
    private var instance: SurvivalCoreRuntime? = null

    fun get(context: Context): SurvivalCoreRuntime {
      return instance ?: synchronized(this) {
        instance ?: SurvivalCoreRuntime(context).also { instance = it }
      }
    }
  }
}
