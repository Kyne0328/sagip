import {createPublicKey, timingSafeEqual, verify} from 'node:crypto';
import {canonicalizeNewReceiptSignature, validateReceiptPublicKey} from '../protocol/receiptV2.js';

export interface ReportStatusAccessProof {
  timestamp: string;
  nonce: string;
  signature: Buffer;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const REPORT_STATUS_PROOF_WINDOW_MS = 60_000;

export function reportStatusAccessDomain(
  reportId: string,
  proof: Pick<ReportStatusAccessProof, 'timestamp' | 'nonce'>,
  cursor: string | null,
): Buffer {
  return Buffer.from(
    'SAGIP-REPORT-STATUS-V1\n' + reportId.toLowerCase() + '\n' +
    proof.timestamp + '\n' + proof.nonce + '\n' + (cursor ?? '') + '\n',
    'utf8',
  );
}

export function validReportStatusCursor(cursor: string | null): boolean {
  return cursor === null || UUID.test(cursor);
}

export function parseReportStatusAccessProof(
  headers: Headers,
  now = Date.now(),
): ReportStatusAccessProof | null {
  const timestamp = headers.get('x-sagip-status-timestamp') ?? '';
  const nonce = headers.get('x-sagip-status-nonce') ?? '';
  const signatureBase64 = headers.get('x-sagip-status-signature') ?? '';
  if (!/^[1-9][0-9]{0,15}$/u.test(timestamp)) return null;
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs) ||
      Math.abs(now - timestampMs) > REPORT_STATUS_PROOF_WINDOW_MS) return null;
  // Bound before decoding, then reject permissive base64 aliases and non-low-S signatures.
  if (nonce.length !== 44 || signatureBase64.length !== 88) return null;
  const nonceBytes = Buffer.from(nonce, 'base64');
  const signature = Buffer.from(signatureBase64, 'base64');
  if (nonceBytes.length !== 32 || nonceBytes.toString('base64') !== nonce ||
      signature.length !== 64 || signature.toString('base64') !== signatureBase64) return null;
  try {
    if (!timingSafeEqual(canonicalizeNewReceiptSignature(signature), signature)) return null;
  } catch {
    return null;
  }
  return {timestamp, nonce, signature};
}

export function verifyReportStatusAccessProof(
  reportId: string,
  proof: ReportStatusAccessProof,
  cursor: string | null,
  publicKeyDer: Uint8Array,
): boolean {
  try {
    if (!UUID.test(reportId.toLowerCase()) || !validReportStatusCursor(cursor)) return false;
    validateReceiptPublicKey(publicKeyDer);
    return verify('sha256', reportStatusAccessDomain(reportId, proof, cursor), {
      key: createPublicKey({key: Buffer.from(publicKeyDer), format: 'der', type: 'spki'}),
      dsaEncoding: 'ieee-p1363',
    }, proof.signature);
  } catch {
    return false;
  }
}
