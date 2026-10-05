import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {validateReceiptPublicKey} from '../protocol/receiptV2.js';
import {
  GrantProvisioningService,
  type AuthorityPolicy,
  type QualifiedAuthorityTime,
} from './grantProvisioning.js';
import {GatewayReceiptFeed, type GatewayReceiptAccess} from './gatewayReceiptFeed.js';
import {ReceiptService, type AuthoritySigner} from './receiptService.js';

const WEEK = 604800000;

export interface OfflineReceiptRuntimeAdapter {
  // Supplied by an explicitly approved deployment integration, never request JSON.
  // This module does not load credentials, generate keys, or install trust.
  signer: AuthoritySigner;
  pinnedRootKeyId: string;
  qualifiedTime(): QualifiedAuthorityTime;
  isQualified(): boolean;
  authorityPolicy: AuthorityPolicy;
  gatewayAccess: GatewayReceiptAccess;
}

export interface OfflineReceiptRuntime {
  receiptService?: ReceiptService;
  authorityService?: GrantProvisioningService;
  gatewayReceiptFeed?: GatewayReceiptFeed;
}

export function offlineReceiptRuntimeMode(
  env: Readonly<Record<string, string | undefined>>,
): 'DISABLED' | 'ADAPTER' {
  const mode = env.SAGIP_OFFLINE_RECEIPTS_MODE ?? 'DISABLED';
  if (mode !== 'DISABLED' && mode !== 'ADAPTER')
    throw new Error('INVALID_OFFLINE_RECEIPTS_MODE');
  return mode;
}

// Both shipping entrypoints call this without an adapter. Thus an environment
// toggle alone can never activate authority. ADAPTER requires a separate,
// approved custody/time/access integration supplied by its caller.
export function createOfflineReceiptRuntime(
  pool: Pick<Pool, 'connect'>,
  env: Readonly<Record<string, string | undefined>>,
  adapter?: OfflineReceiptRuntimeAdapter,
): OfflineReceiptRuntime {
  if (offlineReceiptRuntimeMode(env) === 'DISABLED') return {};
  if (!adapter) throw new Error('OFFLINE_RECEIPTS_ADAPTER_REQUIRED');
  const requireQualified = (): void => {
    if (!adapter.isQualified()) throw new Error('AUTHORITY_UNAVAILABLE');
  };
  requireQualified();
  const publicKeyDer = Buffer.from(adapter.signer.publicKeyDer);
  validateReceiptPublicKey(publicKeyDer);
  const keyId = createHash('sha256').update(publicKeyDer).digest('hex');
  if (!/^[0-9a-f]{64}$/u.test(adapter.pinnedRootKeyId) ||
      keyId !== adapter.pinnedRootKeyId)
    throw new Error('OFFLINE_RECEIPTS_ROOT_MISMATCH');
  const time = (): QualifiedAuthorityTime => {
    requireQualified();
    const t = adapter.qualifiedTime();
    if (!Number.isSafeInteger(t.timeMs) || !Number.isSafeInteger(t.uncertaintyMs) ||
        !Number.isSafeInteger(t.validForMs) || t.uncertaintyMs < 0 ||
        t.uncertaintyMs > 60000 || t.timeMs < t.uncertaintyMs ||
        t.validForMs <= t.uncertaintyMs || t.validForMs > WEEK ||
        !Number.isSafeInteger(t.timeMs + WEEK))
      throw new Error('TIME_UNAVAILABLE');
    return {...t};
  };
  time();
  const signer: AuthoritySigner = {
    publicKeyDer,
    sign: async bytes => {
      requireQualified();
      return adapter.signer.sign(bytes);
    },
  };
  const interval = () => {
    const t = time();
    return {earliestMs: t.timeMs - t.uncertaintyMs, latestMs: t.timeMs + t.uncertaintyMs};
  };
  return {
    receiptService: new ReceiptService(pool, signer, () => time().timeMs, interval),
    authorityService: new GrantProvisioningService(pool, signer, time, adapter.authorityPolicy),
    gatewayReceiptFeed: new GatewayReceiptFeed(pool, publicKeyDer, interval, {
      allowedRoles: adapter.gatewayAccess.allowedRoles,
      isReportAuthorized: (actor, reportId) => {
        requireQualified();
        return adapter.gatewayAccess.isReportAuthorized(actor, reportId);
      },
    }),
  };
}
