import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {Socket} from 'node:dgram';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {
  createRoughtimeRequest, createUdpRoughtimeTransport, encodeRoughtimeMessage, verifyRoughtimeReply,
  ROUGHTIME_VERSION, RoughtimeClock, type RoughtimeClockPolicy,
} from '../../src/responder/roughtimeClock.js';

const root = generateKeyPairSync('ed25519'), online = generateKeyPairSync('ed25519');
const raw = (key: typeof root.publicKey) => key.export({type: 'spki', format: 'der'}).subarray(-32);
const pin = raw(root.publicKey), nonce = Buffer.alloc(32, 42);
const seconds = 1800000000n;
const u32 = (n: number) => {const b = Buffer.alloc(4); b.writeUInt32LE(n); return b;};
const u64 = (n: bigint) => {const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b;};
const encode = (fields: Record<string, Uint8Array>) => encodeRoughtimeMessage(new Map(Object.entries(fields)));
const leaf = (n: Uint8Array) => createHash('sha512').update(Buffer.concat([Buffer.from([0]), n])).digest().subarray(0, 32);
function response(n: Uint8Array = nonce, time = seconds, overrides: Record<string, Uint8Array> = {},
  radius = 3, delegationEnd = seconds + 10000n) {
  const delegation = encode({PUBK: raw(online.publicKey), MINT: u64(seconds - 10000n), MAXT: u64(delegationEnd)});
  const certificate = encode({DELE: delegation,
    'SIG\0': sign(null, Buffer.concat([Buffer.from('RoughTime v1 delegation signature--\0'), delegation]), root.privateKey)});
  const srep = encode({MIDP: u64(time), RADI: u32(radius), ROOT: leaf(n)});
  const body = encode({CERT: certificate, SREP: srep, 'VER\0': u32(ROUGHTIME_VERSION),
    'SIG\0': sign(null, Buffer.concat([Buffer.from('RoughTime v1 response signature\0'), srep]), online.privateKey),
    NONC: n, INDX: u32(0), PATH: Buffer.alloc(0), ...overrides});
  return Buffer.concat([Buffer.from('ROUGHTIM'), u32(body.length), body]);
}
const verify = (b: Uint8Array, n = nonce) => verifyRoughtimeReply(b, n, pin, 100, 2000, 5000);
test('signed nonce-bound seconds profile produces bounded interval including full RTT', () => {
  const result = verify(response());
  assert.equal(result.earliestMs, Number(seconds - 4n) * 1000);
  assert.equal(result.latestMs, Number(seconds + 5n) * 1000 + 100);
  assert.match(result.proofDigest, /^[a-f0-9]{64}$/u);
});
test('request is padded and declares only explicit IETF draft11', () => {
  const request = createRoughtimeRequest(nonce, pin);
  assert.equal(request.length, 1024);
  assert.equal(request.subarray(0, 8).toString(), 'ROUGHTIM');
  assert.equal(request.readUInt32LE(8), 1012);
  assert.ok(request.includes(nonce));
  assert.ok(request.includes(u32(ROUGHTIME_VERSION)));
});
test('wrong nonce, unpinned root and altered signature fail closed', () => {
  assert.throws(() => verify(response(), Buffer.alloc(32)), /NONCE_VERSION/u);
  assert.throws(() => verifyRoughtimeReply(response(), nonce, Buffer.alloc(32), 100, 2000, 2000));
  const forged = response(); forged[forged.length - 1] = forged[forged.length - 1]! ^ 1;
  assert.throws(() => verify(forged));
});
test('downgrade, legacy frame and time units cannot be silently accepted', () => {
  assert.throws(() => verify(response(nonce, seconds, {'VER\0': u32(0x80000008)})), /NONCE_VERSION/u);
  assert.throws(() => verify(response().subarray(12)), /FRAME/u);
  assert.throws(() => verify(response(nonce, seconds * 1000000n)), /RANGE/u);
});
test('radius, delegation interval, Merkle path and index bounds are enforced', () => {
  assert.throws(() => verify(response(nonce, seconds, {}, 6)), /RANGE/u);
  assert.throws(() => verify(response(nonce, seconds, {}, 2)), /RANGE/u);
  assert.throws(() => verify(response(nonce, seconds, {}, 1, seconds + 1n)), /RANGE/u);
  assert.throws(() => verify(response(nonce, seconds, {PATH: Buffer.alloc(4)})), /PATH/u);
  assert.throws(() => verify(response(nonce, seconds, {INDX: u32(1)})), /MERKLE/u);
});
test('trailing bytes, excessive lengths and unsorted duplicate tags reject', () => {
  assert.throws(() => verify(Buffer.concat([response(), Buffer.alloc(4)])), /FRAME/u);
  assert.throws(() => verify(Buffer.alloc(9000)), /FRAME/u);
  const b = response(); b.writeUInt32LE(0xffffffff, 12);
  assert.throws(() => verify(b), /COUNT/u);
});
test('RTT accepts no negative, unbounded or noninteger timing', () => {
  for (const rtt of [-1, 0.5, 2001, NaN]) {
    assert.throws(() => verifyRoughtimeReply(response(), nonce, pin, rtt, 2000, 2000), /RTT/u);
  }
});
const policy: RoughtimeClockPolicy = {
  profile: 'IETF_DRAFT11', sourceId: 'synthetic-qualified-time', host: 'time.invalid', port: 2003, rootPublicKey: pin,
  maxRoundTripMs: 2000, maxRadiusMs: 5000, maxSampleAgeMs: 30000,
  maxUncertaintyMs: 5000, monotonicDriftPpm: 1000, deviceCheckpointValidityMs: 86400000,
};
function requestNonce(request: Uint8Array): Buffer {
  const b = Buffer.from(request).subarray(12), count = b.readUInt32LE();
  for (let i = 0; i < count; i++) {
    if (b.subarray(count * 4 + i * 4, count * 4 + i * 4 + 4).toString() === 'NONC') {
      const start = i === 0 ? 0 : b.readUInt32LE(i * 4);
      return b.subarray(count * 8 + start, count * 8 + start + 32);
    }
  }
  throw new Error('NO_NONCE');
}
test('clock requires actual signed sample, widens for drift and expires without wall time fallback', async () => {
  let elapsed = 1000;
  const clock = new RoughtimeClock(policy, async request => {
    elapsed += 100; return response(requestNonce(request));
  }, () => elapsed);
  assert.equal(clock.isQualified(), false);
  await clock.refresh();
  const initial = clock.time();
  assert.equal(clock.isQualified(), true);
  assert.equal(initial.validForMs + initial.uncertaintyMs, 86400000);
  elapsed += 10000;
  const advanced = clock.time();
  assert.ok(advanced.timeMs > initial.timeMs);
  assert.ok(advanced.uncertaintyMs > initial.uncertaintyMs);
  elapsed += 20000;
  assert.equal(clock.isQualified(), false);
  assert.throws(() => clock.time(), /SAMPLE_EXPIRED/u);
});
test('monotonic rollback and process restart cannot reuse prior qualification', async () => {
  let elapsed = 1000;
  const transport = async (request: Uint8Array) => response(requestNonce(request));
  const clock = new RoughtimeClock(policy, transport, () => elapsed);
  await clock.refresh();
  elapsed = 1;
  assert.equal(clock.isQualified(), false);
  const restarted = new RoughtimeClock(policy, transport, () => 10);
  assert.equal(restarted.isQualified(), false);
});
test('slow response and provider failure leave fresh instance unqualified', async () => {
  let elapsed = 0;
  const clock = new RoughtimeClock(policy, async request => {
    elapsed = 2001; return response(requestNonce(request));
  }, () => elapsed);
  await assert.rejects(clock.refresh(), /RTT/u);
  assert.equal(clock.isQualified(), false);
  const failed = new RoughtimeClock(policy, async () => {throw new Error('OFFLINE');}, () => 0);
  await assert.rejects(failed.refresh(), /OFFLINE/u);
  assert.equal(failed.isQualified(), false);
});
test('concurrent refreshes share one nonce request and successful time cannot roll back', async () => {
  let calls = 0, current = seconds;
  const clock = new RoughtimeClock(policy, async request => {
    calls++; await Promise.resolve(); return response(requestNonce(request), current);
  }, () => 1000);
  await Promise.all([clock.refresh(), clock.refresh()]);
  assert.equal(calls, 1);
  current = seconds - 1n;
  await assert.rejects(clock.refresh(), /TIME_ROLLBACK/u);
});
test('UDP DNS failure and timeout-before-bind remain controlled failures', async () => {
  class UnboundSocket extends EventEmitter {
    callback?: () => void;
    sends = 0;
    closes = 0;
    close() { this.closes++; throw new Error('NOT_RUNNING'); }
    connect(_port: number, _host: string, callback: () => void) { this.callback = callback; }
    send() { this.sends++; }
  }
  const dns = new UnboundSocket();
  const dnsRequest = createUdpRoughtimeTransport(() => dns as unknown as Socket)(Buffer.alloc(0), policy);
  dns.emit('error', new Error('DNS_FAILURE'));
  await assert.rejects(dnsRequest, /DNS_FAILURE/u);
  dns.callback?.();
  assert.equal(dns.sends, 0);
  assert.equal(dns.closes, 2);
  const timeout = new UnboundSocket();
  await assert.rejects(createUdpRoughtimeTransport(() => timeout as unknown as Socket)(
    Buffer.alloc(0), {...policy, maxRoundTripMs: 1}), /TIMEOUT/u);
  timeout.callback?.();
  assert.equal(timeout.sends, 0);
  assert.equal(timeout.closes, 2);
});

test('unsafe policy cannot assert a zero drift or unlimited sample age', () => {
  assert.throws(() => new RoughtimeClock({...policy, monotonicDriftPpm: 0}), /POLICY/u);
  assert.throws(() => new RoughtimeClock({...policy, maxSampleAgeMs: 86400000}), /POLICY/u);
});
