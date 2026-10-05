/** Production-shaped SOR1 codec and pure evaluator. Trusted owners must commit candidates atomically. */
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import {
  decodeReceipt,
  validateReceiptPublicKey,
  verifyReceiptSignature,
} from './receiptV2.js';
import {
  actionDigest,
  advanceCheckpoint,
  issuerProviderId,
  type MonotonicClock,
  type ReportIdentity,
  type TimeCheckpoint,
} from '../responder/receiptAuthority.js';

const DOMAIN = Buffer.from('SAGIP-OFFLINE-ROOT-SNAPSHOT-V1\0');
const MAGIC = Buffer.from('SOR1');
const NIL = '00000000-0000-0000-0000-000000000000';
const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const MAX_COUNTER = 9223372036854775807n;
export const MAX_OFFLINE_ROOT_SNAPSHOT_BYTES = 4096;
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && timingSafeEqual(a, b);
const digest = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const label = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Z0-9_:-]{1,64}$/.test(v);
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v) && v !== NIL;
const time = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const counter = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) &&
  BigInt(v) <= MAX_COUNTER;
function requireValue(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(reason);
}

export interface OfflineRootProofFields {
  format: 'SAGIP_OFFLINE_ROOT_SNAPSHOT';
  version: 1;
  algorithm: 1;
  proofId: string;
  policyDigest: string;
  authorityDomainId: string;
  checkpointSignerKeyId: string;
  receiptRootKeyId: string;
  issuerProviderId: string;
  receiptDigest: string;
  eventId: string;
  actionDigest: string;
  reportId: string;
  reportProtocolVersion: number;
  revision: number;
  payloadDigest: string;
  originKeyId: string;
  scope: string;
  status: number;
  authorityState: 'ACTIVE_AT_CHECKPOINT' | 'REVOKED_AT_CHECKPOINT';
  authorityStateDigest: string;
  revocationEpoch: string;
  notBeforeMs: number;
  authorityCheckedAtMs: number;
  authorityTimeUncertaintyMs: number;
  expiresAtMs: number;
}
const FIELD_NAMES: readonly (keyof OfflineRootProofFields)[] = [
  'format', 'version', 'algorithm', 'proofId', 'policyDigest', 'authorityDomainId',
  'checkpointSignerKeyId', 'receiptRootKeyId', 'issuerProviderId', 'receiptDigest',
  'eventId', 'actionDigest', 'reportId', 'reportProtocolVersion', 'revision',
  'payloadDigest', 'originKeyId', 'scope', 'status', 'authorityState',
  'authorityStateDigest', 'revocationEpoch', 'notBeforeMs', 'authorityCheckedAtMs',
  'authorityTimeUncertaintyMs', 'expiresAtMs',
];
function body(f: OfflineRootProofFields): Buffer {
  requireValue(f && typeof f === 'object' && !Array.isArray(f), 'FIELDS');
  requireValue(Object.keys(f).length === FIELD_NAMES.length &&
    FIELD_NAMES.every(k => Object.hasOwn(f, k)), 'FIELDS');
  requireValue(f.format === 'SAGIP_OFFLINE_ROOT_SNAPSHOT' &&
    f.version === 1 && f.algorithm === 1, 'VERSION');
  requireValue(uuid(f.proofId) && uuid(f.eventId) && uuid(f.reportId), 'UUID');
  for (const id of [f.policyDigest, f.checkpointSignerKeyId, f.receiptRootKeyId,
    f.issuerProviderId, f.receiptDigest, f.actionDigest, f.payloadDigest,
    f.originKeyId, f.authorityStateDigest]) requireValue(digest(id), 'DIGEST');
  requireValue(label(f.authorityDomainId) && label(f.scope), 'SCOPE');
  requireValue((f.reportProtocolVersion === 1 || f.reportProtocolVersion === 2) &&
    Number.isInteger(f.revision) && f.revision > 0 && f.revision <= 2147483647 &&
    Number.isInteger(f.status) && f.status >= 1 && f.status <= 4, 'REPORT');
  requireValue(f.authorityState === 'ACTIVE_AT_CHECKPOINT' ||
    f.authorityState === 'REVOKED_AT_CHECKPOINT', 'STATE');
  requireValue(counter(f.revocationEpoch), 'EPOCH');
  requireValue([f.notBeforeMs, f.authorityCheckedAtMs, f.authorityTimeUncertaintyMs,
    f.expiresAtMs].every(time), 'TIME');
  const lower = f.authorityCheckedAtMs - f.authorityTimeUncertaintyMs;
  const upper = f.authorityCheckedAtMs + f.authorityTimeUncertaintyMs;
  requireValue(time(lower) && time(upper) && f.notBeforeMs <= lower &&
    upper < f.expiresAtMs, 'CHECKPOINT_INTERVAL');
  return Buffer.from(JSON.stringify(Object.fromEntries(FIELD_NAMES.map(k => [k, f[k]]))));
}
function header(b: Buffer): Buffer {
  requireValue(b.length + 72 <= MAX_OFFLINE_ROOT_SNAPSHOT_BYTES, 'SIZE');
  const h = Buffer.alloc(8);
  MAGIC.copy(h);
  h.writeUInt32BE(b.length, 4);
  return h;
}
function signatureValidShape(signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  const b = Buffer.from(signature);
  const r = BigInt('0x' + b.subarray(0, 32).toString('hex'));
  const s = BigInt('0x' + b.subarray(32).toString('hex'));
  return r > 0n && r < N && s > 0n && s <= N / 2n;
}
/** Input only, never signs or loads a private key. Test callers sign synthetically. */
export function offlineRootProofSigningInput(f: OfflineRootProofFields): Buffer {
  const b = body(f);
  return Buffer.concat([DOMAIN, header(b), b]);
}
export function encodeOfflineRootSnapshot(
  f: OfflineRootProofFields, signature: Uint8Array,
): Buffer {
  const b = body(f);
  requireValue(signatureValidShape(signature), 'SIGNATURE_SHAPE');
  return Buffer.concat([header(b), b, Buffer.from(signature)]);
}
export function decodeOfflineRootSnapshot(bytes: Uint8Array) {
  requireValue(bytes.length >= 74 &&
    bytes.length <= MAX_OFFLINE_ROOT_SNAPSHOT_BYTES, 'SIZE');
  const b = Buffer.from(bytes);
  requireValue(b.subarray(0, 4).equals(MAGIC) &&
    b.readUInt32BE(4) + 72 === b.length, 'HEADER');
  const encodedBody = b.subarray(8, -64);
  const f = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    .decode(encodedBody)) as OfflineRootProofFields;
  requireValue(body(f).equals(encodedBody), 'NONCANONICAL_BODY');
  const signature = b.subarray(-64);
  requireValue(signatureValidShape(signature), 'SIGNATURE_SHAPE');
  return { fields: f, signature, signingInput: Buffer.concat([DOMAIN, b.subarray(0, -64)]) };
}

export interface OfflineRootSnapshotPolicy {
  mode: 'BOUNDED_OFFLINE_ROOT_SNAPSHOT';
  authorityDomainId: string;
  signerBindings: readonly {
    checkpointSignerKeyId: string;
    receiptRootKeyId: string;
    issuerProviderId: string;
  }[];
  allowedScopes: readonly string[];
  allowedStatuses: readonly number[];
  maxAuthorityStalenessMs: number;
  maxReceiptIssuanceAgeMs: number;
  maxProofValidityMs: number;
  qualifiedTimeSourceIds: readonly string[];
  disseminationAudience: 'ORIGIN_ONLY' | 'ORIGIN_AND_CUSTODY_RELAYS';
  providerConflictHandling: 'KEEP_SEPARATE_NO_AUTOMATIC_CLOSURE';
  resolvedHandling: 'EXCLUDE' | 'REPORTED_STATUS_ONLY_NO_AUTOMATIC_CLOSURE';
  maxReplayRecords: number;
}
function boundedList<T>(a: readonly T[], check: (v: T) => boolean): boolean {
  return Array.isArray(a) && a.length > 0 && a.length <= 64 &&
    a.every(check) && new Set(a.map(v => JSON.stringify(v))).size === a.length;
}
/** Operator policy has no operational defaults. List ordering is part of its digest. */
export function offlineRootPolicyDigest(p: OfflineRootSnapshotPolicy): string {
  requireValue(p && p.mode === 'BOUNDED_OFFLINE_ROOT_SNAPSHOT' && label(p.authorityDomainId), 'POLICY');
  requireValue(boundedList(p.signerBindings, b =>
    digest(b.checkpointSignerKeyId) && digest(b.receiptRootKeyId) &&
    digest(b.issuerProviderId) && b.checkpointSignerKeyId !== b.receiptRootKeyId), 'POLICY_SIGNERS');
  requireValue(boundedList(p.allowedScopes, label) &&
    boundedList(p.qualifiedTimeSourceIds, label) &&
    boundedList(p.allowedStatuses, s => Number.isInteger(s) && s >= 1 && s <= 4), 'POLICY_ALLOWLIST');
  requireValue([p.maxAuthorityStalenessMs, p.maxReceiptIssuanceAgeMs,
    p.maxProofValidityMs, p.maxReplayRecords].every(v => time(v) && v > 0), 'POLICY_BOUNDS');
  requireValue(p.maxAuthorityStalenessMs <= 900000 && p.maxProofValidityMs <= 900000 &&
    p.maxReceiptIssuanceAgeMs <= 86400000 && p.maxReplayRecords <= 100000, 'POLICY_LIMITS');
  requireValue(p.disseminationAudience === 'ORIGIN_ONLY' ||
    p.disseminationAudience === 'ORIGIN_AND_CUSTODY_RELAYS', 'POLICY_AUDIENCE');
  requireValue(p.providerConflictHandling === 'KEEP_SEPARATE_NO_AUTOMATIC_CLOSURE' &&
    (p.resolvedHandling === 'EXCLUDE' ||
     p.resolvedHandling === 'REPORTED_STATUS_ONLY_NO_AUTOMATIC_CLOSURE') &&
    (!p.allowedStatuses.includes(4) ||
     p.resolvedHandling === 'REPORTED_STATUS_ONLY_NO_AUTOMATIC_CLOSURE'), 'POLICY_CLOSURE');
  return hash(Buffer.from(JSON.stringify([
    'SAGIP-OFFLINE-ROOT-POLICY-V1', p.mode, p.authorityDomainId,
    p.signerBindings.map(b => [b.checkpointSignerKeyId, b.receiptRootKeyId, b.issuerProviderId]),
    p.allowedScopes, p.allowedStatuses, p.maxAuthorityStalenessMs,
    p.maxReceiptIssuanceAgeMs, p.maxProofValidityMs, p.qualifiedTimeSourceIds,
    p.disseminationAudience, p.providerConflictHandling, p.resolvedHandling, p.maxReplayRecords,
  ])));
}
export interface OfflineRootSnapshotState {
  authorityDomainId: string;
  generation: number;
  epochHighWater: string;
  authorityStateDigest: string | null;
  checkedAtEarliestHighWaterMs: number;
  timeEarliestHighWaterMs: number;
  proofs: readonly { proofId: string; proofDigest: string }[];
  receipts: readonly {
    eventId: string; receiptDigest: string; issuerProviderId: string;
    reportId: string; revision: number; sequence: string;
  }[];
}
export interface OfflineRootSnapshotContext {
  policy: OfflineRootSnapshotPolicy | null;
  // Out-of-band pinned keys only. Never populate from the proof or an HTTP caller.
  checkpointSignerKeys: ReadonlyMap<string, Uint8Array>;
  receiptRootKeys: ReadonlyMap<string, Uint8Array>;
  revokedKeyIds: ReadonlySet<string>;
  revokedProviderIds: ReadonlySet<string>;
  report: ReportIdentity | null;
  // Trusted latest revision for this report, even when report is historical evidence.
  activeReportRevision: number | null;
  trustedTime: {
    checkpoint: TimeCheckpoint;
    clock: MonotonicClock;
    qualifiedSourceId: string;
  } | null;
  // Durable owner state across process/boot/key rotation, never a remote request field.
  state: OfflineRootSnapshotState | null;
}
export type OfflineRootSnapshotResult =
  | { kind: 'REJECTED' | 'UNVERIFIED_AUTHORITY'; reason: string }
  | {
      kind: 'CANDIDATE';
      requiresAtomicCommit: true;
      proposedVerification: {
        kind: 'VERIFIED_OFFLINE_ROOT_SNAPSHOT';
        authorityCheckedAtMs: number;
        authorityTimeUncertaintyMs: number;
        revocationNotCheckedWhileOffline: true;
        statusIsIssuerReportOnly: true;
      };
      application: 'NEW' | 'DUPLICATE' | 'HISTORICAL';
      notificationEligibleAfterCommit: boolean;
      eventId: string;
      receiptDigest: string;
      validUntilExclusiveMs: number;
      expectedStateGeneration: number;
      nextState: OfflineRootSnapshotState;
    };
const rejected = (reason: string): OfflineRootSnapshotResult => ({ kind: 'REJECTED', reason });
const unavailable = (reason: string): OfflineRootSnapshotResult =>
  ({ kind: 'UNVERIFIED_AUTHORITY', reason });
function pinned(keys: ReadonlyMap<string, Uint8Array>, id: string) {
  const key = keys.get(id);
  if (!key || hash(key) !== id) return null;
  validateReceiptPublicKey(key);
  return key;
}
function validState(s: OfflineRootSnapshotState, policy: OfflineRootSnapshotPolicy): boolean {
  return s.authorityDomainId === policy.authorityDomainId && time(s.generation) &&
    s.generation < Number.MAX_SAFE_INTEGER && counter(s.epochHighWater) &&
    (s.authorityStateDigest === null ? s.epochHighWater === '0' : digest(s.authorityStateDigest)) &&
    time(s.checkedAtEarliestHighWaterMs) && time(s.timeEarliestHighWaterMs) &&
    Array.isArray(s.proofs) && Array.isArray(s.receipts) &&
    s.proofs.length + s.receipts.length <= policy.maxReplayRecords &&
    s.proofs.every(p => uuid(p.proofId) && digest(p.proofDigest)) &&
    s.receipts.every(r => uuid(r.eventId) && digest(r.receiptDigest) &&
      digest(r.issuerProviderId) && uuid(r.reportId) && Number.isInteger(r.revision) &&
      r.revision > 0 && r.revision <= 2147483647 && counter(r.sequence) && r.sequence !== '0') &&
    new Set(s.proofs.map(p => p.proofId)).size === s.proofs.length &&
    new Set(s.receipts.map(r => r.eventId)).size === s.receipts.length;
}

/** Pure evaluation only. No candidate may be projected before atomic durable commit. */
export function evaluateOfflineRootSnapshot(
  receiptBytes: Uint8Array, proofBytes: Uint8Array, c: OfflineRootSnapshotContext,
): OfflineRootSnapshotResult {
  try {
    const proof = decodeOfflineRootSnapshot(proofBytes), f = proof.fields;
    const receipt = decodeReceipt(receiptBytes), r = receipt.fields;
    if (r.purpose !== 1 || r.providerKind !== 1 || r.grantId !== NIL)
      return rejected('ROOT_RECEIPT_PROFILE');
    if (r.note !== '') return rejected('RELAY_NOTES_FORBIDDEN');
    const signer = pinned(c.checkpointSignerKeys, f.checkpointSignerKeyId);
    const root = pinned(c.receiptRootKeys, f.receiptRootKeyId);
    if (!signer || !root) return unavailable('UNKNOWN_PINNED_KEY');
    if (!verify('sha256', proof.signingInput, {
      key: createPublicKey({ key: Buffer.from(signer), format: 'der', type: 'spki' }),
      dsaEncoding: 'ieee-p1363',
    }, proof.signature)) return rejected('PROOF_SIGNATURE');
    if (!verifyReceiptSignature(receipt, root)) return rejected('RECEIPT_SIGNATURE');
    if (hash(receiptBytes) !== f.receiptDigest || r.actionId !== f.eventId ||
      hex(r.actionDigest) !== f.actionDigest || hex(r.issuerKeyId) !== f.receiptRootKeyId ||
      hex(r.issuerProviderId) !== f.issuerProviderId ||
      !equal(actionDigest(r), r.actionDigest) ||
      !equal(issuerProviderId(1, r.issuerKeyId, NIL), r.issuerProviderId))
      return rejected('RECEIPT_BINDING');
    if (r.reportId !== f.reportId || r.reportProtocolVersion !== f.reportProtocolVersion ||
      r.revision !== f.revision || hex(r.payloadDigest) !== f.payloadDigest ||
      hex(r.originKeyId) !== f.originKeyId || r.status !== f.status)
      return rejected('PROOF_REPORT_BINDING');
    // Known revocation always wins, including over an otherwise valid old snapshot.
    // This refusal is NOT a validated revocation-import token. Separate ingestion must
    // verify revocation provenance/policy and persist it atomically before reuse.
    if (f.authorityState !== 'ACTIVE_AT_CHECKPOINT' ||
      c.revokedKeyIds.has(f.checkpointSignerKeyId) ||
      c.revokedKeyIds.has(f.receiptRootKeyId) || c.revokedProviderIds.has(f.issuerProviderId))
      return unavailable('KNOWN_REVOKED');
    const p = c.policy;
    if (!p) return unavailable('POLICY_MISSING');
    let policyDigest: string;
    try { policyDigest = offlineRootPolicyDigest(p); }
    catch { return unavailable('POLICY_INVALID'); }
    if (policyDigest !== f.policyDigest || f.authorityDomainId !== p.authorityDomainId ||
      !p.signerBindings.some(b => b.checkpointSignerKeyId === f.checkpointSignerKeyId &&
        b.receiptRootKeyId === f.receiptRootKeyId && b.issuerProviderId === f.issuerProviderId) ||
      !p.allowedScopes.includes(f.scope) || !p.allowedStatuses.includes(f.status))
      return unavailable('POLICY_MISMATCH');
    const report = c.report;
    if (!report || report.reportId !== f.reportId ||
      report.reportProtocolVersion !== f.reportProtocolVersion || report.revision !== f.revision ||
      hex(report.payloadDigest) !== f.payloadDigest || hex(report.originKeyId) !== f.originKeyId ||
      hash(report.originPublicKeyDer) !== f.originKeyId ||
      !Number.isInteger(c.activeReportRevision) || c.activeReportRevision === null ||
      c.activeReportRevision < f.revision || c.activeReportRevision > 2147483647)
      return unavailable('REPORT_LINKAGE');
    const checkedLower = f.authorityCheckedAtMs - f.authorityTimeUncertaintyMs;
    const checkedUpper = f.authorityCheckedAtMs + f.authorityTimeUncertaintyMs;
    if (r.issuedAtMs > checkedLower || f.expiresAtMs > r.forwardingExpiresAtMs ||
      f.expiresAtMs - f.notBeforeMs > p.maxProofValidityMs)
      return rejected('PROOF_LIFETIME');
    const authorityDeadline = checkedLower + p.maxAuthorityStalenessMs;
    const receiptAgeDeadline = r.issuedAtMs + p.maxReceiptIssuanceAgeMs;
    if (!time(authorityDeadline) || !time(receiptAgeDeadline))
      return unavailable('POLICY_TIME_OVERFLOW');
    const t = c.trustedTime;
    if (!t || !p.qualifiedTimeSourceIds.includes(t.qualifiedSourceId))
      return unavailable('QUALIFIED_TIME_MISSING');
    const cp = t.checkpoint;
    if (!uuid(cp.bootId) || !digest(cp.proofDigest) ||
      ![cp.earliestMs, cp.latestMs, cp.validUntilMs, cp.receivedElapsedMs, t.clock.elapsedMs].every(time) ||
      cp.latestMs < cp.earliestMs || cp.latestMs >= cp.validUntilMs ||
      cp.validUntilMs - cp.earliestMs > 86400000)
      return unavailable('TRUSTED_CHECKPOINT_INVALID');
    const now = advanceCheckpoint(cp, t.clock);
    if (!now) return unavailable('SAME_BOOT_TIME_UNAVAILABLE');
    if (now.earliestMs < f.notBeforeMs || now.earliestMs < checkedUpper ||
      now.latestMs >= f.expiresAtMs || now.latestMs >= r.forwardingExpiresAtMs)
      return unavailable('TIME_OUTSIDE_PROOF');
    // Both limits are exclusive. Equality has consumed the entire offline budget.
    if (now.latestMs - checkedLower >= p.maxAuthorityStalenessMs)
      return unavailable('AUTHORITY_SNAPSHOT_STALE');
    if (now.latestMs - r.issuedAtMs >= p.maxReceiptIssuanceAgeMs)
      return unavailable('RECEIPT_ISSUANCE_STALE');
    const s = c.state;
    if (!s || !validState(s, p)) return unavailable('DURABLE_STATE_MISSING_OR_INVALID');
    if (BigInt(f.revocationEpoch) < BigInt(s.epochHighWater) ||
      (BigInt(f.revocationEpoch) > BigInt(s.epochHighWater) &&
       checkedLower < s.checkedAtEarliestHighWaterMs) ||
      now.earliestMs < s.timeEarliestHighWaterMs) return unavailable('ROLLBACK');
    if (f.revocationEpoch === s.epochHighWater && s.authorityStateDigest !== null &&
      f.authorityStateDigest !== s.authorityStateDigest) return rejected('EPOCH_EQUIVOCATION');
    const proofDigest = hash(proofBytes);
    const priorProof = s.proofs.find(v => v.proofId === f.proofId);
    if (priorProof && priorProof.proofDigest !== proofDigest) return rejected('PROOF_ID_CONFLICT');
    const priorReceipt = s.receipts.find(v => v.eventId === f.eventId);
    if (priorReceipt && priorReceipt.receiptDigest !== f.receiptDigest)
      return rejected('EVENT_ID_CONFLICT');
    const stream = s.receipts.filter(v => v.issuerProviderId === f.issuerProviderId &&
      v.reportId === f.reportId);
    if (stream.some(v => BigInt(v.sequence) === r.sequence && v.eventId !== f.eventId))
      return rejected('SEQUENCE_CONFLICT');
    const application = priorReceipt ? 'DUPLICATE' :
      f.revision < c.activeReportRevision ||
      stream.some(v => v.revision > f.revision || BigInt(v.sequence) > r.sequence)
        ? 'HISTORICAL' : 'NEW';
    const proofs = priorProof ? [...s.proofs] : [...s.proofs, { proofId: f.proofId, proofDigest }];
    const receipts = priorReceipt ? [...s.receipts] : [...s.receipts, {
      eventId: f.eventId, receiptDigest: f.receiptDigest, issuerProviderId: f.issuerProviderId,
      reportId: f.reportId, revision: f.revision, sequence: r.sequence.toString(),
    }];
    if (proofs.length + receipts.length > p.maxReplayRecords)
      return unavailable('REPLAY_CAPACITY');
    const nextState: OfflineRootSnapshotState = {
      authorityDomainId: s.authorityDomainId, generation: s.generation + 1,
      epochHighWater: f.revocationEpoch, authorityStateDigest: f.authorityStateDigest,
      checkedAtEarliestHighWaterMs: Math.max(s.checkedAtEarliestHighWaterMs, checkedLower),
      timeEarliestHighWaterMs: Math.max(s.timeEarliestHighWaterMs, now.earliestMs),
      proofs, receipts,
    };
    return {
      kind: 'CANDIDATE', requiresAtomicCommit: true,
      proposedVerification: {
        kind: 'VERIFIED_OFFLINE_ROOT_SNAPSHOT', authorityCheckedAtMs: f.authorityCheckedAtMs,
        authorityTimeUncertaintyMs: f.authorityTimeUncertaintyMs,
        revocationNotCheckedWhileOffline: true, statusIsIssuerReportOnly: true,
      },
      application, notificationEligibleAfterCommit: application === 'NEW',
      eventId: f.eventId, receiptDigest: f.receiptDigest,
      validUntilExclusiveMs: Math.min(f.expiresAtMs, r.forwardingExpiresAtMs,
        authorityDeadline, receiptAgeDeadline),
      expectedStateGeneration: s.generation, nextState,
    };
  } catch {
    return rejected('MALFORMED_SNAPSHOT');
  }
}


/** SGB1 is a transport object, not a new SGA2 proof profile. */
export function encodeOfflineRootBundle(receipt: Uint8Array, proof: Uint8Array): Buffer {
  const r = decodeReceipt(receipt).fields, p = decodeOfflineRootSnapshot(proof).fields;
  requireValue(r.purpose === 1 && r.providerKind === 1 && r.note === '' &&
    hash(receipt) === p.receiptDigest && r.actionId === p.eventId, 'BUNDLE_BINDING');
  requireValue(12 + receipt.length + proof.length <= 8192, 'BUNDLE_SIZE');
  const h = Buffer.alloc(12); h.write('SGB1');
  h.writeUInt32BE(receipt.length, 4); h.writeUInt32BE(proof.length, 8);
  return Buffer.concat([h, Buffer.from(receipt), Buffer.from(proof)]);
}
export function decodeOfflineRootBundle(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  requireValue(b.length >= 12 && b.length <= 8192 &&
    b.subarray(0, 4).equals(Buffer.from('SGB1')), 'BUNDLE_HEADER');
  const receiptLength = b.readUInt32BE(4), proofLength = b.readUInt32BE(8);
  requireValue(receiptLength > 0 && proofLength > 0 &&
    receiptLength + proofLength + 12 === b.length, 'BUNDLE_LENGTH');
  const receipt = b.subarray(12, 12 + receiptLength), proof = b.subarray(12 + receiptLength);
  requireValue(encodeOfflineRootBundle(receipt, proof).equals(b), 'BUNDLE_CANONICAL');
  return {receipt, proof};
}
export interface OfflineRootRevocationFields {
  format: 'SAGIP_OFFLINE_ROOT_REVOCATION'; version: 1; algorithm: 1;
  revocationId: string; policyDigest: string; authorityDomainId: string;
  checkpointSignerKeyId: string; targetKind: 'KEY' | 'PROVIDER'; targetId: string;
  revocationEpoch: string; authorityStateDigest: string; revokedAtMs: number;
}
const REVOCATION_FIELDS: readonly (keyof OfflineRootRevocationFields)[] = [
  'format', 'version', 'algorithm', 'revocationId', 'policyDigest', 'authorityDomainId',
  'checkpointSignerKeyId', 'targetKind', 'targetId', 'revocationEpoch',
  'authorityStateDigest', 'revokedAtMs',
];
const REVOCATION_DOMAIN = Buffer.from('SAGIP-OFFLINE-ROOT-REVOCATION-V1\0');
function revocationBody(f: OfflineRootRevocationFields) {
  requireValue(f && typeof f === 'object' && !Array.isArray(f) &&
    Object.keys(f).length === REVOCATION_FIELDS.length &&
    REVOCATION_FIELDS.every(k => Object.hasOwn(f, k)), 'REVOCATION_FIELDS');
  requireValue(f.format === 'SAGIP_OFFLINE_ROOT_REVOCATION' && f.version === 1 &&
    f.algorithm === 1 && uuid(f.revocationId) && label(f.authorityDomainId) &&
    ['KEY', 'PROVIDER'].includes(f.targetKind) && counter(f.revocationEpoch) &&
    f.revocationEpoch !== '0' && time(f.revokedAtMs), 'REVOCATION_FIELDS');
  requireValue([f.policyDigest, f.checkpointSignerKeyId, f.targetId,
    f.authorityStateDigest].every(digest), 'REVOCATION_DIGEST');
  return Buffer.from(JSON.stringify(Object.fromEntries(REVOCATION_FIELDS.map(k => [k, f[k]]))));
}
function revocationHeader(body: Buffer) {
  requireValue(body.length + 72 <= 4096, 'REVOCATION_SIZE');
  const h = Buffer.alloc(8); h.write('SOV1'); h.writeUInt32BE(body.length, 4); return h;
}
export function offlineRootRevocationSigningInput(f: OfflineRootRevocationFields) {
  const b = revocationBody(f); return Buffer.concat([REVOCATION_DOMAIN, revocationHeader(b), b]);
}
export function encodeOfflineRootRevocation(f: OfflineRootRevocationFields, signature: Uint8Array) {
  requireValue(signatureValidShape(signature), 'SIGNATURE_SHAPE');
  const b = revocationBody(f); return Buffer.concat([revocationHeader(b), b, Buffer.from(signature)]);
}
export function decodeOfflineRootRevocation(bytes: Uint8Array) {
  const b = Buffer.from(bytes);
  requireValue(b.length >= 74 && b.length <= 4096 &&
    b.subarray(0, 4).equals(Buffer.from('SOV1')) && b.readUInt32BE(4) + 72 === b.length,
    'REVOCATION_HEADER');
  const encoded = b.subarray(8, -64);
  const fields = JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true})
    .decode(encoded)) as OfflineRootRevocationFields;
  requireValue(revocationBody(fields).equals(encoded) && signatureValidShape(b.subarray(-64)),
    'REVOCATION_NONCANONICAL');
  return {fields, signature: b.subarray(-64), signingInput: Buffer.concat([REVOCATION_DOMAIN, b.subarray(0, -64)])};
}
/** Validate before durable tombstone import, independently of report/time availability. */
export function verifyOfflineRootRevocation(bytes: Uint8Array, policy: OfflineRootSnapshotPolicy,
  keys: ReadonlyMap<string, Uint8Array>): OfflineRootRevocationFields {
  const r = decodeOfflineRootRevocation(bytes), f = r.fields;
  requireValue(f.policyDigest === offlineRootPolicyDigest(policy) &&
    f.authorityDomainId === policy.authorityDomainId &&
    policy.signerBindings.some(b => b.checkpointSignerKeyId === f.checkpointSignerKeyId &&
      (f.targetKind === 'PROVIDER' ? b.issuerProviderId === f.targetId :
        b.receiptRootKeyId === f.targetId || b.checkpointSignerKeyId === f.targetId)),
    'REVOCATION_POLICY');
  const key = pinned(keys, f.checkpointSignerKeyId);
  requireValue(key && verify('sha256', r.signingInput, {
    key: createPublicKey({key: Buffer.from(key), format: 'der', type: 'spki'}),
    dsaEncoding: 'ieee-p1363',
  }, r.signature), 'REVOCATION_SIGNATURE');
  return f;
}
