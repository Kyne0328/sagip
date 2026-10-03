import {fileURLToPath} from 'node:url';

import {MigrationIntegrityError, applyMigrations} from './db/migrate.js';
import {createPool} from './db/pool.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = createPool(databaseUrl);
  try {
    await applyMigrations(pool, MIGRATIONS_DIR);
  } finally {
    await pool.end();
  }
}

function describeMigrationFailure(error: unknown): string {
  if (error instanceof MigrationIntegrityError) {
    return error.message;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as {code?: unknown}).code === 'string'
  ) {
    return `PostgreSQL error ${(error as {code: string}).code}`;
  }
  return 'Unexpected migration error';
}

void main().catch(error => {
  console.error(`SAGIP backend migration failed: ${describeMigrationFailure(error)}`);
  process.exitCode = 1;
});
