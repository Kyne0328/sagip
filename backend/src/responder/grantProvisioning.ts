import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  decodeReceipt,
  encodeReceipt,
  receiptSigningInput,
  validateReceiptPublicKey,
  verifyReceiptSignature,
  type AuthorityGrantFields,
  type TimeProofFields,
  type ReceiptFields,
} from '../protocol/receiptV2.js';
import { issuerProviderId } from './receiptAuthority.js';
import type { AuthoritySigner } from './receiptService.js';
import type { ResponderIdentity } from './types.js';
import { randomUUID } from 'node:crypto';

const NIL = '00000000-0000-0000-0000-000000000000',
  WEEK = 604800000;
export const MAX_AUTHORITY_TIME_PROOFS = 10000;
export const MAX_AUTHORITY_TIME_BYTES = 64 * 1024 * 1024;
const TIME_RECORD_METADATA_BYTES = 112,
  TIME_HIGH_WATER_BYTES = 40;
const TIME_CAPACITY_LOCK = createHash('sha256')
  .update('SAGIP-AUTHORITY-TIME-CAPACITY-V2')
  .digest()
  .readBigInt64BE()
  .toString();
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
const equal = (a: Uint8Array, b: Uint8Array) =>
  Buffer.from(a).equals(Buffer.from(b));
export interface GatewayGrantRequest {
  requestId: string;
  issuerKeyId: Uint8Array;
  issuerPublicKeyDer: Uint8Array;
  issuerProviderId: Uint8Array;
  grantId: string;
  responderId: string;
  callsign: string;
  statusMask: number;
  purposeMask: number;
  scope: string;
}
export interface TimeChallenge {
  verifierId: Uint8Array;
  verifierBootSessionId: string;
  nonce: Uint8Array;
}
export interface QualifiedAuthorityTime {
  timeMs: number;
  uncertaintyMs: number;
  validForMs: number;
}
export interface AuthorityPolicy {
  approvedIssuerKeyIds: Set<string>;
  allowedScopes: Set<string>;
  allowedResponderRoles: Set<string>;
  verifierOwners: Map<string, string>;
  statusMask: number;
  purposeMask: number;
}
export type AuthorityOperator = ResponderIdentity;
interface GrantRow {
  grant_id: string;
  request_digest: Buffer;
  object_bytes: Buffer;
  not_before_ms: string;
  expires_at_ms: string;
  revoked_at_ms: string | null;
}
async function transaction<T>(
  pool: Pick<Pool, 'connect'>,
  body: (c: PoolClient) => Promise<T>,
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
// Identity parameters come only from an authenticated server adapter/operator
// token lookup. Request JSON may never construct an AuthorityOperator.
export class GrantProvisioningService {
  private readonly key: Buffer;
  private readonly keyId: Buffer;
  private readonly policy: AuthorityPolicy;
  constructor(
    private readonly pool: Pick<Pool, 'connect'>,
    private readonly signer: AuthoritySigner,
    private readonly clock: () => QualifiedAuthorityTime,
    policy: AuthorityPolicy,
  ) {
    if (
      !Number.isSafeInteger(policy.statusMask) ||
      policy.statusMask < 1 ||
      policy.statusMask > 15 ||
      (policy.statusMask & 1) !== 1 ||
      !Number.isSafeInteger(policy.purposeMask) ||
      (policy.purposeMask !== 1 && policy.purposeMask !== 9)
    )
      throw new Error('INVALID_AUTHORITY_POLICY');
    validateReceiptPublicKey(signer.publicKeyDer);
    this.key = Buffer.from(signer.publicKeyDer);
    this.keyId = hash(this.key);
    this.policy = {
      approvedIssuerKeyIds: new Set(policy.approvedIssuerKeyIds),
      allowedScopes: new Set(policy.allowedScopes),
      allowedResponderRoles: new Set(policy.allowedResponderRoles),
      verifierOwners: new Map(policy.verifierOwners),
      statusMask: policy.statusMask,
      purposeMask: policy.purposeMask,
    };
  }
  private time(): QualifiedAuthorityTime {
    let t: QualifiedAuthorityTime;
    try {
      t = this.clock();
    } catch {
      throw new Error('TIME_UNAVAILABLE');
    }
    if (
      !Number.isSafeInteger(t.timeMs) ||
      !Number.isSafeInteger(t.uncertaintyMs) ||
      !Number.isSafeInteger(t.validForMs) ||
      t.timeMs < t.uncertaintyMs ||
      t.uncertaintyMs < 0 ||
      t.uncertaintyMs > 60000 ||
      t.validForMs <= t.uncertaintyMs ||
      t.validForMs > WEEK ||
      !Number.isSafeInteger(t.timeMs + WEEK)
    )
      throw new Error('TIME_UNAVAILABLE');
    return { ...t };
  }
  private async actor(
    c: PoolClient,
    actor: ResponderIdentity,
    admin = false,
  ): Promise<void> {
    if (admin && actor.role !== 'AUTHORITY_ADMIN')
      throw new Error('ROLE_REQUIRED');
    const row = (
      await c.query<{ callsign: string; role: string }>(
        'SELECT callsign,role FROM responder_identities WHERE responder_id=$1 FOR SHARE',
        [actor.responderId],
      )
    ).rows[0];
    if (!row || row.callsign !== actor.callsign || row.role !== actor.role)
      throw new Error('UNAUTHORIZED');
    if (
      !admin &&
      actor.role !== 'AUTHORITY_ADMIN' &&
      !this.policy.allowedResponderRoles.has(actor.role)
    )
      throw new Error('ROLE_REQUIRED');
  }
  private async sign(fields: ReceiptFields): Promise<Buffer> {
    let bytes: Buffer;
    try {
      bytes = encodeReceipt(
        fields,
        await this.signer.sign(receiptSigningInput(fields, Buffer.alloc(0))),
        Buffer.alloc(0),
      );
    } catch {
      throw new Error('SIGNER_UNAVAILABLE');
    }
    if (!verifyReceiptSignature(decodeReceipt(bytes), this.key))
      throw new Error('SIGNER_UNAVAILABLE');
    return bytes;
  }
  async issueGatewayGrant(
    input: GatewayGrantRequest,
    operator: AuthorityOperator,
  ): Promise<Uint8Array> {
    const r: GatewayGrantRequest = {
      requestId: input.requestId,
      issuerKeyId: Buffer.from(input.issuerKeyId),
      issuerPublicKeyDer: Buffer.from(input.issuerPublicKeyDer),
      issuerProviderId: Buffer.from(input.issuerProviderId),
      grantId: input.grantId,
      responderId: input.responderId,
      callsign: input.callsign,
      statusMask: input.statusMask,
      purposeMask: input.purposeMask,
      scope: input.scope,
    };
    operator = { ...operator };
    if (
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(r.requestId) ||
      r.requestId === NIL
    )
      throw new Error('INVALID_FIELDS');
    validateReceiptPublicKey(r.issuerPublicKeyDer);
    if (
      !equal(hash(r.issuerPublicKeyDer), r.issuerKeyId) ||
      !equal(
        issuerProviderId(2, r.issuerKeyId, r.grantId),
        r.issuerProviderId,
      ) ||
      equal(r.issuerKeyId, this.keyId)
    )
      throw new Error('KEY_BINDING');
    const skeleton: AuthorityGrantFields = {
      ...r,
      purpose: 3,
      rootKeyId: this.keyId,
      notBeforeMs: 0,
      expiresAtMs: WEEK,
    };
    receiptSigningInput(skeleton, Buffer.alloc(0));
    const requestDigest = hash(
      Buffer.from(
        'SAGIP-GRANT-REQUEST-V2\0' +
          JSON.stringify({
            ...r,
            issuerKeyId: Buffer.from(r.issuerKeyId).toString('hex'),
            issuerPublicKeyDer: Buffer.from(r.issuerPublicKeyDer).toString(
              'hex',
            ),
            issuerProviderId: Buffer.from(r.issuerProviderId).toString('hex'),
          }),
      ),
    );
    return transaction(this.pool, async c => {
      await this.actor(c, operator, true);
      await c.query('SELECT pg_advisory_xact_lock($1)', [
        hash(Buffer.from(r.requestId)).readBigInt64BE().toString(),
      ]);
      const existing = (
        await c.query<GrantRow>(
          'SELECT * FROM receipt_authority_grants WHERE provisioning_request_id=$1 FOR UPDATE',
          [r.requestId],
        )
      ).rows[0];
      if (existing) {
        if (!equal(existing.request_digest, requestDigest))
          throw new Error('REQUEST_CONFLICT');
        if (existing.revoked_at_ms !== null) throw new Error('GRANT_REVOKED');
        return existing.object_bytes;
      }
      if (
        !this.policy.approvedIssuerKeyIds.has(
          Buffer.from(r.issuerKeyId).toString('hex'),
        )
      )
        throw new Error('KEY_NOT_APPROVED');
      if (!this.policy.allowedScopes.has(r.scope))
        throw new Error('SCOPE_DENIED');
      if (
        (r.statusMask & ~this.policy.statusMask) !== 0 ||
        (r.purposeMask & ~this.policy.purposeMask) !== 0
      )
        throw new Error('PURPOSE_DENIED');
      const target = (
        await c.query<{ callsign: string; role: string }>(
          'SELECT callsign,role FROM responder_identities WHERE responder_id=$1 FOR SHARE',
          [r.responderId],
        )
      ).rows[0];
      if (
        !target ||
        target.callsign !== r.callsign ||
        !this.policy.allowedResponderRoles.has(target.role)
      )
        throw new Error('RESPONDER_NOT_APPROVED');
      if (
        (
          await c.query(
            'SELECT origin_key_id FROM origin_keys WHERE origin_key_id=$1',
            [Buffer.from(r.issuerKeyId)],
          )
        ).rows[0]
      )
        throw new Error('CIVILIAN_KEY_REUSE');
      if (
        (
          await c.query(
            'SELECT grant_id FROM receipt_authority_grants WHERE grant_id=$1',
            [r.grantId],
          )
        ).rows[0]
      )
        throw new Error('REQUEST_CONFLICT');
      const t = this.time(),
        start = t.timeMs - t.uncertaintyMs;
      const fields: AuthorityGrantFields = {
        ...skeleton,
        notBeforeMs: start,
        expiresAtMs: start + WEEK,
      };
      const bytes = await this.sign(fields);
      await c.query(
        `INSERT INTO receipt_authority_grants(grant_id,provisioning_request_id,request_digest,issuer_provider_id,issuer_key_id,root_key_id,object_bytes,not_before_ms,expires_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          r.grantId,
          r.requestId,
          requestDigest,
          Buffer.from(r.issuerProviderId),
          Buffer.from(r.issuerKeyId),
          this.keyId,
          bytes,
          start,
          start + WEEK,
        ],
      );
      await this.audit(c, r.grantId, 'ISSUED', operator, t.timeMs, '');
      return bytes;
    });
  }
  async revokeGrant(
    grantId: string,
    operator: AuthorityOperator,
    reason: string,
  ): Promise<{ grantId: string; revokedAtMs: number }> {
    if (
      typeof reason !== 'string' ||
      !reason.length ||
      reason.includes('\0') ||
      Buffer.byteLength(reason, 'utf8') > 1024 ||
      Buffer.from(reason, 'utf8').toString('utf8') !== reason
    )
      throw new Error('INVALID_REVOCATION_REASON');
    operator = { ...operator };
    return transaction(this.pool, async c => {
      await this.actor(c, operator, true);
      const row = (
        await c.query<GrantRow>(
          'SELECT * FROM receipt_authority_grants WHERE grant_id=$1 FOR UPDATE',
          [grantId],
        )
      ).rows[0];
      if (!row) throw new Error('GRANT_NOT_FOUND');
      if (row.revoked_at_ms !== null)
        return { grantId, revokedAtMs: Number(row.revoked_at_ms) };
      const t = this.time(),
        now = t.timeMs;
      await c.query(
        'UPDATE receipt_authority_grants SET revoked_at_ms=$2 WHERE grant_id=$1',
        [grantId, now],
      );
      await this.audit(c, grantId, 'REVOKED', operator, now, reason);
      return { grantId, revokedAtMs: now };
    });
  }
  private async audit(
    c: PoolClient,
    grantId: string,
    eventType: 'ISSUED' | 'REVOKED',
    operator: AuthorityOperator,
    time: number,
    reason: string,
  ): Promise<void> {
    await c.query(
      'INSERT INTO receipt_authority_audit VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        randomUUID(),
        grantId,
        eventType,
        operator.responderId,
        operator.callsign,
        operator.role,
        time,
        reason,
      ],
    );
  }
  async authorityStatus(
    grantId: string,
    responder: ResponderIdentity,
  ): Promise<{
    grantId: string;
    state: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
    authorityCheckedAtMs: number;
  }> {
    responder = { ...responder };
    return transaction(this.pool, async c => {
      await this.actor(c, responder);
      const row = (
        await c.query<GrantRow>(
          'SELECT * FROM receipt_authority_grants WHERE grant_id=$1 FOR SHARE',
          [grantId],
        )
      ).rows[0];
      if (!row) throw new Error('GRANT_NOT_FOUND');
      const t = this.time(),
        now = t.timeMs;
      return {
        grantId,
        state:
          row.revoked_at_ms !== null
            ? 'REVOKED'
            : now + t.uncertaintyMs >= Number(row.expires_at_ms) ||
              now - t.uncertaintyMs < Number(row.not_before_ms)
            ? 'EXPIRED'
            : 'ACTIVE',
        authorityCheckedAtMs: now,
      };
    });
  }
  async issueAuthorityTimeProof(
    input: TimeChallenge,
    responder: ResponderIdentity,
  ): Promise<Uint8Array> {
    const challenge: TimeChallenge = {
      verifierId: Buffer.from(input.verifierId),
      verifierBootSessionId: input.verifierBootSessionId,
      nonce: Buffer.from(input.nonce),
    };
    responder = { ...responder };
    if (
      this.policy.verifierOwners.get(
        Buffer.from(challenge.verifierId).toString('hex'),
      ) !== responder.responderId
    )
      throw new Error('VERIFIER_NOT_APPROVED');
    const skeleton: TimeProofFields = {
      purpose: 4,
      proofId: randomUUID(),
      signerProviderId: issuerProviderId(1, this.keyId, NIL),
      signerKeyId: this.keyId,
      grantId: NIL,
      signerBootSessionId: NIL,
      verifierId: challenge.verifierId,
      verifierBootSessionId: challenge.verifierBootSessionId,
      nonce: challenge.nonce,
      parentCheckpointDigest: Buffer.alloc(32),
      signedTimeMs: 0,
      elapsedSinceCheckpointMs: 0,
      uncertaintyMs: 0,
      validUntilMs: WEEK,
    };
    receiptSigningInput(skeleton, Buffer.alloc(0));
    return transaction(this.pool, async c => {
      await this.actor(c, responder);
      // Quota admission serializes across verifiers and process replicas.
      // Protected nonce history is never evicted to make a new proof fit.
      await c.query('SELECT pg_advisory_xact_lock($1)', [TIME_CAPACITY_LOCK]);
      await c.query('SELECT pg_advisory_xact_lock($1)', [
        hash(challenge.verifierId).readBigInt64BE().toString(),
      ]);
      const t = this.time();
      const existing = (
        await c.query<{
          verifier_boot_id: string;
          responder_id: string;
          valid_until_ms: string;
          object_bytes: Buffer;
        }>(
          'SELECT * FROM receipt_authority_time_proofs WHERE verifier_id=$1 AND nonce=$2',
          [Buffer.from(challenge.verifierId), Buffer.from(challenge.nonce)],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.verifier_boot_id !== challenge.verifierBootSessionId ||
          existing.responder_id !== responder.responderId ||
          t.timeMs + t.uncertaintyMs >= Number(existing.valid_until_ms)
        )
          throw new Error('TIME_CHALLENGE_REUSED');
        return existing.object_bytes;
      }
      const low = t.timeMs - t.uncertaintyMs;
      const high = (
        await c.query<{ high_water_earliest_ms: string }>(
          'SELECT high_water_earliest_ms FROM receipt_authority_time_state WHERE verifier_id=$1',
          [Buffer.from(challenge.verifierId)],
        )
      ).rows[0];
      if (high && low < Number(high.high_water_earliest_ms))
        throw new Error('TIME_ROLLBACK');
      const count = (
        await c.query<{ count: string }>(
          'SELECT COUNT(*) AS count FROM receipt_authority_time_proofs WHERE verifier_id=$1 AND signed_time_ms >= $2',
          [Buffer.from(challenge.verifierId), Math.max(0, t.timeMs - 60000)],
        )
      ).rows[0]!;
      if (Number(count.count) >= 128) throw new Error('CAPACITY_FULL');
      const budget = (
        await c.query<{ count: string; bytes: string }>(
          `SELECT COUNT(*) AS count,COALESCE(SUM(octet_length(object_bytes)+${TIME_RECORD_METADATA_BYTES}),0) AS bytes FROM receipt_authority_time_proofs`,
        )
      ).rows[0]!;
      if (Number(budget.count) >= MAX_AUTHORITY_TIME_PROOFS)
        throw new Error('CAPACITY_FULL');
      const state = (
        await c.query<{ count: string }>(
          'SELECT COUNT(*) AS count FROM receipt_authority_time_state',
        )
      ).rows[0]!;
      const fields: TimeProofFields = {
        ...skeleton,
        signedTimeMs: t.timeMs,
        uncertaintyMs: t.uncertaintyMs,
        validUntilMs: t.timeMs + t.validForMs,
      };
      const bytes = await this.sign(fields);
      if (
        Number(budget.bytes) +
          Number(state.count) * TIME_HIGH_WATER_BYTES +
          bytes.length +
          TIME_RECORD_METADATA_BYTES +
          (high ? 0 : TIME_HIGH_WATER_BYTES) >
        MAX_AUTHORITY_TIME_BYTES
      )
        throw new Error('CAPACITY_FULL');
      await c.query(
        'INSERT INTO receipt_authority_time_proofs VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [
          Buffer.from(challenge.verifierId),
          Buffer.from(challenge.nonce),
          challenge.verifierBootSessionId,
          responder.responderId,
          t.timeMs,
          fields.validUntilMs,
          bytes,
        ],
      );
      await c.query(
        `INSERT INTO receipt_authority_time_state VALUES ($1,$2) ON CONFLICT (verifier_id) DO UPDATE SET high_water_earliest_ms=EXCLUDED.high_water_earliest_ms`,
        [Buffer.from(challenge.verifierId), low],
      );
      return bytes;
    });
  }
}
