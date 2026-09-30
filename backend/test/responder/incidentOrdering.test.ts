import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {applyMigrations} from '../../src/db/migrate.js';
import {ResponderService} from '../../src/responder/service.js';
import {createMemoryPostgresPool} from '../support/postgres.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

async function seedResponder(
  pool: ReturnType<typeof createMemoryPostgresPool>,
  responderId: string,
  callsign: string,
): Promise<void> {
  const tokenHash = createHash('sha256').update(callsign, 'utf8').digest('hex');
  await pool.query(
    `INSERT INTO responder_identities(responder_id, callsign, role, api_key_hash, registered_at)
     VALUES ($1, $2, 'DISPATCHER', $3, NOW())`,
    [responderId, callsign, tokenHash],
  );
}

test('incident queue uses server arrival, operational status, urgency, and stable tie breakers', async () => {
  const pool = createMemoryPostgresPool();
  await applyMigrations(pool, MIGRATIONS_DIR);
  const service = new ResponderService(pool);

  const originKeyId = Buffer.alloc(32, 31);
  await pool.query(
    `INSERT INTO origin_keys(origin_key_id, public_key_der, first_seen_at, last_seen_at)
     VALUES ($1, $2, NOW(), NOW())`,
    [originKeyId, Buffer.from([1, 2, 3])],
  );

  const ids = {
    oldestImmediatePending: '11111111-1111-1111-1111-111111111111',
    newerImmediatePending: '22222222-2222-2222-2222-222222222222',
    immediateEnRoute: '33333333-3333-3333-3333-333333333333',
    needAssistancePending: '44444444-4444-4444-4444-444444444444',
    resolvedImmediate: '55555555-5555-5555-5555-555555555555',
  } as const;

  const incidents = [
    [ids.oldestImmediatePending, 9_999_999_999_999, '2026-09-20T09:59:00.000Z', 1],
    [ids.newerImmediatePending, 1, '2026-09-20T10:00:00.000Z', 1],
    [ids.immediateEnRoute, 2, '2026-09-20T09:00:00.000Z', 1],
    [ids.needAssistancePending, 3, '2026-09-20T08:00:00.000Z', 2],
    [ids.resolvedImmediate, 4, '2026-09-20T07:00:00.000Z', 1],
  ] as const;

  for (const [reportId, createdAtMs, firstReceivedAt, urgency] of incidents) {
    await pool.query(
      `INSERT INTO incidents(report_id, origin_key_id, created_at_ms, first_received_at)
       VALUES ($1, $2, $3, $4)`,
      [reportId, originKeyId, createdAtMs, firstReceivedAt],
    );
    await pool.query(
      `INSERT INTO incident_revisions(report_id, revision, emergency_type, urgency, payload_digest)
       VALUES ($1, 1, 1, $2, $3)`,
      [reportId, urgency, Buffer.alloc(32, urgency)],
    );
  }

  const responderId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  await seedResponder(pool, responderId, 'QUEUE-TEST');
  await pool.query(
    `INSERT INTO responder_acknowledgements(ack_id, report_id, responder_id, status, note, acknowledged_at)
     VALUES
       ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', $1, $3, 'EN_ROUTE', NULL, '2026-09-20T10:10:00.000Z'),
       ('cccccccc-cccc-cccc-cccc-cccccccccccc', $2, $3, 'RESOLVED', NULL, '2026-09-20T10:20:00.000Z')`,
    [ids.immediateEnRoute, ids.resolvedImmediate, responderId],
  );

  const ordered = await service.listIncidents();

  assert.deepEqual(
    ordered.map(incident => incident.reportId),
    [
      ids.oldestImmediatePending,
      ids.newerImmediatePending,
      ids.immediateEnRoute,
      ids.needAssistancePending,
      ids.resolvedImmediate,
    ],
  );

  await pool.end();
});

test('canonical incident status cannot regress because a lower-stage acknowledgement arrived later', async () => {
  const pool = createMemoryPostgresPool();
  await applyMigrations(pool, MIGRATIONS_DIR);
  const service = new ResponderService(pool);

  const originKeyId = Buffer.alloc(32, 41);
  const reportId = '66666666-6666-6666-6666-666666666666';
  await pool.query(
    `INSERT INTO origin_keys(origin_key_id, public_key_der, first_seen_at, last_seen_at)
     VALUES ($1, $2, NOW(), NOW())`,
    [originKeyId, Buffer.from([4, 5, 6])],
  );
  await pool.query(
    `INSERT INTO incidents(report_id, origin_key_id, created_at_ms, first_received_at)
     VALUES ($1, $2, 1000, '2026-09-20T10:00:00.000Z')`,
    [reportId, originKeyId],
  );
  await pool.query(
    `INSERT INTO incident_revisions(report_id, revision, emergency_type, urgency, payload_digest)
     VALUES ($1, 1, 1, 1, $2)`,
    [reportId, Buffer.alloc(32, 42)],
  );

  const resolvedResponder = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const lateResponder = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  await seedResponder(pool, resolvedResponder, 'RESOLVER');
  await seedResponder(pool, lateResponder, 'LATE-ACK');

  await pool.query(
    `INSERT INTO responder_acknowledgements(ack_id, report_id, responder_id, status, note, acknowledged_at)
     VALUES
       ('ffffffff-ffff-ffff-ffff-ffffffffffff', $1, $2, 'RESOLVED', 'Completed', '2026-09-20T10:05:00.000Z'),
       ('99999999-9999-9999-9999-999999999999', $1, $3, 'ACKNOWLEDGED', 'Late offline sync', '2026-09-20T10:10:00.000Z')`,
    [reportId, resolvedResponder, lateResponder],
  );

  const status = await service.getReportStatus(reportId);
  assert.equal(status?.latestAck?.status, 'RESOLVED');

  const detail = await service.getIncidentDetail(reportId);
  assert.equal(detail?.latestAck?.status, 'RESOLVED');

  const summary = await service.getIncidentQueueSummary();
  assert.equal(summary.resolved, 1);
  assert.equal(summary.acknowledged, 0);

  const resolved = await service.listIncidents('RESOLVED');
  assert.deepEqual(resolved.map(incident => incident.reportId), [reportId]);
  assert.equal((await service.listIncidents('ACKNOWLEDGED')).length, 0);

  await pool.end();
});
