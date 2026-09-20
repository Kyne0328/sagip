import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {applyMigrations} from '../../src/db/migrate.js';
import {createMemoryPostgresPool} from '../support/postgres.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

test('applies responder v1 migration and enforces responder constraints', async () => {
  const pool = createMemoryPostgresPool();
  try {
    await applyMigrations(pool, MIGRATIONS_DIR);

    // Verify responder tables exist
    const tables = await pool.query<{table_name: string}>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'responder%'
       ORDER BY table_name`,
    );
    assert.deepEqual(
      tables.rows.map(row => row.table_name),
      ['responder_acknowledgements', 'responder_identities'],
    );

    // Insert a responder identity
    const responderId = '11111111-1111-1111-1111-111111111111';
    const hash1 = 'a'.repeat(64);
    const hash2 = 'b'.repeat(64);
    await pool.query(
      `INSERT INTO responder_identities(responder_id, callsign, role, api_key_hash, registered_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [responderId, 'RESCUE-1', 'DISPATCHER', hash1],
    );

    // Duplicate callsign must fail
    await assert.rejects(
      pool.query(
        `INSERT INTO responder_identities(responder_id, callsign, role, api_key_hash, registered_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        ['22222222-2222-2222-2222-222222222222', 'RESCUE-1', 'MEDIC', hash2],
      ),
    );

    // Insert incident first to satisfy FK
    const reportId = '33333333-3333-3333-3333-333333333333';
    const originKeyId = Buffer.alloc(32, 1);
    await pool.query(
      `INSERT INTO origin_keys(origin_key_id, public_key_der, first_seen_at, last_seen_at)
       VALUES ($1, $2, NOW(), NOW())`,
      [originKeyId, Buffer.from([1, 2, 3])],
    );
    await pool.query(
      `INSERT INTO incidents(report_id, origin_key_id, created_at_ms, first_received_at)
       VALUES ($1, $2, $3, NOW())`,
      [reportId, originKeyId, 1700000000000],
    );

    // Insert responder acknowledgement
    const ackId = '44444444-4444-4444-4444-444444444444';
    await pool.query(
      `INSERT INTO responder_acknowledgements(ack_id, report_id, responder_id, status, note, acknowledged_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [ackId, reportId, responderId, 'ACKNOWLEDGED', 'En route to coordinate'],
    );

    // Duplicate status for same responder on same incident must fail (uniqueness)
    await assert.rejects(
      pool.query(
        `INSERT INTO responder_acknowledgements(ack_id, report_id, responder_id, status, note, acknowledged_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        ['55555555-5555-5555-5555-555555555555', reportId, responderId, 'ACKNOWLEDGED', 'Duplicate status'],
      ),
    );

    // Invalid status must fail CHECK constraint
    await assert.rejects(
      pool.query(
        `INSERT INTO responder_acknowledgements(ack_id, report_id, responder_id, status, note, acknowledged_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        ['66666666-6666-6666-6666-666666666666', reportId, responderId, 'INVALID_STATUS', 'Bad'],
      ),
    );
  } finally {
    await pool.end();
  }
});
