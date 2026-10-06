package com.sagip.survival

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
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
  val locationProvider = LocationSnapshotProvider(appContext)
  val receiptQueue = ReceiptQueue(database)
  private val deliveryScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val deliveryMutex = Mutex()
  private val locationDelivery = LocationDeliveryDispatcher(
    deliveryScope, { callback -> locationProvider.primeBestEffortLocation(callback) },
  ) { runDeliveryPass() }

  fun primeLocation(): Boolean = locationDelivery.primeLocation()
  @Volatile private var returnDeployment: TrustedReceiptReturnConfig? = null
  @Volatile var receiptReturn: TrustedReceiptReturnService? = null
    private set
  private fun receiptReturnClock(): MonotonicClock = returnClockFor(requireNotNull(returnDeployment).verifierId)
  private fun returnClockFor(verifier: ByteArray): MonotonicClock {
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

  /** Only signed-APK public trust data can activate this bootstrap; absent assets leave it off. */
  @Synchronized private fun installPackagedReceiptReturn() {
    if(returnDeployment != null) return
    val manifest=OfflineRootDeploymentManifest.load(appContext) ?: return
    // A release manifest cannot expand the recipient of existing report identifiers.
    val backend=java.net.URI(BackendEndpointConfig.envelopeUrl())
    val destination=java.net.URI(manifest.endpoint)
    require(backend.scheme=="https" && backend.host!=null && backend.rawUserInfo==null &&
      backend.rawQuery==null && backend.rawFragment==null)
    fun port(uri:java.net.URI)=if(uri.port<0)443 else uri.port
    require(destination.scheme=="https" && destination.host.equals(backend.host,ignoreCase=true) &&
      port(destination)==port(backend) && destination.rawUserInfo==null &&
      destination.rawQuery==null && destination.rawFragment==null)
    val identity=AndroidKeystoreSigningIdentity()
    fun clockProfile()=manifest.clockQualification(android.os.Build.FINGERPRINT,android.os.Build.VERSION.SDK_INT,
      returnClockFor(identity.keyId).bootId)
    if(runCatching { clockProfile() }.getOrNull()==null) return
    val inventory=CustodyReceiptInventory(database)
    val transport=HttpCustodyReceiptReturnTransport(manifest.endpoint,inventory::envelope,inventory::reports,
      identity,{returnClockFor(identity.keyId)})
    val feed=ReceiptReturnFeedConfig("neon-custody-"+OfflineRootSnapshotCodec.digest(
      manifest.endpoint.toByteArray(Charsets.UTF_8)).take(16),emptySet(),transport,transport,inventory::reports)
    val config=TrustedReceiptReturnConfig(identity.keyId,manifest.rootPins,manifest.policy.allowedScopes.toSet(),
      qualified={ runCatching { clockProfile()!=null }.getOrDefault(false) },
      offlineRoot=OfflineRootConfig(manifest.policy,manifest.checkpointSignerPins,::clockProfile),
      timeTransport=transport,feed=feed,maximumClockDriftPpm=clockProfile()!!.maximumDriftPpm.coerceAtLeast(100))
    configureReceiptReturn(config)
    val owner=receiptReturn ?: return
    if(!owner.ensureOfflineRootDomain(manifest.initialEpoch,manifest.initialAuthorityStateDigest)) {
      disableReceiptReturn()
      return
    }
    owner.retryPending()
    returnSync.trigger()
  }
  internal fun receiptForwardAllowed(kind: ObjectKind, bytes: ByteArray): Boolean =
    kind == ObjectKind.SOS || receiptReturn?.canForward(kind, bytes) == true
  private fun onDurableRelayReceived() {
    deliveryScope.launch { runCatching { receiptReturn?.retryPending() } }
    triggerImmediateDeliveryIfConnected()
  }
  private val returnSync by lazy {
    StatusSyncDispatcher(deliveryScope) {
      if (hasValidatedInternet()) {
        runCatching { receiptReturn?.refreshTime() }
        runCatching { receiptReturnWorker.runOnce() }
      }
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
    // A current fix may arrive after the one-tap SOS commit. Persist it as a new
    // immutable revision before preparation; location must never gate the first save.
    val locationUpdated = runCatching {
      attachLocationForDelivery(nowMs, locationProvider::getBestAvailableLocation,
        repository::attachLocationToActiveReportIfBetter)
    }.getOrDefault(false)
    if (locationUpdated) {
      runCatching { bleRelay.expediteForNewActivity() }
    }
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
      extensionActiveProvider = { receiptReturn?.feedActive() == true },
      admitObject = { kind, bytes -> receiptReturn?.admit(kind, bytes)
        ?: CustodyResult(CustodyResultKind.PENDING_VERIFICATION, reason = "RECEIPT_EXTENSION_DISABLED") },
      canForwardObject = ::receiptForwardAllowed,
      onDurableRelayReceived = ::onDurableRelayReceived,
    ),
  )

  init {
    // Trust/bootstrap failure cannot block local SOS creation or the normal upload worker.
    deliveryScope.launch { runCatching { installPackagedReceiptReturn() } }
    deliveryScope.launch {
      while(true) {
        delay(30_000L)
        // Existing lifetime is process-wide. Offline idle polling sends no requests.
        if(receiptReturn!=null && hasValidatedInternet()) returnSync.trigger()
      }
    }
  }

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
