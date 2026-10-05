import {createHash, randomUUID, createPublicKey, verify} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import {decodeReceipt, validateReceiptPublicKey, verifyReceiptSignature} from '../protocol/receiptV2.js';
import {
  decodeOfflineRootBundle, decodeOfflineRootSnapshot, encodeOfflineRootBundle, encodeOfflineRootSnapshot,
  offlineRootPolicyDigest, offlineRootProofSigningInput, encodeOfflineRootRevocation,
  offlineRootRevocationSigningInput, verifyOfflineRootRevocation,
  type OfflineRootProofFields, type OfflineRootSnapshotPolicy, type OfflineRootRevocationFields,
} from '../protocol/offlineRootSnapshot.js';
import {actionDigest, issuerProviderId} from './receiptAuthority.js';
import type {QualifiedAuthorityTime} from './grantProvisioning.js';
import type {AuthoritySigner} from './receiptService.js';
import type {ResponderIdentity} from './types.js';

const NIL = '00000000-0000-0000-0000-000000000000';
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
interface Domain {authority_domain_id: string; policy_digest: string; revocation_epoch: string;
  authority_state_digest: string; checked_at_earliest_ms: string}
interface Subject {subject_kind: 'KEY' | 'PROVIDER'; subject_id: string; revoked_at_ms: string | null}
export interface OfflineRootSnapshotAdapter {
  checkpointSigner: AuthoritySigner;
  pinnedCheckpointSignerKeyId: string;
  policy: OfflineRootSnapshotPolicy;
  scope: string;
  allowedResponderRoles: ReadonlySet<string>;
  qualifiedSourceId: string;
}
async function transaction<T>(pool: Pick<Pool, 'connect'>, f: (c: PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    try { const result = await f(c); await c.query('COMMIT'); return result; }
    catch (error) { await c.query('ROLLBACK'); throw error; }
  } finally { c.release(); }
}
/** No credentials are loaded and no domain is enrolled by construction. */
export class OfflineRootSnapshotService {
  readonly policy: OfflineRootSnapshotPolicy;
  private readonly policyDigest: string;
  private readonly signerKeyId: string;
  private readonly rootKeyId: string;
  private readonly providerId: string;
  private readonly root: Buffer;
  private readonly signerPublicKey: Buffer;
  private readonly roles: Set<string>;
  private readonly scope: string;
  constructor(private readonly pool: Pick<Pool, 'connect'>, root: Uint8Array,
    private readonly adapter: OfflineRootSnapshotAdapter,
    private readonly qualifiedTime: () => QualifiedAuthorityTime,
    private readonly newId: () => string = randomUUID) {
    this.policy = structuredClone(adapter.policy);
    this.policyDigest = offlineRootPolicyDigest(this.policy);
    this.root = Buffer.from(root); validateReceiptPublicKey(this.root);
    this.rootKeyId = hash(root);
    this.providerId = hex(issuerProviderId(1, Buffer.from(this.rootKeyId, 'hex'), NIL));
    this.signerPublicKey = Buffer.from(adapter.checkpointSigner.publicKeyDer);
    validateReceiptPublicKey(this.signerPublicKey);
    this.signerKeyId = hash(this.signerPublicKey);
    this.scope = adapter.scope; this.roles = new Set(adapter.allowedResponderRoles);
    if (this.signerKeyId !== adapter.pinnedCheckpointSignerKeyId ||
      this.signerKeyId === this.rootKeyId ||
      !this.policy.signerBindings.some(b => b.checkpointSignerKeyId === this.signerKeyId &&
        b.receiptRootKeyId === this.rootKeyId && b.issuerProviderId === this.providerId) ||
      !this.policy.allowedScopes.includes(this.scope) ||
      !this.policy.qualifiedTimeSourceIds.includes(adapter.qualifiedSourceId) ||
      this.policy.disseminationAudience !== 'ORIGIN_AND_CUSTODY_RELAYS' ||
      this.roles.size === 0 || [...this.roles].some(r => !/^[A-Z][A-Z0-9_]{0,63}$/.test(r)))
      throw new Error('OFFLINE_ROOT_ADAPTER_POLICY');
  }
  private time() {
    const t = this.qualifiedTime();
    if (![t.timeMs, t.uncertaintyMs, t.validForMs].every(Number.isSafeInteger) ||
      t.uncertaintyMs < 0 || t.uncertaintyMs > 60000 || t.timeMs < t.uncertaintyMs ||
      t.validForMs <= t.uncertaintyMs || t.validForMs + t.uncertaintyMs > 86400000 ||
      !Number.isSafeInteger(t.timeMs + 86400000)) throw new Error('TIME_UNAVAILABLE');
    return {...t};
  }
  private async admin(c: PoolClient, actor: ResponderIdentity) {
    const r = (await c.query<{callsign: string; role: string}>(
      'SELECT callsign,role FROM responder_identities WHERE responder_id=$1 FOR SHARE',
      [actor.responderId])).rows[0];
    if (!r || actor.role !== 'AUTHORITY_ADMIN' || r.role !== actor.role || r.callsign !== actor.callsign)
      throw new Error('UNAUTHORIZED');
  }
  private stateDigest(subjects: Subject[]) {
    return hash(Buffer.from(JSON.stringify(['SAGIP-OFFLINE-ROOT-REGISTRY-V1',
      this.policy.authorityDomainId, this.policyDigest,
      [...subjects].sort((a, b) => (a.subject_kind + a.subject_id).localeCompare(b.subject_kind + b.subject_id))
        .map(s => [s.subject_kind, s.subject_id, s.revoked_at_ms])])));
  }
  private async domain(c: PoolClient) {
    const d = (await c.query<Domain>(
      'SELECT * FROM offline_root_domains WHERE authority_domain_id=$1 FOR UPDATE',
      [this.policy.authorityDomainId])).rows[0];
    if (!d || d.policy_digest !== this.policyDigest) throw new Error('OFFLINE_ROOT_REGISTRY_UNAVAILABLE');
    d.revocation_epoch = String(d.revocation_epoch);
    d.checked_at_earliest_ms = String(d.checked_at_earliest_ms);
    const subjects = (await c.query<Subject>(
      'SELECT subject_kind,subject_id,revoked_at_ms FROM offline_root_subjects WHERE authority_domain_id=$1',
      [this.policy.authorityDomainId])).rows.map(s => ({...s,
        revoked_at_ms: s.revoked_at_ms === null ? null : String(s.revoked_at_ms)}));
    if (this.stateDigest(subjects) !== d.authority_state_digest) throw new Error('OFFLINE_ROOT_REGISTRY_CONFLICT');
    return {d, subjects};
  }
  private active(subjects: Subject[], kind: string, id: string) {
    return subjects.some(s => s.subject_kind === kind && s.subject_id === id && s.revoked_at_ms === null);
  }
  private async audit(c: PoolClient, event: string, object: string, d: Domain, at: number) {
    await c.query('INSERT INTO offline_root_registry_audit VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [this.newId(), this.policy.authorityDomainId, event, object, d.revocation_epoch, d.authority_state_digest, at]);
  }
  async validateBundleForDisclosure(c: PoolClient, bundle: Uint8Array): Promise<'VALID' | 'REVOKED' | 'REFRESH'> {
    const {d, subjects} = await this.domain(c), t = this.time();
    const {receipt, proof} = decodeOfflineRootBundle(bundle), p = decodeOfflineRootSnapshot(proof), f = p.fields;
    const r = decodeReceipt(receipt).fields;
    if (!this.active(subjects,'KEY',this.rootKeyId) || !this.active(subjects,'KEY',this.signerKeyId) ||
      !this.active(subjects,'PROVIDER',this.providerId)) return 'REVOKED';
    if (r.purpose !== 1 || f.policyDigest !== this.policyDigest || f.authorityDomainId !== this.policy.authorityDomainId ||
      f.checkpointSignerKeyId !== this.signerKeyId || f.receiptRootKeyId !== this.rootKeyId ||
      f.issuerProviderId !== this.providerId ||
      !verify('sha256',p.signingInput,{key:createPublicKey({key:this.signerPublicKey,format:'der',type:'spki'}),
        dsaEncoding:'ieee-p1363'},p.signature)) throw new Error('OFFLINE_ROOT_STORED_PROOF_INVALID');
    const high = t.timeMs + t.uncertaintyMs;
    if (f.revocationEpoch !== d.revocation_epoch || f.authorityStateDigest !== d.authority_state_digest ||
      high >= f.expiresAtMs || high >= r.forwardingExpiresAtMs ||
      high - (f.authorityCheckedAtMs - f.authorityTimeUncertaintyMs) >= this.policy.maxAuthorityStalenessMs ||
      high - r.issuedAtMs >= this.policy.maxReceiptIssuanceAgeMs) return 'REFRESH';
    return 'VALID';
  }
  async assertRootActive(client?: PoolClient): Promise<void> {
    const check = async (c: PoolClient) => {
      const {subjects} = await this.domain(c);
      if (!this.active(subjects, 'KEY', this.rootKeyId) ||
        !this.active(subjects, 'PROVIDER', this.providerId)) throw new Error('ROOT_AUTHORITY_REVOKED');
    };
    if (client) await check(client); else await transaction(this.pool, check);
  }
  async signWithRootAuthority(input: Uint8Array, signer: AuthoritySigner, client?: PoolClient) {
    const signing = async (c: PoolClient) => {
      await this.assertRootActive(c);
      return signer.sign(input, c);
    };
    return client ? signing(client) : transaction(this.pool, signing);
  }
  /** Explicit trusted operator invocation only; never called by feed or startup. */
  async enrollDomain(operator: ResponderIdentity): Promise<void> {
    await transaction(this.pool, async c => {
      await this.admin(c, operator);
      await c.query('SELECT pg_advisory_xact_lock($1)', [
        createHash('sha256').update(this.policy.authorityDomainId).digest().readBigInt64BE().toString()]);
      const existing = (await c.query<Domain>(
        'SELECT * FROM offline_root_domains WHERE authority_domain_id=$1', [this.policy.authorityDomainId])).rows[0];
      if (existing) { await this.domain(c); return; }
      const subjects: Subject[] = [];
      for (const b of this.policy.signerBindings) for (const [kind, id] of [
        ['KEY', b.checkpointSignerKeyId], ['KEY', b.receiptRootKeyId], ['PROVIDER', b.issuerProviderId],
      ] as const) if (!subjects.some(s => s.subject_kind === kind && s.subject_id === id))
        subjects.push({subject_kind: kind, subject_id: id, revoked_at_ms: null});
      const t = this.time(), state = this.stateDigest(subjects);
      await c.query('INSERT INTO offline_root_domains VALUES ($1,$2,$3,$4,$5)',
        [this.policy.authorityDomainId, this.policyDigest, '1', state, t.timeMs - t.uncertaintyMs]);
      for (const s of subjects) await c.query('INSERT INTO offline_root_subjects VALUES ($1,$2,$3,$4)',
        [this.policy.authorityDomainId, s.subject_kind, s.subject_id, null]);
      await this.audit(c, 'ENROLLED', operator.responderId, {
        authority_domain_id: this.policy.authorityDomainId, policy_digest: this.policyDigest,
        revocation_epoch: '1', authority_state_digest: state, checked_at_earliest_ms: String(t.timeMs - t.uncertaintyMs),
      }, t.timeMs);
    });
  }
  /** The immutable status must already be committed before this transaction starts. */
  async issueCommitted(eventId: string): Promise<Buffer | null> {
    return transaction(this.pool, async c => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [
        createHash('sha256').update('SAGIP-OFFLINE-ROOT-CAPACITY-V1').digest().readBigInt64BE().toString()]);
      const {d, subjects} = await this.domain(c), t = this.time();
      const low = t.timeMs - t.uncertaintyMs, high = t.timeMs + t.uncertaintyMs;
      if (low < Number(d.checked_at_earliest_ms)) throw new Error('TIME_ROLLBACK');
      if (!this.active(subjects, 'KEY', this.rootKeyId) ||
        !this.active(subjects, 'KEY', this.signerKeyId) ||
        !this.active(subjects, 'PROVIDER', this.providerId)) return null;
      const record = (await c.query<{
        object_bytes: Buffer; event_digest: Buffer; action_digest: Buffer;
        preparation_state: string; callsign: string; role: string; responder_id: string;
      }>(`SELECT r.object_bytes,r.event_digest,a.action_digest,a.preparation_state,
        i.callsign,i.role,a.responder_id FROM receipt_records r
        JOIN receipt_actions a ON a.action_id=r.event_id
        JOIN responder_identities i ON i.responder_id=a.responder_id
        WHERE r.event_id=$1 FOR SHARE`, [eventId])).rows[0];
      if (!record || record.preparation_state !== 'SIGNED') return null;
      const bytes = Buffer.from(record.object_bytes), decoded = decodeReceipt(bytes), r = decoded.fields;
      if (r.purpose !== 1 || r.providerKind !== 1 || r.grantId !== NIL ||
        r.actionId !== eventId || r.note !== '' || !this.roles.has(record.role) ||
        record.callsign !== r.callsign || record.responder_id !== r.responderId ||
        !this.policy.allowedStatuses.includes(r.status) ||
        hash(bytes) !== hex(record.event_digest) || hex(r.issuerKeyId) !== this.rootKeyId ||
        hex(r.issuerProviderId) !== this.providerId || hex(r.actionDigest) !== hex(record.action_digest) ||
        hex(actionDigest(r)) !== hex(r.actionDigest) || !verifyReceiptSignature(decoded, this.root))
        return null;
      const report = (await c.query<{payload_digest: Buffer; origin_key_id: Buffer; envelope_bytes: Buffer}>(
        `SELECT r.payload_digest,m.origin_key_id,m.envelope_bytes FROM accepted_messages m
        JOIN incident_revisions r ON r.report_id=m.report_id AND r.revision=m.revision
        WHERE m.report_id=$1 AND m.revision=$2 LIMIT 1`, [r.reportId, r.revision])).rows[0];
      if (!report || report.envelope_bytes[4] !== r.reportProtocolVersion ||
        hex(report.payload_digest) !== hex(r.payloadDigest) || hex(report.origin_key_id) !== hex(r.originKeyId))
        throw new Error('REPORT_IDENTITY_CONFLICT');
      if (r.issuedAtMs > low || high - r.issuedAtMs >= this.policy.maxReceiptIssuanceAgeMs) return null;
      const existing = (await c.query<{bundle_bytes: Buffer; proof_bytes: Buffer; expires_at_ms: string;
        revocation_epoch: string; authority_state_digest: string}>(
        'SELECT * FROM offline_root_snapshots WHERE event_id=$1 ORDER BY expires_at_ms DESC LIMIT 1', [eventId])).rows[0];
      if (existing) {
        const f = decodeOfflineRootSnapshot(existing.proof_bytes).fields;
        if (String(existing.revocation_epoch) === d.revocation_epoch &&
          existing.authority_state_digest === d.authority_state_digest &&
          high < Number(existing.expires_at_ms) &&
          high - (f.authorityCheckedAtMs - f.authorityTimeUncertaintyMs) < this.policy.maxAuthorityStalenessMs)
          return Buffer.from(existing.bundle_bytes);
        if (String(existing.revocation_epoch) === d.revocation_epoch &&
          low - (f.authorityCheckedAtMs - f.authorityTimeUncertaintyMs) < 60000)
          throw new Error('OFFLINE_ROOT_REFRESH_PENDING');
        // Renewal is a new immutable proof; the complete old proof remains protected.
        // SGA2 issuance time, action ID and forwarding lifetime never change.
      }
      const expires = Math.min(low + this.policy.maxProofValidityMs, low + this.policy.maxAuthorityStalenessMs,
        r.issuedAtMs + this.policy.maxReceiptIssuanceAgeMs, r.forwardingExpiresAtMs);
      if (high >= expires) return null;
      const fields: OfflineRootProofFields = {
        format: 'SAGIP_OFFLINE_ROOT_SNAPSHOT', version: 1, algorithm: 1, proofId: this.newId(),
        policyDigest: this.policyDigest, authorityDomainId: this.policy.authorityDomainId,
        checkpointSignerKeyId: this.signerKeyId, receiptRootKeyId: this.rootKeyId,
        issuerProviderId: this.providerId, receiptDigest: hash(bytes), eventId,
        actionDigest: hex(r.actionDigest), reportId: r.reportId, reportProtocolVersion: r.reportProtocolVersion,
        revision: r.revision, payloadDigest: hex(r.payloadDigest), originKeyId: hex(r.originKeyId),
        scope: this.scope, status: r.status, authorityState: 'ACTIVE_AT_CHECKPOINT',
        authorityStateDigest: d.authority_state_digest, revocationEpoch: d.revocation_epoch,
        notBeforeMs: low, authorityCheckedAtMs: t.timeMs, authorityTimeUncertaintyMs: t.uncertaintyMs,
        expiresAtMs: expires,
      };
      const proof = encodeOfflineRootSnapshot(fields,
        await this.adapter.checkpointSigner.sign(offlineRootProofSigningInput(fields)));
      // An untrusted signer adapter must not inject incorrectly signed evidence.
      const checked = decodeOfflineRootSnapshot(proof);
      if (!verify('sha256', checked.signingInput, {
        key: createPublicKey({key: this.signerPublicKey, format: 'der', type: 'spki'}),
        dsaEncoding: 'ieee-p1363',
      }, checked.signature)) throw new Error('SIGNER_UNAVAILABLE');
      const bundle = encodeOfflineRootBundle(bytes, proof), final = this.time();
      if (final.timeMs - final.uncertaintyMs < low || final.timeMs + final.uncertaintyMs >= expires)
        throw new Error('TIME_UNAVAILABLE');
      const budget = (await c.query<{count: string; bytes: string}>(`SELECT COUNT(*) AS count,
        COALESCE(SUM(octet_length(bundle_bytes)+128),0) AS bytes FROM offline_root_snapshots`)).rows[0]!;
      if (Number(budget.count) >= 10000 || Number(budget.bytes) + bundle.length + 128 > 64 * 1024 * 1024)
        throw new Error('OFFLINE_ROOT_CAPACITY');
      await c.query('INSERT INTO offline_root_snapshots VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [eventId, this.policy.authorityDomainId, fields.proofId, hash(bytes), d.revocation_epoch,
          d.authority_state_digest, proof, bundle, expires]);
      await c.query('UPDATE offline_root_domains SET checked_at_earliest_ms=$2 WHERE authority_domain_id=$1',
        [this.policy.authorityDomainId, low]);
      await this.audit(c, 'SNAPSHOT', fields.proofId, d, t.timeMs);
      return bundle;
    });
  }
  async revoke(targetKind: 'KEY' | 'PROVIDER', targetId: string, operator: ResponderIdentity): Promise<Buffer> {
    return transaction(this.pool, async c => {
      await this.admin(c, operator);
      const {d, subjects} = await this.domain(c);
      const prior = (await c.query<{object_bytes: Buffer}>(
        'SELECT object_bytes FROM offline_root_revocations WHERE authority_domain_id=$1 AND target_kind=$2 AND target_id=$3',
        [this.policy.authorityDomainId, targetKind, targetId])).rows[0];
      if (prior) return Buffer.from(prior.object_bytes);
      const target = subjects.find(s => s.subject_kind === targetKind && s.subject_id === targetId);
      if (!target || !this.active(subjects, 'KEY', this.signerKeyId)) throw new Error('REVOCATION_TARGET');
      const t = this.time(), low = t.timeMs - t.uncertaintyMs;
      if (low < Number(d.checked_at_earliest_ms)) throw new Error('TIME_ROLLBACK');
      const epoch = BigInt(d.revocation_epoch) + 1n;
      if (epoch > 9223372036854775807n) throw new Error('EPOCH_EXHAUSTED');
      target.revoked_at_ms = String(t.timeMs);
      const state = this.stateDigest(subjects);
      const fields: OfflineRootRevocationFields = {
        format: 'SAGIP_OFFLINE_ROOT_REVOCATION', version: 1, algorithm: 1,
        revocationId: this.newId(), policyDigest: this.policyDigest,
        authorityDomainId: this.policy.authorityDomainId, checkpointSignerKeyId: this.signerKeyId,
        targetKind, targetId, revocationEpoch: epoch.toString(), authorityStateDigest: state, revokedAtMs: t.timeMs,
      };
      const bytes = encodeOfflineRootRevocation(fields,
        await this.adapter.checkpointSigner.sign(offlineRootRevocationSigningInput(fields)));
      verifyOfflineRootRevocation(bytes, this.policy, new Map([[this.signerKeyId, this.signerPublicKey]]));
      await c.query('UPDATE offline_root_subjects SET revoked_at_ms=$4 WHERE authority_domain_id=$1 AND subject_kind=$2 AND subject_id=$3',
        [this.policy.authorityDomainId, targetKind, targetId, t.timeMs]);
      await c.query('UPDATE offline_root_domains SET revocation_epoch=$2,authority_state_digest=$3,checked_at_earliest_ms=$4 WHERE authority_domain_id=$1',
        [this.policy.authorityDomainId, epoch.toString(), state, low]);
      await c.query('INSERT INTO offline_root_revocations VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [fields.revocationId, this.policy.authorityDomainId, targetKind, targetId, epoch.toString(),
          state, bytes, operator.responderId, t.timeMs]);
      await this.audit(c, 'REVOKED', fields.revocationId, {...d,
        revocation_epoch: epoch.toString(), authority_state_digest: state}, t.timeMs);
      return bytes;
    });
  }
  async listRevocations(): Promise<string[]> {
    return transaction(this.pool, async c => {
      await this.domain(c);
      const rows = (await c.query<{object_bytes: Buffer}>(
        'SELECT object_bytes FROM offline_root_revocations WHERE authority_domain_id=$1 ORDER BY revocation_epoch',
        [this.policy.authorityDomainId])).rows;
      // Policy has at most 64 bindings, so at most 192 protected subject tombstones.
      return rows.map(r => Buffer.from(r.object_bytes).toString('base64'));
    });
  }
}
