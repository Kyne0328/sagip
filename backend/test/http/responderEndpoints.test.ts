import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {applyMigrations} from '../../src/db/migrate.js';
import {createSagipServer} from '../../src/http/createServer.js';
import {ResponderService} from '../../src/responder/service.js';
import {createMemoryPostgresPool} from '../support/postgres.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

test('responder HTTP endpoints: auth, listing, acknowledging, and public status', async () => {
  const pool = createMemoryPostgresPool();
  await applyMigrations(pool, MIGRATIONS_DIR);

  const responderService = new ResponderService(pool);
  const server = createSagipServer({
    ingestEnvelope: async () => {
      throw new Error('Not used in this test');
    },
    responderService,
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 8080;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Seed a responder identity
    const responderId = randomUUID();
    const token = 'secret-responder-token-xyz';
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
    await pool.query(
      `INSERT INTO responder_identities(responder_id, callsign, role, api_key_hash, registered_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [responderId, 'RESCUE-BRAVO-1', 'FIELD_LEAD', tokenHash],
    );

    // Seed an incident with revision
    const reportId = randomUUID();
    const originKeyId = Buffer.alloc(32, 2);
    await pool.query(
      `INSERT INTO origin_keys(origin_key_id, public_key_der, first_seen_at, last_seen_at)
       VALUES ($1, $2, NOW(), NOW())`,
      [originKeyId, Buffer.from([1, 2, 3])],
    );
    await pool.query(
      `INSERT INTO incidents(report_id, origin_key_id, created_at_ms, first_received_at)
       VALUES ($1, $2, $3, NOW())`,
      [reportId, originKeyId, 1758369600000],
    );
    await pool.query(
      `INSERT INTO incident_revisions(report_id, revision, emergency_type, urgency, payload_digest, location_latitude_e6, location_longitude_e6, location_accuracy_cm, location_captured_at_ms, location_source, location_freshness)
       VALUES ($1, 1, 1, 1, $2, 14599512, 120984222, 500, 1758369590000, 1, 1)`,
      [reportId, Buffer.alloc(32, 9)],
    );

    // 1. GET /v1/incidents without auth -> 401
    const unauthRes = await fetch(`${baseUrl}/v1/incidents`);
    assert.equal(unauthRes.status, 401);

    // 2. GET /v1/incidents with invalid token -> 401
    const badAuthRes = await fetch(`${baseUrl}/v1/incidents`, {
      headers: {authorization: 'Bearer bad-token'},
    });
    assert.equal(badAuthRes.status, 401);

    // 3. GET /v1/incidents with valid token -> 200, lists incident
    const listRes = await fetch(`${baseUrl}/v1/incidents`, {
      headers: {authorization: `Bearer ${token}`},
    });
    assert.equal(listRes.status, 200);
    const incidents = (await listRes.json()) as Array<{reportId: string; emergencyType: string; urgency: string; location: {latitude: number; longitude: number}}>;
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]?.reportId, reportId);
    assert.equal(incidents[0]?.emergencyType, 'MEDICAL');
    assert.equal(incidents[0]?.urgency, 'IMMEDIATE_DANGER');
    assert.equal(incidents[0]?.location.latitude, 14.599512);

    // 4. GET /v1/incidents/:reportId -> 200
    const detailRes = await fetch(`${baseUrl}/v1/incidents/${reportId}`, {
      headers: {authorization: `Bearer ${token}`},
    });
    assert.equal(detailRes.status, 200);
    const detail = (await detailRes.json()) as {reportId: string; revisions: unknown[]; acknowledgements: unknown[]};
    assert.equal(detail.reportId, reportId);
    assert.equal(detail.revisions.length, 1);
    assert.equal(detail.acknowledgements.length, 0);

    // 5. POST /v1/incidents/:reportId/ack -> 200
    const ackRes = await fetch(`${baseUrl}/v1/incidents/${reportId}/ack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        status: 'ACKNOWLEDGED',
        note: 'Medic unit en route, ETA 8 mins',
      }),
    });
    assert.equal(ackRes.status, 200);
    const ackData = (await ackRes.json()) as {callsign: string; status: string; note: string};
    assert.equal(ackData.callsign, 'RESCUE-BRAVO-1');
    assert.equal(ackData.status, 'ACKNOWLEDGED');
    assert.equal(ackData.note, 'Medic unit en route, ETA 8 mins');

    // Replay same ACK -> idempotent 200
    const replayAckRes = await fetch(`${baseUrl}/v1/incidents/${reportId}/ack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        status: 'ACKNOWLEDGED',
        note: 'Duplicate click',
      }),
    });
    assert.equal(replayAckRes.status, 200);

    // 6. Public GET /v1/reports/:reportId/status -> 200 (no auth needed)
    const statusRes = await fetch(`${baseUrl}/v1/reports/${reportId}/status`);
    assert.equal(statusRes.status, 200);
    const statusData = (await statusRes.json()) as {reportId: string; serverAccepted: boolean; latestAck: {callsign: string; status: string}};
    assert.equal(statusData.reportId, reportId);
    assert.equal(statusData.serverAccepted, true);
    assert.equal(statusData.latestAck?.callsign, 'RESCUE-BRAVO-1');
    assert.equal(statusData.latestAck?.status, 'ACKNOWLEDGED');

    // Unknown report status -> serverAccepted: false
    const unknownStatusRes = await fetch(`${baseUrl}/v1/reports/${randomUUID()}/status`);
    assert.equal(unknownStatusRes.status, 200);
    const unknownData = (await unknownStatusRes.json()) as {serverAccepted: boolean};
    assert.equal(unknownData.serverAccepted, false);
  } finally {
    server.close();
    await pool.end();
  }
});
