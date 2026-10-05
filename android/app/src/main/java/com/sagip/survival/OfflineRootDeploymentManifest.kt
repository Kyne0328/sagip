package com.sagip.survival

import android.content.Context
import java.io.FileNotFoundException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.Collections
import java.util.UUID

internal data class OfflineRootElapsedClockProfile(
  val buildFingerprint: String,
  val sdkInt: Int,
  val maximumDriftPpm: Int,
  val maximumCheckpointAgeMs: Long,
  val evidenceId: String,
)

/** Public trust data from the signed APK only. Returned pins cannot mutate this deployment. */
internal class OfflineRootDeployment(
  val policy: OfflineRootPolicy,
  roots: Map<String, ByteArray>,
  signers: Map<String, ByteArray>,
  val initialEpoch: Long,
  val initialAuthorityStateDigest: String,
  val endpoint: String,
  val timeSignerKeyId: String,
  val timeSourceId: String,
  profiles: List<OfflineRootElapsedClockProfile>,
) {
  private val roots = roots.mapValues { it.value.copyOf() }
  private val signers = signers.mapValues { it.value.copyOf() }
  val rootPins: Map<String, ByteArray> get() = Collections.unmodifiableMap(roots.mapValues { it.value.copyOf() })
  val checkpointSignerPins: Map<String, ByteArray> get() = Collections.unmodifiableMap(signers.mapValues { it.value.copyOf() })
  val qualifiedElapsedClockProfiles: List<OfflineRootElapsedClockProfile> = Collections.unmodifiableList(profiles.toList())

  fun clockQualification(buildFingerprint: String, sdkInt: Int, bootId: String): OfflineRootClockQualification? {
    if (bootId == "00000000-0000-0000-0000-000000000000" ||
      runCatching { UUID.fromString(bootId).toString() == bootId }.getOrDefault(false).not()) return null
    val profile = qualifiedElapsedClockProfiles.singleOrNull {
      it.buildFingerprint == buildFingerprint && it.sdkInt == sdkInt
    } ?: return null
    return OfflineRootClockQualification(timeSourceId, timeSignerKeyId, bootId,
      profile.maximumDriftPpm, profile.maximumCheckpointAgeMs)
  }
}

/** The sole runtime entry point reads one APK-packaged asset. No downloaded/preference trust sources. */
internal object OfflineRootDeploymentManifest {
  const val ASSET_NAME = "offline-root-authority.json"
  private const val MAX_BYTES = 32 * 1024
  private val HEX = Regex("[0-9a-f]{64}")
  private val LABEL = Regex("[A-Z0-9_:-]{1,64}")
  private const val NIL = "00000000-0000-0000-0000-000000000000"

  fun load(context: Context): OfflineRootDeployment? = try {
    context.applicationContext.assets.open(ASSET_NAME).use { input ->
      val out = java.io.ByteArrayOutputStream()
      val chunk = ByteArray(2048)
      while (true) {
        val n = input.read(chunk)
        if (n < 0) break
        require(out.size() + n <= MAX_BYTES) { "DEPLOYMENT_SIZE" }
        out.write(chunk, 0, n)
      }
      parse(out.toByteArray())
    }
  } catch (_: FileNotFoundException) { null }
    catch (_: Exception) { null }

  internal fun parse(bytes: ByteArray): OfflineRootDeployment? {
    require(bytes.size <= MAX_BYTES) { "DEPLOYMENT_SIZE" }
    if (bytes.isEmpty()) return null
    val source = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
    if (source.all { it in " \r\n\t" }) return null
    val root = fields(Json(source).read(), setOf("format","version","mode","endpoint","policy","rootPins",
      "checkpointSignerPins","initialEpoch","initialAuthorityStateDigest","timeSignerKeyId",
      "timeSourceId","qualifiedElapsedClockProfiles"))
    require(text(root,"format") == "SAGIP_OFFLINE_ROOT_DEPLOYMENT" && number(root,"version") == 1L)
    val mode = text(root,"mode")
    require(mode == "BOUNDED_OFFLINE_ROOT_SNAPSHOT")
    val policy = policy(root.getValue("policy"))
    require(policy.mode == mode)
    OfflineRootSnapshotCodec.policyDigest(policy) // Exact existing policy semantics and limits.
    val roots = pins(root.getValue("rootPins"))
    val signers = pins(root.getValue("checkpointSignerPins"))
    val timeSigner = text(root,"timeSignerKeyId")
    val timeSource = text(root,"timeSourceId")
    require(timeSigner in roots && timeSource in policy.qualifiedTimeSourceIds)
    require(signers.keys == policy.signerBindings.map { it.checkpointSignerKeyId }.toSet())
    require(roots.keys == (policy.signerBindings.map { it.receiptRootKeyId } + timeSigner).toSet())
    for (binding in policy.signerBindings) {
      require(binding.receiptRootKeyId in roots && binding.checkpointSignerKeyId in signers)
      val keyId = OfflineRootSnapshotCodec.hash(roots.getValue(binding.receiptRootKeyId))
      require(OfflineRootSnapshotCodec.hex(ReceiptAuthority.issuerProviderId(1,keyId,NIL)) == binding.issuerProviderId)
    }
    val epochText = text(root,"initialEpoch")
    require(epochText.matches(Regex("0|[1-9][0-9]{0,18}")))
    val epoch = requireNotNull(epochText.toLongOrNull())
    val state = text(root,"initialAuthorityStateDigest").also { require(HEX.matches(it)) }
    val endpoint = text(root,"endpoint").also {
      require(it.length <= 2048)
      val uri = java.net.URI(it)
      require(uri.scheme == "https" && uri.host != null && uri.rawUserInfo == null &&
        uri.rawQuery == null && uri.rawFragment == null && (uri.rawPath.isNullOrEmpty() || uri.rawPath == "/"))
      require(uri.port == -1 || uri.port in 1..65535)
    }.trimEnd('/')
    val profiles = array(root.getValue("qualifiedElapsedClockProfiles")).map {
      val p = fields(it,setOf("buildFingerprint","sdkInt","maximumDriftPpm","maximumCheckpointAgeMs","evidenceId"))
      val fingerprint = text(p,"buildFingerprint")
      val sdk = number(p,"sdkInt")
      val drift = number(p,"maximumDriftPpm")
      val age = number(p,"maximumCheckpointAgeMs")
      val evidence = text(p,"evidenceId")
      require(fingerprint.length in 1..512 && fingerprint.all { ch -> ch.code in 33..126 })
      require(sdk in 24..Int.MAX_VALUE.toLong() && drift in 0..100 && age in 1..86_400_000L && LABEL.matches(evidence))
      OfflineRootElapsedClockProfile(fingerprint,sdk.toInt(),drift.toInt(),age,evidence)
    }
    require(profiles.map { it.buildFingerprint to it.sdkInt }.toSet().size == profiles.size)
    return OfflineRootDeployment(policy,roots,signers,epoch,state,endpoint,timeSigner,timeSource,profiles)
  }

  private fun policy(value: Any): OfflineRootPolicy {
    val p = fields(value,setOf("mode","authorityDomainId","signerBindings","allowedScopes","allowedStatuses",
      "maxAuthorityStalenessMs","maxReceiptIssuanceAgeMs","maxProofValidityMs","qualifiedTimeSourceIds",
      "disseminationAudience","providerConflictHandling","resolvedHandling","maxReplayRecords"))
    val bindings = array(p.getValue("signerBindings")).map {
      val b=fields(it,setOf("checkpointSignerKeyId","receiptRootKeyId","issuerProviderId"))
      OfflineRootSignerBinding(text(b,"checkpointSignerKeyId"),text(b,"receiptRootKeyId"),text(b,"issuerProviderId"))
    }
    fun strings(name: String) = immutable(array(p.getValue(name)).map { it as? String ?: error("DEPLOYMENT_TYPE") })
    val statuses = array(p.getValue("allowedStatuses")).map {
      val n=it as? Long ?: error("DEPLOYMENT_TYPE"); require(n in 1..4);n.toInt()
    }
    val replay = number(p,"maxReplayRecords").also { require(it in 1..100000) }.toInt()
    return OfflineRootPolicy(text(p,"mode"),text(p,"authorityDomainId"),immutable(bindings),strings("allowedScopes"),
      immutable(statuses),number(p,"maxAuthorityStalenessMs"),number(p,"maxReceiptIssuanceAgeMs"),
      number(p,"maxProofValidityMs"),strings("qualifiedTimeSourceIds"),text(p,"disseminationAudience"),
      text(p,"providerConflictHandling"),text(p,"resolvedHandling"),replay)
  }
  private fun pins(value: Any): Map<String,ByteArray> {
    val result = linkedMapOf<String,ByteArray>()
    for (item in array(value)) {
      val pin=fields(item,setOf("keyId","publicKeyDerBase64"))
      val id=text(pin,"keyId");val encoded=text(pin,"publicKeyDerBase64")
      require(HEX.matches(id) && encoded.length in 1..256 && id !in result)
      val key=decodeBase64(encoded)
      ReceiptV2Codec.validatePublicKey(key)
      require(OfflineRootSnapshotCodec.digest(key)==id)
      result[id]=key
    }
    require(result.isNotEmpty())
    return result
  }
  private fun decodeBase64(value: String): ByteArray {
    require(value.length % 4 == 0 && value.matches(Regex("[A-Za-z0-9+/]+={0,2}")))
    val alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    val out=java.io.ByteArrayOutputStream()
    for (i in value.indices step 4) {
      val a=alphabet.indexOf(value[i]);val b=alphabet.indexOf(value[i+1])
      val c=if(value[i+2]=='=') 0 else alphabet.indexOf(value[i+2])
      val d=if(value[i+3]=='=') 0 else alphabet.indexOf(value[i+3])
      require(a>=0 && b>=0 && c>=0 && d>=0)
      val n=(a shl 18) or (b shl 12) or (c shl 6) or d
      out.write(n ushr 16)
      if(value[i+2]!='=') out.write(n ushr 8)
      if(value[i+3]!='=') out.write(n)
    }
    return out.toByteArray().also { require(StatusRequestProof.base64(it)==value) }
  }
  private fun fields(value: Any, expected: Set<String>): Map<String,Any> {
    val map=value as? Map<*,*> ?: error("DEPLOYMENT_OBJECT")
    require(map.keys==expected) { "DEPLOYMENT_FIELDS" }
    return map.entries.associate { (k,v) -> (k as String) to requireNotNull(v) }
  }
  private fun text(map: Map<String,Any>, name: String) = map.getValue(name) as? String ?: error("DEPLOYMENT_STRING")
  private fun number(map: Map<String,Any>, name: String) = map.getValue(name) as? Long ?: error("DEPLOYMENT_INTEGER")
  private fun array(value: Any): List<Any> {
    val list=value as? List<*> ?: error("DEPLOYMENT_ARRAY")
    require(list.size<=64);return list.map { requireNotNull(it) }
  }
  private fun <T> immutable(values: List<T>): List<T> = Collections.unmodifiableList(values.toList())

  /** Bounded schema JSON: ASCII strings, nonnegative integers, objects and arrays only. */
  private class Json(private val source: String) {
    private var position=0
    fun read(): Any { val v=value(0);space();require(position==source.length);return v }
    private fun space() { while(position<source.length && source[position] in " \r\n\t") position++ }
    private fun take(char: Char): Boolean { space();if(source.getOrNull(position)!=char)return false;position++;return true }
    private fun value(depth: Int): Any {
      require(depth<=8);space()
      return when(source.getOrNull(position)) {
        '{' -> {
          position++;val result=linkedMapOf<String,Any>()
          if(!take('}')) while(true) {
            space();val key=string();require(key !in result && result.size<64)
            require(take(':'));result[key]=value(depth+1)
            if(take('}'))break;require(take(','))
          };result
        }
        '[' -> {
          position++;val result=mutableListOf<Any>()
          if(!take(']')) while(true) {
            require(result.size<64);result+=value(depth+1)
            if(take(']'))break;require(take(','))
          };result
        }
        '"' -> string()
        in '0'..'9' -> {
          val start=position
          while(source.getOrNull(position)?.let { it in '0'..'9' } == true)position++
          val token=source.substring(start,position)
          require(token=="0" || !token.startsWith("0"))
          requireNotNull(token.toLongOrNull())
        }
        else -> error("DEPLOYMENT_JSON")
      }
    }
    private fun string(): String {
      require(source.getOrNull(position)=='"');position++
      val out=StringBuilder()
      while(true) {
        val ch=source.getOrNull(position++) ?: error("DEPLOYMENT_JSON")
        if(ch=='"')return out.toString()
        if(ch=='\\') {
          val escaped=source.getOrNull(position++) ?: error("DEPLOYMENT_JSON")
          require(escaped in listOf('"','\\','/'));out.append(escaped)
        } else { require(ch.code in 32..126);out.append(ch) }
        require(out.length<=2048)
      }
    }
  }
}
