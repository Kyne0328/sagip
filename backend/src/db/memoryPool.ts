import {DataType, newDb} from 'pg-mem';
import type {Pool, PoolClient, QueryResult, QueryResultRow} from 'pg';

const BUFFER_PREFIX = 'sagip-hex:';

/**
 * Creates an in-memory PostgreSQL pool using pg-mem, configuring
 * the custom functions required by SAGIP schema migrations and repository.
 */
export function createMemoryPostgresPool(): Pool {
  const memory = newDb({autoCreateForeignKeyIndices: true});
  memory.public.registerFunction({
    name: 'octet_length',
    args: [DataType.bytea],
    returns: DataType.integer,
    implementation: (value: Buffer) => logicalByteLength(value),
  });
  memory.public.registerFunction({
    name: 'pg_advisory_lock',
    args: [DataType.integer],
    returns: DataType.integer,
    implementation: () => 1,
  });
  memory.public.registerFunction({
    name: 'pg_advisory_unlock',
    args: [DataType.integer],
    returns: DataType.bool,
    implementation: () => true,
  });

  const adapter = memory.adapters.createPg();
  const underlying = new adapter.Pool();

  return {
    query: async (text: string, values?: readonly unknown[]) =>
      decodeResult(await underlying.query(text, encodeValues(values))),
    connect: async () => wrapClient(await underlying.connect()),
    end: async () => underlying.end(),
  } as unknown as Pool;
}

function wrapClient(client: PoolClient): PoolClient {
  return {
    query: async (text: string, values?: readonly unknown[]) =>
      decodeResult(await client.query(text, encodeValues(values))),
    release: () => client.release(),
  } as unknown as PoolClient;
}

function encodeValues(values: readonly unknown[] | undefined): unknown[] | undefined {
  return values?.map(value =>
    Buffer.isBuffer(value)
      ? Buffer.from(`${BUFFER_PREFIX}${value.toString('hex')}`, 'ascii')
      : value,
  );
}

function decodeResult<R extends QueryResultRow>(result: QueryResult<R>): QueryResult<R> {
  return {
    ...result,
    rows: result.rows.map(row => decodeRow(row)),
  };
}

function decodeRow<R extends QueryResultRow>(row: R): R {
  const decoded = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, decodeValue(value)]),
  );
  return decoded as R;
}

function decodeValue(value: unknown): unknown {
  if (!Buffer.isBuffer(value)) return value;
  const encoded = value.toString('ascii');
  if (!encoded.startsWith(BUFFER_PREFIX)) return value;
  const hex = encoded.slice(BUFFER_PREFIX.length);
  return Buffer.from(hex, 'hex');
}

function logicalByteLength(value: Buffer): number {
  const encoded = value.toString('ascii');
  if (!encoded.startsWith(BUFFER_PREFIX)) return value.length;
  const hex = encoded.slice(BUFFER_PREFIX.length);
  return hex.length / 2;
}
