package com.sagip.survival

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.ParcelUuid
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class BleCentralManager(
  private val context: Context,
  private val repository: EmergencyRepository,
  private val receiptQueue: ReceiptQueue? = null,
  private val nowProvider: () -> Long = { System.currentTimeMillis() },
) : BleCentralController {
  private data class ActiveBleTransfer(
    val work: OutboundEnvelopeWork,
    val attemptId: String,
  )

  private enum class ExtensionState {
    NONE,
    READING_CAPABILITY,
    WRITING_INVENTORY_REQUEST,
    READING_INVENTORY,
    WRITING_OFFER,
    READING_DECISION,
    SENDING_CHUNKS,
    READING_CUSTODY,
  }

  private val bluetoothManager: BluetoothManager? =
    context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
  private val bluetoothAdapter: BluetoothAdapter? = bluetoothManager?.adapter
  private var scanner: BluetoothLeScanner? = null
  private var currentScanMode: Int? = null

  private val isScanning = AtomicBoolean(false)
  private val discoveredPeers = ConcurrentHashMap<String, BluetoothDevice>()
  private val activeTransfers = ConcurrentHashMap<String, ActiveBleTransfer>()
  private val activeGatts = ConcurrentHashMap<String, BluetoothGatt>()
  private val connectionTimeouts = ConcurrentHashMap<String, ScheduledFuture<*>>()
  private val activeConnections = ConcurrentHashMap.newKeySet<String>()
  private val lastAttemptAt = ConcurrentHashMap<String, Long>()
  private val timeoutExecutor = Executors.newSingleThreadScheduledExecutor { runnable ->
    Thread(runnable, "sagip-ble-timeout").apply { isDaemon = true }
  }

  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult?) {
      val device = result?.device ?: return
      discoveredPeers[device.address] = device
      val now = System.currentTimeMillis()
      val previousAttemptAt = lastAttemptAt[device.address]
      if (previousAttemptAt != null && now - previousAttemptAt < BleRelayLatencyPolicy.PEER_RETRY_INTERVAL_MS) return
      if (activeConnections.size >= BleRelayLatencyPolicy.MAX_ACTIVE_OUTGOING_CONNECTIONS) return
      if (!activeConnections.add(device.address)) return

      lastAttemptAt[device.address] = now
      attemptRelayToPeer(device, now)
    }

    override fun onScanFailed(errorCode: Int) {
      isScanning.set(false)
      scanner = null
      currentScanMode = null
    }
  }

  @Synchronized
  override fun startScanning(scanMode: Int) {
    if (!BleRelayReadinessChecker.evaluate(context).canRun) return
    val adapter = bluetoothAdapter ?: return
    val availableScanner = try {
      adapter.bluetoothLeScanner
    } catch (_: SecurityException) {
      null
    } ?: return
    if (isScanning.get() && currentScanMode == scanMode) return
    if (isScanning.get()) {
      pauseScanning()
    }

    scanner = availableScanner
    val filter = ScanFilter.Builder()
      .setServiceUuid(ParcelUuid(BleProtocolConstants.SERVICE_UUID))
      .build()
    val settings = ScanSettings.Builder()
      .setScanMode(scanMode)
      .build()

    try {
      isScanning.set(true)
      currentScanMode = scanMode
      availableScanner.startScan(listOf(filter), settings, scanCallback)
    } catch (_: SecurityException) {
      isScanning.set(false)
      scanner = null
      currentScanMode = null
    } catch (_: IllegalStateException) {
      isScanning.set(false)
      scanner = null
      currentScanMode = null
    }
  }

  @Synchronized
  override fun pauseScanning() {
    val wasScanning = isScanning.getAndSet(false)
    if (wasScanning) {
      try {
        scanner?.stopScan(scanCallback)
      } catch (_: SecurityException) {
      }
    }
    scanner = null
    currentScanMode = null
  }

  @Synchronized
  override fun stopScanning() {
    pauseScanning()
    activeGatts.values.forEach { gatt ->
      runCatching { gatt.disconnect() }
      runCatching { gatt.close() }
    }
    connectionTimeouts.values.forEach { it.cancel(false) }
    connectionTimeouts.clear()
    activeGatts.clear()
    discoveredPeers.clear()
    activeConnections.clear()
    lastAttemptAt.clear()
    activeTransfers.clear()
  }

  override fun isScanning(): Boolean = isScanning.get()
  override fun getDiscoveredPeerCount(): Int = discoveredPeers.size

  private fun attemptRelayToPeer(device: BluetoothDevice, now: Long) {
    val targetWork = repository.listDueOutbound(now, limit = 1).firstOrNull()
    val transfer = targetWork?.let { work ->
      runCatching {
        ActiveBleTransfer(
          work = work,
          attemptId = repository.recordAttemptStarted(
            messageId = work.messageId,
            transport = "BLE",
            peerIdentifier = device.address,
            now = now,
          ),
        )
      }.getOrNull()
    }
    val hasReturnAck = repository.findLatestResponderAck() != null
    val hasTypedRelayWork = runCatching { receiptQueue?.inventory(null, 1)?.entries?.isNotEmpty() == true }.getOrDefault(false)
    if (transfer == null && !hasReturnAck && !hasTypedRelayWork) {
      activeConnections.remove(device.address)
      return
    }
    if (transfer != null) {
      activeTransfers[device.address] = transfer
    }

    try {
      val gatt = device.connectGatt(context, false, createGattCallback(transfer))
      if (gatt == null) {
        completeAttempt(transfer, "RETRYABLE_FAILURE", "BLE_CONNECT_START_FAILED")
        activeConnections.remove(device.address)
      } else {
        activeGatts[device.address] = gatt
        scheduleConnectionTimeout(
          device.address,
          gatt,
          transfer,
          "BLE_CONNECT_TIMEOUT",
          BleRelayLatencyPolicy.CONNECT_TIMEOUT_MS,
        )
      }
    } catch (_: SecurityException) {
      completeAttempt(transfer, "RETRYABLE_FAILURE", "BLE_PERMISSION_LOST")
      activeConnections.remove(device.address)
    }
  }

  private fun createGattCallback(transfer: ActiveBleTransfer?) = object : BluetoothGattCallback() {
    private val work = transfer?.work
    private var attemptCompleted = false
    private var negotiatedAttMtu = 23
    private var negotiatedPayload = 20
    private var offerChar: BluetoothGattCharacteristic? = null
    private var chunkChar: BluetoothGattCharacteristic? = null
    private var ackChar: BluetoothGattCharacteristic? = null
    private var returnAckChar: BluetoothGattCharacteristic? = null
    private var extensionCapabilityChar: BluetoothGattCharacteristic? = null
    private var extensionControlChar: BluetoothGattCharacteristic? = null
    private var extensionChunkChar: BluetoothGattCharacteristic? = null
    private var extensionCustodyChar: BluetoothGattCharacteristic? = null
    private var extensionState = ExtensionState.NONE
    private var primaryTransferFinished = false
    private val serviceDiscoveryStarted = AtomicBoolean(false)
    private var mtuFallback: ScheduledFuture<*>? = null
    private var fastTypedOffer = false
    private val peerInventory = mutableListOf<InventoryEntry>()
    private var peerInventorySnapshotId: String? = null
    private var expectedPeerInventoryPage = 0
    private var peerInventoryTotalCount: Int? = null
    private var typedLeases = listOf<TransferLease>()
    private var typedLeaseIndex = 0
    private var typedChunks = listOf<ByteArray>()
    private var typedChunkIndex = 0
    private var chunksToSend = listOf<ByteArray>()
    private var chunkIndex = 0

    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      if (status != BluetoothGatt.GATT_SUCCESS) {
        if (!attemptCompleted && transfer != null) {
          completeAttempt(transfer, "RETRYABLE_FAILURE", "BLE_GATT_$status")
          attemptCompleted = true
        }
        cleanupConnection(gatt)
        return
      }
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        runCatching { gatt.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH) }
        scheduleConnectionTimeout(
          gatt.device.address,
          gatt,
          transfer,
          "BLE_SERVICE_SETUP_TIMEOUT",
          BleRelayLatencyPolicy.SERVICE_SETUP_TIMEOUT_MS,
        )
        val mtuRequested = try {
          gatt.requestMtu(512)
        } catch (_: SecurityException) {
          false
        }
        if (mtuRequested) {
          mtuFallback?.cancel(false)
          mtuFallback = timeoutExecutor.schedule(
            { discoverServicesOrDisconnect(gatt) },
            BleRelayLatencyPolicy.MTU_FALLBACK_MS,
            TimeUnit.MILLISECONDS,
          )
        } else {
          discoverServicesOrDisconnect(gatt)
        }
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        mtuFallback?.cancel(false)
        if (!attemptCompleted && transfer != null) {
          completeAttempt(transfer, "RETRYABLE_FAILURE", "BLE_DISCONNECTED")
          attemptCompleted = true
        }
        cleanupConnection(gatt)
      }
    }

    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      mtuFallback?.cancel(false)
      mtuFallback = null
      if (status == BluetoothGatt.GATT_SUCCESS) {
        negotiatedAttMtu = maxOf(23, mtu)
        negotiatedPayload = maxOf(20, mtu - 3)
      }
      discoverServicesOrDisconnect(gatt)
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      if (status != BluetoothGatt.GATT_SUCCESS) {
        gatt.disconnect()
        return
      }

      val service = gatt.getService(BleProtocolConstants.SERVICE_UUID) ?: run {
        gatt.disconnect()
        return
      }

      offerChar = service.getCharacteristic(BleProtocolConstants.CHARACTERISTIC_OFFER_UUID)
      chunkChar = service.getCharacteristic(BleProtocolConstants.CHARACTERISTIC_CHUNK_UUID)
      ackChar = service.getCharacteristic(BleProtocolConstants.CHARACTERISTIC_ACK_UUID)
      returnAckChar = service.getCharacteristic(BleProtocolConstants.CHARACTERISTIC_RETURN_ACK_UUID)
      extensionCapabilityChar = service.getCharacteristic(BleProtocolConstants.CHARACTERISTIC_EXTENSION_CAPABILITY_UUID)
      extensionControlChar = service.getCharacteristic(BleProtocolConstants.CHARACTERISTIC_EXTENSION_CONTROL_UUID)
      extensionChunkChar = service.getCharacteristic(BleProtocolConstants.CHARACTERISTIC_EXTENSION_CHUNK_UUID)
      extensionCustodyChar = service.getCharacteristic(BleProtocolConstants.CHARACTERISTIC_EXTENSION_CUSTODY_UUID)

      if (returnAckChar == null || (work != null && (offerChar == null || chunkChar == null || ackChar == null))) {
        gatt.disconnect()
        return
      }

      scheduleTransferProgressTimeout(gatt)
      if (work != null) {
        // Fresh SOS propagation owns the critical path. Return acknowledgements
        // and receipt-v2 inventory can use the same connection after custody.
        continueLegacyAfterReturnAck(gatt)
      } else {
        readPeerReturnAckOrContinue(gatt)
      }
    }

    private fun tryStartReceiptExtension(gatt: BluetoothGatt): Boolean {
      val queue = receiptQueue ?: return false
      val capability = extensionCapabilityChar ?: return false
      if (extensionControlChar == null || extensionChunkChar == null || extensionCustodyChar == null) return false
      if (negotiatedAttMtu < BleReceiptExchangeCodec.MIN_EXTENSION_MTU) return false
      val hasWork = runCatching { queue.inventory(null, 1).entries.isNotEmpty() }.getOrDefault(false)
      if (!hasWork) return false
      fastTypedOffer = false
      extensionState = ExtensionState.READING_CAPABILITY
      return try {
        gatt.readCharacteristic(capability).also { started -> if (!started) extensionState = ExtensionState.NONE }
      } catch (_: SecurityException) {
        extensionState = ExtensionState.NONE
        false
      }
    }

    private fun requestPeerInventory(gatt: BluetoothGatt, snapshotId: String?, pageIndex: Int): Boolean {
      val control = extensionControlChar ?: return false
      control.value = BleReceiptExchangeCodec.encodeInventoryRequest(BleInventoryRequest(snapshotId, pageIndex))
      extensionState = ExtensionState.WRITING_INVENTORY_REQUEST
      return try {
        gatt.writeCharacteristic(control)
      } catch (_: SecurityException) {
        false
      }
    }

    private fun handlePeerInventoryPage(gatt: BluetoothGatt, bytes: ByteArray) {
      val page = try {
        BleReceiptExchangeCodec.decodeInventory(bytes)
      } catch (_: Exception) {
        extensionState = ExtensionState.NONE
        continueLegacyAfterReturnAck(gatt)
        return
      }
      val snapshot = page.snapshotId ?: run {
        extensionState = ExtensionState.NONE
        continueLegacyAfterReturnAck(gatt)
        return
      }
      if (page.pageIndex != expectedPeerInventoryPage ||
        (peerInventorySnapshotId != null && peerInventorySnapshotId != snapshot) ||
        (peerInventoryTotalCount != null && peerInventoryTotalCount != page.totalCount) ||
        peerInventory.any { existing -> page.entries.any { it.objectKind == existing.objectKind && it.objectId == existing.objectId } }
      ) {
        gatt.disconnect()
        return
      }
      peerInventorySnapshotId = snapshot
      peerInventoryTotalCount = page.totalCount
      peerInventory += page.entries
      if (peerInventory.size > BleReceiptExchangeCodec.MAX_INVENTORY_ENTRIES || peerInventory.size > page.totalCount) {
        gatt.disconnect()
        return
      }
      val nextPage = page.nextPage
      if (nextPage != null) {
        expectedPeerInventoryPage = nextPage
        if (!requestPeerInventory(gatt, snapshot, nextPage)) gatt.disconnect()
        return
      }
      if (peerInventory.size != page.totalCount) {
        gatt.disconnect()
        return
      }
      prepareTypedLeases(gatt)
    }

    private fun prepareTypedLeases(gatt: BluetoothGatt) {
      val queue = receiptQueue ?: run {
        extensionState = ExtensionState.NONE
        continueLegacyAfterReturnAck(gatt)
        return
      }
      val now = nowProvider()
      val leased = try {
        queue.leaseContactWork(
          gatt.device.address,
          now,
          if (fastTypedOffer) BleRelayLatencyPolicy.DIRECT_TYPED_OFFER_THRESHOLD else BleReceiptExchangeCodec.MAX_CONTACT_TRANSFERS,
        )
      } catch (_: Exception) {
        gatt.disconnect()
        return
      }
      val remote = peerInventory.associateBy { it.objectKind to it.objectId }
      val remaining = mutableListOf<TransferLease>()
      for (lease in leased) {
        val held = remote[lease.objectKind to lease.objectId]
        if (held != null && MessageDigest.isEqual(held.digest, lease.digest)) {
          runCatching { queue.releaseTransferLease(lease.leaseId, nowProvider()) }
        } else {
          remaining += lease
        }
      }
      typedLeases = remaining
      typedLeaseIndex = 0
      if (typedLeases.isEmpty()) {
        extensionState = ExtensionState.NONE
        continueLegacyAfterReturnAck(gatt)
        return
      }
      sendTypedOffer(gatt)
    }

    private fun sendTypedOffer(gatt: BluetoothGatt) {
      val queue = receiptQueue ?: run { gatt.disconnect(); return }
      val lease = typedLeases.getOrNull(typedLeaseIndex) ?: run {
        extensionState = ExtensionState.NONE
        continueLegacyAfterReturnAck(gatt)
        return
      }
      val entry = try {
        queue.inventoryEntry(lease.objectId, lease.digest)
      } catch (_: Exception) {
        releaseTypedLease(lease)
        gatt.disconnect()
        return
      } ?: run {
        releaseTypedLease(lease)
        typedLeaseIndex++
        sendTypedOffer(gatt)
        return
      }
      val control = extensionControlChar ?: run { gatt.disconnect(); return }
      val contactClaimed = try {
        queue.claimContactTransfer(gatt.device.address, nowProvider())
      } catch (_: Exception) {
        gatt.disconnect()
        return
      }
      if (!contactClaimed) {
        releaseRemainingTypedLeases()
        extensionState = ExtensionState.NONE
        continueLegacyAfterReturnAck(gatt)
        return
      }
      control.value = try {
        BleReceiptExchangeCodec.encodeOffer(entry, lease.bytes.size)
      } catch (_: Exception) {
        releaseTypedLease(lease)
        typedLeaseIndex++
        sendTypedOffer(gatt)
        return
      }
      extensionState = ExtensionState.WRITING_OFFER
      try {
        if (!gatt.writeCharacteristic(control)) gatt.disconnect()
      } catch (_: SecurityException) {
        gatt.disconnect()
      }
    }

    private fun handleTypedDecision(gatt: BluetoothGatt, bytes: ByteArray) {
      val lease = typedLeases.getOrNull(typedLeaseIndex) ?: run { gatt.disconnect(); return }
      val decision = try {
        BleReceiptExchangeCodec.decodeDecision(bytes)
      } catch (_: Exception) {
        gatt.disconnect()
        return
      }
      if (decision.objectId != lease.objectId || !MessageDigest.isEqual(decision.digest, lease.digest)) {
        gatt.disconnect()
        return
      }
      when (decision.decision) {
        BleDecisionCode.ACCEPT_TRANSFER -> {
          val payload = minOf(
            BleReceiptExchangeCodec.MAX_CHUNK_DATA,
            negotiatedPayload - BleReceiptExchangeCodec.CHUNK_OVERHEAD,
          )
          if (payload < 16) {
            gatt.disconnect()
            return
          }
          typedChunks = try {
            BleReceiptExchangeCodec.encodeObjectChunks(lease.bytes, payload)
          } catch (_: Exception) {
            releaseTypedLease(lease)
            advanceTypedLease(gatt)
            return
          }
          typedChunkIndex = 0
          extensionState = ExtensionState.SENDING_CHUNKS
          sendTypedNextChunk(gatt)
        }
        BleDecisionCode.ALREADY_HAVE_VERIFIED -> {
          finishTypedLease(lease, TransferOutcome.ALREADY_HAVE_VERIFIED)
          advanceTypedLease(gatt)
        }
        BleDecisionCode.CAPACITY_FULL -> {
          finishTypedLease(lease, TransferOutcome.RETRYABLE)
          advanceTypedLease(gatt)
        }
        BleDecisionCode.UNVERIFIED_AUTHORITY -> {
          finishTypedLease(lease, TransferOutcome.PENDING_VERIFICATION)
          advanceTypedLease(gatt)
        }
        BleDecisionCode.UNSUPPORTED,
        BleDecisionCode.EXPIRED,
        BleDecisionCode.REJECTED -> {
          finishTypedLease(lease, TransferOutcome.PERMANENT_REJECTION)
          advanceTypedLease(gatt)
        }
      }
    }

    private fun sendTypedNextChunk(gatt: BluetoothGatt) {
      val characteristic = extensionChunkChar ?: run { gatt.disconnect(); return }
      val bytes = typedChunks.getOrNull(typedChunkIndex) ?: run { readTypedCustody(gatt); return }
      characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
      characteristic.value = bytes
      scheduleTransferProgressTimeout(gatt)
      try {
        if (!gatt.writeCharacteristic(characteristic)) gatt.disconnect()
      } catch (_: SecurityException) {
        gatt.disconnect()
      }
    }

    private fun readTypedCustody(gatt: BluetoothGatt) {
      val custody = extensionCustodyChar ?: run { gatt.disconnect(); return }
      extensionState = ExtensionState.READING_CUSTODY
      try {
        if (!gatt.readCharacteristic(custody)) gatt.disconnect()
      } catch (_: SecurityException) {
        gatt.disconnect()
      }
    }

    private fun handleTypedCustody(gatt: BluetoothGatt, bytes: ByteArray) {
      val lease = typedLeases.getOrNull(typedLeaseIndex) ?: run { gatt.disconnect(); return }
      val custody = try {
        BleReceiptExchangeCodec.decodeCustody(bytes)
      } catch (_: Exception) {
        gatt.disconnect()
        return
      }
      if (custody.objectId != lease.objectId || !MessageDigest.isEqual(custody.digest, lease.digest)) {
        gatt.disconnect()
        return
      }
      when (custody.result) {
        BleCustodyCode.ACCEPTED_DURABLE -> finishTypedLease(lease, TransferOutcome.PEER_CUSTODY)
        BleCustodyCode.DUPLICATE_VERIFIED -> finishTypedLease(lease, TransferOutcome.ALREADY_HAVE_VERIFIED)
        BleCustodyCode.CAPACITY_FULL -> finishTypedLease(lease, TransferOutcome.RETRYABLE)
        BleCustodyCode.UNVERIFIED_AUTHORITY -> finishTypedLease(lease, TransferOutcome.PENDING_VERIFICATION)
        BleCustodyCode.EXPIRED,
        BleCustodyCode.REJECTED -> finishTypedLease(lease, TransferOutcome.PERMANENT_REJECTION)
      }
      advanceTypedLease(gatt)
    }

    private fun releaseTypedLease(lease: TransferLease) {
      runCatching { receiptQueue?.releaseTransferLease(lease.leaseId, nowProvider()) }
    }

    private fun releaseRemainingTypedLeases() {
      typedLeases.drop(typedLeaseIndex).forEach(::releaseTypedLease)
      typedLeaseIndex = typedLeases.size
      typedChunks = emptyList()
      typedChunkIndex = 0
    }

    private fun finishTypedLease(lease: TransferLease, outcome: TransferOutcome) {
      runCatching { receiptQueue?.finishTransfer(lease.leaseId, outcome, nowProvider()) }
    }

    private fun advanceTypedLease(gatt: BluetoothGatt) {
      typedLeaseIndex++
      typedChunks = emptyList()
      typedChunkIndex = 0
      if (typedLeaseIndex < typedLeases.size) sendTypedOffer(gatt)
      else {
        extensionState = ExtensionState.NONE
        continueLegacyAfterReturnAck(gatt)
      }
    }

    private fun continueAfterReturnAck(gatt: BluetoothGatt) {
      if (tryStartReceiptExtension(gatt)) return
      continueLegacyAfterReturnAck(gatt)
    }

    private fun continueLegacyAfterReturnAck(gatt: BluetoothGatt) {
      if (primaryTransferFinished) {
        readPeerReturnAckOrContinue(gatt)
        return
      }
      if (work == null) {
        syncReturnAckAndFinish(gatt)
        return
      }

      try {
        if (!gatt.setCharacteristicNotification(ackChar, true)) {
          gatt.disconnect()
          return
        }
        val desc = ackChar?.getDescriptor(BleProtocolConstants.CLIENT_CONFIG_DESCRIPTOR_UUID)
        if (desc != null) {
          desc.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
          if (!gatt.writeDescriptor(desc)) gatt.disconnect()
        } else {
          sendOffer(gatt)
        }
      } catch (_: SecurityException) {
        gatt.disconnect()
      }
    }

    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      if (status == BluetoothGatt.GATT_SUCCESS) {
        scheduleTransferProgressTimeout(gatt)
        sendOffer(gatt)
      } else {
        gatt.disconnect()
      }
    }

    private fun sendOffer(gatt: BluetoothGatt) {
      val currentWork = work ?: run {
        syncReturnAckAndFinish(gatt)
        return
      }
      val decoded = try {
        TransportEnvelope.decodeAndVerify(currentWork.envelopeBytes)
      } catch (_: Exception) {
        gatt.disconnect()
        return
      }

      val offerBytes = BleProtocolConstants.encodeOffer(UUID.fromString(decoded.messageId), decoded.payloadDigest)
      offerChar?.value = offerBytes
      try {
        if (!gatt.writeCharacteristic(offerChar)) gatt.disconnect()
      } catch (_: SecurityException) {
        gatt.disconnect()
      }
    }

    override fun onCharacteristicWrite(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int,
    ) {
      if (status != BluetoothGatt.GATT_SUCCESS) {
        gatt.disconnect()
        return
      }
      scheduleTransferProgressTimeout(gatt)

      if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_EXTENSION_CONTROL_UUID) {
        when (extensionState) {
          ExtensionState.WRITING_INVENTORY_REQUEST -> {
            extensionState = ExtensionState.READING_INVENTORY
            try {
              if (!gatt.readCharacteristic(extensionControlChar)) gatt.disconnect()
            } catch (_: SecurityException) {
              gatt.disconnect()
            }
          }
          ExtensionState.WRITING_OFFER -> {
            extensionState = ExtensionState.READING_DECISION
            try {
              if (!gatt.readCharacteristic(extensionControlChar)) gatt.disconnect()
            } catch (_: SecurityException) {
              gatt.disconnect()
            }
          }
          else -> gatt.disconnect()
        }
        return
      }
      if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_EXTENSION_CHUNK_UUID) {
        if (extensionState != ExtensionState.SENDING_CHUNKS) {
          gatt.disconnect()
          return
        }
        typedChunkIndex++
        if (typedChunkIndex < typedChunks.size) sendTypedNextChunk(gatt) else readTypedCustody(gatt)
        return
      }

      if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_OFFER_UUID) {
        // Read offer decision
        try {
          gatt.readCharacteristic(offerChar)
        } catch (_: SecurityException) {
          gatt.disconnect()
        }
      } else if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_CHUNK_UUID) {
        chunkIndex++
        if (chunkIndex < chunksToSend.size) {
          sendNextChunk(gatt)
        } else {
          // Notifications are best-effort across OEM BLE stacks. The peer also
          // exposes its durable custody receipt as a readable characteristic,
          // so read it back after the final chunk as a deterministic fallback.
          readDurableAck(gatt)
        }
      } else if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_RETURN_ACK_UUID) {
        // Return ACK write completed
        gatt.disconnect()
      }
    }

    override fun onCharacteristicRead(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int,
    ) {
      scheduleTransferProgressTimeout(gatt)
      if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_EXTENSION_CAPABILITY_UUID) {
        if (extensionState != ExtensionState.READING_CAPABILITY) {
          gatt.disconnect()
          return
        }
        val supported = status == BluetoothGatt.GATT_SUCCESS && runCatching {
          BleReceiptExchangeCodec.decodeCapability(characteristic.value ?: ByteArray(0))
        }.isSuccess
        if (!supported) {
          extensionState = ExtensionState.NONE
          continueLegacyAfterReturnAck(gatt)
          return
        }
        peerInventory.clear()
        peerInventorySnapshotId = null
        expectedPeerInventoryPage = 0
        peerInventoryTotalCount = null
        val localPage = runCatching {
          receiptQueue?.inventory(null, BleRelayLatencyPolicy.DIRECT_TYPED_OFFER_THRESHOLD)
        }.getOrNull()
        if (BleRelayLatencyPolicy.shouldDirectOffer(localPage)) {
          fastTypedOffer = true
          prepareTypedLeases(gatt)
        } else if (!requestPeerInventory(gatt, null, 0)) {
          gatt.disconnect()
        }
        return
      }
      if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_EXTENSION_CONTROL_UUID) {
        if (status != BluetoothGatt.GATT_SUCCESS) {
          gatt.disconnect()
          return
        }
        val bytes = characteristic.value ?: ByteArray(0)
        when (extensionState) {
          ExtensionState.READING_INVENTORY -> handlePeerInventoryPage(gatt, bytes)
          ExtensionState.READING_DECISION -> handleTypedDecision(gatt, bytes)
          else -> gatt.disconnect()
        }
        return
      }
      if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_EXTENSION_CUSTODY_UUID) {
        if (status != BluetoothGatt.GATT_SUCCESS || extensionState != ExtensionState.READING_CUSTODY) {
          gatt.disconnect()
          return
        }
        handleTypedCustody(gatt, characteristic.value ?: ByteArray(0))
        return
      }

      if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_OFFER_UUID) {
        val currentWork = work ?: run {
          syncReturnAckAndFinish(gatt)
          return
        }
        val decisionByte = characteristic.value?.firstOrNull() ?: OfferDecision.REJECT_UNSUPPORTED.code
        val decision = OfferDecision.fromCode(decisionByte)

        when (decision) {
          OfferDecision.ACCEPT -> {
            val payloadLimit = maxOf(16, negotiatedPayload - BleChunkCodec.FRAME_OVERHEAD)
            chunksToSend = try {
              BleChunkCodec.encodeChunks(currentWork.envelopeBytes, payloadLimit)
            } catch (_: Exception) {
              gatt.disconnect()
              return
            }
            chunkIndex = 0
            sendNextChunk(gatt)
          }
          OfferDecision.ALREADY_HAVE -> {
            // A peer with a durable inbound copy re-emits the normal custody ACK.
            // Read it as well so a missed notification cannot strand custody.
            readDurableAck(gatt)
          }
          else -> {
            if (transfer != null && !attemptCompleted) {
              completeAttempt(transfer, "RETRYABLE_FAILURE", "PEER_${decision.name}")
              attemptCompleted = true
            }
            syncReturnAckAndFinish(gatt)
          }
        }
      } else if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_ACK_UUID) {
        if (status == BluetoothGatt.GATT_SUCCESS) {
          characteristic.value?.let { handleDurableAck(gatt, it) }
        }
      } else if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_RETURN_ACK_UUID) {
        if (status == BluetoothGatt.GATT_SUCCESS) {
          val bytes = characteristic.value
          if (bytes != null && bytes.size == BleReturnAckCodec.RETURN_ACK_FRAME_SIZE) {
            try {
              val ack = BleReturnAckCodec.decode(bytes)
              repository.recordResponderAck(ack)
            } catch (_: Exception) {
            }
          }
        }
        if (primaryTransferFinished) {
          syncReturnAckAndFinish(gatt)
        } else {
          continueAfterReturnAck(gatt)
        }
      }
    }

    private fun readPeerReturnAckOrContinue(gatt: BluetoothGatt) {
      scheduleTransferProgressTimeout(gatt)
      val returnAck = returnAckChar
      val started = try {
        returnAck != null && gatt.readCharacteristic(returnAck)
      } catch (_: SecurityException) {
        false
      }
      if (!started) {
        if (primaryTransferFinished) syncReturnAckAndFinish(gatt) else continueAfterReturnAck(gatt)
      }
    }

    private fun scheduleTransferProgressTimeout(gatt: BluetoothGatt) {
      scheduleConnectionTimeout(
        gatt.device.address,
        gatt,
        if (attemptCompleted) null else transfer,
        "BLE_TRANSFER_STALLED",
        BleRelayLatencyPolicy.TRANSFER_PROGRESS_TIMEOUT_MS,
      )
    }

    private fun syncReturnAckAndFinish(gatt: BluetoothGatt) {
      val localAck = repository.findLatestResponderAck()
      val rChar = returnAckChar
      if (localAck != null && rChar != null) {
        try {
          rChar.value = BleReturnAckCodec.encode(localAck)
          if (gatt.writeCharacteristic(rChar)) return
        } catch (_: SecurityException) {
        }
      }
      gatt.disconnect()
    }

    private fun sendNextChunk(gatt: BluetoothGatt) {
      if (chunkIndex >= chunksToSend.size) return
      val chunkBytes = chunksToSend[chunkIndex]
      val characteristic = chunkChar ?: run {
        gatt.disconnect()
        return
      }
      characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
      characteristic.value = chunkBytes
      scheduleTransferProgressTimeout(gatt)
      try {
        if (!gatt.writeCharacteristic(characteristic)) gatt.disconnect()
      } catch (_: SecurityException) {
        gatt.disconnect()
      }
    }

    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
    ) {
      if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_ACK_UUID) {
        characteristic.value?.let { handleDurableAck(gatt, it) }
      }
    }

    private fun readDurableAck(gatt: BluetoothGatt) {
      if (attemptCompleted) return
      val characteristic = ackChar ?: return
      val started = try {
        gatt.readCharacteristic(characteristic)
      } catch (_: SecurityException) {
        false
      }
      if (!started) {
        // Keep the existing connection timeout as the retry fallback.
        return
      }
    }

    private fun handleDurableAck(gatt: BluetoothGatt, ackBytes: ByteArray) {
      if (attemptCompleted || ackBytes.size != BleProtocolConstants.ACK_PAYLOAD_SIZE) return
      val currentWork = work ?: return
      val ack = try {
        BleProtocolConstants.decodeAck(ackBytes)
      } catch (_: Exception) {
        return
      }
      val decoded = try {
        TransportEnvelope.decodeAndVerify(currentWork.envelopeBytes)
      } catch (_: Exception) {
        gatt.disconnect()
        return
      }
      if (ack.first.toString() != decoded.messageId) return

      // Persist peer custody evidence before completing the BLE attempt.
      val receiptStored = runCatching {
        repository.recordRelayReceipt(
          receiptId = ack.second.toString(),
          messageId = currentWork.messageId,
          peerIdentifier = gatt.device.address,
          acknowledgedAt = ack.third,
        )
      }.getOrDefault(false)
      if (receiptStored && transfer != null) {
        completeAttempt(transfer, "SUCCESS", null, ack.third)
        attemptCompleted = true
        primaryTransferFinished = true
      }
      if (primaryTransferFinished && tryStartReceiptExtension(gatt)) {
        return
      }
      readPeerReturnAckOrContinue(gatt)
    }

    private fun discoverServicesOrDisconnect(gatt: BluetoothGatt) {
      if (!serviceDiscoveryStarted.compareAndSet(false, true)) return
      mtuFallback?.cancel(false)
      mtuFallback = null
      scheduleConnectionTimeout(
        gatt.device.address,
        gatt,
        if (attemptCompleted) null else transfer,
        "BLE_SERVICE_DISCOVERY_TIMEOUT",
        BleRelayLatencyPolicy.SERVICE_DISCOVERY_TIMEOUT_MS,
      )
      val started = try {
        gatt.discoverServices()
      } catch (_: SecurityException) {
        false
      }
      if (!started) gatt.disconnect()
    }
  }

  private fun completeAttempt(
    transfer: ActiveBleTransfer?,
    outcome: String,
    retryClassification: String?,
    now: Long = System.currentTimeMillis(),
  ) {
    if (transfer == null) return
    runCatching {
      repository.recordAttemptCompleted(
        attemptId = transfer.attemptId,
        outcome = outcome,
        retryClassification = retryClassification,
        now = now,
      )
    }
    activeTransfers.entries.removeIf { it.value.attemptId == transfer.attemptId }
  }

  private fun scheduleConnectionTimeout(
    peerAddress: String,
    gatt: BluetoothGatt,
    transfer: ActiveBleTransfer?,
    classification: String,
    timeoutMs: Long,
  ) {
    connectionTimeouts.remove(peerAddress)?.cancel(false)
    connectionTimeouts[peerAddress] = timeoutExecutor.schedule(
      {
        if (!activeConnections.remove(peerAddress)) return@schedule
        completeAttempt(transfer, "RETRYABLE_FAILURE", classification)
        activeTransfers.remove(peerAddress)
        activeGatts.remove(peerAddress)
        connectionTimeouts.remove(peerAddress)
        runCatching { gatt.disconnect() }
        runCatching { gatt.close() }
      },
      timeoutMs,
      TimeUnit.MILLISECONDS,
    )
  }

  private fun cleanupConnection(gatt: BluetoothGatt) {
    val peerAddress = runCatching { gatt.device.address }.getOrNull()
    if (peerAddress != null) {
      connectionTimeouts.remove(peerAddress)?.cancel(false)
      activeTransfers.remove(peerAddress)
      activeConnections.remove(peerAddress)
      activeGatts.remove(peerAddress)
    }
    runCatching { gatt.close() }
  }


}
