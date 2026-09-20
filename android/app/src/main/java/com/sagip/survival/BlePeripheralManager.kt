package com.sagip.survival

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.content.Context
import android.os.ParcelUuid
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class BlePeripheralManager(
  private val context: Context,
  private val repository: EmergencyRepository,
) {
  private val bluetoothManager: BluetoothManager? =
    context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
  private val bluetoothAdapter: BluetoothAdapter? = bluetoothManager?.adapter
  private var advertiser: BluetoothLeAdvertiser? = null
  private var gattServer: BluetoothGattServer? = null

  private var isAdvertising = false
  private val activeReassemblers = ConcurrentHashMap<String, BleEnvelopeReassembler>()
  private val activeOffers = ConcurrentHashMap<String, BleManifestOffer>()

  private val advertiseCallback = object : AdvertiseCallback() {
    override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
      isAdvertising = true
    }

    override fun onStartFailure(errorCode: Int) {
      isAdvertising = false
    }
  }

  private val gattServerCallback = object : BluetoothGattServerCallback() {
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      if (newState == BluetoothGatt.STATE_DISCONNECTED) {
        activeReassemblers.remove(device.address)
        activeOffers.remove(device.address)
      }
    }

    override fun onCharacteristicReadRequest(
      device: BluetoothDevice,
      requestId: Int,
      offset: Int,
      characteristic: BluetoothGattCharacteristic,
    ) {
      if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_RETURN_ACK_UUID) {
        val latestAck = repository.findLatestResponderAck()
        if (latestAck != null) {
          val encoded = BleReturnAckCodec.encode(latestAck)
          val responseBytes = if (offset < encoded.size) encoded.copyOfRange(offset, encoded.size) else ByteArray(0)
          gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, responseBytes)
        } else {
          gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, ByteArray(0))
        }
        return
      }
      gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?,
    ) {
      if (value == null) {
        if (responseNeeded) {
          gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
        }
        return
      }

      when (characteristic.uuid) {
        BleProtocolConstants.CHARACTERISTIC_OFFER_UUID -> {
          handleOfferWrite(device, requestId, value, responseNeeded)
        }
        BleProtocolConstants.CHARACTERISTIC_CHUNK_UUID -> {
          handleChunkWrite(device, requestId, value, responseNeeded)
        }
        BleProtocolConstants.CHARACTERISTIC_RETURN_ACK_UUID -> {
          handleReturnAckWrite(device, requestId, value, responseNeeded)
        }
        else -> {
          if (responseNeeded) {
            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
          }
        }
      }
    }

    override fun onDescriptorWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray?,
    ) {
      if (responseNeeded) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
      }
    }
  }

  private fun handleReturnAckWrite(
    device: BluetoothDevice,
    requestId: Int,
    value: ByteArray,
    responseNeeded: Boolean,
  ) {
    try {
      val ack = BleReturnAckCodec.decode(value)
      repository.recordResponderAck(ack)
      if (responseNeeded) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
      }
    } catch (_: Exception) {
      if (responseNeeded) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
      }
    }
  }

  fun start() {
    if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled) return
    startGattServer()
    startAdvertising()
  }

  fun stop() {
    stopAdvertising()
    stopGattServer()
    activeReassemblers.clear()
    activeOffers.clear()
  }

  fun isRunning(): Boolean = isAdvertising && gattServer != null

  private fun startGattServer() {
    if (gattServer != null || bluetoothManager == null) return
    gattServer = bluetoothManager.openGattServer(context, gattServerCallback) ?: return

    val service = BluetoothGattService(
      BleProtocolConstants.SERVICE_UUID,
      BluetoothGattService.SERVICE_TYPE_PRIMARY,
    )

    val offerChar = BluetoothGattCharacteristic(
      BleProtocolConstants.CHARACTERISTIC_OFFER_UUID,
      BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_READ,
      BluetoothGattCharacteristic.PERMISSION_WRITE or BluetoothGattCharacteristic.PERMISSION_READ,
    )

    val chunkChar = BluetoothGattCharacteristic(
      BleProtocolConstants.CHARACTERISTIC_CHUNK_UUID,
      BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
      BluetoothGattCharacteristic.PERMISSION_WRITE,
    )

    val ackChar = BluetoothGattCharacteristic(
      BleProtocolConstants.CHARACTERISTIC_ACK_UUID,
      BluetoothGattCharacteristic.PROPERTY_READ or BluetoothGattCharacteristic.PROPERTY_NOTIFY or BluetoothGattCharacteristic.PROPERTY_INDICATE,
      BluetoothGattCharacteristic.PERMISSION_READ,
    )
    val ackDescriptor = BluetoothGattDescriptor(
      BleProtocolConstants.CLIENT_CONFIG_DESCRIPTOR_UUID,
      BluetoothGattDescriptor.PERMISSION_WRITE or BluetoothGattDescriptor.PERMISSION_READ,
    )
    ackChar.addDescriptor(ackDescriptor)

    val returnAckChar = BluetoothGattCharacteristic(
      BleProtocolConstants.CHARACTERISTIC_RETURN_ACK_UUID,
      BluetoothGattCharacteristic.PROPERTY_READ or BluetoothGattCharacteristic.PROPERTY_WRITE,
      BluetoothGattCharacteristic.PERMISSION_READ or BluetoothGattCharacteristic.PERMISSION_WRITE,
    )

    service.addCharacteristic(offerChar)
    service.addCharacteristic(chunkChar)
    service.addCharacteristic(ackChar)
    service.addCharacteristic(returnAckChar)

    gattServer?.addService(service)
  }

  private fun startAdvertising() {
    if (advertiser != null || bluetoothAdapter == null) return
    advertiser = bluetoothAdapter.bluetoothLeAdvertiser ?: return

    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
      .setConnectable(true)
      .setTimeout(0)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
      .build()

    val data = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .addServiceUuid(ParcelUuid(BleProtocolConstants.SERVICE_UUID))
      .build()

    try {
      advertiser?.startAdvertising(settings, data, advertiseCallback)
    } catch (_: SecurityException) {
      // Missing permission handled gracefully
    }
  }

  private fun stopAdvertising() {
    try {
      advertiser?.stopAdvertising(advertiseCallback)
    } catch (_: SecurityException) {
    }
    advertiser = null
    isAdvertising = false
  }

  private fun stopGattServer() {
    try {
      gattServer?.close()
    } catch (_: Exception) {
    }
    gattServer = null
  }

  private fun handleOfferWrite(
    device: BluetoothDevice,
    requestId: Int,
    value: ByteArray,
    responseNeeded: Boolean,
  ) {
    val offer = try {
      BleProtocolConstants.decodeOffer(value)
    } catch (_: Exception) {
      if (responseNeeded) {
        val reject = byteArrayOf(OfferDecision.REJECT_UNSUPPORTED.code)
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, reject)
      }
      return
    }

    val alreadySeen = repository.isMessageSeen(offer.messageId, offer.payloadDigest)
    val decision = if (alreadySeen) {
      OfferDecision.ALREADY_HAVE
    } else {
      activeOffers[device.address] = offer
      activeReassemblers[device.address] = BleEnvelopeReassembler()
      OfferDecision.ACCEPT
    }

    if (responseNeeded) {
      val resp = byteArrayOf(decision.code)
      gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, resp)
    }
  }

  private fun handleChunkWrite(
    device: BluetoothDevice,
    requestId: Int,
    value: ByteArray,
    responseNeeded: Boolean,
  ) {
    val reassembler = activeReassemblers[device.address]
    if (reassembler == null) {
      if (responseNeeded) {
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
      }
      return
    }

    when (val result = reassembler.addChunk(value)) {
      is ReassemblyResult.InProgress -> {
        if (responseNeeded) {
          gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
        }
      }
      is ReassemblyResult.Complete -> {
        // ENFORCE DURABLE-BEFORE-ACK: commit to SQLite BEFORE emitting ACK
        val persistResult = repository.persistInboundEnvelope(result.envelopeBytes)
        when (persistResult) {
          is InboundPersistResult.Stored -> {
            sendDurableAck(device, UUID.fromString(persistResult.messageId))
            if (responseNeeded) {
              gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            }
          }
          is InboundPersistResult.DuplicateIgnored -> {
            sendDurableAck(device, UUID.fromString(persistResult.messageId))
            if (responseNeeded) {
              gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            }
          }
          is InboundPersistResult.ValidationFailed -> {
            if (responseNeeded) {
              gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
            }
          }
        }
        activeReassemblers.remove(device.address)
        activeOffers.remove(device.address)
      }
      is ReassemblyResult.Failed -> {
        if (responseNeeded) {
          gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
        }
        activeReassemblers.remove(device.address)
        activeOffers.remove(device.address)
      }
    }
  }

  private fun sendDurableAck(device: BluetoothDevice, messageId: UUID) {
    val service = gattServer?.getService(BleProtocolConstants.SERVICE_UUID) ?: return
    val ackChar = service.getCharacteristic(BleProtocolConstants.CHARACTERISTIC_ACK_UUID) ?: return

    val receiptId = UUID.randomUUID()
    val now = System.currentTimeMillis()
    val ackBytes = BleProtocolConstants.encodeAck(messageId, receiptId, now)
    ackChar.value = ackBytes

    try {
      gattServer?.notifyCharacteristicChanged(device, ackChar, false)
    } catch (_: SecurityException) {
    }
  }
}
