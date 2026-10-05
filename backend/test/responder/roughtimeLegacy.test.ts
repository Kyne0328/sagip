import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {createRoughtimeRequest, encodeRoughtimeMessage, verifyRoughtimeReply, RoughtimeClock,
  type RoughtimeClockPolicy} from '../../src/responder/roughtimeClock.js';
const root = generateKeyPairSync('ed25519'), online = generateKeyPairSync('ed25519');
const raw = (key: typeof root.publicKey) => key.export({type: 'spki', format: 'der'}).subarray(-32);
const pin = raw(root.publicKey), nonce = Buffer.alloc(64, 23), micro = 1800000000123456n;
const u32 = (n: number) => {const b = Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const u64 = (n: bigint) => {const b = Buffer.alloc(8);b.writeBigUInt64LE(n);return b;};
const encode = (fields: Record<string, Uint8Array>) => encodeRoughtimeMessage(new Map(Object.entries(fields)));
function response(n: Uint8Array = nonce, overrides: Record<string, Uint8Array> = {}, radius = 1000000) {
  const d = encode({PUBK: raw(online.publicKey), MINT: u64(micro - 10000000n), MAXT: u64(micro + 10000000n)});
  const cert = encode({DELE: d, 'SIG\0': sign(null,
    Buffer.concat([Buffer.from('RoughTime v1 delegation signature--\0'), d]), root.privateKey)});
  const srep = encode({MIDP: u64(micro), RADI: u32(radius),
    ROOT: createHash('sha512').update(Buffer.concat([Buffer.from([0]), n])).digest()});
  return encode({CERT: cert, SREP: srep, INDX: u32(0), PATH: Buffer.alloc(0),
    'SIG\0': sign(null, Buffer.concat([Buffer.from('RoughTime v1 response signature\0'), srep]), online.privateKey), ...overrides});
}
const verify = (b: Uint8Array, n: Uint8Array = nonce) => verifyRoughtimeReply(b, n, pin, 101, 2000, 3000, 'GOOGLE_LEGACY');
test('explicit legacy packet is unframed1024 bytes with64nonce and PADff', () => {
  const request = createRoughtimeRequest(nonce, pin, 'GOOGLE_LEGACY');
  assert.equal(request.length, 1024); assert.equal(request.readUInt32LE(), 2);
  assert.equal(request.readUInt32LE(4), 64);
  assert.equal(request.readUInt32LE(12), 0xff444150);
  assert.deepEqual(request.subarray(16, 80), nonce);
});
test('full signed SHA512 nonce inclusion and microsecond outward rounding verify', () => {
  const t = verify(response());
  assert.equal(t.earliestMs, Number((micro - 1000001n) / 1000n));
  assert.equal(t.latestMs, Number((micro + 1000002n + 999n) / 1000n) + 101);
});
test('profiles never silently downgrade or confuse nonce widths', () => {
  assert.throws(() => verifyRoughtimeReply(response(), nonce, pin, 1, 2000, 3000));
  assert.throws(() => createRoughtimeRequest(nonce, pin));
  assert.throws(() => createRoughtimeRequest(Buffer.alloc(32), pin, 'GOOGLE_LEGACY'));
  assert.throws(() => verify(response(nonce, {'VER\0': u32(0x8000000b)})), /NONCE_VERSION/u);
  assert.throws(() => verify(Buffer.concat([Buffer.from('ROUGHTIM'),u32(response().length),response()])), /FRAME/u);
});
test('missing optional echo cannot bypass actual nonce Merkle inclusion', () => {
  assert.throws(() => verify(response(), Buffer.alloc(64, 24)), /MERKLE/u);
  assert.throws(() => verify(response(nonce, {NONC: Buffer.alloc(64, 24)})), /NONCE_VERSION/u);
  assert.deepEqual(verify(response(nonce, {NONC: nonce})).earliestMs, verify(response()).earliestMs);
});
test('legacy rejects forged signature wrong pin truncated root path and too-wide radius', () => {
  const forged = response(); forged[forged.length-1] = forged[forged.length-1]! ^ 1;
  assert.throws(() => verify(forged));
  assert.throws(() => verifyRoughtimeReply(response(), nonce, Buffer.alloc(32), 1, 2000, 3000, 'GOOGLE_LEGACY'));
  assert.throws(() => verify(response(nonce, {PATH: Buffer.alloc(32)})), /PATH/u);
  assert.throws(() => verify(response(nonce, {}, 3000001)), /RANGE/u);
  assert.throws(() => verifyRoughtimeReply(response(), nonce, pin, 2001, 2000, 3000, 'GOOGLE_LEGACY'), /RTT/u);
});
test('explicit legacy clock uses64nonce with signed sample and still expires', async () => {
  let elapsed = 100;
  const p: RoughtimeClockPolicy = {profile:'GOOGLE_LEGACY',sourceId:'EXPERIMENTAL_DEMO',
    host:'time.invalid',port:2003,rootPublicKey:pin,maxRoundTripMs:2000,maxRadiusMs:3000,
    maxSampleAgeMs:30000,maxUncertaintyMs:5000,monotonicDriftPpm:1000,deviceCheckpointValidityMs:86400000};
  const c = new RoughtimeClock(p, async bytes => { elapsed += 100;
    assert.equal(bytes.length, 1024); return response(Buffer.from(bytes).subarray(16,80)); }, () => elapsed);
  assert.equal(c.isQualified(),false); await c.refresh(); assert.equal(c.isQualified(),true);
  assert.equal(c.time().validForMs+c.time().uncertaintyMs,86400000);
  elapsed += 30000; assert.equal(c.isQualified(),false);
});
