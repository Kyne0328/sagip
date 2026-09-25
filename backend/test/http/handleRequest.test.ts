import assert from 'node:assert/strict';
import test from 'node:test';

import {handleSagipRequest} from '../../src/http/handleRequest.js';
import {IngestionTransientError} from '../../src/ingestion/service.js';
import {SlidingWindowRateLimiter} from '../../src/http/rateLimiter.js';
import {MAX_ENVELOPE_BYTES} from '../../src/protocol/envelopeV1.js';

test('fetch handler preserves HTTP error mapping without a Node server', async () => {
  const response = await handleSagipRequest(
    new Request('https://sagip.example/v1/envelopes', {
      method: 'POST',
      headers: {'content-type': 'application/octet-stream'},
      body: Buffer.from([1]),
    }),
    {
      ingestEnvelope: async () => {
        throw new IngestionTransientError('database password=super-secret');
      },
    },
    {clientIp: '203.0.113.10'},
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {error: 'SERVICE_UNAVAILABLE'});
});

test('fetch handler enforces the 8192-byte envelope boundary', async () => {
  const response = await handleSagipRequest(
    new Request('https://sagip.example/v1/envelopes', {
      method: 'POST',
      headers: {'content-type': 'application/octet-stream'},
      body: Buffer.alloc(MAX_ENVELOPE_BYTES + 1),
    }),
    {
      ingestEnvelope: async () => {
        throw new Error('Should not reach ingest');
      },
    },
    {clientIp: '203.0.113.11'},
  );

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {error: 'PAYLOAD_TOO_LARGE'});
});

test('fetch handler rate limits by supplied client IP', async () => {
  const rateLimiter = new SlidingWindowRateLimiter({maxRequests: 1, windowMs: 60_000});
  const deps = {
    ingestEnvelope: async () => ({
      receiptVersion: 1 as const,
      state: 'SERVER_ACCEPTED' as const,
      receiptId: '00000000-0000-0000-0000-000000000001',
      reportId: '00000000-0000-0000-0000-000000000002',
      revision: 1,
      messageId: '00000000-0000-0000-0000-000000000003',
      acceptedAt: new Date(0).toISOString(),
      envelopeDigestSha256: '00'.repeat(32),
    }),
    rateLimiter,
  };

  const makeRequest = () =>
    new Request('https://sagip.example/v1/envelopes', {
      method: 'POST',
      headers: {'content-type': 'application/octet-stream'},
      body: Buffer.from([1]),
    });

  assert.equal(
    (await handleSagipRequest(makeRequest(), deps, {clientIp: '203.0.113.12'})).status,
    200,
  );
  const limited = await handleSagipRequest(makeRequest(), deps, {clientIp: '203.0.113.12'});
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});
