import {createHash, createPublicKey, verify} from 'node:crypto';
import type {PoolClient} from 'pg';
import {MAX_ENVELOPE_BYTES} from '../protocol/envelopeV1.js';
import {canonicalizeNewReceiptSignature, validateReceiptPublicKey} from '../protocol/receiptV2.js';
import type {TimeChallenge} from './grantProvisioning.js';

export const MAX_CUSTODY_REQUEST_BYTES = 16384;
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const NIL = '00000000-0000-0000-0000-000000000000';
export type CustodyOperation = 'receipts' | 'authority/time';
export function custodyRequestSigningInput(reportId: string, operation: CustodyOperation, body: Uint8Array): Buffer {
  if (!UUID.test(reportId)) throw new Error('INVALID_FIELDS');
  return Buffer.from('SAGIP-CUSTODY-REQUEST-V1\nPOST\n/v2/custody/reports/' + reportId + '/' + operation +
    '\n' + createHash('sha256').update(body).digest('hex') + '\n');
}
export interface CustodyChallenge extends TimeChallenge {envelope: Buffer; cursor: string | null}
/** Possession of the exact accepted SOS permits only its note-free return feed and verifier-bound time. */
export async function authenticateCustodyRequest(c: Pick<PoolClient, 'query'>, reportId: string,
  operation: CustodyOperation, body: Buffer, signature: string | null): Promise<CustodyChallenge | null> {
  if (!UUID.test(reportId) || body.length > MAX_CUSTODY_REQUEST_BYTES || !signature || signature.length !== 88) return null;
  let challenge: CustodyChallenge;
  try {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(body);
    const f = JSON.parse(text) as Record<string, unknown>;
    const keys = ['verifierId', 'verifierBootSessionId', 'nonce', 'verifierPublicKeyDer', 'envelopeBase64',
      ...(operation === 'receipts' ? ['cursor'] : [])];
    if (!f || Array.isArray(f) || JSON.stringify(f) !== text || Object.keys(f).length !== keys.length ||
      !keys.every(k => Object.hasOwn(f, k))) return null;
    const bytes = (v: unknown, min: number, max: number) => {
      if (typeof v !== 'string' || v.length > Math.ceil(max / 3) * 4) throw new Error('INVALID');
      const b = Buffer.from(v, 'base64');
      if (b.length < min || b.length > max || b.toString('base64') !== v) throw new Error('INVALID'); return b;
    };
    const verifierId = bytes(f.verifierId, 32, 32), nonce = bytes(f.nonce, 32, 32);
    const publicKey = bytes(f.verifierPublicKeyDer, 91, 91);
    validateReceiptPublicKey(publicKey);
    if (!createHash('sha256').update(publicKey).digest().equals(verifierId) ||
      typeof f.verifierBootSessionId !== 'string' || !UUID.test(f.verifierBootSessionId) || f.verifierBootSessionId === NIL) return null;
    const cursor = operation === 'receipts' ? f.cursor : null;
    if (cursor !== null && (typeof cursor !== 'string' || !/^[0-9a-f]{64}$/u.test(cursor))) return null;
    const sig = bytes(signature, 64, 64);
    if (!canonicalizeNewReceiptSignature(sig).equals(sig) || !verify('sha256',
      custodyRequestSigningInput(reportId, operation, body),
      {key: createPublicKey({key: publicKey, format: 'der', type: 'spki'}), dsaEncoding: 'ieee-p1363'}, sig)) return null;
    challenge = {verifierId, nonce, verifierBootSessionId: f.verifierBootSessionId,
      envelope: bytes(f.envelopeBase64, 1, MAX_ENVELOPE_BYTES), cursor: cursor as string | null};
  } catch { return null; }
  // Storage errors propagate; an unavailable database is not an authorization decision.
  const accepted = await c.query('SELECT 1 FROM accepted_messages WHERE report_id=$1 AND envelope_bytes=$2 LIMIT 1',
    [reportId, challenge.envelope]);
  return accepted.rows.length === 1 ? challenge : null;
}
