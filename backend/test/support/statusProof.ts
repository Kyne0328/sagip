import {generateKeyPairSync, randomBytes, sign, type KeyObject} from 'node:crypto';
import {canonicalizeNewReceiptSignature} from '../../src/protocol/receiptV2.js';

// Ephemeral test identity only. Never reads application credentials or a live database.
export function statusTestIdentity() {
  return generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
}

export function statusProofHeaders(
  reportId: string,
  privateKey: KeyObject,
  cursor: string | null = null,
  timestampMs = Date.now(),
): Record<string, string> {
  const timestamp = String(timestampMs);
  const nonce = randomBytes(32).toString('base64');
  // Keep the wire construction here independent from the production helper.
  const domain = Buffer.from(`SAGIP-REPORT-STATUS-V1\n${reportId.toLowerCase()}\n${timestamp}\n${nonce}\n${cursor ?? ''}\n`, 'utf8');
  const signature = canonicalizeNewReceiptSignature(sign('sha256', domain, {key: privateKey, dsaEncoding: 'ieee-p1363'}));
  return {
    'x-sagip-status-timestamp': timestamp,
    'x-sagip-status-nonce': nonce,
    'x-sagip-status-signature': signature.toString('base64'),
  };
}
