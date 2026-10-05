import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {applyMigrations} from '../../src/db/migrate.js';
import {decodeEmergencyPayload} from '../../src/protocol/emergencyPayload.js';
import {ProtocolValidationError} from '../../src/protocol/errors.js';
import {IngestionConflictError, IngestionService} from '../../src/ingestion/service.js';
import {ResponderService} from '../../src/responder/service.js';
import {IncidentSnapshotService} from '../../src/responder/incidentSnapshot.js';
import {buildSignedEnvelope, createTestIdentity} from '../support/envelopeFactory.js';
import {createCompatibilityPostgres} from '../support/compatibilityPostgres.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

test('SRP1 v1 and v2 preserve explicit unspecified metadata and every legacy code', () => {
  for (const version of [1, 2]) {
    for (let emergencyType = 0; emergencyType <= 6; emergencyType++) {
      for (let urgency = 0; urgency <= 2; urgency++) {
        const bytes = Buffer.from([0x53, 0x52, 0x50, 0x31, version, emergencyType, urgency, 0,
          ...(version === 2 ? [0, 0] : [])]);
        assert.deepEqual(decodeEmergencyPayload(bytes), {emergencyType, urgency, location: null, message: null});
      }
    }
    for (const [category, urgency] of [[7, 0], [255, 0], [0, 3], [0, 255]]) {
      const bytes = Buffer.from([0x53, 0x52, 0x50, 0x31, version, category!, urgency!, 0,
        ...(version === 2 ? [0, 0] : [])]);
      assert.throws(() => decodeEmergencyPayload(bytes), ProtocolValidationError);
    }
  }
});

test('additive migration accepts 0 without rewriting existing known rows or weakening bounds', async () => {
  const {pool, close} = await createCompatibilityPostgres();
  try {
    await pool.query(await readFile(new URL('../../migrations/001_ingestion_v1.sql', import.meta.url), 'utf8'));
    const reportId = randomUUID();
    const keyId = Buffer.alloc(32, 1);
    await pool.query('INSERT INTO origin_keys VALUES ($1,$2,$3,$3)', [keyId, Buffer.from([1]), new Date()]);
    await pool.query('INSERT INTO incidents VALUES ($1,$2,$3,$4)', [reportId, keyId, 1, new Date()]);
    const insert = (revision: number, category: number, urgency: number) => pool.query(
      'INSERT INTO incident_revisions(report_id,revision,emergency_type,urgency,payload_digest) VALUES ($1,$2,$3,$4,$5)',
      [reportId, revision, category, urgency, Buffer.alloc(32)]);
    await insert(1, 6, 2);
    await assert.rejects(insert(2, 0, 0));
    await pool.query(await readFile(new URL('../../migrations/010_unspecified_sos_metadata.sql', import.meta.url), 'utf8'));
    await insert(2, 0, 0);
    for (const [category, urgency] of [[-1, 0], [7, 0], [0, -1], [0, 3]]) {
      await assert.rejects(insert(3, category!, urgency!));
    }
    assert.deepEqual((await pool.query('SELECT revision,emergency_type,urgency FROM incident_revisions ORDER BY revision')).rows,
      [{revision: 1, emergency_type: 6, urgency: 2}, {revision: 2, emergency_type: 0, urgency: 0}]);
    // The additive constraint must preserve every legacy code combination.
    let revision = 3;
    for (let category = 0; category <= 6; category++) {
      for (let urgency = 0; urgency <= 2; urgency++) {
        await insert(revision++, category, urgency);
      }
    }
    assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM incident_revisions')).rows[0]?.count), 23);
  } finally {
    await close();
  }
});

for (const reverse of [false, true]) {
  test('same-ID optional metadata preserves immutable SOS with ' + (reverse ? 'reverse' : 'forward') + ' arrival', async () => {
    const {pool, close} = await createCompatibilityPostgres();
    try {
      await applyMigrations(pool, MIGRATIONS_DIR);
      const ingestion = new IngestionService(pool);
      const responder = new ResponderService(pool);
      const identity = createTestIdentity();
      const reportId = randomUUID();
      const initialId = randomUUID();
      const initial = buildSignedEnvelope({identity, reportId, messageId: initialId, emergencyType: 0, urgency: 0});
      const details = buildSignedEnvelope({identity, reportId, messageId: randomUUID(), revision: 2,
        emergencyType: 3, urgency: 1, message: 'Smoke at the side entrance'});
      const order = reverse ? [details, initial] : [initial, details];
      for (const bytes of order) await ingestion.ingestEnvelope(bytes);
      assert.deepEqual(await ingestion.ingestEnvelope(initial), await ingestion.ingestEnvelope(initial));
      assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM incidents')).rows[0]?.count), 1);
      assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM accepted_messages')).rows[0]?.count), 2);
      assert.deepEqual((await pool.query('SELECT envelope_bytes FROM accepted_messages WHERE message_id=$1', [initialId])).rows[0]?.envelope_bytes, initial);
      const detail = await responder.getIncidentDetail(reportId);
      assert.equal(detail?.latestRevision, 2);
      assert.equal(detail?.emergencyType, 'FIRE');
      assert.equal(detail?.urgency, 'IMMEDIATE_DANGER');
      assert.equal(detail?.message, 'Smoke at the side entrance');
      assert.deepEqual(detail?.revisions.map(r => [r.revision, r.emergencyType, r.urgency]),
        [[1, 'UNSPECIFIED', 'UNSPECIFIED'], [2, 'FIRE', 'IMMEDIATE_DANGER']]);
      assert.equal((await responder.listIncidents())[0]?.latestRevision, 2);
      await assert.rejects(ingestion.ingestEnvelope(buildSignedEnvelope({
        identity, reportId, messageId: randomUUID(), emergencyType: 6, urgency: 2,
      })), IngestionConflictError);
      assert.equal((await responder.getIncidentDetail(reportId))?.revisions[0]?.urgency, 'UNSPECIFIED');
    } finally {
      await close();
    }
  });
}

test('untriaged SOS remains high in pending queue and frozen snapshot without false danger claims', async () => {
  const {pool, close} = await createCompatibilityPostgres();
  try {
    await applyMigrations(pool, MIGRATIONS_DIR);
    const ingestion = new IngestionService(pool);
    const responder = new ResponderService(pool);
    const identity = createTestIdentity();
    const unknownId = randomUUID();
    const immediateId = randomUUID();
    const routineId = randomUUID();
    const at = Date.parse('2026-10-05T00:00:00Z');
    for (const [reportId, urgency, received] of [[routineId, 2, 0], [unknownId, 0, 1], [immediateId, 1, 2]] as const) {
      await ingestion.ingestEnvelope(buildSignedEnvelope({identity, reportId, messageId: randomUUID(),
        emergencyType: urgency === 0 ? 0 : 1, urgency}), new Date(at + received));
    }
    const queue = await responder.listIncidents('PENDING');
    assert.deepEqual(queue.map(item => item.reportId), [unknownId, immediateId, routineId]);
    assert.equal(queue[0]?.emergencyType, 'UNSPECIFIED');
    assert.equal(queue[0]?.urgency, 'UNSPECIFIED');
    assert.equal(queue[0]?.message, null);
    assert.equal(queue[0]?.location, null);
    assert.equal((await responder.getIncidentQueueSummary()).immediateDanger, 1);
    const owner = {responderId: randomUUID(), callsign: 'SYNTHETIC-UNSPECIFIED', role: 'DISPATCHER', registeredAt: new Date(at).toISOString()};
    await pool.query('INSERT INTO responder_identities(responder_id,callsign,role,api_key_hash,registered_at) VALUES ($1,$2,$3,$4,$5)',
      [owner.responderId, owner.callsign, owner.role, createHash('sha256').update(owner.callsign).digest('hex'), owner.registeredAt]);
    const snapshots = new IncidentSnapshotService(pool);
    const descriptor = await snapshots.createIncidentSnapshot(owner);
    await ingestion.ingestEnvelope(buildSignedEnvelope({identity, reportId: unknownId, messageId: randomUUID(),
      revision: 2, emergencyType: 2, urgency: 0, message: 'Water rising'}));
    assert.ok(descriptor.nextCursor);
    const snapshot = await snapshots.readIncidentSnapshotPage(descriptor.snapshotId, descriptor.nextCursor, owner);
    const entries = snapshot.entries as Array<{reportId: string; emergencyType: string; urgency: string; revision: number}>;
    const frozen = entries.find(entry => entry.reportId === unknownId);
    assert.equal(frozen?.emergencyType, 'UNSPECIFIED');
    assert.equal(frozen?.urgency, 'UNSPECIFIED');
    assert.equal(frozen?.revision, 1);
    const updated = await responder.getIncidentDetail(unknownId);
    assert.equal(updated?.emergencyType, 'FLOOD');
    assert.equal(updated?.urgency, 'UNSPECIFIED');
  } finally {
    await close();
  }
});
