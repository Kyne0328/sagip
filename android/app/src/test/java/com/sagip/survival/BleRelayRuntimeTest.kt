package com.sagip.survival

import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanSettings
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BleRelayRuntimeTest {
  private class FakeCentral : BleCentralController {
    var scanning = false
    var peers = 0
    var starts = 0
    var stops = 0
    var pauses = 0
    var lastScanMode: Int? = null

    override fun startScanning(scanMode: Int) {
      starts++
      lastScanMode = scanMode
      scanning = true
    }

    override fun pauseScanning() {
      pauses++
      scanning = false
    }

    override fun stopScanning() {
      stops++
      scanning = false
      peers = 0
    }

    override fun isScanning(): Boolean = scanning
    override fun getDiscoveredPeerCount(): Int = peers
  }

  private class FakePeripheral : BlePeripheralController {
    var running = false
    var starts = 0
    var stops = 0
    var pauses = 0
    var lastAdvertiseMode: Int? = null

    override fun start(advertiseMode: Int) {
      starts++
      lastAdvertiseMode = advertiseMode
      running = true
    }

    override fun pauseAdvertising() {
      pauses++
      running = false
    }

    override fun stop() {
      stops++
      running = false
    }

    override fun isRunning(): Boolean = running
  }

  private fun readiness(available: Boolean) = BleRelayReadiness(
    availability = if (available) BleRelayAvailability.READY else BleRelayAvailability.PERMISSION_REQUIRED,
    isSupported = true,
    permissionGranted = available,
    bluetoothEnabled = available,
  )

  @Test
  fun `ready runtime starts both BLE roles and reports authoritative transport state`() {
    var ready = true
    val central = FakeCentral()
    val peripheral = FakePeripheral()
    val runtime = BleRelayRuntime(
      readinessProvider = { readiness(ready) },
      activityTimestampProvider = { 0L },
      central = central,
      peripheral = peripheral,
    )

    assertTrue(runtime.start())
    central.peers = 2

    val status = runtime.status()
    assertTrue(status.isScanning)
    assertTrue(status.isAdvertising)
    assertEquals(2, status.peerCount)
    assertEquals(1, central.starts)
    assertEquals(1, peripheral.starts)
  }

  @Test
  fun `fresh relay activation boosts an idle helper phone into rapid discovery`() {
    val central = FakeCentral()
    val peripheral = FakePeripheral()
    val runtime = BleRelayRuntime(
      readinessProvider = { readiness(true) },
      activityTimestampProvider = { 0L },
      central = central,
      peripheral = peripheral,
      nowProvider = { 1_000_000L },
    )

    assertTrue(runtime.start())
    assertEquals(ScanSettings.SCAN_MODE_LOW_LATENCY, central.lastScanMode)
    assertEquals(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY, peripheral.lastAdvertiseMode)
  }

  @Test
  fun `permission loss stops stale radios before reporting relay unavailable`() {
    var ready = true
    val central = FakeCentral()
    val peripheral = FakePeripheral()
    val runtime = BleRelayRuntime(
      readinessProvider = { readiness(ready) },
      activityTimestampProvider = { 0L },
      central = central,
      peripheral = peripheral,
    )

    assertTrue(runtime.start())
    ready = false

    assertFalse(runtime.start())
    val status = runtime.status()
    assertFalse(status.isScanning)
    assertFalse(status.isAdvertising)
    assertEquals(0, status.peerCount)
    assertTrue(central.stops > 0)
    assertTrue(peripheral.stops > 0)
  }

  @Test
  fun `start repairs an unexpectedly stopped radio instead of reporting stale success`() {
    val central = FakeCentral()
    val peripheral = FakePeripheral()
    val runtime = BleRelayRuntime(
      readinessProvider = { readiness(true) },
      activityTimestampProvider = { System.currentTimeMillis() },
      central = central,
      peripheral = peripheral,
    )

    assertTrue(runtime.start())
    central.scanning = false
    peripheral.running = false

    assertTrue(runtime.start())
    assertEquals(2, central.starts)
    assertEquals(2, peripheral.starts)
    assertTrue(runtime.status().isScanning)
    assertTrue(runtime.status().isAdvertising)
  }
  @Test
  fun `receipt v2 capability and inventory codecs are strict and bounded`() {
    val capability = BleReceiptExchangeCodec.encodeCapability()
    assertEquals(8, capability.size)
    assertEquals(2, BleReceiptExchangeCodec.decodeCapability(capability).extensionVersion)

    val snapshotId = "11111111-1111-1111-1111-111111111111"
    val entries = listOf(
      InventoryEntry(
        objectKind = ObjectKind.RESPONDER_RECEIPT,
        objectId = "22222222-2222-2222-2222-222222222222",
        digest = ByteArray(32) { 0x22 },
        reportId = "33333333-3333-3333-3333-333333333333",
        revision = 2,
        custodyAcceptedAtMs = 100L,
        reportProtocolVersion = 1,
        forwardingExpiresAtMs = 9_000L,
      ),
      InventoryEntry(
        objectKind = ObjectKind.REQUESTER_RECEIPT,
        objectId = "44444444-4444-4444-4444-444444444444",
        digest = ByteArray(32) { 0x44 },
        reportId = "55555555-5555-5555-5555-555555555555",
        revision = 3,
        custodyAcceptedAtMs = 101L,
        reportProtocolVersion = 2,
        forwardingExpiresAtMs = 10_000L,
      ),
    )
    val page = InventoryPage(
      entries = entries,
      nextCursor = null,
      snapshotId = snapshotId,
      pageIndex = 0,
      totalCount = 2,
      nextPage = null,
    )
    val encoded = BleReceiptExchangeCodec.encodeInventory(page)
    val decoded = BleReceiptExchangeCodec.decodeInventory(encoded)
    assertEquals(snapshotId, decoded.snapshotId)
    assertEquals(2, decoded.entries.size)
    assertEquals(2, decoded.entries[1].reportProtocolVersion)
    assertEquals(10_000L, decoded.entries[1].forwardingExpiresAtMs)
    assertArrayEquals(entries[0].digest, decoded.entries[0].digest)

    assertFails { BleReceiptExchangeCodec.decodeInventory(encoded + byteArrayOf(0)) }
    assertFails { BleReceiptExchangeCodec.decodeInventory(encoded.copyOf().also { it[21] = 1 }) }
    assertFails { BleReceiptExchangeCodec.decodeCapability(capability.copyOf().also { it[5] = 0x7f }) }
  }

  @Test
  fun `negotiated exchange commit before success and bounds reassembly peers`() {
    val entry = InventoryEntry(
      objectKind = ObjectKind.RESPONDER_RECEIPT,
      objectId = "66666666-6666-6666-6666-666666666666",
      digest = ByteArray(32) { 0x66 },
      reportId = "77777777-7777-7777-7777-777777777777",
      revision = 1,
      custodyAcceptedAtMs = 500L,
      reportProtocolVersion = 1,
      forwardingExpiresAtMs = 20_000L,
    )
    val bytes = ByteArray(700) { (it and 0xff).toByte() }
    val digest = java.security.MessageDigest.getInstance("SHA-256").digest(bytes)
    val offered = entry.copy(digest = digest)
    var commitCalls = 0
    val receiver = BleReceiptExchangeReceiver(
      admit = { kind, objectBytes ->
        commitCalls++
        assertEquals(ObjectKind.RESPONDER_RECEIPT, kind)
        assertArrayEquals(bytes, objectBytes)
        CustodyResult(CustodyResultKind.COMMITTED, offered.objectId, offered.digest)
      },
      nowProvider = { 30_000L },
      receiptIdProvider = { "88888888-8888-8888-8888-888888888888" },
    )
    val offer = BleReceiptExchangeCodec.encodeOffer(offered, bytes.size)
    assertEquals(BleDecisionCode.ACCEPT_TRANSFER, receiver.beginOffer("peer-1", offer).decision)
    val chunks = BleReceiptExchangeCodec.encodeObjectChunks(bytes, maxPayloadPerChunk = 100)
    for (chunk in chunks.dropLast(1)) {
      assertEquals(null, receiver.addChunk("peer-1", chunk))
      assertEquals(0, commitCalls)
    }
    val custody = receiver.addChunk("peer-1", chunks.last())
    assertEquals(1, commitCalls)
    assertEquals(BleCustodyCode.ACCEPTED_DURABLE, custody?.result)

    val peers = (2..5).map { "peer-$it" }
    peers.forEach { peer -> assertEquals(BleDecisionCode.ACCEPT_TRANSFER, receiver.beginOffer(peer, offer).decision) }
    assertEquals(BleDecisionCode.CAPACITY_FULL, receiver.beginOffer("peer-6", offer).decision)
    assertEquals(BleDecisionCode.REJECTED, receiver.beginOffer("peer-2", offer).decision)

    receiver.disconnect("peer-2")
    assertEquals(BleDecisionCode.ACCEPT_TRANSFER, receiver.beginOffer("peer-6", offer).decision)
    val duplicate = BleReceiptExchangeCodec.encodeObjectChunks(bytes, 100).first()
    assertEquals(null, receiver.addChunk("peer-6", duplicate))
    val failed = receiver.addChunk("peer-6", duplicate)
    assertEquals(BleCustodyCode.REJECTED, failed?.result)
  }

  @Test
  fun `negotiated exchange rejects preflight conflict and stale reassembly`() {
    val bytes = ByteArray(64) { it.toByte() }
    val digest = java.security.MessageDigest.getInstance("SHA-256").digest(bytes)
    val entry = InventoryEntry(
      objectKind = ObjectKind.RESPONDER_RECEIPT,
      objectId = "99999999-9999-9999-9999-999999999999",
      digest = digest,
      reportId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      revision = 1,
      custodyAcceptedAtMs = 1L,
      reportProtocolVersion = 1,
      forwardingExpiresAtMs = 90_000L,
    )
    val offer = BleReceiptExchangeCodec.encodeOffer(entry, bytes.size)
    val conflict = BleReceiptExchangeReceiver(
      admit = { _, _ -> throw AssertionError("conflicting offer must not reach admission") },
      preflightDecision = { BleDecisionCode.REJECTED },
    )
    assertEquals(BleDecisionCode.REJECTED, conflict.beginOffer("peer-conflict", offer).decision)

    var nowMs = 1_000L
    var admitted = false
    val stale = BleReceiptExchangeReceiver(
      admit = { _, _ ->
        admitted = true
        CustodyResult(CustodyResultKind.COMMITTED, entry.objectId, entry.digest)
      },
      nowProvider = { nowMs },
    )
    assertEquals(BleDecisionCode.ACCEPT_TRANSFER, stale.beginOffer("peer-stale", offer).decision)
    nowMs += BleReceiptExchangeReceiver.SESSION_TIMEOUT_MS
    val custody = stale.addChunk(
      "peer-stale",
      BleReceiptExchangeCodec.encodeObjectChunks(bytes, 32).first(),
    )
    assertEquals(BleCustodyCode.REJECTED, custody?.result)
    assertFalse(admitted)
    assertEquals(0, stale.activePeerCount())

    assertFails {
      BleReceiptExchangeCodec.encodeCustody(
        BleCustodyResult(
          entry.objectId,
          entry.digest,
          BleCustodyCode.REJECTED,
          "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          1L,
        ),
      )
    }
  }
  private fun assertFails(block: () -> Unit) {
    try {
      block()
      throw AssertionError("expected failure")
    } catch (_: IllegalArgumentException) {
    }
  }

}
