import assert from 'node:assert/strict';
import {type AddressInfo} from 'node:net';
import test from 'node:test';

import {createSagipServer} from '../../src/http/createServer.js';
import {SlidingWindowRateLimiter} from '../../src/http/rateLimiter.js';
import {MAX_ENVELOPE_BYTES} from '../../src/protocol/envelopeV1.js';
import {decodeEmergencyPayloadV1} from '../../src/protocol/emergencyPayloadV1.js';

test('SlidingWindowRateLimiter enforces window limit and recovers after window expiry', () => {
  const limiter = new SlidingWindowRateLimiter({
    windowMs: 1000,
    maxRequests: 3,
  });

  const ip = '192.168.1.50';
  const t0 = 100_000;

  // First 3 allowed
  assert.equal(limiter.isAllowed(ip, t0), true);
  assert.equal(limiter.isAllowed(ip, t0 + 100), true);
  assert.equal(limiter.isAllowed(ip, t0 + 200), true);

  // 4th rejected within the window
  assert.equal(limiter.isAllowed(ip, t0 + 300), false);

  // After window expires (1001ms later), allowed again
  assert.equal(limiter.isAllowed(ip, t0 + 1001), true);
});

test('HTTP boundary enforces 429 Too Many Requests when rate limit exceeded', async () => {
  const limiter = new SlidingWindowRateLimiter({
    windowMs: 60_000,
    maxRequests: 2,
  });

  const server = createSagipServer({
    ingestEnvelope: async () => ({
      receiptVersion: 1,
      state: 'SERVER_ACCEPTED',
      receiptId: '00000000-0000-0000-0000-000000000001',
      messageId: '00000000-0000-0000-0000-000000000002',
      reportId: '00000000-0000-0000-0000-000000000003',
      revision: 1,
      acceptedAt: '2026-09-20T12:00:00.000Z',
    }),
    responderService: {
      getReportStatus: async (reportId: string) => ({
        reportId,
        isAccepted: true,
        acceptedAt: '2026-09-20T12:00:00.000Z',
        responderAck: null,
      }),
    } as never,
    rateLimiter: limiter,
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1st request -> 200 / valid
    const r1 = await fetch(`${baseUrl}/v1/reports/00000000-0000-0000-0000-000000000003/status`);
    assert.equal(r1.status, 200);

    // 2nd request -> 200
    const r2 = await fetch(`${baseUrl}/v1/reports/00000000-0000-0000-0000-000000000003/status`);
    assert.equal(r2.status, 200);

    // 3rd request -> 429 Too Many Requests
    const r3 = await fetch(`${baseUrl}/v1/reports/00000000-0000-0000-0000-000000000003/status`);
    assert.equal(r3.status, 429);
    assert.equal(r3.headers.get('retry-after'), '60');
    const body = (await r3.json()) as {error: string};
    assert.equal(body.error, 'TOO_MANY_REQUESTS');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('HTTP boundary rejects envelopes larger than MAX_ENVELOPE_BYTES (8192 bytes)', async () => {
  const server = createSagipServer({
    ingestEnvelope: async () => {
      throw new Error('Should not reach ingest');
    },
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const oversized = Buffer.alloc(MAX_ENVELOPE_BYTES + 10, 0xaa);
    const res = await fetch(`${baseUrl}/v1/envelopes`, {
      method: 'POST',
      headers: {'content-type': 'application/octet-stream'},
      body: oversized,
    });
    assert.equal(res.status, 413);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test('Payload codec strictly rejects out-of-range latitude and longitude bounds', () => {
  // Construct SRP1 payload with out-of-range latitude (> 90.0 degrees = 90_000_000 E6)
  const invalidLatPayload = Buffer.alloc(30);
  invalidLatPayload.write('SRP1', 0, 'ascii');
  invalidLatPayload.writeUInt8(1, 4); // version
  invalidLatPayload.writeUInt8(1, 5); // emergencyType
  invalidLatPayload.writeUInt8(1, 6); // urgency
  invalidLatPayload.writeUInt8(1, 7); // locationPresent = 1
  invalidLatPayload.writeInt32BE(91_000_000, 8); // Invalid lat: 91 degrees
  invalidLatPayload.writeInt32BE(120_000_000, 12); // Valid lon
  invalidLatPayload.writeInt32BE(500, 16); // accuracyCm
  invalidLatPayload.writeBigInt64BE(1_000_000n, 20); // capturedAtMs
  invalidLatPayload.writeUInt8(1, 28); // source
  invalidLatPayload.writeUInt8(1, 29); // freshness

  assert.throws(() => decodeEmergencyPayloadV1(invalidLatPayload), /Latitude is out of range/);

  // Construct SRP1 payload with out-of-range longitude (> 180.0 degrees = 180_000_000 E6)
  const invalidLonPayload = Buffer.alloc(30);
  invalidLonPayload.write('SRP1', 0, 'ascii');
  invalidLonPayload.writeUInt8(1, 4);
  invalidLonPayload.writeUInt8(1, 5);
  invalidLonPayload.writeUInt8(1, 6);
  invalidLonPayload.writeUInt8(1, 7);
  invalidLonPayload.writeInt32BE(14_000_000, 8); // Valid lat
  invalidLonPayload.writeInt32BE(185_000_000, 12); // Invalid lon: 185 degrees
  invalidLonPayload.writeInt32BE(500, 16);
  invalidLonPayload.writeBigInt64BE(1_000_000n, 20);
  invalidLonPayload.writeUInt8(1, 28);
  invalidLonPayload.writeUInt8(1, 29);

  assert.throws(() => decodeEmergencyPayloadV1(invalidLonPayload), /Longitude is out of range/);
});

