import { createHash, timingSafeEqual } from 'node:crypto';
import {
  decodeReceipt,
  encodeReceipt,
  verifyReceiptSignature,
  type AuthorityGrantFields,
  type DecodedReceipt,
  type ResponderReceiptFields,
  type TimeProofFields,
} from '../protocol/receiptV2.js';
const NIL = '00000000-0000-0000-0000-000000000000',
  WEEK = 604800000;
export interface TimeInterval {
  earliestMs: number;
  latestMs: number;
}
export interface ReportIdentity {
  reportId: string;
  reportProtocolVersion: number;
  revision: number;
  payloadDigest: Uint8Array;
  originKeyId: Uint8Array;
  originPublicKeyDer: Uint8Array;
}
export interface VerificationContext {
  roots: Map<string, Uint8Array>;
  revokedGrants: Set<string>;
  allowedScopes: Set<string>;
  trustedTime: TimeInterval | null;
  authorityCheckedAtMs: number | null;
  currentAuthorityChecked: boolean;
  report: ReportIdentity | null;
  linkedAck?: Uint8Array;
  pairedTimeProviderId: string | null;
}
export type ReceiptVerification =
  | { kind: 'REJECTED' | 'UNVERIFIED_AUTHORITY'; reason: string }
  | {
      kind: 'VERIFIED_CURRENT' | 'VERIFIED_OFFLINE_AUTHORITY';
      eventId: string;
      revision: number;
      authorityCheckedAtMs: number | null;
      revocationNotCheckedWhileOffline: boolean;
    };
export interface MonotonicClock {
  bootId: string;
  elapsedMs: number;
}
export interface TimeCheckpoint extends TimeInterval {
  bootId: string;
  receivedElapsedMs: number;
  validUntilMs: number;
  proofDigest: string;
}
export interface TimeChallenge {
  id: string;
  verifierId: Uint8Array;
  verifierBootSessionId: string;
  nonce: Uint8Array;
  sentElapsedMs: number;
  highWaterEarliestMs: number | null;
  context: VerificationContext;
  // The trusted owner must atomically consume this exact outstanding challenge, compare
  // boot/high-water again and persist the checkpoint. False refuses acceptance.
  commitCheckpoint: (checkpoint: TimeCheckpoint) => boolean;
}
export type TimeAcceptance =
  | { kind: 'ACCEPTED'; checkpoint: TimeCheckpoint }
  | { kind: 'REJECTED'; reason: string };
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest();
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && timingSafeEqual(a, b);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const no = (
  reason: string,
): { kind: 'UNVERIFIED_AUTHORITY'; reason: string } => ({
  kind: 'UNVERIFIED_AUTHORITY',
  reason,
});
const bad = (reason: string): { kind: 'REJECTED'; reason: string } => ({
  kind: 'REJECTED',
  reason,
});
function rootFor(id: Uint8Array, c: VerificationContext): Uint8Array | null {
  const key = c.roots.get(hex(id));
  return key && same(hash(key), id) ? key : null;
}
export function issuerProviderId(
  kind: number,
  keyId: Uint8Array,
  grantId: string,
): Buffer {
  return hash(
    Buffer.concat([
      Buffer.from('SAGIP-PROVIDER-V2\0'),
      Buffer.from([kind]),
      Buffer.from(keyId),
      Buffer.from(grantId.replaceAll('-', ''), 'hex'),
    ]),
  );
}
export function actionDigest(f: ResponderReceiptFields): Buffer {
  const uuid = (s: string) => Buffer.from(s.replaceAll('-', ''), 'hex');
  const revision = Buffer.alloc(4);
  revision.writeUInt32BE(f.revision);
  const observed = Buffer.alloc(8);
  observed.writeBigUInt64BE(f.observedIncidentVersion);
  const note = Buffer.from(f.note),
    length = Buffer.alloc(2);
  length.writeUInt16BE(note.length);
  return hash(
    Buffer.concat([
      Buffer.from('SAGIP-ACTION-V2\0'),
      uuid(f.actionId),
      Buffer.from([f.providerKind]),
      Buffer.from(f.issuerProviderId),
      uuid(f.reportId),
      Buffer.from([f.reportProtocolVersion]),
      revision,
      Buffer.from(f.payloadDigest),
      Buffer.from(f.originKeyId),
      uuid(f.responderId),
      observed,
      Buffer.from([f.status]),
      length,
      note,
    ]),
  );
}
function proofMembers(proof: Buffer): DecodedReceipt[] {
  if (!proof.length) return [];
  let offset = 1;
  const result: DecodedReceipt[] = [];
  for (let i = 0; i < proof[0]!; i++) {
    const n = proof.readUInt16BE(offset);
    offset += 2;
    result.push(decodeReceipt(proof.subarray(offset, offset + n)));
    offset += n;
  }
  return result;
}
type GrantCheck =
  | { kind: 'VALID'; grant: AuthorityGrantFields }
  | { kind: 'REJECTED' | 'UNVERIFIED_AUTHORITY'; reason: string };
function grantCheck(
  d: DecodedReceipt,
  c: VerificationContext,
  policy = true,
): GrantCheck {
  if (d.fields.purpose !== 3) return bad('GRANT_PROFILE');
  const g = d.fields,
    root = rootFor(g.rootKeyId, c);
  if (!root) return no('UNKNOWN_ROOT');
  if (!verifyReceiptSignature(d, root)) return bad('GRANT_SIGNATURE');
  if (
    !same(hash(g.issuerPublicKeyDer), g.issuerKeyId) ||
    !same(issuerProviderId(2, g.issuerKeyId, g.grantId), g.issuerProviderId)
  )
    return bad('GRANT_KEY_BINDING');
  if (g.expiresAtMs <= g.notBeforeMs || g.expiresAtMs - g.notBeforeMs > WEEK)
    return bad('GRANT_DURATION');
  if (policy && c.revokedGrants.has(g.grantId)) return no('REVOKED_GRANT');
  if (policy && !c.allowedScopes.has(g.scope)) return no('SCOPE_UNAVAILABLE');
  return { kind: 'VALID', grant: g };
}
function intervalValid(t: TimeInterval): boolean {
  return (
    Number.isSafeInteger(t.earliestMs) &&
    Number.isSafeInteger(t.latestMs) &&
    t.earliestMs >= 0 &&
    t.latestMs >= t.earliestMs
  );
}
function within(t: TimeInterval, start: number, end: number): boolean {
  return intervalValid(t) && t.earliestMs >= start && t.latestMs < end;
}
function reportMatches(
  f: {
    reportId: string;
    reportProtocolVersion: number;
    revision: number;
    originKeyId: Uint8Array;
  },
  r: ReportIdentity,
): boolean {
  return (
    f.reportId === r.reportId &&
    f.reportProtocolVersion === r.reportProtocolVersion &&
    f.revision === r.revision &&
    same(f.originKeyId, r.originKeyId)
  );
}
export function verifyReceipt(
  bytes: Uint8Array,
  c: VerificationContext,
): ReceiptVerification {
  try {
    const d = decodeReceipt(bytes),
      f = d.fields;
    if (f.purpose !== 1 && f.purpose !== 2) return bad('NOT_RECEIPT');
    if (f.purpose === 2) {
      if (!same(hash(f.originPublicKeyDer), f.originKeyId))
        return bad('ORIGIN_KEY_BINDING');
      if (!verifyReceiptSignature(d, f.originPublicKeyDer))
        return bad('SIGNATURE_INVALID');
      const r = c.report;
      if (!r || !reportMatches(f, r)) return no('REPORT_LINKAGE');
      if (!same(f.originPublicKeyDer, r.originPublicKeyDer))
        return bad('ORIGIN_KEY_BINDING');
      if (!c.linkedAck) return no('ACK_LINKAGE');
      const ack = decodeReceipt(c.linkedAck);
      if (
        ack.fields.purpose !== 1 ||
        ack.fields.actionId !== f.ackEventId ||
        !same(hash(c.linkedAck), f.ackDigest) ||
        f.forwardingExpiresAtMs !== ack.fields.forwardingExpiresAtMs
      )
        return bad('ACK_LINKAGE');
      const result = verifyReceipt(c.linkedAck, c);
      if ('reason' in result) return result;
      return { ...result, eventId: f.eventId, revision: f.revision };
    }
    if (
      !same(
        issuerProviderId(f.providerKind, f.issuerKeyId, f.grantId),
        f.issuerProviderId,
      ) ||
      !same(actionDigest(f), f.actionDigest)
    )
      return bad('ACTION_BINDING');
    let key: Uint8Array,
      grant: AuthorityGrantFields | null = null;
    const offline = f.providerKind === 2;
    if (!offline) {
      const root = rootFor(f.issuerKeyId, c);
      if (!root) return no('UNKNOWN_ROOT');
      key = root;
    } else {
      const checked = grantCheck(proofMembers(d.proof)[0]!, c, false);
      if (checked.kind !== 'VALID') return checked;
      grant = checked.grant;
      if (
        f.grantId !== grant.grantId ||
        !same(f.issuerKeyId, grant.issuerKeyId) ||
        !same(f.issuerProviderId, grant.issuerProviderId) ||
        f.responderId !== grant.responderId ||
        f.callsign !== grant.callsign ||
        (grant.statusMask & (1 << (f.status - 1))) === 0
      )
        return bad('GRANT_BINDING');
      if (
        f.issuedAtMs < grant.notBeforeMs ||
        f.issuedAtMs >= grant.expiresAtMs ||
        f.forwardingExpiresAtMs > grant.expiresAtMs
      )
        return bad('GRANT_ISSUANCE');
      key = grant.issuerPublicKeyDer;
    }
    if (!verifyReceiptSignature(d, key)) return bad('SIGNATURE_INVALID');
    const r = c.report;
    if (!r || !reportMatches(f, r) || !same(f.payloadDigest, r.payloadDigest))
      return no('REPORT_LINKAGE');
    if (grant) {
      if (c.revokedGrants.has(grant.grantId)) return no('REVOKED_GRANT');
      if (!c.allowedScopes.has(grant.scope)) return no('SCOPE_UNAVAILABLE');
      if (
        !c.trustedTime ||
        !within(c.trustedTime, grant.notBeforeMs, grant.expiresAtMs)
      )
        return no('GRANT_TIME_UNAVAILABLE');
    }
    if (
      !c.trustedTime ||
      !intervalValid(c.trustedTime) ||
      c.trustedTime.latestMs >= f.forwardingExpiresAtMs
    )
      return no('RECEIPT_TIME_UNAVAILABLE');
    if (!offline && !c.currentAuthorityChecked)
      return no('ROOT_AUTHORITY_UNCHECKED');
    return {
      kind: offline ? 'VERIFIED_OFFLINE_AUTHORITY' : 'VERIFIED_CURRENT',
      eventId: f.actionId,
      revision: f.revision,
      authorityCheckedAtMs: c.authorityCheckedAtMs,
      revocationNotCheckedWhileOffline: offline,
    };
  } catch {
    return bad('MALFORMED_OBJECT');
  }
}
function rootTime(
  d: DecodedReceipt,
  c: VerificationContext,
): TimeProofFields | null {
  if (d.fields.purpose !== 4 || d.fields.grantId !== NIL) return null;
  const f = d.fields,
    root = rootFor(f.signerKeyId, c);
  if (
    !root ||
    !verifyReceiptSignature(d, root) ||
    !same(issuerProviderId(1, f.signerKeyId, NIL), f.signerProviderId) ||
    f.elapsedSinceCheckpointMs !== 0 ||
    !f.parentCheckpointDigest.every(x => x === 0) ||
    f.uncertaintyMs > 60000 ||
    f.validUntilMs <= f.signedTimeMs + f.uncertaintyMs ||
    f.validUntilMs - f.signedTimeMs > WEEK
  )
    return null;
  return f;
}
export function acceptTimeProof(
  bytes: Uint8Array,
  q: TimeChallenge,
  clock: MonotonicClock,
): TimeAcceptance {
  const reject = (reason: string): TimeAcceptance => ({
    kind: 'REJECTED',
    reason,
  });
  try {
    const d = decodeReceipt(bytes);
    if (d.fields.purpose !== 4) return reject('TIME_PROFILE');
    const f = d.fields,
      c = q.context;
    if (
      !Number.isSafeInteger(clock.elapsedMs) ||
      !Number.isSafeInteger(q.sentElapsedMs) ||
      q.sentElapsedMs < 0 ||
      clock.bootId !== q.verifierBootSessionId ||
      f.verifierBootSessionId !== q.verifierBootSessionId ||
      !same(f.verifierId, q.verifierId) ||
      !same(f.nonce, q.nonce)
    )
      return reject('CHALLENGE_BINDING');
    const age = clock.elapsedMs - q.sentElapsedMs;
    if (age < 0 || age > 60000) return reject('CHALLENGE_AGE');
    let start = 0,
      end = f.validUntilMs;
    if (f.grantId === NIL) {
      if (!rootTime(d, c)) return reject('ROOT_TIME_INVALID');
    } else {
      const members = proofMembers(d.proof),
        checked = grantCheck(members[0]!, c);
      if (checked.kind !== 'VALID') return reject(checked.reason);
      const g = checked.grant,
        parent = rootTime(members[1]!, c);
      if (!parent) return reject('PARENT_TIME_INVALID');
      if (
        c.pairedTimeProviderId !== hex(f.signerProviderId) ||
        f.grantId !== g.grantId ||
        !same(f.signerKeyId, g.issuerKeyId) ||
        !same(f.signerProviderId, g.issuerProviderId) ||
        (g.purposeMask & 8) === 0 ||
        !same(parent.verifierId, g.issuerKeyId) ||
        f.signerBootSessionId !== parent.verifierBootSessionId
      )
        return reject('DELEGATED_TIME_BINDING');
      const parentBytes = encodeReceipt(
        members[1]!.fields,
        members[1]!.signature,
        members[1]!.proof,
      );
      if (
        !same(hash(parentBytes), f.parentCheckpointDigest) ||
        f.signedTimeMs !== parent.signedTimeMs + f.elapsedSinceCheckpointMs ||
        f.uncertaintyMs <
          parent.uncertaintyMs +
            Math.ceil(f.elapsedSinceCheckpointMs / 10000) ||
        f.uncertaintyMs > 86400000 ||
        f.validUntilMs !== Math.min(g.expiresAtMs, parent.validUntilMs) ||
        !verifyReceiptSignature(d, g.issuerPublicKeyDer)
      )
        return reject('DELEGATED_TIME_INVALID');
      start = g.notBeforeMs;
      end = Math.min(g.expiresAtMs, parent.validUntilMs);
    }
    const uncertainty = f.uncertaintyMs + age,
      interval = {
        earliestMs: f.signedTimeMs - uncertainty,
        latestMs: f.signedTimeMs + uncertainty,
      };
    if (!within(interval, start, end)) return reject('TIME_INTERVAL');
    if (
      q.highWaterEarliestMs !== null &&
      (!Number.isSafeInteger(q.highWaterEarliestMs) ||
        q.highWaterEarliestMs < 0 ||
        interval.earliestMs < q.highWaterEarliestMs)
    )
      return reject('TIME_ROLLBACK');
    const checkpoint: TimeCheckpoint = {
      ...interval,
      bootId: clock.bootId,
      receivedElapsedMs: clock.elapsedMs,
      validUntilMs: end,
      proofDigest: hex(hash(bytes)),
    };
    if (!q.commitCheckpoint(checkpoint))
      return reject('CHALLENGE_COMMIT_CONFLICT');
    return { kind: 'ACCEPTED', checkpoint };
  } catch {
    return reject('MALFORMED_TIME');
  }
}
export function advanceCheckpoint(
  checkpoint: TimeCheckpoint,
  clock: MonotonicClock,
): TimeInterval | null {
  if (
    clock.bootId !== checkpoint.bootId ||
    !Number.isSafeInteger(clock.elapsedMs) ||
    !Number.isSafeInteger(checkpoint.receivedElapsedMs)
  )
    return null;
  const elapsed = clock.elapsedMs - checkpoint.receivedElapsedMs;
  if (elapsed < 0 || !Number.isSafeInteger(elapsed)) return null;
  const drift = Math.ceil(elapsed / 10000),
    t = {
      earliestMs: checkpoint.earliestMs + elapsed - drift,
      latestMs: checkpoint.latestMs + elapsed + drift,
    };
  return within(t, 0, checkpoint.validUntilMs) ? t : null;
}
