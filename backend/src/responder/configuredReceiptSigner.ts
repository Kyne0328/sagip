import {createHash, createPrivateKey, createPublicKey, sign} from 'node:crypto';
import {canonicalizeNewReceiptSignature, validateReceiptPublicKey} from '../protocol/receiptV2.js';
import type {AuthoritySigner} from './receiptService.js';
import type {OfflineReceiptRuntimeAdapter} from './offlineReceiptRuntime.js';

export function configuredPkcs8Signer(pkcs8Pem: string, pinnedPublicKeyId: string): AuthoritySigner {
  try {
    if (!/^[a-f0-9]{64}$/.test(pinnedPublicKeyId) || typeof pkcs8Pem !== 'string' ||
      pkcs8Pem.length > 4096 || !pkcs8Pem.startsWith('-----BEGIN PRIVATE KEY-----'))
      throw new Error('INVALID');
    const privateKey = createPrivateKey({key: pkcs8Pem, format: 'pem', type: 'pkcs8'});
    if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
      throw new Error('INVALID');
    const publicKeyDer = createPublicKey(privateKey).export({format: 'der', type: 'spki'});
    validateReceiptPublicKey(publicKeyDer);
    if (createHash('sha256').update(publicKeyDer).digest('hex') !== pinnedPublicKeyId)
      throw new Error('INVALID');
    return {publicKeyDer, sign: async input => canonicalizeNewReceiptSignature(
      sign('sha256', input, {key: privateKey, dsaEncoding: 'ieee-p1363'}))};
  } catch {
    // Never include supplied key bytes or crypto parser errors in logs/responses.
    throw new Error('RECEIPT_SIGNER_CONFIGURATION_INVALID');
  }
}
type TrustedConfiguration = Omit<OfflineReceiptRuntimeAdapter, 'signer' | 'offlineRoot'> & {
  offlineRoot: Omit<NonNullable<OfflineReceiptRuntimeAdapter['offlineRoot']>, 'checkpointSigner'>;
};
/** Explicit bootstrap helper only. Does not read process.env, enroll trust, or qualify a clock. */
export function configuredOfflineReceiptAdapter(
  secrets: Readonly<Record<string, string | undefined>>, trusted: TrustedConfiguration,
): OfflineReceiptRuntimeAdapter {
  const signer = configuredPkcs8Signer(secrets.SAGIP_RECEIPT_SIGNER_PKCS8 ?? '', trusted.pinnedRootKeyId);
  const checkpointSigner = configuredPkcs8Signer(secrets.SAGIP_SNAPSHOT_SIGNER_PKCS8 ?? '',
    trusted.offlineRoot.pinnedCheckpointSignerKeyId);
  if (trusted.pinnedRootKeyId === trusted.offlineRoot.pinnedCheckpointSignerKeyId)
    throw new Error('INDEPENDENT_CHECKPOINT_SIGNER_REQUIRED');
  return {...trusted, signer, offlineRoot: {...trusted.offlineRoot, checkpointSigner}};
}
