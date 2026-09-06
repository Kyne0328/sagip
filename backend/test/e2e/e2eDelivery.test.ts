import assert from 'node:assert/strict';
import type {AddressInfo} from 'node:net';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {applyMigrations} from '../../src/db/migrate.js';
import {createMemoryPostgresPool} from '../../src/db/memoryPool.js';
import {createSagipServer} from '../../src/http/createServer.js';
import {IngestionService, type ServerReceipt} from '../../src/ingestion/service.js';
import {buildSignedEnvelope, createTestIdentity} from '../support/envelopeFactory.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

interface RunningTestHarness {
  baseUrl: string;
  query(text: string, values?: readonly unknown[]): Promise<unknown[]>;
}

async function withHarness(run: (harness: RunningTestHarness) => Promise<void>): Promise<void> {
  const pool = createMemoryPostgresPool();
  try {
    await applyMigrations(pool, MIGRATIONS_DIR);
    const ingestion = new IngestionService(pool);
    const server = createSagipServer({
      ingestEnvelope: bytes => ingestion.ingestEnvelope(bytes),
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await run({
        baseUrl,
        query: async (text, values) => {
          const result = values !== undefined ? await pool.query(text, [...values]) : await pool.query(text);
          return result.rows;
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      });
    }
  } finally {
    await pool.end();
  }
}

async function postEnvelope(baseUrl: string, bytes: Buffer): Promise<{status: number; data: unknown}> {
  const response = await fetch(`${baseUrl}/v1/envelopes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
    },
    body: bytes,
  });
  const data = await response.json();
  return {status: response.status, data};
}

test('E2E: Android-format SGP1 envelope submission, receipt verification, and database persistence', async () => {
  await withHarness(async ({baseUrl, query}) => {
    const identityA = createTestIdentity();
    const envelopeBytesA = buildSignedEnvelope({
      identity: identityA,
      emergencyType: 1,
      urgency: 1,
    });

    // 1. Initial successful delivery
    const resA = await postEnvelope(baseUrl, envelopeBytesA);
    assert.equal(resA.status, 200);
    const receiptA = resA.data as ServerReceipt;
    assert.equal(receiptA.receiptVersion, 1);
    assert.equal(receiptA.state, 'SERVER_ACCEPTED');
    assert.equal(receiptA.receiptId.length, 36);
    assert.ok(receiptA.messageId.length > 0);
    assert.ok(receiptA.reportId.length > 0);
    assert.equal(receiptA.revision, 1);
    assert.ok(!Number.isNaN(Date.parse(receiptA.acceptedAt)));

    // 2. Second delivery from another device / emergency
    const identityB = createTestIdentity();
    const envelopeBytesB = buildSignedEnvelope({
      identity: identityB,
      messageId: '33333333-3333-3333-3333-333333333333',
      reportId: '44444444-4444-4444-4444-444444444444',
      emergencyType: 2,
      urgency: 2,
    });

    const resB = await postEnvelope(baseUrl, envelopeBytesB);
    assert.equal(resB.status, 200);
    const receiptB = resB.data as ServerReceipt;
    assert.equal(receiptB.state, 'SERVER_ACCEPTED');
    assert.notEqual(receiptB.receiptId, receiptA.receiptId);
    assert.notEqual(receiptB.reportId, receiptA.reportId);

    // 3. Exact replay of envelope A (simulating client retry or mesh duplicate) returns identical receipt
    const replayA = await postEnvelope(baseUrl, envelopeBytesA);
    assert.equal(replayA.status, 200);
    const receiptReplayA = replayA.data as ServerReceipt;
    assert.deepEqual(receiptReplayA, receiptA);

    // 4. Verify persisted database state
    const envelopesInDb = await query('SELECT message_id, report_id, revision FROM accepted_messages ORDER BY revision');
    assert.equal(envelopesInDb.length, 2);

    const receiptsInDb = await query('SELECT receipt_id, message_id FROM server_receipts');
    assert.equal(receiptsInDb.length, 2);

    const incidentsInDb = await query('SELECT report_id FROM incidents');
    assert.equal(incidentsInDb.length, 2);

    // 5. Conflict test: same report revision with modified content triggers INGESTION_CONFLICT (409)
    const conflictBytes = buildSignedEnvelope({
      identity: identityA,
      priority: 10,
    });
    const conflictRes = await postEnvelope(baseUrl, conflictBytes);
    assert.equal(conflictRes.status, 409);
  });
});
