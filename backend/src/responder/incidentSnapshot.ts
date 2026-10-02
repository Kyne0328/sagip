import {createHash, randomBytes, randomUUID} from 'node:crypto';

import type {Pool, PoolClient} from 'pg';

import {decodeEnvelopeV1} from '../protocol/envelopeV1.js';
import {ResponderService} from './service.js';
import type {ResponderIdentity} from './types.js';

const SNAPSHOT_TTL_MS = 15 * 60 * 1000;
const PAGE_MAX_ENTRIES = 100;
const PAGE_MAX_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_MAX_INCIDENTS = 10_000;
const OWNER_MAX_ACTIVE = 2;
const OWNER_MAX_BYTES = 128 * 1024 * 1024;

export interface SnapshotDescriptor {
  snapshotId: string;
  createdAtMs: number;
  expiresAtMs: number;
  total: number;
  summary: Record<string, number>;
  nextCursor: string | null;
}

export interface IncidentSnapshotPage extends SnapshotDescriptor {
  entries: unknown[];
}

export class IncidentSnapshotService {
  constructor(private readonly pool: Pool, private readonly nowMs: () => number = Date.now) {}

  async createIncidentSnapshot(responder: ResponderIdentity): Promise<SnapshotDescriptor> {
    const now = this.nowMs();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('INVALID_TIME');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query('DELETE FROM incident_snapshots WHERE expires_at_ms <= $1', [now]);
      await client.query('SELECT responder_id FROM responder_identities WHERE responder_id = $1 FOR UPDATE', [responder.responderId]);
      const usage = await client.query<{count: string | number; bytes: string | number}>(
        'SELECT COUNT(*) AS count, COALESCE(SUM(byte_count), 0) AS bytes FROM incident_snapshots WHERE responder_id = $1 AND expires_at_ms > $2',
        [responder.responderId, now],
      );
      const activeCount = Number(usage.rows[0]?.count ?? 0);
      const activeBytes = Number(usage.rows[0]?.bytes ?? 0);
      if (activeCount >= OWNER_MAX_ACTIVE || activeBytes >= OWNER_MAX_BYTES) throw new Error('CAPACITY_FULL');

      const responderService = new ResponderService(client);
      const summary = await responderService.getIncidentQueueSummary();
      if (summary.total > SNAPSHOT_MAX_INCIDENTS) throw new Error('CAPACITY_FULL');
      const entries: unknown[] = [];
      for (let offset = 0; offset < summary.total; offset += PAGE_MAX_ENTRIES) {
        const incidents = await responderService.listIncidents(undefined, PAGE_MAX_ENTRIES, offset);
        for (const incident of incidents) {
          const detail = await responderService.getIncidentDetail(incident.reportId);
          if (!detail) throw new Error('SNAPSHOT_INCOMPLETE');
          entries.push(await buildSnapshotEntry(client, detail, responder.responderId, now));
        }
      }
      if (entries.length !== summary.total) throw new Error('SNAPSHOT_INCOMPLETE');

      const snapshotId = randomUUID();
      const expiresAtMs = now + SNAPSHOT_TTL_MS;
      const pages = paginate(snapshotId, now, expiresAtMs, summary as unknown as Record<string, number>, entries);
      const totalBytes = pages.reduce((sum, page) => sum + page.byteCount, 0);
      if (activeBytes + totalBytes > OWNER_MAX_BYTES) throw new Error('CAPACITY_FULL');

      await client.query(
        'INSERT INTO incident_snapshots(snapshot_id,responder_id,created_at_ms,expires_at_ms,total,summary_json,byte_count,created_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,NOW())',
        [snapshotId, responder.responderId, now, expiresAtMs, entries.length, JSON.stringify(summary), totalBytes],
      );
      for (const page of pages) {
        await client.query(
          'INSERT INTO incident_snapshot_pages(snapshot_id,page_index,cursor_digest,page_json,byte_count) VALUES ($1,$2,$3,$4::jsonb,$5)',
          [snapshotId, page.index, digestCursor(page.cursor), JSON.stringify(page.json), page.byteCount],
        );
      }
      await client.query('COMMIT');
      return {snapshotId, createdAtMs: now, expiresAtMs, total: entries.length, summary: summary as unknown as Record<string, number>, nextCursor: pages[0]?.cursor ?? null};
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async readIncidentSnapshotPage(snapshotId: string, cursor: string, responder: ResponderIdentity): Promise<IncidentSnapshotPage> {
    if (!isUuid(snapshotId) || !/^[A-Za-z0-9_-]{16,128}$/u.test(cursor)) throw new Error('INVALID_CURSOR');
    const now = this.nowMs();
    const result = await this.pool.query<{page_json: IncidentSnapshotPage; expires_at_ms: string | number}>(
      'SELECT p.page_json, s.expires_at_ms FROM incident_snapshot_pages p JOIN incident_snapshots s ON s.snapshot_id = p.snapshot_id WHERE p.snapshot_id = $1 AND p.cursor_digest = $2 AND s.responder_id = $3',
      [snapshotId, digestCursor(cursor), responder.responderId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('SNAPSHOT_NOT_FOUND');
    if (Number(row.expires_at_ms) <= now) throw new Error('SNAPSHOT_EXPIRED');
    return row.page_json;
  }
}

async function buildSnapshotEntry(client: PoolClient, detail: NonNullable<Awaited<ReturnType<ResponderService['getIncidentDetail']>>>, responderId: string, syncedAtMs: number): Promise<Record<string, unknown>> {
  const identity = await client.query<{origin_key_id: Buffer; receipt_version: string | number; payload_digest: Buffer; envelope_bytes: Buffer}>(
    'SELECT i.origin_key_id, i.receipt_version, ir.payload_digest, am.envelope_bytes FROM incidents i JOIN incident_revisions ir ON ir.report_id = i.report_id AND ir.revision = $2 JOIN accepted_messages am ON am.report_id = i.report_id AND am.revision = $2 WHERE i.report_id = $1',
    [detail.reportId, detail.latestRevision],
  );
  const binding = identity.rows[0];
  if (!binding) throw new Error('SNAPSHOT_INCOMPLETE');
  const envelopeBytes = Buffer.from(binding.envelope_bytes);
  const envelope = decodeEnvelopeV1(envelopeBytes);
  const reportProtocolVersion = envelopeBytes[4];
  if (
    reportProtocolVersion !== 1 ||
    envelope.reportId !== detail.reportId ||
    envelope.revision !== detail.latestRevision ||
    !Buffer.from(envelope.payloadDigest).equals(Buffer.from(binding.payload_digest)) ||
    !Buffer.from(envelope.originKeyId).equals(Buffer.from(binding.origin_key_id))
  ) throw new Error('SNAPSHOT_BINDING_INVALID');

  const evidence = await client.query<{event_id: string; event_digest: Buffer; object_bytes: Buffer; object_kind: string; revision: number; verification: string; issuer_provider_id: Buffer}>(
    'SELECT event_id,event_digest,object_bytes,object_kind,revision,verification,issuer_provider_id FROM receipt_records WHERE report_id = $1 ORDER BY recorded_at_ms ASC,event_id ASC',
    [detail.reportId],
  );
  const pending = await client.query<{action_id: string; fields: {observedIncidentVersion?: string; status?: number; note?: string}}>(
    "SELECT action_id,fields FROM receipt_actions WHERE report_id = $1 AND responder_id = $2 AND preparation_state = 'PREPARING' ORDER BY action_id ASC",
    [detail.reportId, responderId],
  );

  return {
    reportId: detail.reportId,
    reportProtocolVersion,
    revision: detail.latestRevision,
    payloadDigest: Buffer.from(binding.payload_digest).toString('base64'),
    originKeyId: Buffer.from(binding.origin_key_id).toString('base64'),
    observedIncidentVersion: String(binding.receipt_version),
    emergencyType: detail.emergencyType,
    urgency: detail.urgency,
    location: detail.location,
    reportCreatedAtMs: detail.createdAtMs,
    receivedAtMs: Date.parse(detail.firstReceivedAt),
    syncedAtMs,
    latestAck: detail.latestAck,
    revisions: detail.revisions,
    acknowledgements: detail.acknowledgements,
    receiptEvidence: evidence.rows.map(row => ({eventId: row.event_id,eventDigest: Buffer.from(row.event_digest).toString('hex'),bytesBase64: Buffer.from(row.object_bytes).toString('base64'),kind: row.object_kind,revision: row.revision,verification: row.verification,issuerProviderId: Buffer.from(row.issuer_provider_id).toString('base64')})),
    pendingActions: pending.rows.map(row => ({actionId: row.action_id,observedIncidentVersion: String(row.fields?.observedIncidentVersion ?? '0'),status: statusName(row.fields?.status),note: typeof row.fields?.note === 'string' ? row.fields.note : ''})),
  };
}

function paginate(snapshotId: string, createdAtMs: number, expiresAtMs: number, summary: Record<string, number>, entries: unknown[]): Array<{index: number; cursor: string; byteCount: number; json: IncidentSnapshotPage}> {
  const chunks: unknown[][] = [];
  let current: unknown[] = [];
  for (const entry of entries) {
    const candidate = [...current, entry];
    if (candidate.length > PAGE_MAX_ENTRIES || jsonBytes(candidate) > PAGE_MAX_BYTES / 2) {
      if (current.length === 0) throw new Error('CAPACITY_FULL');
      chunks.push(current);
      current = [entry];
    } else current = candidate;
  }
  if (current.length > 0) chunks.push(current);
  const cursors = chunks.map(() => randomBytes(24).toString('base64url'));
  return chunks.map((chunk, index) => {
    const json: IncidentSnapshotPage = {snapshotId,createdAtMs,expiresAtMs,total:entries.length,summary,entries:chunk,nextCursor:cursors[index + 1] ?? null};
    const byteCount = jsonBytes(json);
    if (byteCount > PAGE_MAX_BYTES) throw new Error('CAPACITY_FULL');
    return {index,cursor:cursors[index]!,byteCount,json};
  });
}

function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
function digestCursor(cursor: string): Buffer { return createHash('sha256').update(cursor, 'utf8').digest(); }
function statusName(value: number | undefined): string { return value === 2 ? 'EN_ROUTE' : value === 3 ? 'ON_SCENE' : value === 4 ? 'RESOLVED' : 'ACKNOWLEDGED'; }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value); }
