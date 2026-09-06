import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';

import type {Pool, PoolClient} from 'pg';

const MIGRATION_ADVISORY_LOCK_KEY = 0x53414749;

export class MigrationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationIntegrityError';
  }
}

export async function applyMigrations(
  pool: Pick<Pool, 'connect'>,
  migrationsDir: string,
): Promise<void> {
  const client = await pool.connect();
  let lockHeld = false;
  let primaryError: unknown;
  let hasPrimaryError = false;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    lockHeld = true;

    await ensureMigrationTable(client);
    const migrationNames = (await readdir(migrationsDir))
      .filter(name => /^\d+.*\.sql$/u.test(name))
      .sort((left, right) => left.localeCompare(right));

    for (const name of migrationNames) {
      const sql = await readFile(path.join(migrationsDir, name), 'utf8');
      const checksum = createHash('sha256').update(sql, 'utf8').digest('hex');
      const existing = await client.query<{checksum_sha256: string}>(
        'SELECT checksum_sha256 FROM schema_migrations WHERE name = $1',
        [name],
      );
      if ((existing.rowCount ?? 0) > 0) {
        if (existing.rows[0]?.checksum_sha256 !== checksum) {
          throw new MigrationIntegrityError(
            `Applied migration ${name} does not match its recorded checksum`,
          );
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations(name, checksum_sha256, applied_at)
           VALUES ($1, $2, NOW())`,
          [name, checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      }
    }
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  }

  let unlockError: unknown;
  let hasUnlockError = false;
  if (lockHeld) {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    } catch (error) {
      unlockError = error;
      hasUnlockError = true;
    }
  }

  if (hasUnlockError) {
    client.release(unlockError instanceof Error ? unlockError : true);
  } else {
    client.release();
  }

  if (hasPrimaryError) throw primaryError;
  if (hasUnlockError) throw unlockError;
}

async function ensureMigrationTable(client: PoolClient): Promise<void> {
  const existing = await client.query(
    `SELECT 1
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'schema_migrations'`,
  );
  if ((existing.rowCount ?? 0) > 0) return;

  try {
    await client.query(`
      CREATE TABLE schema_migrations (
        name TEXT PRIMARY KEY,
        checksum_sha256 TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL
      )
    `);
  } catch (error) {
    if (!isPostgresErrorCode(error, '42P07')) throw error;
  }
}

function isPostgresErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as {code?: unknown}).code === code
  );
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original migration failure.
  }
}
