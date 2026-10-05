import type {Pool} from 'pg';
import {offlineRootPolicyDigest, type OfflineRootSnapshotPolicy} from '../protocol/offlineRootSnapshot.js';
import {createQualifiedOfflineReceiptRuntime, type ConfiguredOfflineReceiptTrust} from './qualifiedOfflineReceiptRuntime.js';
import {offlineReceiptRuntimeMode, type OfflineReceiptRuntime} from './offlineReceiptRuntime.js';
import {RoughtimeClock, type RoughtimeClockPolicy} from './roughtimeClock.js';

const fail = (ok: unknown): void => { if (!ok) throw new Error('INVALID_OFFLINE_RECEIPTS_CONFIGURATION'); };
const HEX = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
function object(value: unknown): Record<string, unknown> {
  fail(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: string[]) {
  fail(Object.keys(value).length === fields.length && fields.every(k => Object.hasOwn(value, k)));
}
function text(value: unknown, pattern: RegExp): string {
  fail(typeof value === 'string' && pattern.test(value as string)); return value as string;
}
function list(value: unknown, pattern: RegExp, max = 64): string[] {
  fail(Array.isArray(value) && value.length > 0 && value.length <= max);
  const result = (value as unknown[]).map(v => text(v, pattern));
  fail(new Set(result).size === result.length); return result;
}
const ROLE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SCOPE = /^[A-Z0-9_:-]{1,64}$/u;

/** Public deployment manifest, never request JSON. Contains no private keys or bearer tokens. */
export function parseOfflineReceiptConfiguration(raw: string): {
  trust: ConfiguredOfflineReceiptTrust; time: RoughtimeClockPolicy;
} {
  fail(typeof raw === 'string' && Buffer.byteLength(raw) <= 65536);
  const config = object(JSON.parse(raw));
  exact(config, ['schema', 'pinnedRootKeyId', 'authorityPolicy', 'gatewayAccess', 'offlineRoot', 'time']);
  fail(config.schema === 1);
  const pinnedRootKeyId = text(config.pinnedRootKeyId, HEX);
  const a = object(config.authorityPolicy);
  exact(a, ['approvedIssuerKeyIds', 'allowedScopes', 'allowedResponderRoles', 'verifierOwners', 'statusMask', 'purposeMask']);
  // Empty delegated issuer allowlist is valid for a root-only deployment.
  fail(Array.isArray(a.approvedIssuerKeyIds) && a.approvedIssuerKeyIds.length <= 64);
  const issuerIds = (a.approvedIssuerKeyIds as unknown[]).map(id => text(id, HEX));
  fail(new Set(issuerIds).size === issuerIds.length);
  fail(Array.isArray(a.verifierOwners) && a.verifierOwners.length <= 10000);
  const verifierOwners = new Map<string, string>();
  for (const tuple of a.verifierOwners as unknown[]) {
    fail(Array.isArray(tuple) && tuple.length === 2);
    const [id, owner] = tuple as unknown[];
    const verifier = text(id, HEX); fail(!verifierOwners.has(verifier));
    verifierOwners.set(verifier, text(owner, UUID));
  }
  fail(Number.isInteger(a.statusMask) && (a.statusMask as number) >= 1 &&
    (a.statusMask as number) <= 15 && ((a.statusMask as number) & 1) === 1 &&
    (a.purposeMask === 1 || a.purposeMask === 9));
  const authorityPolicy = {
    approvedIssuerKeyIds: new Set(issuerIds), allowedScopes: new Set(list(a.allowedScopes, SCOPE)),
    allowedResponderRoles: new Set(list(a.allowedResponderRoles, ROLE)), verifierOwners,
    statusMask: a.statusMask as number, purposeMask: a.purposeMask as number,
  };
  const gateway = object(config.gatewayAccess);
  exact(gateway, ['allowedRoles', 'assignments']);
  const allowedRoles = new Set(list(gateway.allowedRoles, ROLE));
  fail(Array.isArray(gateway.assignments) && gateway.assignments.length <= 10000);
  const assignments = new Map<string, ReadonlySet<string>>();
  for (const value of gateway.assignments as unknown[]) {
    const item = object(value); exact(item, ['responderId', 'reportIds']);
    const id = text(item.responderId, UUID); fail(!assignments.has(id));
    assignments.set(id, new Set(list(item.reportIds, UUID, 1000)));
  }
  const offline = object(config.offlineRoot);
  exact(offline, ['pinnedCheckpointSignerKeyId', 'policy', 'scope', 'allowedResponderRoles', 'qualifiedSourceId']);
  const pinnedCheckpointSignerKeyId = text(offline.pinnedCheckpointSignerKeyId, HEX);
  const policy = object(offline.policy) as unknown as OfflineRootSnapshotPolicy;
  offlineRootPolicyDigest(policy);
  const scope = text(offline.scope, SCOPE), qualifiedSourceId = text(offline.qualifiedSourceId, LABEL);
  fail(pinnedRootKeyId !== pinnedCheckpointSignerKeyId &&
    policy.signerBindings.some(b => b.receiptRootKeyId === pinnedRootKeyId &&
      b.checkpointSignerKeyId === pinnedCheckpointSignerKeyId) &&
    policy.allowedScopes.includes(scope) && policy.qualifiedTimeSourceIds.includes(qualifiedSourceId));
  const t = object(config.time);
  exact(t, ['profile', 'sourceId', 'host', 'port', 'rootPublicKeyBase64', 'maxRoundTripMs', 'maxRadiusMs',
    'maxSampleAgeMs', 'maxUncertaintyMs', 'monotonicDriftPpm', 'deviceCheckpointValidityMs']);
  const encoded = text(t.rootPublicKeyBase64, /^[A-Za-z0-9+/]{43}=$/u);
  const rootPublicKey = Buffer.from(encoded, 'base64');
  fail(rootPublicKey.length === 32 && rootPublicKey.toString('base64') === encoded &&
    t.sourceId === qualifiedSourceId);
  const time: RoughtimeClockPolicy = {
    profile: text(t.profile, /^(IETF_DRAFT11|GOOGLE_LEGACY)$/u) as RoughtimeClockPolicy['profile'],
    sourceId: qualifiedSourceId, host: text(t.host, /^[A-Za-z0-9.-]{1,253}$/u),
    port: t.port as number, rootPublicKey, maxRoundTripMs: t.maxRoundTripMs as number,
    maxRadiusMs: t.maxRadiusMs as number, maxSampleAgeMs: t.maxSampleAgeMs as number,
    maxUncertaintyMs: t.maxUncertaintyMs as number, monotonicDriftPpm: t.monotonicDriftPpm as number,
    deviceCheckpointValidityMs: t.deviceCheckpointValidityMs as number,
  };
  // Constructor validates numeric limits but performs no I/O or enrollment.
  new RoughtimeClock(time);
  return {time, trust: {
    pinnedRootKeyId, authorityPolicy,
    gatewayAccess: {allowedRoles, isReportAuthorized: (actor, reportId) =>
      allowedRoles.has(actor.role) && assignments.get(actor.responderId)?.has(reportId) === true},
    offlineRoot: {pinnedCheckpointSignerKeyId, policy, scope,
      allowedResponderRoles: new Set(list(offline.allowedResponderRoles, ROLE)), qualifiedSourceId},
  }};
}
/** Optional authority failures never prevent base SOS ingestion from starting. */
export async function loadConfiguredOfflineReceiptRuntime(pool: Pick<Pool, 'connect'>,
  env: Readonly<Record<string, string | undefined>>): Promise<OfflineReceiptRuntime> {
  try {
    if (offlineReceiptRuntimeMode(env) === 'DISABLED') return {};
    const raw = env.SAGIP_OFFLINE_RECEIPTS_CONFIG_JSON;
    if (!raw) throw new Error('OFFLINE_RECEIPTS_CONFIGURATION_REQUIRED');
    const configured = parseOfflineReceiptConfiguration(raw);
    return await createQualifiedOfflineReceiptRuntime(pool, env, configured.trust,
      new RoughtimeClock(configured.time));
  } catch {
    // No exception text, configuration, key material or identity list is logged.
    console.warn('Optional offline receipt authority is unavailable');
    return {};
  }
}
