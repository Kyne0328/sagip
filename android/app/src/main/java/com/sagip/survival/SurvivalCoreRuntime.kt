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
  @Volatile private var deployment: GatewayDeploymentConfig? = null
  private var gatewayService: ResponderGatewayService? = null
  @Volatile private var localServer: GatewayLocalServer? = null
  private val gatewayIdentity by lazy { GatewaySigningIdentity() }
  private fun gatewayClock(): MonotonicClock {
    val bootCount = android.provider.Settings.Global.getInt(appContext.contentResolver,
      android.provider.Settings.Global.BOOT_COUNT, -1)
    check(bootCount >= 0) { "BOOT_ID_UNAVAILABLE" }
    return MonotonicClock(java.util.UUID.nameUUIDFromBytes(gatewayIdentity.keyId +
      bootCount.toString().toByteArray(Charsets.US_ASCII)).toString(), android.os.SystemClock.elapsedRealtime())
  }
  val gateway: ResponderGatewayService get() = synchronized(this) {
    gatewayService ?: run {
      val boundDeployment = deployment
      ResponderGatewayService(database, { gatewayIdentity },
        boundDeployment?.roots ?: emptyMap(), boundDeployment?.scopes ?: emptySet(),
        gatewayAccess::isAllowed, ::gatewayClock,
        deploymentQualified = { deployment === boundDeployment && (boundDeployment == null || runCatching(boundDeployment.qualified).getOrDefault(false)) },
      ).also { gatewayService = it }
    }
  }
  private fun gatewayDeploymentQualified() = deployment?.let { runCatching(it.qualified).getOrDefault(false) } == true
  val gatewaySyncWorker = GatewaySyncWorker(database, { deployment?.receiptTransport },
    { gatewayDeploymentQualified() && runCatching { gateway.authorityReady() }.getOrDefault(false) }, ::gatewayClock)

  /** Native operator integration only. No certificates/keys, roles, topology or endpoint are installed by default. */
  @Synchronized fun configureGateway(config: GatewayDeploymentConfig) {
    require(config.roots.isNotEmpty() && config.scopes.isNotEmpty())
    config.roots.forEach { (id,key) ->
      ReceiptV2Codec.validatePublicKey(key)
      require(java.security.MessageDigest.getInstance("SHA-256").digest(key).joinToString("") { "%02x".format(it.toInt() and 255) } == id)
    }
    stopGatewayServer()
    deployment = config.copy(roots=config.roots.mapValues { it.value.copyOf() },scopes=config.scopes.toSet())
    gatewayService = null
  }
  @Synchronized fun resumeGatewayServer(): GatewayStartResult? {
    val config = deployment ?: return null
    val topology = config.localConfig ?: return null
    if(!gatewayDeploymentQualified() || !gatewayAccess.isAllowed() || !gateway.authorityReady()) return null
    val server = localServer ?: GatewayLocalServer(
      GatewayPairingStore(database,topology.allowedOrigin,{ gatewayDeploymentQualified() && gatewayAccess.isAllowed() },
        { if(gatewayDeploymentQualified()) gateway.sessionAuthority() else null },::gatewayClock,{ gateway.hasPendingWork() }),
      GatewayAdmissionStore(database,::gatewayClock),{ if(gatewayDeploymentQualified()) gateway.sessionAuthority() else null },
      GatewayTimeProofIssuer { if(gatewayDeploymentQualified()) gateway.issueTimeProof(it) else TimeProofResult("TIME_UNAVAILABLE",reason="AUTHORITY_UNAVAILABLE") },GatewayActionApi(database,gateway,::gatewayClock),
    ).also { localServer = it }
    return server.start(topology)
  }
  @Synchronized fun stopGatewayServer() { localServer?.stop();localServer=null }
  fun startGatewayPairing(): GatewayPairingCode { check(gatewayAccess.isAllowed());return requireNotNull(localServer) { "GATEWAY_STOPPED" }.startPairing() }
  fun approveGatewayPairing(pairingId: String,browserBinding: String): Boolean {
    check(gatewayAccess.isAllowed());return requireNotNull(localServer) { "GATEWAY_STOPPED" }.approveNative(pairingId,browserBinding)
  }
  fun runGatewaySync(nowMs: Long = System.currentTimeMillis()): SyncBatchResult =
    runCatching { gatewaySyncWorker.runOnce(nowMs) }.getOrElse { SyncBatchResult(retryable=1) }
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

/** Supplied explicitly by native operator integration; qualified covers deployment clock/trust policy. */
data class GatewayDeploymentConfig(val roots: Map<String,ByteArray>,val scopes: Set<String>,
  val qualified: () -> Boolean,val localConfig: GatewayLocalConfig? = null,
  val receiptTransport: GatewayReceiptTransport? = null)
