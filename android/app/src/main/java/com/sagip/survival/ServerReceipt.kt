package com.sagip.survival

data class ServerReceipt(
  val receiptVersion: Int,
  val state: String,
  val receiptId: String,
  val messageId: String,
  val reportId: String,
  val revision: Int,
  val acceptedAt: String,
)
