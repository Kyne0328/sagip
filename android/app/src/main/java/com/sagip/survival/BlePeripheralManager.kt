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
  private val receiptQueue: ReceiptQueue? = null,
  private val verificationContextProvider: () -> VerificationContext? = { null },
  private val nowProvider: () -> Long = { System.currentTimeMillis() },
  private val onDurableRelayReceived: () -> Unit = {},
  private val objectContextProvider: ((ObjectKind, ByteArray) -> VerificationContext?)? = null,
  private val canForwardObject: ((ObjectKind, ByteArray) -> Boolean)? = null,
  private val admitObject: ((ObjectKind, ByteArray) -> CustodyResult)? = null,
  private val extensionActiveProvider: () -> Boolean = { false },
) : BlePeripheralController {
  private val bluetoothManager: BluetoothManager? =
    context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
  private val bluetoothAdapter: BluetoothAdapter? = bluetoothManager?.adapter
  private var advertiser: BluetoothLeAdvertiser? = null
  private var gattServer: BluetoothGattServer? = null
  private var currentAdvertiseMode: Int? = null
  private var pendingAdvertiseMode: Int? = null
  @Volatile private var serviceReady = false

  private var isAdvertising = false
  private val activeReassemblers = ConcurrentHashMap<String, BleEnvelopeReassembler>()
  private val activeOffers = ConcurrentHashMap<String, BleManifestOffer>()
  private val offerDecisions = ConcurrentHashMap<String, OfferDecision>()
  private val durableAcks = ConcurrentHashMap<String, ByteArray>()
  private data class ExtensionSnapshot(
    val snapshotId: String,
    val entries: List<InventoryEntry>,
    val objectMask: Int,
    var lastActivityAtMs: Long,
  )
  private val extensionControlResponses = ConcurrentHashMap<String, ByteArray>()
  private val extensionCustodyResponses = ConcurrentHashMap<String, ByteArray>()
  private val extensionSnapshots = ConcurrentHashMap<String, ExtensionSnapshot>()
  private val extensionPeerActivity = ConcurrentHashMap<String, Long>()
  private val extensionContactPersistedAt = ConcurrentHashMap<String, Long>()
  private val extensionMtu = ConcurrentHashMap<String, Int>()
  private val extensionReceiver = BleReceiptExchangeReceiver(
    admit = ::admitExtensionObject,
    alreadyHaveVerified = ::alreadyHaveVerifiedExtensionObject,
    preflightDecision = ::extensionPreflightDecision,
    offerAllowed = { peerId, _ -> claimExtensionOffer(peerId) },
    nowProvider = nowProvider,
  )

  private val advertiseCallback = object : AdvertiseCallback() {
    override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
      isAdvertising = true
    }

    override fun onStartFailure(errorCode: Int) {
      isAdvertising = false
      advertiser = null
      currentAdvertiseMode = null
    }
  }

  private val gattServerCallback = object : BluetoothGattServerCallback() {
    override fun onServiceAdded(status: Int, service: BluetoothGattService) {
      if (service.uuid != BleProtocolConstants.SERVICE_UUID) return
      synchronized(this@BlePeripheralManager) {
        serviceReady = status == BluetoothGatt.GATT_SUCCESS
        if (!serviceReady) {
          stopAdvertising()
          return
        }
        pendingAdvertiseMode?.let { mode -> startAdvertising(mode) }
      }
    }

    override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
      extensionMtu[device.address] = mtu
    }

    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      if (newState == BluetoothGatt.STATE_DISCONNECTED) {
        activeReassemblers.remove(device.address)
        activeOffers.remove(device.address)
        offerDecisions.remove(device.address)
        durableAcks.remove(device.address)
        extensionReceiver.disconnect(device.address)
        extensionControlResponses.remove(device.address)
        extensionCustodyResponses.remove(device.address)
        extensionSnapshots.remove(device.address)
        extensionPeerActivity.remove(device.address)
        extensionContactPersistedAt.remove(device.address)
        extensionMtu.remove(device.address)
      }
    }

    override fun onCharacteristicReadRequest(
      device: BluetoothDevice,
      requestId: Int,
      offset: Int,
      characteristic: BluetoothGattCharacteristic,
    ) {
      if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_EXTENSION_CAPABILITY_UUID) {
        val encoded = if (extensionEnabled()) BleReceiptExchangeCodec.encodeCapability(
          if (admitObject != null) BleReceiptExchangeCodec.SUPPORTED_OBJECT_MASK else BleReceiptExchangeCodec.LEGACY_OBJECT_MASK,
        ) else ByteArray(0)
        sendLongReadResponse(device, requestId, offset, encoded)
        return
      }
      if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_EXTENSION_CONTROL_UUID) {
        if (!extensionEnabled() || extensionSnapshots[device.address]?.entries?.all(::canAdvertiseEntry) == false) {
          extensionControlResponses.remove(device.address)
          extensionSnapshots.remove(device.address)
        }
        sendLongReadResponse(device, requestId, offset, extensionControlResponses[device.address] ?: ByteArray(0))
        return
      }
      if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_EXTENSION_CUSTODY_UUID) {
        sendLongReadResponse(device, requestId, offset, extensionCustodyResponses[device.address] ?: ByteArray(0))
        return
      }
      if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_OFFER_UUID) {
        val decision = offerDecisions.remove(device.address)
          ?: OfferDecision.REJECT_UNSUPPORTED
        val durableDuplicate = if (decision == OfferDecision.ALREADY_HAVE) {
          activeOffers.remove(device.address)
        } else {
          null
        }
        gattServer?.sendResponse(
          device,
          requestId,
          BluetoothGatt.GATT_SUCCESS,
          offset,
          byteArrayOf(decision.code),
        )
        if (durableDuplicate != null) {
          sendDurableAck(device, UUID.fromString(durableDuplicate.messageId))
        }
        return
      }
      if (characteristic.uuid == BleProtocolConstants.CHARACTERISTIC_ACK_UUID) {
        val encoded = durableAcks[device.address] ?: ByteArray(0)
        val responseBytes = if (offset < encoded.size) encoded.copyOfRange(offset, encoded.size) else ByteArray(0)
        gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, responseBytes)
        return
      }
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
        BleProtocolConstants.CHARACTERISTIC_EXTENSION_CONTROL_UUID -> {
          handleExtensionControlWrite(device, requestId, value, responseNeeded)
        }
        BleProtocolConstants.CHARACTERISTIC_EXTENSION_CHUNK_UUID -> {
          handleExtensionChunkWrite(device, requestId, value, responseNeeded)
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

  private fun extensionEnabled(): Boolean = receiptQueue != null && runCatching {
    verificationContextProvider()?.trustedTime != null || (admitObject != null && extensionActiveProvider())
  }.getOrDefault(false)

  private fun canAdvertiseEntry(entry: InventoryEntry): Boolean = runCatching {
    val stored = receiptQueue?.getObject(entry.objectId, entry.digest) ?: return false
    forwardAllowed(entry.objectKind, stored.bytes)
  }.getOrDefault(false)

  private fun forwardAllowed(kind: ObjectKind, bytes: ByteArray): Boolean = runCatching {
    if (!BleReceiptExchangeCodec.canTransferWithoutTime(kind) && verificationContextProvider()?.trustedTime == null) return false
    canForwardObject?.invoke(kind, bytes) ?: run {
      val context = verificationContextProvider() ?: return false
      if (kind == ObjectKind.SOS) context.trustedTime != null
      else ReceiptAuthority.verifyReceipt(bytes, context) is ReceiptVerification.Verified
    }
  }.getOrDefault(false)

  private fun ensureExtensionPeer(peerId: String, nowMs: Long): Boolean {
    val stale = extensionPeerActivity.entries
      .filter { (_, last) -> nowMs < last || nowMs - last >= EXTENSION_CONTACT_TIMEOUT_MS }
      .map { it.key }
    stale.forEach { stalePeer ->
      extensionPeerActivity.remove(stalePeer)
      extensionContactPersistedAt.remove(stalePeer)
      extensionSnapshots.remove(stalePeer)
      extensionControlResponses.remove(stalePeer)
      extensionCustodyResponses.remove(stalePeer)
      extensionReceiver.disconnect(stalePeer)
    }
    if (!extensionPeerActivity.containsKey(peerId) && extensionPeerActivity.size >= MAX_EXTENSION_PEERS) return false
    extensionPeerActivity[peerId] = nowMs
    val lastPersistedAt = extensionContactPersistedAt[peerId]
    if (BleRelayLatencyPolicy.shouldPersistContactActivity(lastPersistedAt, nowMs)) {
      receiptQueue?.touchContact(peerId, nowMs)
      extensionContactPersistedAt[peerId] = nowMs
    }
    return true
  }

  private fun extensionMtuReady(peerId: String): Boolean =
    (extensionMtu[peerId] ?: 23) >= BleReceiptExchangeCodec.MIN_EXTENSION_MTU

  private fun sendLongReadResponse(
    device: BluetoothDevice,
    requestId: Int,
    offset: Int,
    encoded: ByteArray,
  ) {
    if (offset < 0 || offset > encoded.size) {
      gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, offset, null)
      return
    }
    val maxResponseBytes = maxOf(1, (extensionMtu[device.address] ?: 23) - 1)
    val end = minOf(encoded.size, offset + maxResponseBytes)
    gattServer?.sendResponse(
      device,
      requestId,
      BluetoothGatt.GATT_SUCCESS,
      offset,
      encoded.copyOfRange(offset, end),
    )
  }

  private fun admitExtensionObject(kind: ObjectKind, bytes: ByteArray): CustodyResult {
    val queue = receiptQueue
      ?: return CustodyResult(CustodyResultKind.PENDING_VERIFICATION, reason = "RECEIPT_EXTENSION_DISABLED")
    val result = if (admitObject != null) {
      admitObject.invoke(kind, bytes)
    } else {
      if (kind == ObjectKind.OFFLINE_ROOT_BUNDLE || kind == ObjectKind.OFFLINE_ROOT_REVOCATION) {
        return CustodyResult(CustodyResultKind.PENDING_VERIFICATION, reason = "OFFLINE_ROOT_BUNDLE_DISABLED")
      }
      val context = if (objectContextProvider != null) objectContextProvider.invoke(kind, bytes) else verificationContextProvider()
      if (context == null) return CustodyResult(CustodyResultKind.PENDING_VERIFICATION, reason = "VERIFICATION_CONTEXT_UNAVAILABLE")
      queue.admitObject(bytes, kind, context)
    }
    if (result.kind == CustodyResultKind.COMMITTED || result.kind == CustodyResultKind.DUPLICATE) {
      runCatching { onDurableRelayReceived() }
    }
    return result
  }

  private fun extensionPreflightDecision(entry: InventoryEntry): BleDecisionCode? {
    if (!BleReceiptExchangeCodec.canTransferWithoutTime(entry.objectKind) && verificationContextProvider()?.trustedTime == null) {
      return BleDecisionCode.UNVERIFIED_AUTHORITY
    }
    if (entry.objectKind == ObjectKind.OFFLINE_ROOT_BUNDLE || entry.objectKind == ObjectKind.OFFLINE_ROOT_REVOCATION) {
      if (admitObject == null) return BleDecisionCode.UNSUPPORTED
      val stored = receiptQueue?.getObject(entry.objectId, entry.digest)
      if (stored != null && !forwardAllowed(entry.objectKind, stored.bytes)) return BleDecisionCode.UNVERIFIED_AUTHORITY
      // Expired/evicted custody has no exact bytes to reverify. Do not ACK a tombstone alone.
      if (stored == null) return null
    }
    val known = receiptQueue?.knownVerifiedDigest(entry.objectKind, entry.objectId) ?: return null
    return if (java.security.MessageDigest.isEqual(known, entry.digest)) {
      BleDecisionCode.ALREADY_HAVE_VERIFIED
    } else {
      BleDecisionCode.REJECTED
    }
  }

  private fun claimExtensionOffer(peerId: String): Boolean {
    val now = nowProvider()
    if (!ensureExtensionPeer(peerId, now)) return false
    return receiptQueue?.claimContactTransfer(peerId, now) == true
  }

  private fun alreadyHaveVerifiedExtensionObject(entry: InventoryEntry): Boolean {
    if (!BleReceiptExchangeCodec.canTransferWithoutTime(entry.objectKind) && verificationContextProvider()?.trustedTime == null) return false
    val queue = receiptQueue ?: return false
    val stored = queue.getObject(entry.objectId, entry.digest) ?: return false
    return (entry.objectKind != ObjectKind.OFFLINE_ROOT_BUNDLE && entry.objectKind != ObjectKind.OFFLINE_ROOT_REVOCATION) ||
      forwardAllowed(entry.objectKind, stored.bytes)
  }

  private fun handleExtensionControlWrite(
    device: BluetoothDevice,
    requestId: Int,
    value: ByteArray,
    responseNeeded: Boolean,
  ) {
    if (!extensionEnabled() || !extensionMtuReady(device.address) || !ensureExtensionPeer(device.address, nowProvider()) || value.size < 4) {
      if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
      return
    }
    val magic = value.copyOfRange(0, 4).toString(Charsets.US_ASCII)
    val response = try {
      when (magic) {
        "SGQ2" -> encodeExtensionInventory(device.address, value)
        "SGO2" -> BleReceiptExchangeCodec.encodeDecision(extensionReceiver.beginOffer(device.address, value))
        else -> throw IllegalArgumentException("unsupported extension control frame")
      }
    } catch (_: Exception) {
      null
    }
    if (response == null) {
      extensionControlResponses.remove(device.address)
      if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
      return
    }
    extensionControlResponses[device.address] = response
    if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
  }

  private fun encodeExtensionInventory(peerId: String, requestBytes: ByteArray): ByteArray {
    val request = BleReceiptExchangeCodec.decodeInventoryRequest(requestBytes)
    val now = nowProvider()
    require(ensureExtensionPeer(peerId, now)) { "extension peer capacity" }
    var snapshot = extensionSnapshots[peerId]
    if (snapshot != null && now - snapshot.lastActivityAtMs >= EXTENSION_CONTACT_TIMEOUT_MS) {
      extensionSnapshots.remove(peerId)
      extensionReceiver.disconnect(peerId)
      snapshot = null
    }
    if (request.snapshotId == null) {
      if (snapshot == null) {
        val entries = requireNotNull(receiptQueue).contactInventory(BleReceiptExchangeCodec.MAX_INVENTORY_ENTRIES) { kind, bytes ->
          BleReceiptExchangeCodec.supportsObject(request.objectMask, kind) && forwardAllowed(kind, bytes)
        }
        snapshot = ExtensionSnapshot(UUID.randomUUID().toString(), entries.map { it.copy(digest = it.digest.copyOf()) }, request.objectMask, now)
        extensionSnapshots[peerId] = snapshot
      }
    } else {
      require(snapshot != null && snapshot.snapshotId == request.snapshotId) { "unknown inventory snapshot" }
    }
    val active = requireNotNull(snapshot)
    require(active.objectMask == request.objectMask) { "inventory capabilities changed" }
    require(active.entries.all(::canAdvertiseEntry)) { "inventory authority changed" }
    active.lastActivityAtMs = now
    val from = request.pageIndex * BleReceiptExchangeCodec.MAX_INVENTORY_PAGE_ENTRIES
    if (active.entries.isEmpty()) {
      require(request.pageIndex == 0) { "inventory page out of range" }
    } else {
      require(from < active.entries.size) { "inventory page out of range" }
    }
    val pageEntries = active.entries.drop(from).take(BleReceiptExchangeCodec.MAX_INVENTORY_PAGE_ENTRIES)
    val next = if (from + pageEntries.size < active.entries.size) request.pageIndex + 1 else null
    return BleReceiptExchangeCodec.encodeInventory(
      InventoryPage(
        entries = pageEntries,
        nextCursor = null,
        snapshotId = active.snapshotId,
        pageIndex = request.pageIndex,
        totalCount = active.entries.size,
        nextPage = next,
      ),
    )
  }

  private fun handleExtensionChunkWrite(
    device: BluetoothDevice,
    requestId: Int,
    value: ByteArray,
    responseNeeded: Boolean,
  ) {
    if (!extensionEnabled() || !extensionMtuReady(device.address) || !ensureExtensionPeer(device.address, nowProvider())) {
      if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null)
      return
    }
    val result = extensionReceiver.addChunk(device.address, value)
    if (result != null) {
      val encoded = BleReceiptExchangeCodec.encodeCustody(result)
      extensionCustodyResponses[device.address] = encoded
      val service = gattServer?.getService(BleProtocolConstants.SERVICE_UUID)
      val custody = service?.getCharacteristic(BleProtocolConstants.CHARACTERISTIC_EXTENSION_CUSTODY_UUID)
      if (custody != null) {
        custody.value = encoded
        try {
          gattServer?.notifyCharacteristicChanged(device, custody, false)
        } catch (_: SecurityException) {
        }
      }
    }
    if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
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

  @Synchronized
  override fun start(advertiseMode: Int) {
    if (!BleRelayReadinessChecker.evaluate(context).canRun) return
    pendingAdvertiseMode = advertiseMode
    startGattServer()
    if (!serviceReady) return
    if (isAdvertising && currentAdvertiseMode == advertiseMode) return
    if (isAdvertising) pauseAdvertising()
    startAdvertising(advertiseMode)
  }

  @Synchronized
  override fun pauseAdvertising() {
    pendingAdvertiseMode = null
    stopAdvertising()
  }

  @Synchronized
  override fun stop() {
    pendingAdvertiseMode = null
    stopAdvertising()
    stopGattServer()
    activeReassemblers.clear()
    activeOffers.clear()
    offerDecisions.clear()
    durableAcks.clear()
    extensionControlResponses.clear()
    extensionCustodyResponses.clear()
    extensionReceiver.clear()
    extensionSnapshots.clear()
    extensionPeerActivity.clear()
    extensionMtu.clear()
  }

  override fun isRunning(): Boolean = isAdvertising && serviceReady && gattServer != null

  private fun startGattServer() {
    if (gattServer != null || bluetoothManager == null) return
    gattServer = try {
      bluetoothManager.openGattServer(context, gattServerCallback)
    } catch (_: SecurityException) {
      null
    } ?: return

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

    if (extensionEnabled()) {
      val capabilityChar = BluetoothGattCharacteristic(
        BleProtocolConstants.CHARACTERISTIC_EXTENSION_CAPABILITY_UUID,
        BluetoothGattCharacteristic.PROPERTY_READ,
        BluetoothGattCharacteristic.PERMISSION_READ,
      )
      val controlChar = BluetoothGattCharacteristic(
        BleProtocolConstants.CHARACTERISTIC_EXTENSION_CONTROL_UUID,
        BluetoothGattCharacteristic.PROPERTY_READ or BluetoothGattCharacteristic.PROPERTY_WRITE,
        BluetoothGattCharacteristic.PERMISSION_READ or BluetoothGattCharacteristic.PERMISSION_WRITE,
      )
      val extensionChunkChar = BluetoothGattCharacteristic(
        BleProtocolConstants.CHARACTERISTIC_EXTENSION_CHUNK_UUID,
        BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
        BluetoothGattCharacteristic.PERMISSION_WRITE,
      )
      val extensionCustodyChar = BluetoothGattCharacteristic(
        BleProtocolConstants.CHARACTERISTIC_EXTENSION_CUSTODY_UUID,
        BluetoothGattCharacteristic.PROPERTY_READ or BluetoothGattCharacteristic.PROPERTY_NOTIFY or BluetoothGattCharacteristic.PROPERTY_INDICATE,
        BluetoothGattCharacteristic.PERMISSION_READ,
      )
      extensionCustodyChar.addDescriptor(
        BluetoothGattDescriptor(
          BleProtocolConstants.CLIENT_CONFIG_DESCRIPTOR_UUID,
          BluetoothGattDescriptor.PERMISSION_WRITE or BluetoothGattDescriptor.PERMISSION_READ,
        ),
      )
      service.addCharacteristic(capabilityChar)
      service.addCharacteristic(controlChar)
      service.addCharacteristic(extensionChunkChar)
      service.addCharacteristic(extensionCustodyChar)
    }

    serviceReady = false
    val added = gattServer?.addService(service) == true
    if (!added) {
      stopGattServer()
    }
  }

  private fun startAdvertising(advertiseMode: Int) {
    if (!serviceReady || advertiser != null || bluetoothAdapter == null) return
    advertiser = try {
      bluetoothAdapter.bluetoothLeAdvertiser
    } catch (_: SecurityException) {
      null
    } ?: return

    val txPower = when (advertiseMode) {
      AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY -> AdvertiseSettings.ADVERTISE_TX_POWER_HIGH
      AdvertiseSettings.ADVERTISE_MODE_BALANCED -> AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM
      else -> AdvertiseSettings.ADVERTISE_TX_POWER_LOW
    }
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(advertiseMode)
      .setConnectable(true)
      .setTimeout(0)
      .setTxPowerLevel(txPower)
      .build()

    val data = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .addServiceUuid(ParcelUuid(BleProtocolConstants.SERVICE_UUID))
      .build()

    try {
      currentAdvertiseMode = advertiseMode
      advertiser?.startAdvertising(settings, data, advertiseCallback)
    } catch (_: SecurityException) {
      advertiser = null
      isAdvertising = false
      currentAdvertiseMode = null
    } catch (_: IllegalStateException) {
      advertiser = null
      isAdvertising = false
      currentAdvertiseMode = null
    }
  }

  private fun stopAdvertising() {
    try {
      advertiser?.stopAdvertising(advertiseCallback)
    } catch (_: SecurityException) {
    }
    advertiser = null
    isAdvertising = false
    currentAdvertiseMode = null
  }

  private fun stopGattServer() {
    try {
      gattServer?.close()
    } catch (_: Exception) {
    }
    gattServer = null
    serviceReady = false
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

    val durableInboundCopy = repository.hasSeenInboundMessage(offer.messageId, offer.payloadDigest)
    val alreadySeen = durableInboundCopy || repository.isMessageSeen(offer.messageId, offer.payloadDigest)
    val decision = if (alreadySeen) {
      activeReassemblers.remove(device.address)
      if (durableInboundCopy) {
        activeOffers[device.address] = offer
      } else {
        activeOffers.remove(device.address)
      }
      OfferDecision.ALREADY_HAVE
    } else {
      activeOffers[device.address] = offer
      activeReassemblers[device.address] = BleEnvelopeReassembler()
      OfferDecision.ACCEPT
    }
    offerDecisions[device.address] = decision

    if (responseNeeded) {
      gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
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
            runCatching { EmergencyJobScheduler.scheduleImmediateNetworkSync(context.applicationContext) }
            runCatching { onDurableRelayReceived() }
            sendDurableAck(device, UUID.fromString(persistResult.messageId))
            if (responseNeeded) {
              gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            }
          }
          is InboundPersistResult.DuplicateIgnored -> {
            runCatching { EmergencyJobScheduler.scheduleImmediateNetworkSync(context.applicationContext) }
            runCatching { onDurableRelayReceived() }
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
    durableAcks[device.address] = ackBytes
    ackChar.value = ackBytes

    try {
      gattServer?.notifyCharacteristicChanged(device, ackChar, false)
    } catch (_: SecurityException) {
    }
  }

  companion object {
    private const val EXTENSION_CONTACT_TIMEOUT_MS = 60_000L
    private const val MAX_EXTENSION_PEERS = 4
  }
}
