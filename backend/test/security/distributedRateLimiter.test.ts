import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {applyMigrations} from '../../src/db/migrate.js';
import {PostgresSlidingWindowRateLimiter} from '../../src/http/rateLimiter.js';
import {createMemoryPostgresPool} from '../support/postgres.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

test('Postgres rate limiter shares enforcement state across server instances without storing raw IP', async () => {
  const pool = createMemoryPostgresPool();
  await applyMigrations(pool, MIGRATIONS_DIR);

  try {
    const firstInstance = new PostgresSlidingWindowRateLimiter(pool, {
      windowMs: 60_000,
      maxRequests: 2,
    });
    const secondInstance = new PostgresSlidingWindowRateLimiter(pool, {
      windowMs: 60_000,
      maxRequests: 2,
    });

    const now = 180_000;
    assert.equal(await firstInstance.isAllowed('203.0.113.20', now), true);
    assert.equal(await secondInstance.isAllowed('203.0.113.20', now + 1), true);
    assert.equal(await firstInstance.isAllowed('203.0.113.20', now + 2), false);

    const stored = await pool.query<{bucket_key: string}>(
      'SELECT bucket_key FROM request_rate_limit_windows',
    );
    assert.ok(stored.rows.length > 0);
    assert.equal(stored.rows.some(row => row.bucket_key.includes('203.0.113.20')), false);
    assert.equal(stored.rows.every(row => /^[0-9a-f]{64}$/u.test(row.bucket_key)), true);
  } finally {
    await pool.end();
  }
});
