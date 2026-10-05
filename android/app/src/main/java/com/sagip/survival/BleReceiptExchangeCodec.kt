package com.sagip.survival

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.CRC32

data class BleReceiptCapability(
  val extensionVersion: Int,
  val objectMask: Int,
  val maxInventoryEntries: Int,
  val maxContactTransfers: Int,
)

data class BleInventoryRequest(
  val snapshotId: String?,
  val pageIndex: Int,
  val objectMask: Int = BleReceiptExchangeCodec.LEGACY_OBJECT_MASK,
)

data class ObjectFrame(
  val entry: InventoryEntry,
  val totalLength: Int?,
)

enum class BleDecisionCode(val code: Int) {
  ACCEPT_TRANSFER(1),
  ALREADY_HAVE_VERIFIED(2),
  CAPACITY_FULL(3),
  UNSUPPORTED(4),
  UNVERIFIED_AUTHORITY(5),
  EXPIRED(6),
  REJECTED(7),
  ;

  companion object {
    fun fromCode(code: Int): BleDecisionCode = entries.firstOrNull { it.code == code }
      ?: throw IllegalArgumentException("unknown SGD2 decision")
  }
}

data class BleDecision(
  val objectId: String,
  val digest: ByteArray,
  val decision: BleDecisionCode,
)

enum class BleCustodyCode(val code: Int) {
  ACCEPTED_DURABLE(1),
  DUPLICATE_VERIFIED(2),
  CAPACITY_FULL(3),
  UNVERIFIED_AUTHORITY(4),
  EXPIRED(5),
  REJECTED(6),
  ;

  companion object {
    fun fromCode(code: Int): BleCustodyCode = entries.firstOrNull { it.code == code }
      ?: throw IllegalArgumentException("unknown SGK2 result")
  }
}

data class BleCustodyResult(
  val objectId: String,
  val digest: ByteArray,
  val result: BleCustodyCode,
  val custodyReceiptId: String?,
  val acceptedAtMs: Long?,
)

data class BleObjectChunk(
  val chunkIndex: Int,
  val totalChunks: Int,
  val data: ByteArray,
)

object BleReceiptExchangeCodec {
  private val CAPABILITY_MAGIC = "SGX2".toByteArray(Charsets.US_ASCII)
  private val INVENTORY_REQUEST_MAGIC = "SGQ2".toByteArray(Charsets.US_ASCII)
  private val INVENTORY_MAGIC = "SGI2".toByteArray(Charsets.US_ASCII)
  private val OFFER_MAGIC = "SGO2".toByteArray(Charsets.US_ASCII)
  private val DECISION_MAGIC = "SGD2".toByteArray(Charsets.US_ASCII)
  private val CHUNK_MAGIC = "SGC2".toByteArray(Charsets.US_ASCII)
  private val CUSTODY_MAGIC = "SGK2".toByteArray(Charsets.US_ASCII)
  private const val NIL_UUID = "00000000-0000-0000-0000-000000000000"
  private const val MAX_PROTOCOL_TIME = 9_007_199_254_740_991L

  const val LEGACY_OBJECT_MASK = 0x07
  const val OFFLINE_ROOT_OBJECT_MASK = 0x08
  const val SUPPORTED_OBJECT_MASK = LEGACY_OBJECT_MASK or OFFLINE_ROOT_OBJECT_MASK
  const val CAPABILITY_SIZE = 8
  const val INVENTORY_ENTRY_SIZE = 78
  const val INVENTORY_REQUEST_SIZE = 24
  const val INVENTORY_HEADER_SIZE = 26
  const val MAX_INVENTORY_PAGE_ENTRIES = 4
  const val MAX_INVENTORY_ENTRIES = 32
  const val OFFER_SIZE = 82
  const val DECISION_SIZE = 53
  const val CHUNK_OVERHEAD = 14
  const val MAX_OBJECT_BYTES = 8192
  const val MAX_CHUNKS = 256
  const val MAX_CHUNK_DATA = 498
  const val CUSTODY_SIZE = 77
  const val MAX_CONTACT_TRANSFERS = 8
  const val MIN_EXTENSION_MTU = 85

  fun supportsObject(objectMask: Int, kind: ObjectKind): Boolean {
    val flag = if (kind == ObjectKind.OFFLINE_ROOT_REVOCATION) OFFLINE_ROOT_OBJECT_MASK else 1 shl (kind.wireCode - 1)
    return (objectMask and flag) != 0
  }

  fun canTransferWithoutTime(kind: ObjectKind): Boolean = kind == ObjectKind.OFFLINE_ROOT_REVOCATION

  fun encodeCapability(objectMask: Int = SUPPORTED_OBJECT_MASK): ByteArray = ByteBuffer.allocate(CAPABILITY_SIZE)
    .order(ByteOrder.BIG_ENDIAN)
    .put(CAPABILITY_MAGIC)
    .put(2.toByte())
    .put(objectMask.also { require(it == LEGACY_OBJECT_MASK || it == SUPPORTED_OBJECT_MASK) }.toByte())
    .put(MAX_INVENTORY_ENTRIES.toByte())
    .put(MAX_CONTACT_TRANSFERS.toByte())
    .array()

  fun decodeCapability(bytes: ByteArray): BleReceiptCapability {
    require(bytes.size == CAPABILITY_SIZE) { "SGX2 length" }
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
    require(readMagic(buffer, CAPABILITY_MAGIC)) { "SGX2 magic" }
    val capability = BleReceiptCapability(
      extensionVersion = buffer.u8(),
      objectMask = buffer.u8(),
      maxInventoryEntries = buffer.u8(),
      maxContactTransfers = buffer.u8(),
    )
    require(
      capability.extensionVersion == 2 &&
        capability.objectMask in setOf(LEGACY_OBJECT_MASK, SUPPORTED_OBJECT_MASK) &&
        capability.maxInventoryEntries == MAX_INVENTORY_ENTRIES &&
        capability.maxContactTransfers == MAX_CONTACT_TRANSFERS
    ) { "unsupported SGX2 profile" }
    return capability
  }

  fun encodeInventoryRequest(request: BleInventoryRequest): ByteArray {
    require(request.pageIndex in 0..7) { "SGQ2 page" }
    if (request.snapshotId == null) require(request.pageIndex == 0) { "new SGQ2 must start at page zero" }
    val buffer = ByteBuffer.allocate(INVENTORY_REQUEST_SIZE).order(ByteOrder.BIG_ENDIAN)
    buffer.put(INVENTORY_REQUEST_MAGIC)
    buffer.put(1.toByte())
    putUuid(buffer, request.snapshotId ?: NIL_UUID, allowNil = true)
    buffer.put(request.pageIndex.toByte())
    require(request.objectMask == LEGACY_OBJECT_MASK || request.objectMask == SUPPORTED_OBJECT_MASK)
    buffer.putShort((request.objectMask and OFFLINE_ROOT_OBJECT_MASK).toShort())
    return buffer.array()
  }

  fun decodeInventoryRequest(bytes: ByteArray): BleInventoryRequest {
    require(bytes.size == INVENTORY_REQUEST_SIZE) { "SGQ2 length" }
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
    require(readMagic(buffer, INVENTORY_REQUEST_MAGIC)) { "SGQ2 magic" }
    require(buffer.u8() == 1) { "SGQ2 operation" }
    val id = readUuid(buffer, allowNil = true)
    val page = buffer.u8()
    require(page in 0..7) { "SGQ2 page" }
    val flags = buffer.short.toInt() and 0xffff
    require(flags == 0 || flags == OFFLINE_ROOT_OBJECT_MASK) { "SGQ2 reserved" }
    val snapshot = id.takeUnless { it == NIL_UUID }
    if (snapshot == null) require(page == 0) { "new SGQ2 must start at page zero" }
    return BleInventoryRequest(snapshot, page, LEGACY_OBJECT_MASK or flags)
  }

  fun encodeInventory(page: InventoryPage): ByteArray {
    val snapshotId = requireNotNull(page.snapshotId) { "SGI2 snapshot required" }
    require(page.pageIndex in 0..7) { "SGI2 page" }
    require(page.entries.size <= MAX_INVENTORY_PAGE_ENTRIES) { "SGI2 entry count" }
    require(page.totalCount in page.entries.size..MAX_INVENTORY_ENTRIES) { "SGI2 total count" }
    val start = page.pageIndex * MAX_INVENTORY_PAGE_ENTRIES
    val expectedCount = if (page.totalCount == 0) {
      require(page.pageIndex == 0) { "empty SGI2 must be page zero" }
      0
    } else {
      require(start < page.totalCount) { "SGI2 page out of range" }
      minOf(MAX_INVENTORY_PAGE_ENTRIES, page.totalCount - start)
    }
    require(page.entries.size == expectedCount) { "SGI2 page count" }
    val expectedNext = if (start + expectedCount < page.totalCount) page.pageIndex + 1 else null
    require(page.nextPage == expectedNext) { "SGI2 next page" }
    val nextPage = page.nextPage ?: 255
    val out = ByteBuffer.allocate(INVENTORY_HEADER_SIZE + page.entries.size * INVENTORY_ENTRY_SIZE)
      .order(ByteOrder.BIG_ENDIAN)
    out.put(INVENTORY_MAGIC)
    out.put(2.toByte())
    putUuid(out, snapshotId)
    out.put(page.pageIndex.toByte())
    out.put(page.entries.size.toByte())
    out.put(nextPage.toByte())
    out.put(page.totalCount.toByte())
    out.put(0)
    page.entries.forEach { encodeInventoryEntry(out, it) }
    return out.array()
  }

  fun decodeInventory(bytes: ByteArray): InventoryPage {
    require(bytes.size in INVENTORY_HEADER_SIZE..(INVENTORY_HEADER_SIZE + MAX_INVENTORY_PAGE_ENTRIES * INVENTORY_ENTRY_SIZE)) { "SGI2 length" }
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
    require(readMagic(buffer, INVENTORY_MAGIC)) { "SGI2 magic" }
    require(buffer.u8() == 2) { "SGI2 version" }
    val snapshot = readUuid(buffer)
    val pageIndex = buffer.u8()
    val count = buffer.u8()
    val nextRaw = buffer.u8()
    val total = buffer.u8()
    val flags = buffer.u8()
    require(pageIndex in 0..7 && count in 0..MAX_INVENTORY_PAGE_ENTRIES && total in count..MAX_INVENTORY_ENTRIES && flags == 0) { "SGI2 header" }
    require(bytes.size == INVENTORY_HEADER_SIZE + count * INVENTORY_ENTRY_SIZE) { "SGI2 exact length" }
    val next = if (nextRaw == 255) null else nextRaw.also {
      require(it in (pageIndex + 1)..7) { "SGI2 next page" }
    }
    val start = pageIndex * MAX_INVENTORY_PAGE_ENTRIES
    val expectedCount = if (total == 0) {
      require(pageIndex == 0) { "empty SGI2 must be page zero" }
      0
    } else {
      require(start < total) { "SGI2 page out of range" }
      minOf(MAX_INVENTORY_PAGE_ENTRIES, total - start)
    }
    require(count == expectedCount) { "SGI2 page count" }
    val expectedNext = if (start + expectedCount < total) pageIndex + 1 else null
    require(next == expectedNext) { "SGI2 next page" }
    val entries = List(count) { decodeInventoryEntry(buffer) }
    require(entries.map { it.objectKind to it.objectId }.toSet().size == entries.size) { "SGI2 duplicate object" }
    require(buffer.remaining() == 0) { "SGI2 trailing bytes" }
    return InventoryPage(entries, null, snapshot, pageIndex, total, next)
  }

  fun encodeOffer(entry: InventoryEntry, totalLength: Int): ByteArray {
    // The approved R01 SGO2 profile is fixed at 82 bytes and does not carry totalLength.
    // Bound the local object here and prove exact bytes by digest after SGC2 reassembly.
    require(totalLength in 1..if (entry.objectKind == ObjectKind.OFFLINE_ROOT_REVOCATION) 4096 else MAX_OBJECT_BYTES) { "SGO2 object length" }
    val out = ByteBuffer.allocate(OFFER_SIZE).order(ByteOrder.BIG_ENDIAN)
    out.put(OFFER_MAGIC)
    encodeInventoryEntry(out, entry)
    return out.array()
  }

  fun decodeObjectFrame(bytes: ByteArray): ObjectFrame {
    require(bytes.size == OFFER_SIZE) { "SGO2 length" }
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
    require(readMagic(buffer, OFFER_MAGIC)) { "SGO2 magic" }
    val entry = decodeInventoryEntry(buffer)
    require(buffer.remaining() == 0) { "SGO2 trailing bytes" }
    return ObjectFrame(entry, null)
  }

  fun encodeDecision(decision: BleDecision): ByteArray {
    require(decision.digest.size == 32) { "SGD2 digest" }
    val out = ByteBuffer.allocate(DECISION_SIZE).order(ByteOrder.BIG_ENDIAN)
    out.put(DECISION_MAGIC)
    putUuid(out, decision.objectId)
    out.put(decision.digest)
    out.put(decision.decision.code.toByte())
    return out.array()
  }

  fun decodeDecision(bytes: ByteArray): BleDecision {
    require(bytes.size == DECISION_SIZE) { "SGD2 length" }
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
    require(readMagic(buffer, DECISION_MAGIC)) { "SGD2 magic" }
    val id = readUuid(buffer)
    val digest = ByteArray(32).also(buffer::get)
    return BleDecision(id, digest, BleDecisionCode.fromCode(buffer.u8()))
  }

  fun encodeObjectChunks(bytes: ByteArray, maxPayloadPerChunk: Int): List<ByteArray> {
    require(bytes.isNotEmpty() && bytes.size <= MAX_OBJECT_BYTES) { "SGC2 object size" }
    require(maxPayloadPerChunk in 16..MAX_CHUNK_DATA) { "SGC2 payload bound" }
    val total = (bytes.size + maxPayloadPerChunk - 1) / maxPayloadPerChunk
    require(total in 1..MAX_CHUNKS) { "SGC2 chunk count" }
    return List(total) { index ->
      val from = index * maxPayloadPerChunk
      val to = minOf(bytes.size, from + maxPayloadPerChunk)
      val data = bytes.copyOfRange(from, to)
      val crc = CRC32().apply { update(data) }.value
      ByteBuffer.allocate(CHUNK_OVERHEAD + data.size).order(ByteOrder.BIG_ENDIAN)
        .put(CHUNK_MAGIC).putShort(index.toShort()).putShort(total.toShort()).putShort(data.size.toShort())
        .put(data).putInt(crc.toInt()).array()
    }
  }

  fun decodeObjectChunk(bytes: ByteArray): BleObjectChunk {
    require(bytes.size >= CHUNK_OVERHEAD && bytes.size <= CHUNK_OVERHEAD + MAX_CHUNK_DATA) { "SGC2 frame size" }
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
    require(readMagic(buffer, CHUNK_MAGIC)) { "SGC2 magic" }
    val index = buffer.short.toInt() and 0xffff
    val total = buffer.short.toInt() and 0xffff
    val length = buffer.short.toInt() and 0xffff
    require(total in 1..MAX_CHUNKS && index < total && length in 1..MAX_CHUNK_DATA) { "SGC2 header" }
    require(bytes.size == CHUNK_OVERHEAD + length) { "SGC2 exact length" }
    val data = ByteArray(length).also(buffer::get)
    val expected = buffer.int.toLong() and 0xffffffffL
    val actual = CRC32().apply { update(data) }.value
    require(actual == expected) { "SGC2 CRC" }
    return BleObjectChunk(index, total, data)
  }

  fun encodeCustody(result: BleCustodyResult): ByteArray {
    require(result.digest.size == 32) { "SGK2 digest" }
    val accepted = result.result == BleCustodyCode.ACCEPTED_DURABLE
    if (accepted) {
      require(result.custodyReceiptId != null && result.acceptedAtMs != null && result.acceptedAtMs in 1..MAX_PROTOCOL_TIME) {
        "SGK2 accepted evidence"
      }
    } else {
      require(result.custodyReceiptId == null && result.acceptedAtMs == null) { "SGK2 non-success evidence must be zero" }
    }
    val out = ByteBuffer.allocate(CUSTODY_SIZE).order(ByteOrder.BIG_ENDIAN)
    out.put(CUSTODY_MAGIC)
    putUuid(out, result.objectId)
    out.put(result.digest)
    out.put(result.result.code.toByte())
    putUuid(out, result.custodyReceiptId ?: NIL_UUID, allowNil = true)
    out.putLong(result.acceptedAtMs ?: 0L)
    return out.array()
  }

  fun decodeCustody(bytes: ByteArray): BleCustodyResult {
    require(bytes.size == CUSTODY_SIZE) { "SGK2 length" }
    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
    require(readMagic(buffer, CUSTODY_MAGIC)) { "SGK2 magic" }
    val objectId = readUuid(buffer)
    val digest = ByteArray(32).also(buffer::get)
    val result = BleCustodyCode.fromCode(buffer.u8())
    val receipt = readUuid(buffer, allowNil = true)
    val acceptedAt = buffer.long
    require(acceptedAt in 0..MAX_PROTOCOL_TIME) { "SGK2 time" }
    if (result == BleCustodyCode.ACCEPTED_DURABLE) {
      require(receipt != NIL_UUID && acceptedAt > 0L) { "SGK2 accepted evidence" }
      return BleCustodyResult(objectId, digest, result, receipt, acceptedAt)
    }
    require(receipt == NIL_UUID && acceptedAt == 0L) { "SGK2 non-success evidence" }
    return BleCustodyResult(objectId, digest, result, null, null)
  }

  private fun encodeInventoryEntry(out: ByteBuffer, entry: InventoryEntry) {
    require(entry.digest.size == 32) { "inventory digest" }
    require(entry.reportProtocolVersion in 1..2 && entry.revision > 0) { "inventory report binding" }
    require(entry.forwardingExpiresAtMs in 0..MAX_PROTOCOL_TIME) { "inventory expiry" }
    if (entry.objectKind == ObjectKind.SOS) {
      require(entry.forwardingExpiresAtMs == 0L) { "SOS inventory expiry must be zero" }
    } else {
      require(entry.forwardingExpiresAtMs > 0L) { "receipt inventory expiry required" }
    }
    if (entry.objectKind == ObjectKind.OFFLINE_ROOT_REVOCATION) {
      require(entry.reportId == entry.objectId && entry.revision == 1 && entry.reportProtocolVersion == 1 &&
        entry.forwardingExpiresAtMs == MAX_PROTOCOL_TIME) { "revocation routing metadata" }
    }
    out.put(entry.objectKind.wireCode.toByte())
    putUuid(out, entry.objectId)
    out.put(entry.digest)
    putUuid(out, entry.reportId)
    out.put(entry.reportProtocolVersion.toByte())
    out.putInt(entry.revision)
    out.putLong(entry.forwardingExpiresAtMs)
  }

  private fun decodeInventoryEntry(buffer: ByteBuffer): InventoryEntry {
    require(buffer.remaining() >= INVENTORY_ENTRY_SIZE) { "inventory entry truncated" }
    val kindCode = buffer.u8()
    val kind = ObjectKind.entries.firstOrNull { it.wireCode == kindCode }
      ?: throw IllegalArgumentException("inventory object kind")
    val objectId = readUuid(buffer)
    val digest = ByteArray(32).also(buffer::get)
    val reportId = readUuid(buffer)
    val protocol = buffer.u8()
    val revision = buffer.int.toLong() and 0xffffffffL
    val expiry = buffer.long
    require(protocol in 1..2 && revision in 1..Int.MAX_VALUE.toLong()) { "inventory report binding" }
    require(expiry in 0..MAX_PROTOCOL_TIME) { "inventory expiry" }
    if (kind == ObjectKind.SOS) require(expiry == 0L) { "SOS inventory expiry must be zero" }
    else require(expiry > 0L) { "receipt inventory expiry required" }
    if (kind == ObjectKind.OFFLINE_ROOT_REVOCATION) {
      require(reportId == objectId && revision == 1L && protocol == 1 && expiry == MAX_PROTOCOL_TIME) {
        "revocation routing metadata"
      }
    }
    return InventoryEntry(
      objectKind = kind,
      objectId = objectId,
      digest = digest,
      reportId = reportId,
      revision = revision.toInt(),
      custodyAcceptedAtMs = 0L,
      reportProtocolVersion = protocol,
      forwardingExpiresAtMs = expiry,
    )
  }

  private fun readMagic(buffer: ByteBuffer, expected: ByteArray): Boolean {
    if (buffer.remaining() < expected.size) return false
    val actual = ByteArray(expected.size).also(buffer::get)
    return actual.contentEquals(expected)
  }

  private fun putUuid(buffer: ByteBuffer, value: String, allowNil: Boolean = false) {
    val uuid = UUID.fromString(value)
    require(allowNil || value != NIL_UUID) { "nil UUID" }
    buffer.putLong(uuid.mostSignificantBits)
    buffer.putLong(uuid.leastSignificantBits)
  }

  private fun readUuid(buffer: ByteBuffer, allowNil: Boolean = false): String {
    require(buffer.remaining() >= 16) { "UUID truncated" }
    val value = UUID(buffer.long, buffer.long).toString()
    require(allowNil || value != NIL_UUID) { "nil UUID" }
    return value
  }

  private fun ByteBuffer.u8(): Int = get().toInt() and 0xff
}

class BleReceiptExchangeReceiver(
  private val admit: (ObjectKind, ByteArray) -> CustodyResult,
  private val alreadyHaveVerified: (InventoryEntry) -> Boolean = { false },
  private val preflightDecision: (InventoryEntry) -> BleDecisionCode? = { null },
  private val offerAllowed: (String, InventoryEntry) -> Boolean = { _, _ -> true },
  private val nowProvider: () -> Long = { System.currentTimeMillis() },
  private val receiptIdProvider: () -> String = { UUID.randomUUID().toString() },
) {
  private data class Session(
    val entry: InventoryEntry,
    var lastActivityAtMs: Long,
    var expectedChunk: Int = 0,
    var expectedTotal: Int? = null,
    val bytes: ByteArrayOutputStream = ByteArrayOutputStream(),
  )

  private val sessions = LinkedHashMap<String, Session>()

  @Synchronized
  fun beginOffer(peerId: String, offerBytes: ByteArray): BleDecision {
    require(peerId.isNotBlank()) { "peer id" }
    val now = nowProvider()
    pruneExpiredSessions(now)
    val frame = try {
      BleReceiptExchangeCodec.decodeObjectFrame(offerBytes)
    } catch (_: IllegalArgumentException) {
      return rejectedDecisionForMalformedOffer(offerBytes)
    }
    val entry = frame.entry
    if (!offerAllowed(peerId, entry)) {
      return BleDecision(entry.objectId, entry.digest.copyOf(), BleDecisionCode.REJECTED)
    }
    preflightDecision(entry)?.let { code ->
      return BleDecision(entry.objectId, entry.digest.copyOf(), code)
    }
    if (alreadyHaveVerified(entry)) {
      return BleDecision(entry.objectId, entry.digest.copyOf(), BleDecisionCode.ALREADY_HAVE_VERIFIED)
    }
    if (sessions.containsKey(peerId)) {
      return BleDecision(entry.objectId, entry.digest.copyOf(), BleDecisionCode.REJECTED)
    }
    if (sessions.size >= MAX_REASSEMBLY_PEERS) {
      return BleDecision(entry.objectId, entry.digest.copyOf(), BleDecisionCode.CAPACITY_FULL)
    }
    sessions[peerId] = Session(entry, lastActivityAtMs = now)
    return BleDecision(entry.objectId, entry.digest.copyOf(), BleDecisionCode.ACCEPT_TRANSFER)
  }

  @Synchronized
  fun addChunk(peerId: String, chunkBytes: ByteArray): BleCustodyResult? {
    val session = sessions[peerId] ?: return null
    val now = nowProvider()
    if (now < session.lastActivityAtMs || now - session.lastActivityAtMs >= SESSION_TIMEOUT_MS) {
      sessions.remove(peerId)
      return failure(session.entry, BleCustodyCode.REJECTED)
    }
    session.lastActivityAtMs = now
    val chunk = try {
      BleReceiptExchangeCodec.decodeObjectChunk(chunkBytes)
    } catch (_: IllegalArgumentException) {
      sessions.remove(peerId)
      return failure(session.entry, BleCustodyCode.REJECTED)
    }
    if (session.expectedTotal == null) session.expectedTotal = chunk.totalChunks
    if (session.expectedTotal != chunk.totalChunks || chunk.chunkIndex != session.expectedChunk) {
      sessions.remove(peerId)
      return failure(session.entry, BleCustodyCode.REJECTED)
    }
    val objectLimit = if (session.entry.objectKind == ObjectKind.OFFLINE_ROOT_REVOCATION) 4096 else BleReceiptExchangeCodec.MAX_OBJECT_BYTES
    if (session.bytes.size() + chunk.data.size > objectLimit) {
      sessions.remove(peerId)
      return failure(session.entry, BleCustodyCode.REJECTED)
    }
    session.bytes.write(chunk.data)
    session.expectedChunk++
    if (session.expectedChunk < chunk.totalChunks) return null

    sessions.remove(peerId)
    val objectBytes = session.bytes.toByteArray()
    val digest = MessageDigest.getInstance("SHA-256").digest(objectBytes)
    if (!MessageDigest.isEqual(digest, session.entry.digest)) {
      return failure(session.entry, BleCustodyCode.REJECTED)
    }
    val admitted = try {
      admit(session.entry.objectKind, objectBytes)
    } catch (_: Exception) {
      return failure(session.entry, BleCustodyCode.REJECTED)
    }
    if (admitted.objectId != null && admitted.objectId != session.entry.objectId) {
      return failure(session.entry, BleCustodyCode.REJECTED)
    }
    if (admitted.digest != null && !MessageDigest.isEqual(admitted.digest, session.entry.digest)) {
      return failure(session.entry, BleCustodyCode.REJECTED)
    }
    return when (admitted.kind) {
      CustodyResultKind.COMMITTED -> {
        val now = nowProvider()
        val receiptId = receiptIdProvider()
        require(now in 1..9_007_199_254_740_991L) { "custody time" }
        require(receiptId != "00000000-0000-0000-0000-000000000000") { "custody receipt id" }
        BleCustodyResult(
          session.entry.objectId,
          session.entry.digest.copyOf(),
          BleCustodyCode.ACCEPTED_DURABLE,
          receiptId,
          now,
        )
      }
      CustodyResultKind.DUPLICATE -> failure(session.entry, BleCustodyCode.DUPLICATE_VERIFIED)
      CustodyResultKind.PENDING_VERIFICATION -> failure(session.entry, BleCustodyCode.UNVERIFIED_AUTHORITY)
      CustodyResultKind.CAPACITY_FULL -> failure(session.entry, BleCustodyCode.CAPACITY_FULL)
      CustodyResultKind.REJECTED -> failure(
        session.entry,
        if (admitted.reason?.contains("EXPIRED") == true) BleCustodyCode.EXPIRED else BleCustodyCode.REJECTED,
      )
    }
  }

  @Synchronized
  fun disconnect(peerId: String) {
    sessions.remove(peerId)
  }

  @Synchronized
  fun clear() {
    sessions.clear()
  }

  @Synchronized
  fun activePeerCount(): Int = sessions.size

  private fun pruneExpiredSessions(nowMs: Long) {
    val iterator = sessions.entries.iterator()
    while (iterator.hasNext()) {
      val session = iterator.next().value
      if (nowMs < session.lastActivityAtMs || nowMs - session.lastActivityAtMs >= SESSION_TIMEOUT_MS) {
        iterator.remove()
      }
    }
  }

  private fun failure(entry: InventoryEntry, result: BleCustodyCode) = BleCustodyResult(
    objectId = entry.objectId,
    digest = entry.digest.copyOf(),
    result = result,
    custodyReceiptId = null,
    acceptedAtMs = null,
  )

  private fun rejectedDecisionForMalformedOffer(bytes: ByteArray): BleDecision {
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
    return BleDecision("ffffffff-ffff-ffff-ffff-ffffffffffff", digest, BleDecisionCode.REJECTED)
  }

  companion object {
    const val MAX_REASSEMBLY_PEERS = 4
    const val SESSION_TIMEOUT_MS = 60_000L
  }
}
