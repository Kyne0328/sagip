import {Pool} from 'pg';

export function createPool(databaseUrl: string): Pool {
  if (databaseUrl.trim().length === 0) {
    throw new Error('DATABASE_URL must not be empty');
  }
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
  });
}
