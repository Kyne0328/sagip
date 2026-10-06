import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {validateReceiptPublicKey} from '../protocol/receiptV2.js';
import {
  GrantProvisioningService,
  type AuthorityPolicy,
  type QualifiedAuthorityTime,
} from './grantProvisioning.js';
import {GatewayReceiptFeed, type GatewayReceiptAccess} from './gatewayReceiptFeed.js';
import {OriginAuthorityTimeService} from './originAuthorityTimeService.js';
import {ReceiptService, type AuthoritySigner} from './receiptService.js';
import {OfflineRootSnapshotService, type OfflineRootSnapshotAdapter} from './offlineRootSnapshotService.js';
import {authenticateCustodyRequest} from './reportCustodyAccess.js';

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
  offlineRoot?: OfflineRootSnapshotAdapter;
}

export interface OfflineReceiptRuntime {
  refreshAuthorityTime?: () => Promise<void>;
  receiptService?: ReceiptService;
  authorityService?: GrantProvisioningService;
  originAuthorityTimeService?: OriginAuthorityTimeService;
  custodyAuthorityTimeService?: OriginAuthorityTimeService;
  gatewayReceiptFeed?: GatewayReceiptFeed;
  offlineRootSnapshotService?: OfflineRootSnapshotService;
}

export function offlineReceiptRuntimeMode(
  env: Readonly<Record<string, string | undefined>>,
): 'DISABLED' | 'ADAPTER' {
  const mode = env.SAGIP_OFFLINE_RECEIPTS_MODE ?? 'DISABLED';
  if (mode !== 'DISABLED' && mode !== 'ADAPTER')
    throw new Error('INVALID_OFFLINE_RECEIPTS_MODE');
  return mode;
}

// Shipping entrypoints use the explicit public manifest and configured custody/time
// adapter. A mode toggle alone cannot supply keys, enroll registry trust, or qualify
// a clock. Lazy construction keeps optional authority outages separate from SOS ingestion.
export function createOfflineReceiptRuntime(
  pool: Pick<Pool, 'connect'>,
  env: Readonly<Record<string, string | undefined>>,
  adapter?: OfflineReceiptRuntimeAdapter,
  deferClockQualification = false,
): OfflineReceiptRuntime {
  if (offlineReceiptRuntimeMode(env) === 'DISABLED') return {};
  if (!adapter) throw new Error('OFFLINE_RECEIPTS_ADAPTER_REQUIRED');
  const requireQualified = (): void => {
    if (!adapter.isQualified()) throw new Error('AUTHORITY_UNAVAILABLE');
  };
  if (!deferClockQualification) requireQualified();
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
  if (!deferClockQualification) time();
  const signer: AuthoritySigner = {
    publicKeyDer,
    assertActive: async c => { if (snapshots) await snapshots.assertRootActive(c); },
    sign: async (bytes, c) => {
      requireQualified();
      return snapshots ? snapshots.signWithRootAuthority(bytes, adapter.signer, c) : adapter.signer.sign(bytes, c);
    },
  };
  const interval = () => {
    const t = time();
    return {earliestMs: t.timeMs - t.uncertaintyMs, latestMs: t.timeMs + t.uncertaintyMs};
  };
  const snapshots = adapter.offlineRoot ?
    new OfflineRootSnapshotService(pool, publicKeyDer, adapter.offlineRoot, time) : undefined;
  return {
    ...(snapshots ? {offlineRootSnapshotService: snapshots} : {}),
    receiptService: new ReceiptService(pool, signer, () => {
      const t = time(); return snapshots ? t.timeMs - t.uncertaintyMs : t.timeMs;
    }, interval, snapshots ? eventId => snapshots.issueCommitted(eventId) : undefined),
    authorityService: new GrantProvisioningService(pool, signer, time, adapter.authorityPolicy),
    originAuthorityTimeService: new OriginAuthorityTimeService(pool, signer, time),
    ...(snapshots?.policy.disseminationAudience === 'ORIGIN_AND_CUSTODY_RELAYS' ? {
      custodyAuthorityTimeService: new OriginAuthorityTimeService(pool, signer, time,
        (c, reportId, body, signature) => authenticateCustodyRequest(c, reportId, 'authority/time', body, signature)),
    } : {}),
    gatewayReceiptFeed: new GatewayReceiptFeed(pool, publicKeyDer, interval, {
      allowedRoles: adapter.gatewayAccess.allowedRoles,
      isReportAuthorized: (actor, reportId) => {
        requireQualified();
        return adapter.gatewayAccess.isReportAuthorized(actor, reportId);
      },
    }, snapshots),
  };
}
