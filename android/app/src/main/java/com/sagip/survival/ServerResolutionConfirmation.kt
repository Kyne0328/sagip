package com.sagip.survival

/** A historical root snapshot may be superseded only by its exact authenticated online event. */
internal object ServerResolutionConfirmation {
  fun matches(
    reportId: String, revision: Int, serverAckId: String, serverStatus: String,
    serverRevision: Int, serverCheckedAt: Long, historyComplete: Boolean,
    receipt: ReceiptFields.Responder,
  ): Boolean = historyComplete && revision > 0 && serverRevision == revision &&
    serverStatus == "RESOLVED" && receipt.status == 4 && receipt.providerKind == 1 &&
    receipt.grantId == "00000000-0000-0000-0000-000000000000" &&
    receipt.reportId == reportId && receipt.revision == revision &&
    receipt.actionId == serverAckId && serverCheckedAt >= receipt.issuedAtMs
}
