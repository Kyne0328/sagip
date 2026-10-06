import {createHash, createPublicKey, verify} from 'node:crypto';
import {canonicalizeNewReceiptSignature, validateReceiptPublicKey} from '../protocol/receiptV2.js';
import type {TimeChallenge} from './grantProvisioning.js';
export function deviceTimeSigningInput(body: Uint8Array): Buffer {
  return Buffer.from('SAGIP-DEVICE-TIME-REQUEST-V1\nPOST\n/v2/authority/device-time\n' +
    createHash('sha256').update(body).digest('hex') + '\n');
}
/** Time-only proof of installation-key possession; this grants no report/responder access. */
export async function authenticateDeviceTimeRequest(body: Buffer, signature: string | null): Promise<TimeChallenge | null> {
  if (body.length > 4096 || !signature || signature.length !== 88) return null;
  try {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(body);
    const f = JSON.parse(text) as Record<string, unknown>;
    const fields = ['verifierId', 'verifierBootSessionId', 'nonce', 'verifierPublicKeyDer'];
    if (!f || Array.isArray(f) || JSON.stringify(f) !== text || Object.keys(f).length !== fields.length ||
      !fields.every(k => Object.hasOwn(f, k))) return null;
    const bytes = (value: unknown, length: number) => {
      if (typeof value !== 'string' || value.length > Math.ceil(length / 3) * 4) throw new Error('INVALID');
      const b = Buffer.from(value, 'base64');
      if (b.length !== length || b.toString('base64') !== value) throw new Error('INVALID'); return b;
    };
    const verifierId = bytes(f.verifierId, 32), nonce = bytes(f.nonce, 32), key = bytes(f.verifierPublicKeyDer, 91);
    validateReceiptPublicKey(key);
    if (!createHash('sha256').update(key).digest().equals(verifierId) ||
      typeof f.verifierBootSessionId !== 'string' || f.verifierBootSessionId === '00000000-0000-0000-0000-000000000000' ||
      !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(f.verifierBootSessionId)) return null;
    const sig = bytes(signature, 64);
    if (!canonicalizeNewReceiptSignature(sig).equals(sig) || !verify('sha256', deviceTimeSigningInput(body),
      {key: createPublicKey({key, format: 'der', type: 'spki'}), dsaEncoding: 'ieee-p1363'}, sig)) return null;
    return {verifierId, nonce, verifierBootSessionId: f.verifierBootSessionId};
  } catch { return null; }
}
