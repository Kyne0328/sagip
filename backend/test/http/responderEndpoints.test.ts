import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {applyMigrations} from '../../src/db/migrate.js';
import {createSagipServer} from '../../src/http/createServer.js';
import {ResponderService} from '../../src/responder/service.js';
import {statusProofHeaders, statusTestIdentity} from '../support/statusProof.js';
import {createMemoryPostgresPool} from '../support/postgres.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

test('responder HTTP endpoints: auth, listing, acknowledging, and private origin status', async () => {
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
    const origin = statusTestIdentity();
    const originPublicKey = origin.publicKey.export({format: 'der', type: 'spki'});
    const originKeyId = createHash('sha256').update(originPublicKey).digest();
    await pool.query(
      `INSERT INTO origin_keys(origin_key_id, public_key_der, first_seen_at, last_seen_at)
       VALUES ($1, $2, NOW(), NOW())`,
      [originKeyId, originPublicKey],
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
    await pool.query(
      `INSERT INTO incident_revisions(report_id, revision, emergency_type, urgency, payload_digest, message)
       VALUES ($1, 2, 3, 2, $2, 'Need help 🆘')`,
      [reportId, Buffer.alloc(32, 10)],
    );

    // 1. GET /v1/incidents without auth -> 401
    const unauthRes = await fetch(`${baseUrl}/v1/incidents`);
    assert.equal(unauthRes.status, 401);

    // 2. GET /v1/incidents with invalid token -> 401
    const badAuthRes = await fetch(`${baseUrl}/v1/incidents`, {
      headers: {authorization: 'Bearer bad-token'},
    });
    assert.equal(badAuthRes.status, 401);

    const badSessionLoginRes = await fetch(`${baseUrl}/v1/responder/session`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({token: 'bad-token'}),
    });
    assert.equal(badSessionLoginRes.status, 401);

    // 3. Exchange the provisioned token for a browser session.
    const sessionLoginRes = await fetch(`${baseUrl}/v1/responder/session`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({token}),
    });
    assert.equal(sessionLoginRes.status, 200);
    assert.equal(sessionLoginRes.headers.get('cache-control'), 'no-store');
    const setCookie = sessionLoginRes.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /__Host-sagip-responder=/u);
    assert.match(setCookie, /HttpOnly/u);
    assert.match(setCookie, /Secure/u);
    assert.match(setCookie, /SameSite=Strict/u);
    assert.doesNotMatch(setCookie, new RegExp(token, 'u'));
    const sessionCookie = setCookie.split(';')[0] ?? '';
    assert.ok(sessionCookie.length > '__Host-sagip-responder='.length);

    const sessionBody = (await sessionLoginRes.json()) as {
      responder: {callsign: string; role: string};
      expiresAt: string;
    };
    assert.equal(sessionBody.responder.callsign, 'RESCUE-BRAVO-1');
    assert.equal(sessionBody.responder.role, 'FIELD_LEAD');
    assert.ok(Date.parse(sessionBody.expiresAt) > Date.now());

    const restoreSessionRes = await fetch(`${baseUrl}/v1/responder/session`, {
      headers: {cookie: sessionCookie},
    });
    assert.equal(restoreSessionRes.status, 200);
    const restoredSession = (await restoreSessionRes.json()) as {
      responder: {callsign: string};
    };
    assert.equal(restoredSession.responder.callsign, 'RESCUE-BRAVO-1');

    // 4. Cookie-authenticated console access works without exposing the bearer token again.
    const cookieListRes = await fetch(`${baseUrl}/v1/incidents`, {
      headers: {cookie: sessionCookie},
    });
    assert.equal(cookieListRes.status, 200);
    assert.equal(((await cookieListRes.json()) as unknown[]).length, 1);

    const summaryRes = await fetch(`${baseUrl}/v1/incidents/summary`, {
      headers: {cookie: sessionCookie},
    });
    assert.equal(summaryRes.status, 200);
    assert.deepEqual(await summaryRes.json(), {
      total: 1,
      pending: 1,
      acknowledged: 0,
      enRoute: 0,
      onScene: 0,
      resolved: 0,
      immediateDanger: 0,
    });

    // 5. Bearer authentication remains supported for API clients.
    const listRes = await fetch(`${baseUrl}/v1/incidents`, {
      headers: {authorization: `Bearer ${token}`},
    });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.headers.get('cache-control'), 'no-store');
    const incidents = (await listRes.json()) as Array<{message: string | null; reportId: string; emergencyType: string; urgency: string; location: {latitude: number; longitude: number}}>;
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0]?.reportId, reportId);
    assert.equal(incidents[0]?.message, 'Need help 🆘');
    assert.equal(incidents[0]?.emergencyType, 'FIRE');
    assert.equal(incidents[0]?.urgency, 'NEED_ASSISTANCE');
    assert.equal(incidents[0]?.location.latitude, 14.599512);

    const invalidFilterRes = await fetch(`${baseUrl}/v1/incidents?status=NOT_A_STATUS`, {
      headers: {authorization: `Bearer ${token}`},
    });
    assert.equal(invalidFilterRes.status, 400);

    const invalidSortRes = await fetch(`${baseUrl}/v1/incidents?sort=created_at`, {
      headers: {authorization: `Bearer ${token}`},
    });
    assert.equal(invalidSortRes.status, 400);
    assert.deepEqual(await invalidSortRes.json(), {error: 'INVALID_SORT'});
    const sortedFilteredRes = await fetch(`${baseUrl}/v1/incidents?status=PENDING&sort=urgency&limit=100`, {
      headers: {authorization: `Bearer ${token}`},
    });
    assert.equal(sortedFilteredRes.status, 200);
    assert.equal(((await sortedFilteredRes.json()) as unknown[]).length, 1);

    const invalidLimitRes = await fetch(`${baseUrl}/v1/incidents?limit=1000`, {
      headers: {authorization: `Bearer ${token}`},
    });
    assert.equal(invalidLimitRes.status, 400);

    const invalidOffsetRes = await fetch(`${baseUrl}/v1/incidents?offset=-1`, {
      headers: {authorization: `Bearer ${token}`},
    });
    assert.equal(invalidOffsetRes.status, 400);

    // 4. GET /v1/incidents/:reportId -> 200
    const detailRes = await fetch(`${baseUrl}/v1/incidents/${reportId}`, {
      headers: {authorization: `Bearer ${token}`},
    });
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.headers.get('cache-control'), 'no-store');
    const detail = (await detailRes.json()) as {
      reportId: string;
      latestRevision: number;
      emergencyType: string;
      location: {latitude: number};
      message: string | null;
      revisions: Array<{revision: number; message: string | null}>;
      acknowledgements: unknown[];
    };
    assert.equal(detail.reportId, reportId);
    assert.equal(detail.message, 'Need help 🆘');
    assert.deepEqual(detail.revisions.map(row => [row.revision, row.message]), [[1, null], [2, 'Need help 🆘']]);
    assert.equal(detail.latestRevision, 2);
    assert.equal(detail.emergencyType, 'FIRE');
    assert.equal(detail.location.latitude, 14.599512);
    assert.equal(detail.revisions.length, 2);
    assert.equal(detail.acknowledgements.length, 0);

    const wrongMediaTypeRes = await fetch(`${baseUrl}/v1/incidents/${reportId}/ack`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({status: 'ACKNOWLEDGED'}),
    });
    assert.equal(wrongMediaTypeRes.status, 415);

    const longNoteRes = await fetch(`${baseUrl}/v1/incidents/${reportId}/ack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({status: 'ACKNOWLEDGED', note: 'x'.repeat(1001)}),
    });
    assert.equal(longNoteRes.status, 400);

    const nullBodyRes = await fetch(`${baseUrl}/v1/incidents/${reportId}/ack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: 'null',
    });
    assert.equal(nullBodyRes.status, 400);
    assert.deepEqual(await nullBodyRes.json(), {error: 'INVALID_ACK_BODY'});

    const invalidNoteTypeRes = await fetch(`${baseUrl}/v1/incidents/${reportId}/ack`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({status: 'ACKNOWLEDGED', note: {unsafe: true}}),
    });
    assert.equal(invalidNoteTypeRes.status, 400);
    assert.deepEqual(await invalidNoteTypeRes.json(), {error: 'INVALID_ACK_BODY'});

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

    // 6. Disconnect revokes the browser session without affecting bearer credentials.
    const logoutRes = await fetch(`${baseUrl}/v1/responder/session`, {
      method: 'DELETE',
      headers: {cookie: sessionCookie},
    });
    assert.equal(logoutRes.status, 204);
    assert.match(logoutRes.headers.get('set-cookie') ?? '', /Max-Age=0/u);

    const revokedSessionRes = await fetch(`${baseUrl}/v1/incidents`, {
      headers: {cookie: sessionCookie},
    });
    assert.equal(revokedSessionRes.status, 401);

    const bearerAfterLogoutRes = await fetch(`${baseUrl}/v1/incidents`, {
      headers: {authorization: `Bearer ${token}`},
    });
    assert.equal(bearerAfterLogoutRes.status, 200);

    // 7. Only the origin device can read private report status/history.
    const deniedStatus = await fetch(`${baseUrl}/v1/reports/${reportId}/status`);
    assert.equal(deniedStatus.status, 401);
    const statusRes = await fetch(`${baseUrl}/v1/reports/${reportId}/status`, {
      headers: statusProofHeaders(reportId, origin.privateKey),
    });
    assert.equal(statusRes.status, 200);
    const statusData = (await statusRes.json()) as {reportId: string; serverAccepted: boolean; latestAck: {callsign: string; status: string}};
    assert.equal(statusData.reportId, reportId);
    assert.equal(statusData.serverAccepted, true);
    assert.equal(statusData.latestAck?.callsign, 'RESCUE-BRAVO-1');
    assert.equal(statusData.latestAck?.status, 'ACKNOWLEDGED');

    // Unknown IDs have the same response as known IDs without proof.
    const unknownStatusRes = await fetch(`${baseUrl}/v1/reports/${randomUUID()}/status`);
    assert.equal(unknownStatusRes.status, 401);
    assert.deepEqual(await unknownStatusRes.json(), await deniedStatus.json());
  } finally {
    server.close();
    await pool.end();
  }
});
