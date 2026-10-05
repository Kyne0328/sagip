import {createMemoryPostgresPool} from './postgres.js';
import {createIsolatedPostgres} from './realPostgres.js';

// CI supplies only its disposable PostgreSQL URL. Local runs keep the fast
// in-memory fixture; never fall back to DATABASE_URL or a production schema.
export async function createCompatibilityPostgres() {
  if (process.env.SAGIP_TEST_DATABASE_URL) {
    return createIsolatedPostgres();
  }
  const pool = createMemoryPostgresPool();
  return {pool, close: () => pool.end()};
}
