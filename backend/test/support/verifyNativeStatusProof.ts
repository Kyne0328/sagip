/**
 * Isolated Android-to-backend wire verification. Reads only the synthetic JVM
 * test artifact, uses pg-mem, never connects to a database or starts a service.
 */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {applyMigrations} from '../../src/db/migrate.js';
import {handleSagipRequest} from '../../src/http/handleRequest.js';
import {ResponderService} from '../../src/responder/service.js';
import {createMemoryPostgresPool} from './postgres.js';

const artifactPath = new URL('../../../android/build/private-status-proof.json', import.meta.url);
const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as {
  reportId: string; timestamp: string; nonce: string; signatureBase64: string;
  publicKeySpkiBase64: string; cursor: null;
};
assert.equal(artifact.cursor, null);
assert.ok(Number.isSafeInteger(Number(artifact.timestamp)));
const key = Buffer.from(artifact.publicKeySpkiBase64, 'base64');
const headers = {
  'x-sagip-status-timestamp': artifact.timestamp,
  'x-sagip-status-nonce': artifact.nonce,
  'x-sagip-status-signature': artifact.signatureBase64,
};
const pool = createMemoryPostgresPool();
const actualNow = Date.now;
try {
  await applyMigrations(pool, fileURLToPath(new URL('../../migrations/', import.meta.url)));
  const keyId = createHash('sha256').update(key).digest();
  await pool.query('INSERT INTO origin_keys VALUES ($1,$2,NOW(),NOW())', [keyId, key]);
  await pool.query('INSERT INTO incidents(report_id,origin_key_id,created_at_ms,first_received_at) VALUES ($1,$2,1,NOW())', [artifact.reportId, keyId]);
  await pool.query('INSERT INTO incident_revisions(report_id,revision,emergency_type,urgency,payload_digest) VALUES ($1,1,1,1,$2)', [artifact.reportId, Buffer.alloc(32, 1)]);
  const responderId = randomUUID();
  await pool.query('INSERT INTO responder_identities(responder_id,callsign,role,api_key_hash,registered_at) VALUES ($1,$2,$3,$4,NOW())',
    [responderId, 'SYNTHETIC-ANDROID-TEST', 'FIELD_LEAD', 'a'.repeat(64)]);
  const service = new ResponderService(pool);
  await service.acknowledgeIncident(artifact.reportId, responderId, 'EN_ROUTE', 'INTERNAL_ONLY_NEVER_RETURN');
  const deps = {
    ingestEnvelope: async () => { throw new Error('unused'); },
    responderService: service,
    rateLimiter: {isAllowed: () => true},
  };
  // Explicitly freeze only the read-proof freshness clock at the signed fixture
  // instant; cryptographic verification and the HTTP handler are unmodified.
  Date.now = () => Number(artifact.timestamp);
  const response = await handleSagipRequest(new Request(
    'https://sagip.synthetic/v1/reports/' + artifact.reportId + '/status', {headers},
  ), deps);
  assert.equal(response.status, 200);
  const body = await response.json() as {transport: string; latestAck: {status: string; note: null}; acknowledgements: unknown[]};
  assert.equal(body.transport, 'AUTHENTICATED_SERVER');
  assert.equal(body.latestAck.status, 'EN_ROUTE');
  assert.equal(body.latestAck.note, null);
  assert.equal(body.acknowledgements.length, 1);
  assert.doesNotMatch(JSON.stringify(body), /INTERNAL_ONLY_NEVER_RETURN/u);
  const wrongReport = await handleSagipRequest(new Request(
    'https://sagip.synthetic/v1/reports/' + randomUUID() + '/status', {headers},
  ), deps);
  assert.equal(wrongReport.status, 401);
  console.log('Android native signature accepted by real private-status handler: 200 EN_ROUTE; cross-report 401; notes excluded. Synthetic pg-mem database only; freshness clock explicitly fixed to signed artifact timestamp.');
} finally {
  Date.now = actualNow;
  await pool.end();
}
