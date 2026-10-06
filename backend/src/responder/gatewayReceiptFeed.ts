import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {decodeReceipt, MAX_RECEIPT_BYTES, validateReceiptPublicKey} from '../protocol/receiptV2.js';
import {verifyReceipt, type ReportIdentity, type TimeInterval, type VerificationContext} from './receiptAuthority.js';
import type {ResponderIdentity} from './types.js';
import type {OfflineRootSnapshotService} from './offlineRootSnapshotService.js';
import {authenticateCustodyRequest} from './reportCustodyAccess.js';

export const MAX_GATEWAY_RECEIPT_PAGE_BYTES = 262144;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
export interface GatewayReceiptAccess {
  allowedRoles: ReadonlySet<string>;
  // Trusted current assignments only. Neither role nor request reportId grants access.
  // Approval covers status dissemination for this exact audience/report. Notes never relay.
  isReportAuthorized(actor: Readonly<ResponderIdentity>, reportId: string): boolean;
}
export interface GatewayReceiptPage {
  entries: Array<{eventId: string; eventDigest: string; bytesBase64: string; offlineBundleBase64?: string}>;
  revocationsBase64?: string[];
  nextCursor: string | null;
}
function receiptFields(bytes: Uint8Array) {
  try { return decodeReceipt(bytes).fields; } catch { return null; }
}
interface Row {
  event_id: string;
  event_digest: Buffer;
  object_bytes: Buffer;
  recorded_at_ms: string;
}
// Retrieval is transport custody only. Each receiver must verify original bytes
// using its own qualified context; HTTP success is never portable authority.
export class GatewayReceiptFeed {
  private readonly key: Buffer;
  private readonly keyId: string;
  private readonly roles: Set<string>;
  constructor(
    private readonly pool: Pick<Pool, 'connect'>,
    root: Uint8Array,
    private readonly trustedTime: () => TimeInterval,
    private readonly access: GatewayReceiptAccess,
    private readonly snapshots?: OfflineRootSnapshotService,
  ) {
    validateReceiptPublicKey(root);
    this.key = Buffer.from(root);
    this.keyId = hash(this.key).toString('hex');
    if (access.allowedRoles.size === 0 ||
        [...access.allowedRoles].some(role => !/^[A-Z][A-Z0-9_]{0,63}$/u.test(role)))
      throw new Error('INVALID_GATEWAY_ACCESS_POLICY');
    this.roles = new Set(access.allowedRoles);
  }

  async list(reportId: string, cursor: string | null, identity: ResponderIdentity): Promise<GatewayReceiptPage> {
    const actor = Object.freeze({...identity});
    if (!this.roles.has(actor.role) || !this.access.isReportAuthorized(actor, reportId))
      throw new Error('SCOPE_DENIED');
    return this.listAuthorized(reportId, cursor, async c => {
      if (!this.roles.has(actor.role) || !this.access.isReportAuthorized(actor, reportId)) throw new Error('SCOPE_DENIED');
      if (c) {
        const registered = (await c.query<{callsign: string; role: string}>(
          'SELECT callsign,role FROM responder_identities WHERE responder_id=$1', [actor.responderId])).rows[0];
        if (!registered || registered.callsign !== actor.callsign || registered.role !== actor.role) throw new Error('UNAUTHORIZED');
      }
    });
  }

  async listForCustody(reportId: string, body: Buffer, signature: string | null): Promise<GatewayReceiptPage> {
    if (!this.snapshots || this.snapshots.policy.disseminationAudience !== 'ORIGIN_AND_CUSTODY_RELAYS')
      throw new Error('SCOPE_DENIED');
    const authClient = await this.pool.connect();
    let cursor: string | null;
    try {
      const auth = await authenticateCustodyRequest(authClient, reportId, 'receipts', body, signature);
      if (!auth) throw new Error('ORIGIN_PROOF_REQUIRED');
      cursor = auth.cursor;
    } finally { authClient.release(); }
    return this.listAuthorized(reportId, cursor, async c => {
      if (c && !await authenticateCustodyRequest(c, reportId, 'receipts', body, signature))
        throw new Error('ORIGIN_PROOF_REQUIRED');
    });
  }

  async authenticateCustody(reportId: string, body: Buffer, signature: string | null): Promise<boolean> {
    if (this.snapshots?.policy.disseminationAudience !== 'ORIGIN_AND_CUSTODY_RELAYS') return false;
    const c = await this.pool.connect();
    try { return await authenticateCustodyRequest(c, reportId, 'receipts', body, signature) !== null; }
    finally { c.release(); }
  }

  private async listAuthorized(reportId: string, cursor: string | null,
    authorize: (c?: import('pg').PoolClient) => Promise<void>): Promise<GatewayReceiptPage> {
    if (!UUID.test(reportId) ||
        (cursor !== null && !/^[0-9a-f]{64}$/u.test(cursor)))
      throw new Error('INVALID_CURSOR');
    const time = this.trustedTime();
    if (!Number.isSafeInteger(time.earliestMs) || !Number.isSafeInteger(time.latestMs) ||
        time.earliestMs < 0 || time.latestMs < time.earliestMs)
      throw new Error('TIME_UNAVAILABLE');
    const initialRevocations = this.snapshots ? await this.snapshots.listRevocations() : undefined;
    const c = await this.pool.connect();
    let released = false;
    try {
      await authorize(c);
      let boundary: Row | undefined;
      if (cursor !== null) {
        boundary = (await c.query<Row>(
          'SELECT event_id,event_digest,recorded_at_ms FROM receipt_records WHERE report_id=$1 AND event_digest=$2 AND recorded_at_ms IS NOT NULL',
          [reportId, Buffer.from(cursor, 'hex')],
        )).rows[0];
        if (!boundary) throw new Error('INVALID_CURSOR');
      }
      const rows = (await c.query<Row>(
        `SELECT event_id,event_digest,object_bytes,recorded_at_ms FROM receipt_records
         WHERE report_id=$1 AND recorded_at_ms IS NOT NULL
         ${boundary ? 'AND (recorded_at_ms>$2 OR (recorded_at_ms=$2 AND event_id>$3))' : ''}
         ORDER BY recorded_at_ms,event_id LIMIT 33`,
        boundary ? [reportId, boundary.recorded_at_ms, boundary.event_id] : [reportId],
      )).rows;
      const page: GatewayReceiptPage = {entries: [], nextCursor: null,
        ...(initialRevocations ? {revocationsBase64: initialRevocations} : {})};
      if (Buffer.byteLength(JSON.stringify(page)) > MAX_GATEWAY_RECEIPT_PAGE_BYTES)
        throw new Error('OFFLINE_ROOT_CAPACITY');
      const contexts = new Map<string, {bytes: Buffer; context: VerificationContext}>();
      const grants = new Set<string>();
      let scanned = 0;
      for (const row of rows.slice(0, 32)) {
        const bytes = Buffer.from(row.object_bytes);
        let forwardable = false;
        let offlineBundleBase64: string | undefined;
        if (bytes.length <= MAX_RECEIPT_BYTES &&
            hash(bytes).equals(Buffer.from(row.event_digest))) {
          try {
            const receipt = receiptFields(bytes);
            if (receipt && (receipt.purpose === 1 || receipt.purpose === 2) &&
                receipt.reportId === reportId && receipt.forwardingExpiresAtMs > time.latestMs &&
                (receipt.purpose === 1 ? receipt.actionId : receipt.eventId) === row.event_id) {
              const record = (await c.query<{
                revision: number; payload_digest: Buffer; origin_key_id: Buffer;
                public_key_der: Buffer; envelope_bytes: Buffer;
              }>(
                `SELECT m.revision,r.payload_digest,m.origin_key_id,k.public_key_der,m.envelope_bytes
                 FROM accepted_messages m JOIN incident_revisions r ON r.report_id=m.report_id AND r.revision=m.revision
                 JOIN origin_keys k ON k.origin_key_id=m.origin_key_id
                 WHERE m.report_id=$1 AND m.revision=$2 LIMIT 1`,
                [reportId, receipt.revision],
              )).rows[0];
              if (record) {
                const report: ReportIdentity = {
                  reportId, revision: record.revision,
                  reportProtocolVersion: record.envelope_bytes[4]!,
                  payloadDigest: record.payload_digest, originKeyId: record.origin_key_id,
                  originPublicKeyDer: record.public_key_der,
                };
                const linkedAck = receipt.purpose === 2 ? (await c.query<{object_bytes: Buffer}>(
                  'SELECT object_bytes FROM receipt_records WHERE event_id=$1 AND report_id=$2',
                  [receipt.ackEventId, reportId],
                )).rows[0]?.object_bytes : undefined;
                const authority = receipt.purpose === 1 ? receipt :
                  linkedAck ? receiptFields(linkedAck) : null;
                // Includes requester receipts whose linked ACK carries private notes.
                if (authority?.purpose === 1 && authority.note !== '') { scanned++; continue; }
                const scopes = new Set<string>(), revoked = new Set<string>();
                if (authority?.purpose === 1 && authority.providerKind === 2) {
                  grants.add(authority.grantId);
                  const stored = (await c.query<{object_bytes: Buffer; revoked_at_ms: string | null}>(
                    'SELECT object_bytes,revoked_at_ms FROM receipt_authority_grants WHERE grant_id=$1',
                    [authority.grantId],
                  )).rows[0];
                  if (stored) {
                    const grant = receiptFields(stored.object_bytes);
                    if (grant?.purpose === 3) scopes.add(grant.scope);
                    if (stored.revoked_at_ms !== null) revoked.add(authority.grantId);
                  }
                }
                const context: VerificationContext = {
                  roots: new Map([[this.keyId, this.key]]), allowedScopes: scopes,
                  revokedGrants: revoked, trustedTime: time,
                  authorityCheckedAtMs: time.latestMs, currentAuthorityChecked: true,
                  report, ...(linkedAck ? {linkedAck} : {}), pairedTimeProviderId: null,
                };
                const verification = verifyReceipt(bytes, context);
                contexts.set(Buffer.from(row.event_digest).toString('hex'), {bytes, context});
                forwardable = verification.kind === 'VERIFIED_CURRENT' ||
                  verification.kind === 'VERIFIED_OFFLINE_AUTHORITY';
                if (forwardable && this.snapshots && receipt.purpose === 1 && receipt.providerKind === 1) {
                  // Reserve the maximum encoded bundle size without nested pool checkout.
                  // Actual signing/registry reads happen after releasing this read client.
                  offlineBundleBase64 = 'A'.repeat(Math.ceil(8192 / 3) * 4);
                }
              }
            }
          } catch (error) {
            // Corrupt signed objects fail closed; database failures must not
            // masquerade as a successful empty synchronization.
            if (!(error instanceof Error) || !error.message.startsWith('Invalid receipt'))
              throw error;
          }
        }
        if (forwardable) {
          const entry = {
            eventId: row.event_id, eventDigest: Buffer.from(row.event_digest).toString('hex'),
            bytesBase64: bytes.toString('base64'),
            ...(offlineBundleBase64 ? {offlineBundleBase64} : {}),
          };
          const candidate = {...page, entries: [...page.entries, entry], nextCursor: '0'.repeat(64)};
          if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_GATEWAY_RECEIPT_PAGE_BYTES)
            break;
          page.entries.push(entry);
        }
        scanned++;
      }
      // Progress also crosses filtered/expired records. Each call scans <=32.
      if (rows.length > scanned && scanned > 0)
        page.nextCursor = Buffer.from(rows[scanned - 1]!.event_digest).toString('hex');
      // Refresh revocation after page construction, then take qualified time.
      // These reads define the page's final authority snapshot. A later
      // revocation can only be learned through a subsequent online check.
      const revoked = new Set<string>();
      for (const id of grants) {
        const current = (await c.query<{revoked_at_ms: string | null}>(
          'SELECT revoked_at_ms FROM receipt_authority_grants WHERE grant_id=$1', [id],
        )).rows[0];
        if (!current || current.revoked_at_ms !== null) revoked.add(id);
      }
      const finalTime = this.trustedTime();
      if (!Number.isSafeInteger(finalTime.earliestMs) || !Number.isSafeInteger(finalTime.latestMs) ||
          finalTime.earliestMs < time.earliestMs || finalTime.latestMs < finalTime.earliestMs)
        throw new Error('TIME_UNAVAILABLE');
      page.entries = page.entries.filter(entry => {
        const candidate = contexts.get(entry.eventDigest)!;
        const verification = verifyReceipt(candidate.bytes, {
          ...candidate.context, revokedGrants: revoked, trustedTime: finalTime,
          authorityCheckedAtMs: finalTime.latestMs,
        });
        return verification.kind === 'VERIFIED_CURRENT' ||
          verification.kind === 'VERIFIED_OFFLINE_AUTHORITY';
      });
      c.release(); released = true;
      if (this.snapshots) {
        const retained: GatewayReceiptPage['entries'] = [];
        for (const entry of page.entries) {
          if (!entry.offlineBundleBase64) { retained.push(entry); continue; }
          const bundle = await this.snapshots.issueCommitted(entry.eventId);
          if (bundle) retained.push({...entry, offlineBundleBase64: bundle.toString('base64')});
        }
        page.entries = retained;
        page.revocationsBase64 = await this.snapshots.listRevocations();
        if (Buffer.byteLength(JSON.stringify(page)) > MAX_GATEWAY_RECEIPT_PAGE_BYTES)
          throw new Error('OFFLINE_ROOT_CAPACITY');
      }
      // No snapshot service call owns another connection while this final client is held.
      const finalClient = await this.pool.connect();
      try {
        await authorize(finalClient);
        let rootActive = true;
        if (this.snapshots) {
          try { await this.snapshots.assertRootActive(finalClient); }
          catch (error) {
            if (error instanceof Error && error.message === 'ROOT_AUTHORITY_REVOKED') rootActive = false;
            else throw error;
          }
        }
        const finalRevoked = new Set<string>();
        for (const id of grants) {
          const row = (await finalClient.query<{revoked_at_ms: string | null}>(
            'SELECT revoked_at_ms FROM receipt_authority_grants WHERE grant_id=$1', [id])).rows[0];
          if (!row || row.revoked_at_ms !== null) finalRevoked.add(id);
        }
        if (this.snapshots) {
          const allowed: GatewayReceiptPage['entries'] = [];
          for (const entry of page.entries) {
            if (entry.offlineBundleBase64) {
              const result = await this.snapshots.validateBundleForDisclosure(finalClient,
                Buffer.from(entry.offlineBundleBase64, 'base64'));
              if (result === 'REFRESH') throw new Error('OFFLINE_ROOT_DISCLOSURE_PENDING');
              if (result === 'REVOKED') continue;
            }
            allowed.push(entry);
          }
          page.entries = allowed;
        }
        const currentTime = this.trustedTime();
        if (currentTime.earliestMs < finalTime.earliestMs) throw new Error('TIME_UNAVAILABLE');
        page.entries = page.entries.filter(entry => {
          const candidate = contexts.get(entry.eventDigest)!;
          const v = verifyReceipt(candidate.bytes, {...candidate.context, trustedTime: currentTime,
            revokedGrants: finalRevoked, authorityCheckedAtMs: currentTime.latestMs});
          return rootActive && (v.kind === 'VERIFIED_CURRENT' || v.kind === 'VERIFIED_OFFLINE_AUTHORITY');
        });
      } finally { finalClient.release(); }
      if (this.snapshots) {
        page.revocationsBase64 = await this.snapshots.listRevocations();
        if (Buffer.byteLength(JSON.stringify(page)) > MAX_GATEWAY_RECEIPT_PAGE_BYTES)
          throw new Error('OFFLINE_ROOT_CAPACITY');
      }
      // Recheck current policy after I/O, before disclosure.
      await authorize();
      return page;
    } finally {
      if (!released) c.release();
    }
  }
}
