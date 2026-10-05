import { createHash, createHmac, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  canonicalizeNewReceiptSignature,
  decodeReceipt,
  encodeReceipt,
  receiptSigningInput,
  validateReceiptPublicKey,
  type ResponderReceiptFields,
} from '../protocol/receiptV2.js';
import {
  actionDigest,
  issuerProviderId,
  verifyReceipt,
  type ReportIdentity,
  type TimeInterval,
} from './receiptAuthority.js';
import type { ResponderIdentity } from './types.js';

const NIL = '00000000-0000-0000-0000-000000000000',
  WEEK = 604800000,
  LEASE = 60000,
  MAX_RECEIPT_RECORDS = 10000,
  MAX_RECEIPT_BYTES_TOTAL = 64 * 1024 * 1024,
  MAX_QUARANTINE_RECORDS = 128,
  MAX_QUARANTINE_BYTES = 1024 * 1024;
export type ActionIntent = Pick<
  ResponderReceiptFields,
  | 'actionId'
  | 'providerKind'
  | 'issuerProviderId'
  | 'reportId'
  | 'reportProtocolVersion'
  | 'revision'
  | 'payloadDigest'
  | 'originKeyId'
  | 'responderId'
  | 'observedIncidentVersion'
  | 'status'
  | 'note'
  | 'actionDigest'
>;
export interface AllocatedAction extends ResponderReceiptFields {
  allocatedAtMs: number;
  preparationState: 'PREPARING' | 'SIGNED';
}
export interface ActionCommitResult {
  actionId: string;
  issuerProviderId: Uint8Array;
  actionDigest: Uint8Array;
  state: 'PREPARING' | 'SIGNED' | 'CONFLICT' | 'REJECTED';
  eventDigest: string | null;
  reason: string | null;
}
export interface ReceiptImportResult {
  eventId: string | null;
  issuerProviderId: Uint8Array | null;
  eventDigest: string | null;
  state: 'IMPORTED' | 'DUPLICATE' | 'QUARANTINED' | 'REJECTED';
  projection: 'APPLIED' | 'HISTORICAL' | 'CONFLICT' | 'NONE';
  reason: string | null;
}
export interface ReceiptAccessChallenge {
  challengeId: string;
  reportId: string;
  originKeyId: Uint8Array;
  nonce: Uint8Array;
  expiresAtMs: number;
}
export interface ReceiptPageEntry {
  eventId: string;
  eventDigest: string;
  bytesBase64: string;
  kind: 'SGA2' | 'SGR2';
  revision: number;
  verification: string;
}
export interface ReceiptPage {
  entries: ReceiptPageEntry[];
  nextCursor: string | null;
}

// Operator-supplied, pinned cloud root. Never generated or replaced on failure.
// sign returns a canonical low-S P1363 signature over the supplied domain bytes.
export interface AuthoritySigner {
  publicKeyDer: Uint8Array;
  sign(input: Uint8Array): Promise<Uint8Array>;
}
type StoredFields = Omit<
  ResponderReceiptFields,
  | 'issuerProviderId'
  | 'actionDigest'
  | 'payloadDigest'
  | 'originKeyId'
  | 'issuerKeyId'
  | 'sequence'
  | 'observedIncidentVersion'
> & {
  issuerProviderId: string;
  actionDigest: string;
  payloadDigest: string;
  originKeyId: string;
  issuerKeyId: string;
  sequence: string;
  observedIncidentVersion: string;
};
interface ActionRow {
  action_id: string;
  issuer_provider_id: Buffer;
  action_digest: Buffer;
  issuer_key_id: Buffer;
  fields: StoredFields;
  preparation_state: 'PREPARING' | 'SIGNED';
  lease_token: string | null;
  lease_until_ms: string | null;
}
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest();
const same = (a: Uint8Array, b: Uint8Array) =>
  Buffer.from(a).equals(Buffer.from(b));
const placeholder = Buffer.concat([
  Buffer.alloc(31),
  Buffer.from([1]),
  Buffer.alloc(31),
  Buffer.from([1]),
]);
function storeFields(f: ResponderReceiptFields): StoredFields {
  return {
    ...f,
    issuerProviderId: Buffer.from(f.issuerProviderId).toString('hex'),
    actionDigest: Buffer.from(f.actionDigest).toString('hex'),
    payloadDigest: Buffer.from(f.payloadDigest).toString('hex'),
    originKeyId: Buffer.from(f.originKeyId).toString('hex'),
    issuerKeyId: Buffer.from(f.issuerKeyId).toString('hex'),
    sequence: f.sequence.toString(),
    observedIncidentVersion: f.observedIncidentVersion.toString(),
  };
}
function readFields(row: ActionRow): ResponderReceiptFields {
  const f = row.fields;
  const fields = {
    ...f,
    issuerProviderId: Buffer.from(f.issuerProviderId, 'hex'),
    actionDigest: Buffer.from(f.actionDigest, 'hex'),
    payloadDigest: Buffer.from(f.payloadDigest, 'hex'),
    originKeyId: Buffer.from(f.originKeyId, 'hex'),
    issuerKeyId: Buffer.from(f.issuerKeyId, 'hex'),
    sequence: BigInt(f.sequence),
    observedIncidentVersion: BigInt(f.observedIncidentVersion),
  };
  encodeReceipt(fields, placeholder, Buffer.alloc(0));
  return fields;
}
function uuidBytes(value: string): Buffer {
  const hex = value.replaceAll('-', '');
  if (!/^[0-9a-fA-F]{32}$/u.test(hex)) throw new Error('INVALID_UUID');
  return Buffer.from(hex, 'hex');
}
function uint64(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_TIME');
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
}
function receiptAccessDomain(challenge: ReceiptAccessChallenge): Buffer {
  return Buffer.concat([
    Buffer.from('SAGIP-ORIGIN-READ-V1', 'ascii'),
    Buffer.from([0]),
    uuidBytes(challenge.challengeId),
    uuidBytes(challenge.reportId),
    Buffer.from(challenge.originKeyId),
    Buffer.from(challenge.nonce),
    uint64(challenge.expiresAtMs),
  ]);
}
async function transaction<T>(
  pool: Pick<Pool, 'connect'>,
  body: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    try {
      const result = await body(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  } finally {
    c.release();
  }
}
// Callers must pass an identity from the authenticated server adapter, never
// construct it from ActionIntent. Registration alone is not authentication.
export class ReceiptService {
  private readonly key: Buffer;
  private readonly keyId: Buffer;
  private readonly provider: Buffer;
  constructor(
    private readonly pool: Pick<Pool, 'connect'>,
    private readonly signer: AuthoritySigner,
    private readonly now: () => number = Date.now,
    private readonly qualifiedInterval?: () => TimeInterval,
  ) {
    validateReceiptPublicKey(signer.publicKeyDer);
    this.key = Buffer.from(signer.publicKeyDer);
    this.keyId = digest(this.key);
    this.provider = issuerProviderId(1, this.keyId, NIL);
  }
  private clock(): number {
    const n = this.now();
    if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(n + WEEK))
      throw new Error('INVALID_TIME');
    return n;
  }
  private verificationTime(now: number): TimeInterval {
    const time = this.qualifiedInterval?.() ?? {earliestMs: now, latestMs: now};
    if (!Number.isSafeInteger(time.earliestMs) || !Number.isSafeInteger(time.latestMs) ||
        time.earliestMs < 0 || time.latestMs < time.earliestMs)
      throw new Error('TIME_UNAVAILABLE');
    return time;
  }
  private async lookup(
    c: PoolClient,
    id: string,
  ): Promise<ActionRow | undefined> {
    return (
      await c.query<ActionRow>(
        'SELECT * FROM receipt_actions WHERE action_id=$1',
        [id],
      )
    ).rows[0];
  }
  async allocateAction(
    input: ActionIntent,
    responder: ResponderIdentity,
  ): Promise<AllocatedAction> {
    return (await this.allocateActionResult(input, responder)).action;
  }
  async allocateActionResult(
    input: ActionIntent,
    responder: ResponderIdentity,
  ): Promise<{action: AllocatedAction; created: boolean}> {
    // Own only canonical intent fields before the first asynchronous boundary.
    // Unknown JSON properties and mutable caller buffers never reach storage.
    const intent: ActionIntent = {
      actionId: input.actionId,
      providerKind: input.providerKind,
      issuerProviderId: Buffer.from(input.issuerProviderId),
      reportId: input.reportId,
      reportProtocolVersion: input.reportProtocolVersion,
      revision: input.revision,
      payloadDigest: Buffer.from(input.payloadDigest),
      originKeyId: Buffer.from(input.originKeyId),
      responderId: input.responderId,
      observedIncidentVersion: input.observedIncidentVersion,
      status: input.status,
      note: input.note,
      actionDigest: Buffer.from(input.actionDigest),
    };
    responder = { ...responder };
    if (intent.responderId !== responder.responderId)
      throw new Error('UNAUTHORIZED');
    if (
      intent.providerKind !== 1 ||
      !same(intent.issuerProviderId, this.provider)
    )
      throw new Error('PROVIDER_CONFLICT');
    const now = this.clock();
    const fields: ResponderReceiptFields = {
      ...intent,
      purpose: 1,
      issuerKeyId: this.keyId,
      grantId: NIL,
      callsign: responder.callsign,
      sequence: 1n,
      issuedAtMs: now,
      forwardingExpiresAtMs: now + WEEK,
    };
    // The strict codec validates bounds before SQL and before computing a digest.
    encodeReceipt(fields, placeholder, Buffer.alloc(0));
    if (!same(actionDigest(fields), intent.actionDigest))
      throw new Error('DIGEST_CONFLICT');
    return transaction(this.pool, async c => {
      const registered = (
        await c.query<{ callsign: string; role: string }>(
          'SELECT callsign,role FROM responder_identities WHERE responder_id=$1 FOR SHARE',
          [responder.responderId],
        )
      ).rows[0];
      if (
        !registered ||
        registered.callsign !== responder.callsign ||
        registered.role !== responder.role
      )
        throw new Error('UNAUTHORIZED');
      // Same UUID can target different incidents; serialize globally before any
      // sequence allocation. Hash collisions only reduce concurrency.
      await c.query('SELECT pg_advisory_xact_lock($1)', [
        digest(Buffer.from(intent.actionId)).readBigInt64BE().toString(),
      ]);
      const existing = await this.lookup(c, intent.actionId);
      if (existing) {
        if (
          !same(existing.issuer_provider_id, intent.issuerProviderId) ||
          !same(existing.action_digest, intent.actionDigest)
        )
          throw new Error('ACTION_CONFLICT');
        const retained = readFields(existing);
        return {
          action: {
            ...retained,
            allocatedAtMs: retained.issuedAtMs,
            preparationState: existing.preparation_state,
          },
          created: false,
        };
      }
      const imported = (
        await c.query(
          'SELECT event_id FROM receipt_records WHERE event_id=$1',
          [intent.actionId],
        )
      ).rows[0];
      if (imported) throw new Error('ACTION_CONFLICT');
      const incident = (
        await c.query<{ receipt_version: string }>(
          'SELECT receipt_version FROM incidents WHERE report_id=$1 FOR UPDATE',
          [intent.reportId],
        )
      ).rows[0];
      if (!incident) throw new Error('REPORT_IDENTITY_CONFLICT');
      const report = await this.report(c, intent.reportId);
      if (
        report.revision !== intent.revision ||
        report.reportProtocolVersion !== intent.reportProtocolVersion ||
        !same(report.payloadDigest, intent.payloadDigest) ||
        !same(report.originKeyId, intent.originKeyId)
      )
        throw new Error('REPORT_IDENTITY_CONFLICT');
      if (BigInt(incident.receipt_version) !== intent.observedIncidentVersion)
        throw new Error('INCIDENT_VERSION_CONFLICT');
      const counter = await c.query<{ sequence: string }>(
        `INSERT INTO receipt_sequences(issuer_key_id,grant_id,report_id,sequence) VALUES ($1,$2,$3,1)
        ON CONFLICT (issuer_key_id,grant_id,report_id) DO UPDATE SET sequence=receipt_sequences.sequence+1 RETURNING sequence`,
        [this.keyId, NIL, intent.reportId],
      );
      fields.sequence = BigInt(counter.rows[0]!.sequence);
      await c.query(
        `INSERT INTO receipt_actions(action_id,issuer_provider_id,action_digest,issuer_key_id,grant_id,report_id,responder_id,sequence,fields,preparation_state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PREPARING')`,
        [
          intent.actionId,
          this.provider,
          Buffer.from(intent.actionDigest),
          this.keyId,
          NIL,
          intent.reportId,
          intent.responderId,
          fields.sequence.toString(),
          storeFields(fields),
        ],
      );
      return {
        action: {
          ...fields,
          allocatedAtMs: fields.issuedAtMs,
          preparationState: 'PREPARING',
        },
        created: true,
      };
    });
  }
  private async report(c: PoolClient, id: string): Promise<ReportIdentity> {
    const row = (
      await c.query<{
        report_id: string;
        revision: number;
        payload_digest: Buffer;
        origin_key_id: Buffer;
        public_key_der: Buffer;
        envelope_bytes: Buffer;
      }>(
        `SELECT m.report_id,m.revision,r.payload_digest,m.origin_key_id,k.public_key_der,m.envelope_bytes
      FROM accepted_messages m JOIN incident_revisions r ON r.report_id=m.report_id AND r.revision=m.revision JOIN origin_keys k ON k.origin_key_id=m.origin_key_id
      WHERE m.report_id=$1 ORDER BY m.revision DESC LIMIT 1`,
        [id],
      )
    ).rows[0];
    if (!row) throw new Error('REPORT_IDENTITY_CONFLICT');
    return {
      reportId: row.report_id,
      reportProtocolVersion: row.envelope_bytes[4]!,
      revision: row.revision,
      payloadDigest: row.payload_digest,
      originKeyId: row.origin_key_id,
      originPublicKeyDer: row.public_key_der,
    };
  }
  async getActionResult(
    actionId: string,
    responder: ResponderIdentity,
  ): Promise<ActionCommitResult | null> {
    return transaction(this.pool, async c => {
      const row = (
        await c.query<ActionRow>(
          'SELECT * FROM receipt_actions WHERE action_id=$1 AND responder_id=$2',
          [actionId, responder.responderId],
        )
      ).rows[0];
      if (!row) return null;
      const registered = (
        await c.query<{callsign: string; role: string}>(
          'SELECT callsign,role FROM responder_identities WHERE responder_id=$1',
          [responder.responderId],
        )
      ).rows[0];
      if (
        !registered ||
        registered.callsign !== responder.callsign ||
        registered.role !== responder.role
      )
        return null;
      const fields = readFields(row);
      if (row.preparation_state !== 'SIGNED')
        return this.result(fields, 'PREPARING');
      const bytes = (
        await c.query<{object_bytes: Buffer}>(
          'SELECT object_bytes FROM receipt_records WHERE event_id=$1',
          [actionId],
        )
      ).rows[0]?.object_bytes;
      if (!bytes) throw new Error('SIGNED_RECEIPT_MISSING');
      return this.result(fields, 'SIGNED', bytes);
    });
  }

  async getReceipt(actionId: string): Promise<Uint8Array | null> {
    const c = await this.pool.connect();
    try {
      return (
        (
          await c.query<{ object_bytes: Buffer }>(
            'SELECT object_bytes FROM receipt_records WHERE event_id=$1',
            [actionId],
          )
        ).rows[0]?.object_bytes ?? null
      );
    } finally {
      c.release();
    }
  }
  private result(
    f: ResponderReceiptFields,
    state: ActionCommitResult['state'],
    bytes: Uint8Array | null = null,
    reason: string | null = null,
  ): ActionCommitResult {
    return {
      actionId: f.actionId,
      issuerProviderId: f.issuerProviderId,
      actionDigest: f.actionDigest,
      state,
      eventDigest: bytes ? digest(bytes).toString('hex') : null,
      reason,
    };
  }
  async prepareReceipt(actionId: string): Promise<ActionCommitResult> {
    const token = randomUUID(),
      now = this.clock();
    const claim = await transaction(this.pool, async c => {
      const row = (
        await c.query<ActionRow>(
          'SELECT * FROM receipt_actions WHERE action_id=$1 FOR UPDATE',
          [actionId],
        )
      ).rows[0];
      if (!row) throw new Error('ACTION_NOT_FOUND');
      const fields = readFields(row);
      if (row.preparation_state === 'SIGNED') {
        const bytes = (
          await c.query<{ object_bytes: Buffer }>(
            'SELECT object_bytes FROM receipt_records WHERE event_id=$1',
            [actionId],
          )
        ).rows[0]?.object_bytes;
        if (!bytes) throw new Error('SIGNED_RECEIPT_MISSING');
        return { fields, done: this.result(fields, 'SIGNED', bytes) };
      }
      if (!same(fields.issuerKeyId, this.keyId))
        return {
          fields,
          done: this.result(fields, 'PREPARING', null, 'SIGNER_UNAVAILABLE'),
        };
      if (now >= fields.forwardingExpiresAtMs)
        return {
          fields,
          done: this.result(fields, 'REJECTED', null, 'FORWARDING_EXPIRED'),
        };
      if (
        row.lease_until_ms !== null &&
        BigInt(row.lease_until_ms) > BigInt(now)
      )
        return { fields, done: this.result(fields, 'PREPARING') };
      await c.query(
        'UPDATE receipt_actions SET lease_token=$2,lease_until_ms=$3 WHERE action_id=$1',
        [actionId, token, now + LEASE],
      );
      return { fields, done: null };
    });
    if (claim.done) return claim.done;
    const f = claim.fields;
    let bytes: Buffer;
    try {
      const input = receiptSigningInput(f, Buffer.alloc(0));
      bytes = encodeReceipt(f, await this.signer.sign(input), Buffer.alloc(0));
    } catch {
      return this.result(f, 'PREPARING', null, 'SIGNER_UNAVAILABLE');
    }
    return transaction(this.pool, async c => {
      // Same incident-first order as ingestion/allocation avoids lock inversion.
      await c.query(
        'SELECT report_id FROM incidents WHERE report_id=$1 FOR UPDATE',
        [f.reportId],
      );
      const row = (
        await c.query<ActionRow>(
          'SELECT * FROM receipt_actions WHERE action_id=$1 FOR UPDATE',
          [actionId],
        )
      ).rows[0]!;
      if (row.preparation_state === 'SIGNED') {
        const existing = (
          await c.query<{ object_bytes: Buffer }>(
            'SELECT object_bytes FROM receipt_records WHERE event_id=$1',
            [actionId],
          )
        ).rows[0]!;
        return this.result(f, 'SIGNED', existing.object_bytes);
      }
      if (
        row.lease_token !== token ||
        BigInt(row.lease_until_ms ?? '0') <= BigInt(this.clock())
      )
        return this.result(f, 'PREPARING');
      const report = await this.report(c, f.reportId),
        time = this.clock();
      // A newer revision makes this authentic signed action historical; verify
      // against its original accepted identity before storing it.
      const original =
        report.revision === f.revision
          ? report
          : await this.originalReport(c, f);
      const verified = verifyReceipt(bytes, {
        roots: new Map([[this.keyId.toString('hex'), this.key]]),
        revokedGrants: new Set(),
        allowedScopes: new Set(),
        trustedTime: this.verificationTime(time),
        authorityCheckedAtMs: time,
        currentAuthorityChecked: true,
        report: original,
        pairedTimeProviderId: null,
      });
      if (verified.kind !== 'VERIFIED_CURRENT')
        return this.result(f, 'REJECTED', null, 'VERIFICATION_FAILED');
      await this.ensureReceiptCapacity(c, bytes.length);
      await c.query(
        `INSERT INTO receipt_records(event_id,issuer_provider_id,action_digest,event_digest,object_bytes,forwarding_expires_at_ms,report_id,revision,object_kind,verification,recorded_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          actionId,
          Buffer.from(f.issuerProviderId),
          Buffer.from(f.actionDigest),
          digest(bytes),
          bytes,
          f.forwardingExpiresAtMs,
          f.reportId,
          f.revision,
          'SGA2',
          verified.kind,
          time,
        ],
      );
      if (report.revision === f.revision) {
        const projected = await c.query(
          `INSERT INTO receipt_projections(issuer_provider_id,report_id,revision,sequence,event_id) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (issuer_provider_id,report_id) DO UPDATE SET revision=EXCLUDED.revision,sequence=EXCLUDED.sequence,event_id=EXCLUDED.event_id
          WHERE receipt_projections.revision<EXCLUDED.revision OR (receipt_projections.revision=EXCLUDED.revision AND receipt_projections.sequence<EXCLUDED.sequence)
          RETURNING event_id`,
          [
            Buffer.from(f.issuerProviderId),
            f.reportId,
            f.revision,
            f.sequence.toString(),
            actionId,
          ],
        );
        if ((projected.rowCount ?? 0) > 0)
          await c.query(
            'UPDATE incidents SET receipt_version=receipt_version+1 WHERE report_id=$1',
            [f.reportId],
          );
      }
      await c.query(
        "UPDATE receipt_actions SET preparation_state='SIGNED',lease_token=NULL,lease_until_ms=NULL WHERE action_id=$1",
        [actionId],
      );
      return this.result(f, 'SIGNED', bytes);
    });
  }
  async createReceiptAccessChallenge(reportId: string): Promise<ReceiptAccessChallenge> {
    const now = this.clock();
    return transaction(this.pool, async c => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [
        digest(Buffer.from('SAGIP-RECEIPT-ACCESS-CHALLENGE-CAPACITY-V1')).readBigInt64BE().toString(),
      ]);
      await c.query('DELETE FROM receipt_access_challenges WHERE expires_at_ms<$1', [now]);
      const count = Number((await c.query<{count: string}>('SELECT COUNT(*) AS count FROM receipt_access_challenges')).rows[0]?.count ?? '0');
      if (count >= 10000) throw new Error('CAPACITY_FULL');
      const incident = (await c.query<{origin_key_id: Buffer}>(
        'SELECT origin_key_id FROM incidents WHERE report_id=$1', [reportId],
      )).rows[0];
      if (!incident) throw new Error('REPORT_NOT_FOUND');
      const challenge: ReceiptAccessChallenge = {
        challengeId: randomUUID(), reportId,
        originKeyId: Buffer.from(incident.origin_key_id),
        nonce: randomBytes(32), expiresAtMs: now + 60000,
      };
      await c.query(
        'INSERT INTO receipt_access_challenges(challenge_id,report_id,origin_key_id,nonce,created_at_ms,expires_at_ms) VALUES ($1,$2,$3,$4,$5,$6)',
        [challenge.challengeId, reportId, Buffer.from(challenge.originKeyId), Buffer.from(challenge.nonce), now, challenge.expiresAtMs],
      );
      return challenge;
    });
  }

  async authorizeReceiptAccess(
    reportId: string,
    challengeId: string,
    signatureInput: Uint8Array,
  ): Promise<{sessionToken: string; expiresAtMs: number}> {
    const signature = Buffer.from(signatureInput), now = this.clock();
    return transaction(this.pool, async c => {
      const row = (await c.query<{
        origin_key_id: Buffer; nonce: Buffer; expires_at_ms: string;
        consumed_at_ms: string | null; public_key_der: Buffer;
      }>(
        `SELECT ch.origin_key_id,ch.nonce,ch.expires_at_ms,ch.consumed_at_ms,k.public_key_der
         FROM receipt_access_challenges ch JOIN origin_keys k ON k.origin_key_id=ch.origin_key_id
         WHERE ch.challenge_id=$1 AND ch.report_id=$2 FOR UPDATE`,
        [challengeId, reportId],
      )).rows[0];
      if (!row) throw new Error('CHALLENGE_NOT_FOUND');
      if (row.consumed_at_ms !== null) throw new Error('CHALLENGE_CONSUMED');
      const expiresAtMs = Number(row.expires_at_ms);
      if (!Number.isSafeInteger(expiresAtMs) || now > expiresAtMs) throw new Error('CHALLENGE_EXPIRED');
      const challenge: ReceiptAccessChallenge = {
        challengeId, reportId, originKeyId: row.origin_key_id,
        nonce: row.nonce, expiresAtMs,
      };
      let canonical: Buffer;
      try {
        canonical = canonicalizeNewReceiptSignature(signature);
      } catch {
        throw new Error('INVALID_SIGNATURE');
      }
      if (canonical.length !== signature.length || !timingSafeEqual(canonical, signature))
        throw new Error('INVALID_SIGNATURE');
      let valid = false;
      try {
        valid = verifySignature('sha256', receiptAccessDomain(challenge), {
          key: createPublicKey({key: row.public_key_der, format: 'der', type: 'spki'}),
          dsaEncoding: 'ieee-p1363',
        }, signature);
      } catch {
        valid = false;
      }
      if (!valid) throw new Error('INVALID_SIGNATURE');
      await c.query('UPDATE receipt_access_challenges SET consumed_at_ms=$2 WHERE challenge_id=$1', [challengeId, now]);
      await c.query('SELECT pg_advisory_xact_lock($1)', [
        digest(Buffer.from('SAGIP-RECEIPT-ACCESS-SESSION-CAPACITY-V1')).readBigInt64BE().toString(),
      ]);
      await c.query('DELETE FROM receipt_access_sessions WHERE expires_at_ms<$1', [now]);
      const count = Number((await c.query<{count: string}>('SELECT COUNT(*) AS count FROM receipt_access_sessions')).rows[0]?.count ?? '0');
      if (count >= 10000) throw new Error('CAPACITY_FULL');
      const sessionToken = randomBytes(32).toString('base64url'),
        sessionDigest = digest(Buffer.from(sessionToken, 'utf8')),
        sessionExpiresAt = now + 900000;
      await c.query(
        'INSERT INTO receipt_access_sessions(session_digest,report_id,origin_key_id,created_at_ms,expires_at_ms) VALUES ($1,$2,$3,$4,$5)',
        [sessionDigest, reportId, row.origin_key_id, now, sessionExpiresAt],
      );
      return {sessionToken, expiresAtMs: sessionExpiresAt};
    });
  }

  async listReportReceipts(
    reportId: string,
    sessionToken: string,
    cursor: string | null,
  ): Promise<ReceiptPage> {
    const now = this.clock(), tokenDigest = digest(Buffer.from(sessionToken, 'utf8'));
    const c = await this.pool.connect();
    try {
      const session = (await c.query<{expires_at_ms: string}>(
        'SELECT expires_at_ms FROM receipt_access_sessions WHERE session_digest=$1 AND report_id=$2',
        [tokenDigest, reportId],
      )).rows[0];
      if (!session || Number(session.expires_at_ms) <= now) throw new Error('UNAUTHORIZED');
      let afterTime: number | null = null, afterEvent: string | null = null;
      if (cursor) {
        const parts = cursor.split('.');
        if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('INVALID_CURSOR');
        const payload = Buffer.from(parts[0], 'base64url'), supplied = Buffer.from(parts[1], 'base64url');
        if (payload.toString('base64url') !== parts[0] || supplied.toString('base64url') !== parts[1]) throw new Error('INVALID_CURSOR');
        const expected = createHmac('sha256', Buffer.from(sessionToken, 'utf8'))
          .update('SAGIP-RECEIPT-CURSOR-V1\0', 'ascii')
          .update(reportId, 'utf8')
          .update(payload)
          .digest();
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('INVALID_CURSOR');
        const parsed: unknown = JSON.parse(payload.toString('utf8'));
        if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(parsed[0])) throw new Error('INVALID_CURSOR');
        afterTime = Number(parsed[0]); afterEvent = parsed[1];
        if (!Number.isSafeInteger(afterTime)) throw new Error('INVALID_CURSOR');
      }
      type Row = {event_id: string; event_digest: Buffer; object_bytes: Buffer; object_kind: 'SGA2'|'SGR2'; revision: number; verification: string; recorded_at_ms: string};
      const rows = afterTime === null
        ? (await c.query<Row>(
            `SELECT event_id,event_digest,object_bytes,object_kind,revision,verification,recorded_at_ms
             FROM receipt_records WHERE report_id=$1 AND recorded_at_ms IS NOT NULL
             ORDER BY recorded_at_ms,event_id LIMIT 33`, [reportId])).rows
        : (await c.query<Row>(
            `SELECT event_id,event_digest,object_bytes,object_kind,revision,verification,recorded_at_ms
             FROM receipt_records WHERE report_id=$1 AND recorded_at_ms IS NOT NULL
               AND (recorded_at_ms>$2 OR (recorded_at_ms=$2 AND event_id>$3))
             ORDER BY recorded_at_ms,event_id LIMIT 33`, [reportId, afterTime, afterEvent])).rows;
      const entries: ReceiptPageEntry[] = [];
      let last: Row | null = null;
      for (const row of rows.slice(0, 32)) {
        const entry: ReceiptPageEntry = {
          eventId: row.event_id,
          eventDigest: Buffer.from(row.event_digest).toString('hex'),
          bytesBase64: Buffer.from(row.object_bytes).toString('base64'),
          kind: row.object_kind,
          revision: Number(row.revision),
          verification: row.verification,
        };
        const candidate = [...entries, entry];
        if (Buffer.byteLength(JSON.stringify({entries: candidate, nextCursor: null}), 'utf8') > 262144) break;
        entries.push(entry); last = row;
      }
      const hasMore = rows.length > entries.length;
      let nextCursor: string | null = null;
      if (hasMore && last) {
        const payload = Buffer.from(JSON.stringify([String(last.recorded_at_ms), last.event_id]), 'utf8');
        const mac = createHmac('sha256', Buffer.from(sessionToken, 'utf8'))
          .update('SAGIP-RECEIPT-CURSOR-V1\0', 'ascii')
          .update(reportId, 'utf8')
          .update(payload)
          .digest();
        nextCursor = payload.toString('base64url') + '.' + mac.toString('base64url');
      }
      return {entries, nextCursor};
    } finally {
      c.release();
    }
  }

  private async ensureReceiptCapacity(c: PoolClient, objectBytes: number): Promise<void> {
    await c.query('SELECT pg_advisory_xact_lock($1)', [
      digest(Buffer.from('SAGIP-RECEIPT-STORE-CAPACITY-V1')).readBigInt64BE().toString(),
    ]);
    const stats = (await c.query<{count: string; bytes: string}>(
      'SELECT COUNT(*) AS count,COALESCE(SUM(octet_length(object_bytes)),0) AS bytes FROM receipt_records',
    )).rows[0];
    if (
      Number(stats?.count ?? '0') >= MAX_RECEIPT_RECORDS ||
      Number(stats?.bytes ?? '0') + objectBytes > MAX_RECEIPT_BYTES_TOTAL
    )
      throw new Error('CAPACITY_FULL');
  }

  private async quarantineReceipt(
    c: PoolClient,
    input: {
      eventId: string;
      reportId: string;
      revision: number;
      objectKind: 'SGA2' | 'SGR2';
      issuerProviderId: Buffer | null;
      actionDigest: Buffer | null;
      eventDigest: Buffer;
      objectBytes: Buffer;
      verification: string;
      reason: string;
      recordedAtMs: number;
    },
  ): Promise<void> {
    await c.query('SELECT pg_advisory_xact_lock($1)', [
      digest(Buffer.from('SAGIP-RECEIPT-QUARANTINE-CAPACITY-V1')).readBigInt64BE().toString(),
    ]);
    if ((await c.query('SELECT quarantine_id FROM receipt_quarantine WHERE event_digest=$1', [input.eventDigest])).rows[0])
      return;
    let stats = (await c.query<{count: string; bytes: string}>(
      'SELECT COUNT(*) AS count,COALESCE(SUM(octet_length(object_bytes)),0) AS bytes FROM receipt_quarantine',
    )).rows[0];
    while (
      Number(stats?.count ?? '0') >= MAX_QUARANTINE_RECORDS ||
      Number(stats?.bytes ?? '0') + input.objectBytes.length > MAX_QUARANTINE_BYTES
    ) {
      const oldest = (await c.query<{quarantine_id: string}>(
        'SELECT quarantine_id FROM receipt_quarantine ORDER BY recorded_at_ms,quarantine_id LIMIT 1',
      )).rows[0];
      if (!oldest) throw new Error('CAPACITY_FULL');
      await c.query('DELETE FROM receipt_quarantine WHERE quarantine_id=$1', [oldest.quarantine_id]);
      stats = (await c.query<{count: string; bytes: string}>(
        'SELECT COUNT(*) AS count,COALESCE(SUM(octet_length(object_bytes)),0) AS bytes FROM receipt_quarantine',
      )).rows[0];
    }
    await c.query(
      `INSERT INTO receipt_quarantine(quarantine_id,event_id,report_id,revision,object_kind,issuer_provider_id,action_digest,event_digest,object_bytes,verification,reason,recorded_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        randomUUID(), input.eventId, input.reportId, input.revision, input.objectKind,
        input.issuerProviderId, input.actionDigest, input.eventDigest, input.objectBytes,
        input.verification, input.reason, input.recordedAtMs,
      ],
    );
  }

  private async clearQuarantine(c: PoolClient, eventDigest: Buffer): Promise<void> {
    await c.query('DELETE FROM receipt_quarantine WHERE event_digest=$1', [eventDigest]);
  }

  async importGatewayReceipt(
    input: Uint8Array,
    importer: ResponderIdentity,
  ): Promise<ReceiptImportResult> {
    const bytes = Buffer.from(input),
      eventDigest = digest(bytes);
    let decoded;
    try {
      decoded = decodeReceipt(bytes);
    } catch {
      return {
        eventId: null,
        issuerProviderId: null,
        eventDigest: eventDigest.toString('hex'),
        state: 'REJECTED',
        projection: 'NONE',
        reason: 'MALFORMED_OBJECT',
      };
    }
    if (decoded.fields.purpose !== 1 && decoded.fields.purpose !== 2) {
      return {
        eventId: null,
        issuerProviderId: null,
        eventDigest: eventDigest.toString('hex'),
        state: 'REJECTED',
        projection: 'NONE',
        reason: 'NOT_RECEIPT',
      };
    }
    const receipt = decoded.fields;
    return transaction(this.pool, async c => {
      const registered = (
        await c.query<{callsign: string; role: string}>(
          'SELECT callsign,role FROM responder_identities WHERE responder_id=$1',
          [importer.responderId],
        )
      ).rows[0];
      const eventId = receipt.purpose === 1 ? receipt.actionId : receipt.eventId;
      const objectKind = receipt.purpose === 1 ? 'SGA2' as const : 'SGR2' as const;
      if (
        !registered ||
        registered.callsign !== importer.callsign ||
        registered.role !== importer.role
      ) {
        return {
          eventId,
          issuerProviderId:
            receipt.purpose === 1 ? Buffer.from(receipt.issuerProviderId) : null,
          eventDigest: eventDigest.toString('hex'),
          state: 'REJECTED',
          projection: 'NONE',
          reason: 'UNAUTHORIZED',
        };
      }

      await c.query(
        'SELECT report_id FROM incidents WHERE report_id=$1 FOR UPDATE',
        [receipt.reportId],
      );
      let report: ReportIdentity;
      try {
        report = await this.originalReport(c, receipt);
      } catch {
        const issuer = receipt.purpose === 1 ? Buffer.from(receipt.issuerProviderId) : null;
        const action = receipt.purpose === 1 ? Buffer.from(receipt.actionDigest) : null;
        await this.quarantineReceipt(c, {
          eventId,
          reportId: receipt.reportId,
          revision: receipt.revision,
          objectKind,
          issuerProviderId: issuer,
          actionDigest: action,
          eventDigest,
          objectBytes: bytes,
          verification: 'UNVERIFIED_AUTHORITY',
          reason: 'REPORT_LINKAGE',
          recordedAtMs: this.clock(),
        });
        return {
          eventId,
          issuerProviderId: issuer,
          eventDigest: eventDigest.toString('hex'),
          state: 'QUARANTINED',
          projection: 'NONE',
          reason: 'REPORT_LINKAGE',
        };
      }

      let linkedAck: Buffer | undefined;
      let issuerProvider: Buffer | null =
        receipt.purpose === 1 ? Buffer.from(receipt.issuerProviderId) : null;
      let storedActionDigest: Buffer | null =
        receipt.purpose === 1 ? Buffer.from(receipt.actionDigest) : null;
      let linkedSequence: bigint | null =
        receipt.purpose === 1 ? receipt.sequence : null;
      if (receipt.purpose === 2) {
        const linked = (
          await c.query<{object_bytes: Buffer}>(
            'SELECT object_bytes FROM receipt_records WHERE event_id=$1',
            [receipt.ackEventId],
          )
        ).rows[0]?.object_bytes;
        if (linked) {
          try {
            const fields = decodeReceipt(linked).fields;
            if (fields.purpose === 1) {
              linkedAck = Buffer.from(linked);
              issuerProvider = Buffer.from(fields.issuerProviderId);
              storedActionDigest = Buffer.from(fields.actionDigest);
              linkedSequence = fields.sequence;
            }
          } catch {
            linkedAck = undefined;
          }
        }
      }

      const revokedGrants = new Set<string>();
      const allowedScopes = new Set<string>();
      const authorityReceipt =
        receipt.purpose === 1
          ? receipt
          : linkedAck
            ? decodeReceipt(linkedAck).fields
            : null;
      if (
        authorityReceipt?.purpose === 1 &&
        authorityReceipt.providerKind === 2
      ) {
        const grantRow = (
          await c.query<{object_bytes: Buffer; revoked_at_ms: string | null}>(
            'SELECT object_bytes,revoked_at_ms FROM receipt_authority_grants WHERE grant_id=$1',
            [authorityReceipt.grantId],
          )
        ).rows[0];
        if (grantRow) {
          try {
            const grant = decodeReceipt(grantRow.object_bytes).fields;
            if (grant.purpose === 3) allowedScopes.add(grant.scope);
          } catch {
            // Verification below classifies malformed authority state.
          }
          if (grantRow.revoked_at_ms !== null)
            revokedGrants.add(authorityReceipt.grantId);
        }
      }

      const now = this.clock(),
        verification = verifyReceipt(bytes, {
          roots: new Map([[this.keyId.toString('hex'), this.key]]),
          revokedGrants,
          allowedScopes,
          trustedTime: this.verificationTime(now),
          authorityCheckedAtMs: now,
          currentAuthorityChecked: true,
          report,
          ...(linkedAck ? {linkedAck} : {}),
          pairedTimeProviderId: null,
        });
      if (verification.kind === 'REJECTED') {
        return {
          eventId,
          issuerProviderId: issuerProvider,
          eventDigest: eventDigest.toString('hex'),
          state: 'REJECTED',
          projection: 'NONE',
          reason: verification.reason,
        };
      }

      if (!issuerProvider || !storedActionDigest || linkedSequence === null) {
        const reason =
          verification.kind === 'UNVERIFIED_AUTHORITY'
            ? verification.reason
            : 'ACK_LINKAGE';
        await this.quarantineReceipt(c, {
          eventId,
          reportId: receipt.reportId,
          revision: receipt.revision,
          objectKind,
          issuerProviderId: null,
          actionDigest: null,
          eventDigest,
          objectBytes: bytes,
          verification: verification.kind,
          reason,
          recordedAtMs: now,
        });
        return {
          eventId,
          issuerProviderId: null,
          eventDigest: eventDigest.toString('hex'),
          state: 'QUARANTINED',
          projection: 'NONE',
          reason,
        };
      }

      if (verification.kind === 'UNVERIFIED_AUTHORITY') {
        await this.quarantineReceipt(c, {
          eventId,
          reportId: receipt.reportId,
          revision: receipt.revision,
          objectKind,
          issuerProviderId: issuerProvider,
          actionDigest: storedActionDigest,
          eventDigest,
          objectBytes: bytes,
          verification: verification.kind,
          reason: verification.reason,
          recordedAtMs: now,
        });
        return {
          eventId,
          issuerProviderId: issuerProvider,
          eventDigest: eventDigest.toString('hex'),
          state: 'QUARANTINED',
          projection: 'NONE',
          reason: verification.reason,
        };
      }

      await c.query('SELECT pg_advisory_xact_lock($1)', [
        digest(Buffer.from(eventId)).readBigInt64BE().toString(),
      ]);
      const existing = (
        await c.query<{event_digest: Buffer; object_bytes: Buffer}>(
          'SELECT event_digest,object_bytes FROM receipt_records WHERE event_id=$1 FOR UPDATE',
          [eventId],
        )
      ).rows[0];
      if (existing) {
        if (
          !same(existing.event_digest, eventDigest) ||
          !same(existing.object_bytes, bytes)
        ) {
          await this.quarantineReceipt(c, {
            eventId,
            reportId: receipt.reportId,
            revision: receipt.revision,
            objectKind,
            issuerProviderId: issuerProvider,
            actionDigest: storedActionDigest,
            eventDigest,
            objectBytes: bytes,
            verification: verification.kind,
            reason: 'EVENT_EQUIVOCATION',
            recordedAtMs: now,
          });
          return {
            eventId,
            issuerProviderId: issuerProvider,
            eventDigest: eventDigest.toString('hex'),
            state: 'REJECTED',
            projection: 'CONFLICT',
            reason: 'EVENT_EQUIVOCATION',
          };
        }
        if (receipt.purpose === 2) {
          return {
            eventId,
            issuerProviderId: issuerProvider,
            eventDigest: eventDigest.toString('hex'),
            state: 'DUPLICATE',
            projection: 'NONE',
            reason: null,
          };
        }
        const projected = (
          await c.query<{event_id: string}>(
            'SELECT event_id FROM receipt_projections WHERE issuer_provider_id=$1 AND report_id=$2',
            [issuerProvider, receipt.reportId],
          )
        ).rows[0];
        return {
          eventId,
          issuerProviderId: issuerProvider,
          eventDigest: eventDigest.toString('hex'),
          state: 'DUPLICATE',
          projection:
            projected?.event_id === eventId ? 'APPLIED' : 'HISTORICAL',
          reason: null,
        };
      }

      await this.ensureReceiptCapacity(c, bytes.length);
      await c.query(
        'INSERT INTO receipt_records(event_id,issuer_provider_id,action_digest,event_digest,object_bytes,forwarding_expires_at_ms,report_id,revision,object_kind,verification,recorded_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          eventId,
          issuerProvider,
          storedActionDigest,
          eventDigest,
          bytes,
          receipt.forwardingExpiresAtMs,
          receipt.reportId,
          receipt.revision,
          objectKind,
          verification.kind,
          now,
        ],
      );
      await this.clearQuarantine(c, eventDigest);

      if (receipt.purpose === 2) {
        return {
          eventId,
          issuerProviderId: issuerProvider,
          eventDigest: eventDigest.toString('hex'),
          state: 'IMPORTED',
          projection: 'NONE',
          reason: null,
        };
      }
      const latest = (
        await c.query<{revision: number | string}>(
          'SELECT MAX(revision) AS revision FROM incident_revisions WHERE report_id=$1',
          [receipt.reportId],
        )
      ).rows[0]?.revision;
      if (Number(latest) !== receipt.revision) {
        return {
          eventId,
          issuerProviderId: issuerProvider,
          eventDigest: eventDigest.toString('hex'),
          state: 'IMPORTED',
          projection: 'HISTORICAL',
          reason: null,
        };
      }
      const current = (
        await c.query<{sequence: string; event_id: string}>(
          'SELECT sequence,event_id FROM receipt_projections WHERE issuer_provider_id=$1 AND report_id=$2 FOR UPDATE',
          [issuerProvider, receipt.reportId],
        )
      ).rows[0];
      if (
        current &&
        BigInt(current.sequence) === receipt.sequence &&
        current.event_id !== eventId
      ) {
        return {
          eventId,
          issuerProviderId: issuerProvider,
          eventDigest: eventDigest.toString('hex'),
          state: 'IMPORTED',
          projection: 'CONFLICT',
          reason: 'SEQUENCE_CONFLICT',
        };
      }
      if (current && BigInt(current.sequence) > receipt.sequence) {
        return {
          eventId,
          issuerProviderId: issuerProvider,
          eventDigest: eventDigest.toString('hex'),
          state: 'IMPORTED',
          projection: 'HISTORICAL',
          reason: null,
        };
      }
      const projected = await c.query(
        `INSERT INTO receipt_projections(issuer_provider_id,report_id,revision,sequence,event_id) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (issuer_provider_id,report_id) DO UPDATE SET revision=EXCLUDED.revision,sequence=EXCLUDED.sequence,event_id=EXCLUDED.event_id
         WHERE receipt_projections.revision<EXCLUDED.revision OR (receipt_projections.revision=EXCLUDED.revision AND receipt_projections.sequence<EXCLUDED.sequence)
         RETURNING event_id`,
        [
          issuerProvider,
          receipt.reportId,
          receipt.revision,
          receipt.sequence.toString(),
          eventId,
        ],
      );
      if ((projected.rowCount ?? 0) === 0) {
        return {
          eventId,
          issuerProviderId: issuerProvider,
          eventDigest: eventDigest.toString('hex'),
          state: 'IMPORTED',
          projection: 'HISTORICAL',
          reason: null,
        };
      }
      await c.query(
        'UPDATE incidents SET receipt_version=receipt_version+1 WHERE report_id=$1',
        [receipt.reportId],
      );
      return {
        eventId,
        issuerProviderId: issuerProvider,
        eventDigest: eventDigest.toString('hex'),
        state: 'IMPORTED',
        projection: 'APPLIED',
        reason: null,
      };
    });
  }

  private async originalReport(
    c: PoolClient,
    f: Pick<ResponderReceiptFields, 'reportId' | 'revision' | 'originKeyId'>,
  ): Promise<ReportIdentity> {
    const row = (
      await c.query<{
        payload_digest: Buffer;
        public_key_der: Buffer;
        envelope_bytes: Buffer;
      }>(
        `SELECT r.payload_digest,k.public_key_der,m.envelope_bytes FROM incident_revisions r JOIN accepted_messages m ON m.report_id=r.report_id AND m.revision=r.revision JOIN origin_keys k ON k.origin_key_id=m.origin_key_id WHERE r.report_id=$1 AND r.revision=$2`,
        [f.reportId, f.revision],
      )
    ).rows[0];
    if (!row) throw new Error('REPORT_IDENTITY_CONFLICT');
    return {
      reportId: f.reportId,
      reportProtocolVersion: row.envelope_bytes[4]!,
      revision: f.revision,
      payloadDigest: row.payload_digest,
      originKeyId: f.originKeyId,
      originPublicKeyDer: row.public_key_der,
    };
  }
}
