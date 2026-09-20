import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import type {Pool} from 'pg';

import {applyMigrations, MigrationIntegrityError} from '../../src/db/migrate.js';
import {createMemoryPostgresPool} from '../support/postgres.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

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
        'incidents',
        'origin_keys',
        'responder_acknowledgements',
        'responder_identities',
        'schema_migrations',
        'server_receipts',
      ],
    );

    const migrations = await pool.query<{name: string; checksum_sha256: string}>(
      'SELECT name, checksum_sha256 FROM schema_migrations ORDER BY name',
    );
    assert.equal(migrations.rowCount, 2);
    assert.equal(migrations.rows[0]?.name, '001_ingestion_v1.sql');
    assert.match(migrations.rows[0]?.checksum_sha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(migrations.rows[1]?.name, '002_responder_v1.sql');
    assert.match(migrations.rows[1]?.checksum_sha256 ?? '', /^[0-9a-f]{64}$/);

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
