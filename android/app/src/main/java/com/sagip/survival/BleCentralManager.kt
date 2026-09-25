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
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class BleCentralManager(
  private val context: Context,
  private val repository: EmergencyRepository,
) : BleCentralController {
  private data class ActiveBleTransfer(
    val work: OutboundEnvelopeWork,
    val attemptId: String,
  )

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
      if (previousAttemptAt != null && now - previousAttemptAt < PEER_RETRY_INTERVAL_MS) return
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
    if (transfer == null && !hasReturnAck) {
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
        scheduleConnectionTimeout(device.address, gatt, transfer)
      }
    } catch (_: SecurityException) {
      completeAttempt(transfer, "RETRYABLE_FAILURE", "BLE_PERMISSION_LOST")
      activeConnections.remove(device.address)
    }
  }

  private fun createGattCallback(transfer: ActiveBleTransfer?) = object : BluetoothGattCallback() {
    private val work = transfer?.work
    private var attemptCompleted = false
    private var negotiatedMtu = 240
    private var offerChar: BluetoothGattCharacteristic? = null
    private var chunkChar: BluetoothGattCharacteristic? = null
    private var ackChar: BluetoothGattCharacteristic? = null
    private var returnAckChar: BluetoothGattCharacteristic? = null
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
        val mtuRequested = try {
          gatt.requestMtu(512)
        } catch (_: SecurityException) {
          false
        }
        if (!mtuRequested) {
          discoverServicesOrDisconnect(gatt)
        }
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        if (!attemptCompleted && transfer != null) {
          completeAttempt(transfer, "RETRYABLE_FAILURE", "BLE_DISCONNECTED")
          attemptCompleted = true
        }
        cleanupConnection(gatt)
      }
    }

    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      if (status == BluetoothGatt.GATT_SUCCESS) {
        negotiatedMtu = maxOf(23, mtu - 3)
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

      if (returnAckChar == null || (work != null && (offerChar == null || chunkChar == null || ackChar == null))) {
        gatt.disconnect()
        return
      }

      val returnAckReadStarted = try {
        gatt.readCharacteristic(returnAckChar)
      } catch (_: SecurityException) {
        false
      }
      if (!returnAckReadStarted) continueAfterReturnAck(gatt)
    }

    private fun continueAfterReturnAck(gatt: BluetoothGatt) {
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
      if (status == BluetoothGatt.GATT_SUCCESS) sendOffer(gatt) else gatt.disconnect()
    }

    private fun sendOffer(gatt: BluetoothGatt) {
      val currentWork = work ?: run {
        syncReturnAckAndFinish(gatt)
        return
      }
      val decoded = try {
        TransportEnvelopeV1.decode(currentWork.envelopeBytes)
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

      if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_OFFER_UUID) {
        // Read offer decision
        try {
          gatt.readCharacteristic(offerChar)
        } catch (_: SecurityException) {
          gatt.disconnect()
        }
      } else if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_CHUNK_UUID) {
        // Send next chunk
        chunkIndex++
        if (chunkIndex < chunksToSend.size) {
          sendNextChunk(gatt)
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
      if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_OFFER_UUID) {
        val currentWork = work ?: run {
          syncReturnAckAndFinish(gatt)
          return
        }
        val decisionByte = characteristic.value?.firstOrNull() ?: OfferDecision.REJECT_UNSUPPORTED.code
        val decision = OfferDecision.fromCode(decisionByte)

        if (decision == OfferDecision.ACCEPT) {
          val payloadLimit = maxOf(16, negotiatedMtu - BleChunkCodec.FRAME_OVERHEAD)
          chunksToSend = try {
            BleChunkCodec.encodeChunks(currentWork.envelopeBytes, payloadLimit)
          } catch (_: Exception) {
            gatt.disconnect()
            return
          }
          chunkIndex = 0
          sendNextChunk(gatt)
        } else {
          if (transfer != null && !attemptCompleted) {
            completeAttempt(transfer, "RETRYABLE_FAILURE", "PEER_${decision.name}")
            attemptCompleted = true
          }
          // Peer already has it or rejected, check if we can share a return ACK before disconnecting
          syncReturnAckAndFinish(gatt)
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
        continueAfterReturnAck(gatt)
      }
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
      characteristic.value = chunkBytes
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
        val currentWork = work ?: return
        val ackBytes = characteristic.value ?: return
        val ack = try {
          BleProtocolConstants.decodeAck(ackBytes)
        } catch (_: Exception) {
          gatt.disconnect()
          return
        }

        val decoded = try {
          TransportEnvelopeV1.decode(currentWork.envelopeBytes)
        } catch (_: Exception) {
          gatt.disconnect()
          return
        }

        if (ack.first.toString() == decoded.messageId) {
          // Record successful peer relay receipt in SQLite before completing
          // the transport attempt. If persistence fails, the lease expires and
          // the same immutable envelope remains retryable.
          val receiptStored = runCatching {
            repository.recordRelayReceipt(
              receiptId = ack.second.toString(),
              messageId = currentWork.messageId,
              peerIdentifier = gatt.device.address,
              acknowledgedAt = ack.third,
            )
          }.getOrDefault(false)
          if (receiptStored && transfer != null && !attemptCompleted) {
            completeAttempt(transfer, "SUCCESS", null, ack.third)
            attemptCompleted = true
          }
        }
        syncReturnAckAndFinish(gatt)
      }
    }

    private fun discoverServicesOrDisconnect(gatt: BluetoothGatt) {
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
  ) {
    connectionTimeouts.remove(peerAddress)?.cancel(false)
    connectionTimeouts[peerAddress] = timeoutExecutor.schedule(
      {
        if (!activeConnections.remove(peerAddress)) return@schedule
        completeAttempt(transfer, "RETRYABLE_FAILURE", "BLE_CONNECTION_TIMEOUT")
        activeTransfers.remove(peerAddress)
        activeGatts.remove(peerAddress)
        connectionTimeouts.remove(peerAddress)
        runCatching { gatt.disconnect() }
        runCatching { gatt.close() }
      },
      CONNECTION_TIMEOUT_MS,
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

  companion object {
    private const val PEER_RETRY_INTERVAL_MS = 30_000L
    private const val CONNECTION_TIMEOUT_MS = 45_000L
  }
}
