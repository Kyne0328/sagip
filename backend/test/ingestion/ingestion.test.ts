import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import type {Pool} from 'pg';

import {applyMigrations} from '../../src/db/migrate.js';
import {
  IngestionConflictError,
  IngestionService,
  IngestionTransientError,
} from '../../src/ingestion/service.js';
import {buildSignedEnvelope, createTestIdentity} from '../support/envelopeFactory.js';
import {createMemoryPostgresPool} from '../support/postgres.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

test('500-byte message persists unchanged and concurrent replay returns one receipt', async () => {
  await withService(async (service, pool) => {
    const message = 'é'.repeat(248) + "'SOS";
    assert.equal(Buffer.byteLength(message, 'utf8'), 500);
    const bytes = buildSignedEnvelope({message});
    const receipts = await Promise.all([service.ingestEnvelope(bytes), service.ingestEnvelope(bytes)]);
    assert.deepEqual(receipts[0], receipts[1]);
    assert.equal((await pool.query('SELECT message FROM incident_revisions')).rows[0]?.message, message);
    for (const table of ['incidents', 'incident_revisions', 'accepted_messages', 'server_receipts']) {
      assert.equal(Number((await pool.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0]?.count), 1);
    }
    assert.deepEqual((await pool.query('SELECT envelope_bytes FROM accepted_messages')).rows[0]?.envelope_bytes, bytes);
  });
});

test('ingestion owns verified envelope bytes before asynchronous persistence', async () => {
  await withService(async (service, pool) => {
    const bytes = buildSignedEnvelope();
    const original = Buffer.from(bytes);
    const pending = service.ingestEnvelope(bytes);
    bytes.fill(0);
    const receipt = await pending;

    assert.deepEqual(
      (await pool.query('SELECT envelope_bytes FROM accepted_messages')).rows[0]?.envelope_bytes,
      original,
    );
    assert.deepEqual(await service.ingestEnvelope(original), receipt);
  });
});

test('ingestion snapshots acceptance time before asynchronous persistence', async () => {
  await withService(async (service) => {
    const acceptedAt = new Date('2026-09-05T04:00:00.000Z');
    const pending = service.ingestEnvelope(buildSignedEnvelope(), acceptedAt);
    acceptedAt.setTime(0);
    assert.equal((await pending).acceptedAt, '2026-09-05T04:00:00.000Z');
  });
});

test('501-byte message rejects before persistence', async () => {
  await withService(async (service, pool) => {
    await assert.rejects(service.ingestEnvelope(buildSignedEnvelope({message: 'é'.repeat(250) + 'a'})));
    assert.equal(Number((await pool.query('SELECT COUNT(*) AS count FROM incidents')).rows[0]?.count), 0);
  });
});

test('changed message for same revision conflicts and retains canonical content', async () => {
  await withService(async (service, pool) => {
    const identity = createTestIdentity();
    const bytes = buildSignedEnvelope({identity, message: 'original'});
    const receipt = await service.ingestEnvelope(bytes);
    for (const messageId of [undefined, '33333333-3333-3333-3333-333333333333']) {
      await assert.rejects(service.ingestEnvelope(buildSignedEnvelope({
        identity, ...(messageId === undefined ? {} : {messageId}), message: 'changed',
      })),
        (error: unknown) => error instanceof IngestionConflictError);
    }
    assert.equal((await pool.query('SELECT message FROM incident_revisions')).rows[0]?.message, 'original');
    assert.deepEqual(await service.ingestEnvelope(bytes), receipt);
  });
});

test('reverse revision arrival retains one incident and original report creation time', async () => {
  await withService(async (service, pool) => {
    const identity = createTestIdentity();
    const createdAtMs = 1234n;
    const latest = buildSignedEnvelope({identity, createdAtMs, revision: 2, message: 'details', messageId: '33333333-3333-3333-3333-333333333333'});
    const original = buildSignedEnvelope({identity, createdAtMs});
    const receipt = await service.ingestEnvelope(latest, new Date('2026-09-05T04:00:00Z'));
    await service.ingestEnvelope(original, new Date('2026-09-05T05:00:00Z'));
    const incidents = await pool.query('SELECT created_at_ms, first_received_at FROM incidents');
    assert.equal(incidents.rowCount, 1);
    assert.equal(BigInt(incidents.rows[0]?.created_at_ms), createdAtMs);
    assert.equal(new Date(incidents.rows[0]?.first_received_at).toISOString(), '2026-09-05T04:00:00.000Z');
    assert.deepEqual((await pool.query('SELECT revision, message FROM incident_revisions ORDER BY revision')).rows,
      [{revision: 1, message: null}, {revision: 2, message: 'details'}]);
    assert.deepEqual(await service.ingestEnvelope(latest), receipt);
    assert.equal((await pool.query('SELECT * FROM server_receipts')).rowCount, 2);
  });
});

async function withService(
  run: (service: IngestionService, pool: ReturnType<typeof createMemoryPostgresPool>) => Promise<void>,
): Promise<void> {
  const pool = createMemoryPostgresPool();
  try {
    await applyMigrations(pool, MIGRATIONS_DIR);
    await run(new IngestionService(pool), pool);
  } finally {
    await pool.end();
  }
}

test('first acceptance creates one incident revision message and canonical receipt', async () => {
  await withService(async (service, pool) => {
    const bytes = buildSignedEnvelope();
    const receipt = await service.ingestEnvelope(bytes, new Date('2026-09-05T04:00:00.000Z'));

    assert.equal(receipt.receiptVersion, 1);
    assert.equal(receipt.state, 'SERVER_ACCEPTED');
    assert.equal(receipt.messageId, '11111111-1111-1111-1111-111111111111');
    assert.equal(receipt.reportId, '22222222-2222-2222-2222-222222222222');
    assert.equal(receipt.revision, 1);
    assert.equal(receipt.acceptedAt, '2026-09-05T04:00:00.000Z');
    assert.match(receipt.receiptId, /^[0-9a-f-]{36}$/i);

    for (const table of ['incidents', 'incident_revisions', 'accepted_messages', 'server_receipts']) {
      const count = await pool.query<{count: string}>(`SELECT COUNT(*) AS count FROM ${table}`);
      assert.equal(Number(count.rows[0]?.count), 1, table);
    }
  });
});

test('exact retry after a lost response returns the identical stored receipt', async () => {
  await withService(async (service, pool) => {
    const bytes = buildSignedEnvelope();
    const first = await service.ingestEnvelope(bytes, new Date('2026-09-05T04:00:00.000Z'));
    const retry = await service.ingestEnvelope(bytes, new Date('2026-09-05T05:00:00.000Z'));

    assert.deepEqual(retry, first);
    const count = await pool.query<{count: string}>('SELECT COUNT(*) AS count FROM accepted_messages');
    assert.equal(Number(count.rows[0]?.count), 1);
  });
});

test('same message ID with different immutable envelope bytes is a conflict', async () => {
  await withService(async service => {
    const identity = createTestIdentity();
    await service.ingestEnvelope(
      buildSignedEnvelope({identity, priority: 0}),
      new Date('2026-09-05T04:00:00.000Z'),
    );

    await assert.rejects(
      service.ingestEnvelope(
        buildSignedEnvelope({identity, priority: 10}),
        new Date('2026-09-05T04:01:00.000Z'),
      ),
      (error: unknown) => error instanceof IngestionConflictError,
    );
  });
});

test('same report revision with another message ID is a conflict', async () => {
  await withService(async service => {
    const identity = createTestIdentity();
    await service.ingestEnvelope(
      buildSignedEnvelope({identity}),
      new Date('2026-09-05T04:00:00.000Z'),
    );

    await assert.rejects(
      service.ingestEnvelope(
        buildSignedEnvelope({
          identity,
          messageId: '33333333-3333-3333-3333-333333333333',
        }),
        new Date('2026-09-05T04:01:00.000Z'),
      ),
      (error: unknown) => error instanceof IngestionConflictError,
    );
  });
});

test('database connection failures are classified as transient', async () => {
  const pool = {
    connect: async () => {
      const error = new Error('database unavailable') as Error & {code: string};
      error.code = 'ECONNREFUSED';
      throw error;
    },
  } as unknown as Pick<Pool, 'connect'>;
  const service = new IngestionService(pool);

  await assert.rejects(
    service.ingestEnvelope(buildSignedEnvelope()),
    (error: unknown) => error instanceof IngestionTransientError,
  );
});

test('same report ID under another origin key is a conflict', async () => {
  await withService(async service => {
    await service.ingestEnvelope(
      buildSignedEnvelope({identity: createTestIdentity()}),
      new Date('2026-09-05T04:00:00.000Z'),
    );

    await assert.rejects(
      service.ingestEnvelope(
        buildSignedEnvelope({
          identity: createTestIdentity(),
          messageId: '44444444-4444-4444-4444-444444444444',
          revision: 2,
        }),
        new Date('2026-09-05T04:01:00.000Z'),
      ),
      (error: unknown) => error instanceof IngestionConflictError,
    );
  });
});
