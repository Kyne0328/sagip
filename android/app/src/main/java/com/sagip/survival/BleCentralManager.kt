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
import java.util.concurrent.atomic.AtomicBoolean

class BleCentralManager(
  private val context: Context,
  private val repository: EmergencyRepository,
) {
  private val bluetoothManager: BluetoothManager? =
    context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
  private val bluetoothAdapter: BluetoothAdapter? = bluetoothManager?.adapter
  private var scanner: BluetoothLeScanner? = null

  private val isScanning = AtomicBoolean(false)
  private val discoveredPeers = ConcurrentHashMap<String, BluetoothDevice>()
  private val activeTransfers = ConcurrentHashMap<String, OutboundEnvelopeWork>()
  private var negotiatedMtu = 240

  private val scanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult?) {
      val device = result?.device ?: return
      if (!discoveredPeers.containsKey(device.address)) {
        discoveredPeers[device.address] = device
        attemptRelayToPeer(device)
      }
    }

    override fun onScanFailed(errorCode: Int) {
      isScanning.set(false)
    }
  }

  fun startScanning() {
    if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled) return
    if (isScanning.getAndSet(true)) return

    scanner = bluetoothAdapter.bluetoothLeScanner
    val filter = ScanFilter.Builder()
      .setServiceUuid(ParcelUuid(BleProtocolConstants.SERVICE_UUID))
      .build()
    val settings = ScanSettings.Builder()
      .setScanMode(ScanSettings.SCAN_MODE_BALANCED)
      .build()

    try {
      scanner?.startScan(listOf(filter), settings, scanCallback)
    } catch (_: SecurityException) {
      isScanning.set(false)
    }
  }

  fun stopScanning() {
    if (!isScanning.getAndSet(false)) return
    try {
      scanner?.stopScan(scanCallback)
    } catch (_: SecurityException) {
    }
    scanner = null
    discoveredPeers.clear()
  }

  fun isScanning(): Boolean = isScanning.get()
  fun getDiscoveredPeerCount(): Int = discoveredPeers.size

  private fun attemptRelayToPeer(device: BluetoothDevice) {
    val dueEnvelopes = repository.listDueOutbound(System.currentTimeMillis(), limit = 1)
    if (dueEnvelopes.isEmpty()) return

    val targetWork = dueEnvelopes.first()
    activeTransfers[device.address] = targetWork

    try {
      device.connectGatt(context, false, createGattCallback(targetWork))
    } catch (_: SecurityException) {
      activeTransfers.remove(device.address)
    }
  }

  private fun createGattCallback(work: OutboundEnvelopeWork) = object : BluetoothGattCallback() {
    private var offerChar: BluetoothGattCharacteristic? = null
    private var chunkChar: BluetoothGattCharacteristic? = null
    private var ackChar: BluetoothGattCharacteristic? = null
    private var returnAckChar: BluetoothGattCharacteristic? = null
    private var chunksToSend = listOf<ByteArray>()
    private var chunkIndex = 0

    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        try {
          gatt.requestMtu(512)
        } catch (_: SecurityException) {
          gatt.discoverServices()
        }
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        activeTransfers.remove(gatt.device.address)
        try {
          gatt.close()
        } catch (_: Exception) {
        }
      }
    }

    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      negotiatedMtu = maxOf(23, mtu - 3)
      try {
        gatt.discoverServices()
      } catch (_: SecurityException) {
      }
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

      if (offerChar == null || chunkChar == null || ackChar == null) {
        gatt.disconnect()
        return
      }

      // Read return ACK if available from peer
      returnAckChar?.let { rChar ->
        try {
          gatt.readCharacteristic(rChar)
        } catch (_: SecurityException) {
        }
      }

      // Enable notifications on ACK characteristic
      try {
        gatt.setCharacteristicNotification(ackChar, true)
        val desc = ackChar?.getDescriptor(BleProtocolConstants.CLIENT_CONFIG_DESCRIPTOR_UUID)
        if (desc != null) {
          desc.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
          gatt.writeDescriptor(desc)
        } else {
          sendOffer(gatt)
        }
      } catch (_: SecurityException) {
        gatt.disconnect()
      }
    }

    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      sendOffer(gatt)
    }

    private fun sendOffer(gatt: BluetoothGatt) {
      val decoded = try {
        TransportEnvelopeV1.decode(work.envelopeBytes)
      } catch (_: Exception) {
        gatt.disconnect()
        return
      }

      val offerBytes = BleProtocolConstants.encodeOffer(UUID.fromString(decoded.messageId), decoded.payloadDigest)
      offerChar?.value = offerBytes
      try {
        gatt.writeCharacteristic(offerChar)
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
        val decisionByte = characteristic.value?.firstOrNull() ?: OfferDecision.REJECT_UNSUPPORTED.code
        val decision = OfferDecision.fromCode(decisionByte)

        if (decision == OfferDecision.ACCEPT) {
          val payloadLimit = maxOf(16, negotiatedMtu - BleChunkCodec.FRAME_OVERHEAD)
          chunksToSend = BleChunkCodec.encodeChunks(work.envelopeBytes, payloadLimit)
          chunkIndex = 0
          sendNextChunk(gatt)
        } else {
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
      }
    }

    private fun syncReturnAckAndFinish(gatt: BluetoothGatt) {
      val localAck = repository.findLatestResponderAck()
      val rChar = returnAckChar
      if (localAck != null && rChar != null) {
        try {
          rChar.value = BleReturnAckCodec.encode(localAck)
          gatt.writeCharacteristic(rChar)
          return
        } catch (_: SecurityException) {
        }
      }
      gatt.disconnect()
    }

    private fun sendNextChunk(gatt: BluetoothGatt) {
      if (chunkIndex >= chunksToSend.size) return
      val chunkBytes = chunksToSend[chunkIndex]
      chunkChar?.value = chunkBytes
      try {
        gatt.writeCharacteristic(chunkChar)
      } catch (_: SecurityException) {
        gatt.disconnect()
      }
    }

    override fun onCharacteristicChanged(
      gatt: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
    ) {
      if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_ACK_UUID) {
        val ackBytes = characteristic.value ?: return
        val ack = try {
          BleProtocolConstants.decodeAck(ackBytes)
        } catch (_: Exception) {
          return
        }

        val decoded = try {
          TransportEnvelopeV1.decode(work.envelopeBytes)
        } catch (_: Exception) {
          return
        }

        if (ack.first.toString() == decoded.messageId) {
          // Record successful peer relay receipt in SQLite
          repository.recordRelayReceipt(
            receiptId = ack.second.toString(),
            messageId = work.messageId,
            peerIdentifier = gatt.device.address,
            acknowledgedAt = ack.third,
          )
          repository.recordAttemptCompleted(
            attemptId = UUID.randomUUID().toString(),
            outcome = "SUCCESS",
            retryClassification = null,
            now = ack.third,
          )
        }
        syncReturnAckAndFinish(gatt)
      }
    }
  }
}
