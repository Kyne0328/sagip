package com.sagip.survival

interface SigningIdentity {
  val keyId: ByteArray
  val publicKeyDer: ByteArray
  fun sign(data: ByteArray): ByteArray
}
