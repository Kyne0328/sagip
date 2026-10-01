import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

export async function createIsolatedPostgres(
  connectionString = process.env.SAGIP_TEST_DATABASE_URL,
) {
  assert.ok(
    connectionString,
    'Real PostgreSQL required: set SAGIP_TEST_DATABASE_URL to an isolated test database',
  );
  const admin = new Pool({ connectionString });
  // The identifier is entirely test-generated. Never interpolate caller input
  // into the create/drop statements, and never fall back to the public schema.
  const schema = 'receipt_test_' + randomUUID().replaceAll('-', '');
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } catch (e) {
    await admin.end();
    throw e;
  }
  const pool = new Pool({
    connectionString,
    options: `-c search_path=${schema}`,
  });
  return {
    pool,
    close: async () => {
      try {
        await pool.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    },
  };
}
