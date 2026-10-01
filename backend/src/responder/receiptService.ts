import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
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
} from './receiptAuthority.js';
import type { ResponderIdentity } from './types.js';

const NIL = '00000000-0000-0000-0000-000000000000',
  WEEK = 604800000,
  LEASE = 60000;
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
          ...retained,
          allocatedAtMs: retained.issuedAtMs,
          preparationState: existing.preparation_state,
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
        ...fields,
        allocatedAtMs: fields.issuedAtMs,
        preparationState: 'PREPARING',
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
        trustedTime: { earliestMs: time, latestMs: time },
        authorityCheckedAtMs: time,
        currentAuthorityChecked: true,
        report: original,
        pairedTimeProviderId: null,
      });
      if (verified.kind !== 'VERIFIED_CURRENT')
        return this.result(f, 'REJECTED', null, 'VERIFICATION_FAILED');
      await c.query(
        `INSERT INTO receipt_records(event_id,issuer_provider_id,action_digest,event_digest,object_bytes,forwarding_expires_at_ms) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          actionId,
          Buffer.from(f.issuerProviderId),
          Buffer.from(f.actionDigest),
          digest(bytes),
          bytes,
          f.forwardingExpiresAtMs,
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
  private async originalReport(
    c: PoolClient,
    f: ResponderReceiptFields,
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
