import assert from 'node:assert/strict';
import type {AddressInfo} from 'node:net';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {applyMigrations} from '../../src/db/migrate.js';
import {createSagipServer} from '../../src/http/createServer.js';
import {
  IngestionService,
  IngestionTransientError,
} from '../../src/ingestion/service.js';
import {buildSignedEnvelope, createTestIdentity} from '../support/envelopeFactory.js';
import {createMemoryPostgresPool} from '../support/postgres.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

async function withRealIngestionServer(
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const pool = createMemoryPostgresPool();
  try {
    await applyMigrations(pool, MIGRATIONS_DIR);
    const service = new IngestionService(pool);
    await withServer(createSagipServer({ingestEnvelope: bytes => service.ingestEnvelope(bytes)}), run);
  } finally {
    await pool.end();
  }
}

async function withServer(
  server: ReturnType<typeof createSagipServer>,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error === undefined ? resolve() : reject(error)));
    });
  }
}

async function postEnvelope(
  baseUrl: string,
  body: Buffer,
  contentType = 'application/octet-stream',
): Promise<Response> {
  return fetch(`${baseUrl}/v1/envelopes`, {
    method: 'POST',
    headers: {'content-type': contentType},
    body,
  });
}

test('POST /v1/envelopes accepts first delivery and returns the same receipt on duplicate', async () => {
  await withRealIngestionServer(async baseUrl => {
    const identity = createTestIdentity();
    const bytes = buildSignedEnvelope({identity});

    const first = await postEnvelope(baseUrl, bytes);
    const retry = await postEnvelope(baseUrl, bytes);

    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    const firstReceipt = await first.json();
    const retryReceipt = await retry.json();
    assert.deepEqual(retryReceipt, firstReceipt);
    assert.equal((firstReceipt as {state?: unknown}).state, 'SERVER_ACCEPTED');
  });
});

test('HTTP boundary maps protocol, identity, media type, size, route, and method failures', async () => {
  await withRealIngestionServer(async baseUrl => {
    const identity = createTestIdentity();
    const first = buildSignedEnvelope({identity, priority: 0});
    assert.equal((await postEnvelope(baseUrl, first)).status, 200);

    assert.equal((await postEnvelope(baseUrl, Buffer.from('bad'))).status, 400);
    assert.equal(
      (await postEnvelope(baseUrl, first, 'application/json')).status,
      415,
    );
    assert.equal((await postEnvelope(baseUrl, Buffer.alloc(8193))).status, 413);
    assert.equal((await fetch(`${baseUrl}/missing`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/v1/envelopes`)).status, 405);

    const conflict = buildSignedEnvelope({identity, priority: 10});
    assert.equal((await postEnvelope(baseUrl, conflict)).status, 409);
  });
});

test('HTTP boundary maps transient database failure to 503 without leaking internals', async () => {
  await withServer(
    createSagipServer({
      ingestEnvelope: async () => {
        throw new IngestionTransientError('database password=super-secret');
      },
    }),
    async baseUrl => {
      const response = await postEnvelope(baseUrl, buildSignedEnvelope());
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {error: 'SERVICE_UNAVAILABLE'});
    },
  );
});

test('HTTP boundary maps unknown failure to safe 500 response', async () => {
  await withServer(
    createSagipServer({
      ingestEnvelope: async () => {
        throw new Error('SECRET_STACK_PAYLOAD_MARKER');
      },
    }),
    async baseUrl => {
      const response = await postEnvelope(baseUrl, buildSignedEnvelope());
      assert.equal(response.status, 500);
      const text = await response.text();
      assert.equal(text.includes('SECRET_STACK_PAYLOAD_MARKER'), false);
      assert.deepEqual(JSON.parse(text), {error: 'INTERNAL_ERROR'});
    },
  );
});
