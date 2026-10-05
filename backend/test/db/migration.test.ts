import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import type {Pool} from 'pg';

import {applyMigrations, MigrationIntegrityError} from '../../src/db/migrate.js';
import {createMemoryPostgresPool} from '../support/postgres.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

test('message migration preserves legacy rows, reapplies unchanged and bounds UTF-8 bytes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sagip-message-migration-'));
  const pool = createMemoryPostgresPool();
  try {
    const existingMigrations = [
      '001_ingestion_v1.sql',
      '002_responder_v1.sql',
      '003_distributed_rate_limit.sql',
      '004_responder_sessions.sql',
      '005_signed_receipts_v2.sql',
      '006_authority_time_v2.sql',
      '007_receipt_import_v2.sql',
      '008_incident_snapshots.sql',
    ];
    for (const name of existingMigrations) {
      await copyFile(path.join(MIGRATIONS_DIR, name), path.join(directory, name));
    }
    await applyMigrations(pool, directory);

    const reportId = '22222222-2222-2222-2222-222222222222';
    const keyId = Buffer.alloc(32);
    await pool.query('INSERT INTO origin_keys VALUES ($1, $2, NOW(), NOW())', [keyId, Buffer.from([1])]);
    await pool.query('INSERT INTO incidents VALUES ($1, $2, 1000, NOW())', [reportId, keyId]);
    await pool.query(
      `INSERT INTO incident_revisions(report_id, revision, emergency_type, urgency, payload_digest)
       VALUES ($1, 1, 1, 1, $2)`,
      [reportId, Buffer.alloc(32)],
    );

    await copyFile(
      path.join(MIGRATIONS_DIR, '009_incident_messages.sql'),
      path.join(directory, '009_incident_messages.sql'),
    );
    await applyMigrations(pool, directory);

    const legacy = await pool.query('SELECT * FROM incident_revisions');
    assert.equal(legacy.rows[0]?.message, null);
    const bookkeeping = await pool.query('SELECT * FROM schema_migrations ORDER BY name');
    await applyMigrations(pool, directory);
    assert.deepEqual((await pool.query('SELECT * FROM incident_revisions')).rows, legacy.rows);
    assert.deepEqual((await pool.query('SELECT * FROM schema_migrations ORDER BY name')).rows, bookkeeping.rows);

    const message = 'é'.repeat(250);
    await pool.query('UPDATE incident_revisions SET message = $1 WHERE report_id = $2', [message, reportId]);
    assert.equal((await pool.query('SELECT message FROM incident_revisions')).rows[0]?.message, message);
    await assert.rejects(
      pool.query('UPDATE incident_revisions SET message = $1 WHERE report_id = $2', [message + 'a', reportId]),
    );
    assert.equal((await pool.query('SELECT message FROM incident_revisions')).rows[0]?.message, message);
  } finally {
    await pool.end();
    await rm(directory, {recursive: true, force: true});
  }
});

test('applies ingestion v1 migration and database identity constraints', async () => {
  const pool = createMemoryPostgresPool();
  try {
    await applyMigrations(pool, MIGRATIONS_DIR);

    const tables = await pool.query<{table_name: string}>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
       ORDER BY table_name`,
    );
    assert.deepEqual(
      tables.rows.map(row => row.table_name),
      [
        'accepted_messages',
        'incident_revisions',
        'incident_snapshot_pages',
        'incident_snapshots',
        'incidents',
        'origin_keys',
        'receipt_access_challenges',
        'receipt_access_sessions',
        'receipt_actions',
        'receipt_authority_audit',
        'receipt_authority_grants',
        'receipt_authority_time_proofs',
        'receipt_authority_time_state',
        'receipt_projections',
        'receipt_quarantine',
        'receipt_records',
        'receipt_sequences',
        'request_rate_limit_windows',
        'responder_acknowledgements',
        'responder_identities',
        'responder_sessions',
        'schema_migrations',
        'server_receipts',
      ],
    );

    const migrations = await pool.query<{name: string; checksum_sha256: string}>(
      'SELECT name, checksum_sha256 FROM schema_migrations ORDER BY name',
    );
    assert.equal(migrations.rowCount, 10);
    assert.equal(migrations.rows[0]?.name, '001_ingestion_v1.sql');
    assert.match(migrations.rows[0]?.checksum_sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(migrations.rows[1]?.name, '002_responder_v1.sql');
    assert.match(migrations.rows[1]?.checksum_sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(migrations.rows[2]?.name, '003_distributed_rate_limit.sql');
    assert.match(migrations.rows[2]?.checksum_sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(migrations.rows[3]?.name, '004_responder_sessions.sql');
    assert.match(migrations.rows[3]?.checksum_sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(migrations.rows[4]?.name, '005_signed_receipts_v2.sql');
    assert.match(migrations.rows[4]?.checksum_sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(migrations.rows[5]?.name, '006_authority_time_v2.sql');
    assert.match(migrations.rows[5]?.checksum_sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(migrations.rows[6]?.name, '007_receipt_import_v2.sql');
    assert.match(migrations.rows[6]?.checksum_sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(migrations.rows[7]?.name, '008_incident_snapshots.sql');
    assert.match(migrations.rows[7]?.checksum_sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(migrations.rows[8]?.name, '009_incident_messages.sql');
    assert.equal(migrations.rows[9]?.name, '010_unspecified_sos_metadata.sql');
    assert.match(migrations.rows[9]?.checksum_sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.match(migrations.rows[8]?.checksum_sha256 ?? '', /^[0-9a-f]{64}$/);

    await assert.rejects(
      pool.query(
        `INSERT INTO origin_keys(origin_key_id, public_key_der, first_seen_at, last_seen_at)
         VALUES ($1, $2, NOW(), NOW())`,
        [Buffer.alloc(31), Buffer.from([1])],
      ),
    );
  } finally {
    await pool.end();
  }
});

test('holds a PostgreSQL advisory lock for the migration session', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sagip-empty-migrations-'));
  const queries: string[] = [];
  const client = {
    query: async (sql: string) => {
      queries.push(sql.replace(/\s+/gu, ' ').trim());
      if (sql.includes('information_schema.tables')) {
        return {rowCount: 1, rows: [{present: 1}]};
      }
      return {rowCount: 1, rows: []};
    },
    release: () => undefined,
  };
  const pool = {connect: async () => client} as unknown as Pick<Pool, 'connect'>;

  try {
    await applyMigrations(pool, directory);
    assert.match(queries[0] ?? '', /pg_advisory_lock/iu);
    assert.match(queries.at(-1) ?? '', /pg_advisory_unlock/iu);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('accepts a legacy CRLF checksum for unchanged migration SQL', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sagip-migrations-'));
  const pool = createMemoryPostgresPool();
  try {
    const migration = path.join(directory, '001_test.sql');
    const lfSql = 'CREATE TABLE example (id INTEGER PRIMARY KEY);\n';
    const crlfSql = lfSql.replace(/\n/gu, '\r\n');
    const legacyCrlfChecksum = createHash('sha256')
      .update(crlfSql, 'utf8')
      .digest('hex');

    await writeFile(migration, lfSql, 'utf8');
    await applyMigrations(pool, directory);
    await pool.query(
      'UPDATE schema_migrations SET checksum_sha256 = $1 WHERE name = $2',
      [legacyCrlfChecksum, '001_test.sql'],
    );

    await applyMigrations(pool, directory);
  } finally {
    await pool.end();
    await rm(directory, {recursive: true, force: true});
  }
});

test('refuses an applied migration whose file checksum changed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sagip-migrations-'));
  const pool = createMemoryPostgresPool();
  try {
    const migration = path.join(directory, '001_test.sql');
    await writeFile(migration, 'CREATE TABLE example (id INTEGER PRIMARY KEY);\n', 'utf8');
    await applyMigrations(pool, directory);

    await writeFile(migration, 'CREATE TABLE example (id INTEGER PRIMARY KEY, changed TEXT);\n', 'utf8');

    await assert.rejects(
      applyMigrations(pool, directory),
      (error: unknown) => error instanceof MigrationIntegrityError,
    );
  } finally {
    await pool.end();
    await rm(directory, {recursive: true, force: true});
  }
});
