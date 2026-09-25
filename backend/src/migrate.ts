import {fileURLToPath} from 'node:url';

import {applyMigrations} from './db/migrate.js';
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

void main().catch(() => {
  console.error('SAGIP backend migration failed');
  process.exitCode = 1;
});
