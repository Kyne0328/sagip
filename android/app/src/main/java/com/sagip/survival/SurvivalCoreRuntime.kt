package com.sagip.survival

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

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
  private val deliveryScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val deliveryMutex = Mutex()
  @Volatile private var returnDeployment: TrustedReceiptReturnConfig? = null
  @Volatile var receiptReturn: TrustedReceiptReturnService? = null
    private set
  private fun receiptReturnClock(): MonotonicClock {
    val verifier = requireNotNull(returnDeployment).verifierId
    val boot = android.provider.Settings.Global.getInt(appContext.contentResolver,
      android.provider.Settings.Global.BOOT_COUNT, -1)
    check(boot >= 0) { "BOOT_ID_UNAVAILABLE" }
    return MonotonicClock(java.util.UUID.nameUUIDFromBytes(verifier +
      boot.toString().toByteArray(Charsets.US_ASCII)).toString(), android.os.SystemClock.elapsedRealtime())
  }
  val receiptReturnWorker = ReceiptReturnWorker(database, { receiptReturn },
    { returnDeployment?.feed }, ::receiptReturnClock)

  /** Native operator integration only. Reapply approved configuration after restart; no persistent credentials. */
  @Synchronized fun configureReceiptReturn(config: TrustedReceiptReturnConfig) {
    val bound = config.copy(verifierId=config.verifierId.copyOf(),
      roots=config.roots.mapValues { it.value.copyOf() }, scopes=config.scopes.toSet(),
      feed=config.feed?.let { it.copy(reportIds=it.reportIds.toSet()) })
    val service = TrustedReceiptReturnService(database, receiptQueue, bound, ::receiptReturnClock,
      active={ returnDeployment === bound })
    returnDeployment = bound
    receiptReturn = service
  }
  @Synchronized fun disableReceiptReturn() { returnDeployment = null; receiptReturn = null }
  internal fun receiptForwardAllowed(kind: ObjectKind, bytes: ByteArray): Boolean =
    kind == ObjectKind.SOS || receiptReturn?.canForward(kind, bytes) == true
  private fun onDurableRelayReceived() {
    deliveryScope.launch { runCatching { receiptReturn?.retryPending() } }
    triggerImmediateDeliveryIfConnected()
  }
  private val returnSync by lazy {
    StatusSyncDispatcher(deliveryScope) {
      if (hasValidatedInternet()) runCatching { receiptReturnWorker.runOnce() }
    }
  }
  private val statusSync by lazy {
    StatusSyncDispatcher(deliveryScope) {
      VictimStatusWorker(VictimStatusStore(database),
        HttpPrivateReportStatusSender(BackendEndpointConfig.envelopeUrl(), AndroidKeystoreSigningIdentity()),
      ).runOnce()
    }
  }
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
  private fun hasValidatedInternet(): Boolean {
    val connectivity = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
    val network = connectivity.activeNetwork ?: return false
    val capabilities = connectivity.getNetworkCapabilities(network) ?: return false
    return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
      capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
  }

  fun triggerImmediateDeliveryIfConnected() {
    if (!hasValidatedInternet()) return
    deliveryScope.launch {
      runCatching { runDeliveryPass() }
    }
  }

  suspend fun runDeliveryPass(nowMs: Long = System.currentTimeMillis()): Int = deliveryMutex.withLock {
    val sender = HttpEnvelopeSender(BackendEndpointConfig.envelopeUrl())
    val worker = DeliveryWorker(
      repository = repository,
      sender = sender,
      relayStore = repository,
      ackStore = null,
    )
    val preparation = runCatching {
      EnvelopePreparationService(
        repository = repository,
        identity = AndroidKeystoreSigningIdentity(),
      ).preparePending()
    }
    val completed = worker.runOnce(nowMs)
    // Informational history reads must never hold up a newly committed SOS upload.
    statusSync.trigger()
    runGatewaySync(nowMs)
    runCatching { receiptReturn?.retryPending() }
    returnSync.trigger()
    // Do not let a local signing/preparation failure block an already-durable
    // relayed envelope from reaching the server. Scheduled delivery still
    // receives the failure so Android can retry the pending local preparation.
    preparation.getOrThrow()
    completed
  }

  val bleRelay = BleRelayRuntime(
    readinessProvider = { BleRelayReadinessChecker.evaluate(appContext) },
    activityTimestampProvider = { repository.newestActiveRelayTimestamp() },
    central = BleCentralManager(appContext, repository, receiptQueue, canForwardObject = ::receiptForwardAllowed,
      custodyTimeProvider = { receiptReturn?.trustedTime()?.latestMs }),
    // Default-off. Qualified time and explicit trust configuration are required for v2 capability.
    peripheral = BlePeripheralManager(
      appContext,
      repository,
      receiptQueue,
      verificationContextProvider = { receiptReturn?.baseContext() },
      objectContextProvider = { kind, bytes -> receiptReturn?.contextFor(kind, bytes) },
      canForwardObject = ::receiptForwardAllowed,
      onDurableRelayReceived = ::onDurableRelayReceived,
    ),
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
