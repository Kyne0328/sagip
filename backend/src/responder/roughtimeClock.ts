import {createHash, createPublicKey, randomBytes, verify} from 'node:crypto';
import {createSocket, type Socket} from 'node:dgram';
import type {QualifiedAuthorityTime} from './grantProvisioning.js';

// Experimental demo profiles are explicitly selected. There is never automatic downgrade.
export type RoughtimeProfile = 'IETF_DRAFT11' | 'GOOGLE_LEGACY';
// Protocol reference: https://datatracker.ietf.org/doc/draft-ietf-ntp-roughtime/11/
// Interoperability reference: github.com/cloudflare/roughtime protocol (Apache-2.0).
export const ROUGHTIME_VERSION = 0x8000000b;
const FRAME = Buffer.from('ROUGHTIM');
const DELEGATION_CONTEXT = Buffer.from('RoughTime v1 delegation signature--\0');
const RESPONSE_CONTEXT = Buffer.from('RoughTime v1 response signature\0');
const tagNumber = (tag: string) => Buffer.from(tag, 'latin1').readUInt32LE();
const validTag = (tag: string) => tag.length === 4 && /^[A-Z]{3}$/u.test(tag.slice(0, 3)) &&
  (tag.charCodeAt(3) === 0 || /^[A-Z]$/u.test(tag[3]!));
const fail = (condition: unknown, reason: string): void => { if (!condition) throw new Error(reason); };
const sha512 = (...parts: Uint8Array[]) => createHash('sha512').update(Buffer.concat(parts)).digest();
const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(value); return b; };

// Small strict tagged-message codec. Lengths/counts are checked before slicing.
export function encodeRoughtimeMessage(fields: ReadonlyMap<string, Uint8Array>): Buffer {
  const entries = [...fields].sort((a, b) => tagNumber(a[0]) - tagNumber(b[0]));
  fail(entries.length > 0 && entries.length <= 32 &&
    entries.every(([tag, b]) => validTag(tag) && b.length % 4 === 0), 'ROUGHTIME_FIELDS');
  const h = Buffer.alloc(entries.length * 8); h.writeUInt32LE(entries.length);
  let offset = 0;
  entries.forEach(([tag, b], i) => {
    if (i > 0) h.writeUInt32LE(offset, i * 4);
    h.writeUInt32LE(tagNumber(tag), entries.length * 4 + i * 4);
    offset += b.length;
  });
  fail(offset + h.length <= 8192, 'ROUGHTIME_SIZE');
  return Buffer.concat([h, ...entries.map(([, b]) => Buffer.from(b))]);
}
function decode(bytes: Uint8Array): Map<string, Buffer> {
  const b = Buffer.from(bytes);
  fail(b.length >= 8 && b.length <= 8192 && b.length % 4 === 0, 'ROUGHTIME_ENCODING');
  const count = b.readUInt32LE();
  fail(count > 0 && count <= 32 && count * 8 <= b.length, 'ROUGHTIME_COUNT');
  const result = new Map<string, Buffer>(); let offset = 0, previous = -1;
  for (let i = 0; i < count; i++) {
    const tag = b.readUInt32LE(count * 4 + i * 4);
    const next = i + 1 < count ? b.readUInt32LE((i + 1) * 4) : b.length - count * 8;
    fail(tag > previous && next >= offset && next % 4 === 0 && next <= b.length - count * 8,
      'ROUGHTIME_OFFSETS');
    const name = b.subarray(count * 4 + i * 4, count * 4 + i * 4 + 4).toString('latin1');
    fail(validTag(name), 'ROUGHTIME_TAG');
    result.set(name, b.subarray(count * 8 + offset, count * 8 + next));
    previous = tag; offset = next;
  }
  return result;
}
function field(fields: Map<string, Buffer>, tag: string, length?: number): Buffer {
  const value = fields.get(tag);
  fail(value && (length === undefined || value.length === length), 'ROUGHTIME_FIELD_' + tag);
  return value!;
}
function key(raw: Uint8Array) {
  fail(raw.length === 32, 'ROUGHTIME_KEY');
  return createPublicKey({key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
    type: 'spki', format: 'der'});
}
export function createRoughtimeRequest(nonce: Uint8Array, pinnedRoot: Uint8Array,
  profile: RoughtimeProfile = 'IETF_DRAFT11'): Buffer {
  fail((profile === 'IETF_DRAFT11' || profile === 'GOOGLE_LEGACY') &&
    nonce.length === (profile === 'GOOGLE_LEGACY' ? 64 : 32) && pinnedRoot.length === 32, 'ROUGHTIME_REQUEST');
  if (profile === 'GOOGLE_LEGACY') {
    // Legacy request contains NONC and PAD-ff, no IETF framing/version negotiation.
    const padding = Buffer.alloc(1024 - 16 - 64);
    const header = Buffer.alloc(16); header.writeUInt32LE(2); header.writeUInt32LE(64, 4);
    header.writeUInt32LE(tagNumber('NONC'), 8); header.writeUInt32LE(0xff444150, 12);
    return Buffer.concat([header, nonce, padding]);
  }
  const fields = new Map<string, Uint8Array>([
    ['NONC', nonce], ['VER\0', u32(ROUGHTIME_VERSION)],
    ['SRV\0', sha512(Buffer.from([255]), pinnedRoot).subarray(0, 32)],
    ['ZZZZ', Buffer.alloc(1024 - 12 - 32 - 32 - 4 - 4 * 8)],
  ]);
  const body = encodeRoughtimeMessage(fields);
  return Buffer.concat([FRAME, u32(body.length), body]);
}
export interface RoughtimeInterval {earliestMs: number; latestMs: number; proofDigest: string}
export function verifyRoughtimeReply(reply: Uint8Array, nonce: Uint8Array,
  pinnedRoot: Uint8Array, roundTripMs: number, maxRoundTripMs: number,
  maxRadiusMs: number, profile: RoughtimeProfile = 'IETF_DRAFT11'): RoughtimeInterval {
  const b = Buffer.from(reply), legacy = profile === 'GOOGLE_LEGACY', width = legacy ? 64 : 32;
  fail(profile === 'IETF_DRAFT11' || legacy, 'ROUGHTIME_PROFILE');
  fail(nonce.length === width && Number.isSafeInteger(roundTripMs) && roundTripMs >= 0 &&
    Number.isSafeInteger(maxRoundTripMs) && maxRoundTripMs > 0 && roundTripMs <= maxRoundTripMs &&
    Number.isSafeInteger(maxRadiusMs) && maxRadiusMs >= 0, 'ROUGHTIME_RTT');
  fail(b.length >= 20 && b.length <= 8192 && (legacy
    ? !b.subarray(0, 8).equals(FRAME)
    : b.subarray(0, 8).equals(FRAME) && b.readUInt32LE(8) === b.length - 12), 'ROUGHTIME_FRAME');
  const outer = decode(legacy ? b : b.subarray(12));
  if (legacy) {
    fail(!outer.has('VER\0') && (!outer.has('NONC') ||
      field(outer, 'NONC', 64).equals(Buffer.from(nonce))), 'ROUGHTIME_NONCE_VERSION');
  } else {
    fail(field(outer, 'VER\0', 4).readUInt32LE() === ROUGHTIME_VERSION &&
      field(outer, 'NONC', 32).equals(Buffer.from(nonce)), 'ROUGHTIME_NONCE_VERSION');
  }
  const cert = decode(field(outer, 'CERT')), delegationBytes = field(cert, 'DELE');
  fail(verify(null, Buffer.concat([DELEGATION_CONTEXT, delegationBytes]), key(pinnedRoot),
    field(cert, 'SIG\0', 64)), 'ROUGHTIME_DELEGATION_SIGNATURE');
  const delegation = decode(delegationBytes);
  const srepBytes = field(outer, 'SREP');
  fail(verify(null, Buffer.concat([RESPONSE_CONTEXT, srepBytes]),
    key(field(delegation, 'PUBK', 32)), field(outer, 'SIG\0', 64)), 'ROUGHTIME_RESPONSE_SIGNATURE');
  const srep = decode(srepBytes), midpoint = field(srep, 'MIDP', 8).readBigUInt64LE();
  const min = field(delegation, 'MINT', 8).readBigUInt64LE();
  const max = field(delegation, 'MAXT', 8).readBigUInt64LE();
  const radius = BigInt(field(srep, 'RADI', 4).readUInt32LE());
  // Require the full uncertainty interval inside the delegation; bound second quantization too.
  fail((legacy || radius >= 3n) && min <= max && midpoint > radius && midpoint - radius - 1n >= min &&
    midpoint + radius + 2n <= max && (legacy ? radius <= BigInt(maxRadiusMs) * 1000n : radius * 1000n <= BigInt(maxRadiusMs)), 'ROUGHTIME_RANGE');
  const path = field(outer, 'PATH');
  fail(path.length % width === 0 && path.length <= 32 * width, 'ROUGHTIME_PATH');
  let index = field(outer, 'INDX', 4).readUInt32LE();
  let digest = sha512(Buffer.from([0]), nonce).subarray(0, width);
  for (let offset = 0; offset < path.length; offset += width) {
    const sibling = path.subarray(offset, offset + width);
    digest = (index % 2 === 0 ? sha512(Buffer.from([1]), digest, sibling) :
      sha512(Buffer.from([1]), sibling, digest)).subarray(0, width);
    index = Math.floor(index / 2);
  }
  fail(index === 0 && digest.equals(field(srep, 'ROOT', width)), 'ROUGHTIME_MERKLE');
  // Explicit units, with conservative rounding and the full measured RTT.
  const earliest = legacy ? (midpoint - radius - 1n) / 1000n : (midpoint - radius - 1n) * 1000n;
  const latest = (legacy ? (midpoint + radius + 2n + 999n) / 1000n :
    (midpoint + radius + 2n) * 1000n) + BigInt(roundTripMs);
  fail(latest <= BigInt(Number.MAX_SAFE_INTEGER), 'ROUGHTIME_OVERFLOW');
  return {earliestMs: Number(earliest), latestMs: Number(latest),
    proofDigest: createHash('sha256').update(b).digest('hex')};
}
export interface RoughtimeClockPolicy {
  profile: RoughtimeProfile;
  sourceId: string; host: string; port: number; rootPublicKey: Uint8Array;
  maxRoundTripMs: number; maxRadiusMs: number; maxSampleAgeMs: number;
  maxUncertaintyMs: number; monotonicDriftPpm: number; deviceCheckpointValidityMs: number;
}
export type RoughtimeTransport = (request: Uint8Array, policy: RoughtimeClockPolicy) => Promise<Uint8Array>;
/** Operational egress and provider-key approval are prerequisites; construction sends nothing. */
export function createUdpRoughtimeTransport(factory: () => Socket = () => createSocket('udp4')): RoughtimeTransport {
  return (request, policy) => new Promise((resolve, reject) => {
  const socket = factory(); let finished = false;
  const finish = (error?: Error, bytes?: Buffer) => {
    if (finished) return; finished = true; clearTimeout(timer);
    try { socket.close(); } catch { /* DNS/early timeout can leave an unbound socket. */ }
    if (error) reject(error); else resolve(bytes!);
  };
  const timer = setTimeout(() => finish(new Error('ROUGHTIME_TIMEOUT')), policy.maxRoundTripMs);
  socket.once('error', error => finish(error));
  try {
    socket.connect(policy.port, policy.host, () => {
      if (finished) {
        try { socket.close(); } catch { /* A prior close may already have completed. */ }
        return;
      }
      socket.once('message', bytes => finish(undefined, bytes));
      try { socket.send(request, error => { if (error) finish(error); }); }
      catch { finish(new Error('ROUGHTIME_SEND_FAILED')); }
    });
  } catch { finish(new Error('ROUGHTIME_CONNECT_FAILED')); }
  });
}
export const udpRoughtimeTransport = createUdpRoughtimeTransport();
/** Same-process monotonic checkpoint. Restart requires a fresh signed provider response. */
export class RoughtimeClock {
  private sample: (RoughtimeInterval & {receivedElapsedMs: number}) | null = null;
  private pending: Promise<void> | null = null;
  private lastElapsed = 0;
  private highWater = 0;
  private readonly policy: RoughtimeClockPolicy;
  constructor(policy: RoughtimeClockPolicy, private readonly transport: RoughtimeTransport = udpRoughtimeTransport,
    private readonly elapsedMs: () => number = () => Number(process.hrtime.bigint() / 1000000n)) {
    this.policy = {...policy, rootPublicKey: Buffer.from(policy.rootPublicKey)};
    fail((policy.profile === 'IETF_DRAFT11' || policy.profile === 'GOOGLE_LEGACY') &&
      /^[A-Za-z0-9._:-]{1,128}$/.test(policy.sourceId) && /^[A-Za-z0-9.-]{1,253}$/.test(policy.host) &&
      Number.isInteger(policy.port) && policy.port > 0 && policy.port <= 65535 && policy.rootPublicKey.length === 32 &&
      [policy.maxRoundTripMs, policy.maxRadiusMs, policy.maxSampleAgeMs, policy.maxUncertaintyMs,
        policy.monotonicDriftPpm, policy.deviceCheckpointValidityMs].every(Number.isSafeInteger) &&
      policy.maxRoundTripMs > 0 && policy.maxRoundTripMs <= 10000 && policy.maxRadiusMs >= (policy.profile === 'IETF_DRAFT11' ? 3000 : 0) &&
      policy.maxRadiusMs <= 10000 && policy.maxSampleAgeMs > 0 && policy.maxSampleAgeMs <= 60000 &&
      policy.maxUncertaintyMs > 0 && policy.maxUncertaintyMs <= 60000 &&
      policy.monotonicDriftPpm > 0 && policy.monotonicDriftPpm <= 10000 &&
      policy.deviceCheckpointValidityMs > policy.maxUncertaintyMs * 2 &&
      policy.deviceCheckpointValidityMs <= 86400000, 'ROUGHTIME_POLICY');
  }
  private elapsed(): number {
    const now = this.elapsedMs();
    fail(Number.isSafeInteger(now) && now >= this.lastElapsed && now >= 0, 'ROUGHTIME_MONOTONIC_ROLLBACK');
    this.lastElapsed = now; return now;
  }
  async refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.acquire();
    try { await this.pending; } finally { this.pending = null; }
  }
  private async acquire(): Promise<void> {
    const nonce = randomBytes(this.policy.profile === 'GOOGLE_LEGACY' ? 64 : 32), sent = this.elapsed();
    const bytes = await this.transport(createRoughtimeRequest(nonce, this.policy.rootPublicKey, this.policy.profile), this.policy);
    const received = this.elapsed();
    const result = verifyRoughtimeReply(bytes, nonce, this.policy.rootPublicKey, received - sent,
      this.policy.maxRoundTripMs, this.policy.maxRadiusMs, this.policy.profile);
    fail(result.earliestMs >= this.highWater, 'ROUGHTIME_TIME_ROLLBACK');
    this.sample = {...result, receivedElapsedMs: received};
    this.time();
  }
  time(): QualifiedAuthorityTime {
    fail(this.sample !== null, 'TIME_UNAVAILABLE');
    const sample = this.sample!, delta = this.elapsed() - sample.receivedElapsedMs;
    fail(delta >= 0 && delta < this.policy.maxSampleAgeMs, 'ROUGHTIME_SAMPLE_EXPIRED');
    const drift = Math.ceil(delta * this.policy.monotonicDriftPpm / 1000000) + 1;
    const low = sample.earliestMs + Math.max(0, delta - drift);
    const high = sample.latestMs + delta + drift;
    const midpoint = Math.floor((low + high) / 2), uncertainty = Math.max(midpoint - low, high - midpoint);
    fail(Number.isSafeInteger(high) && low >= this.highWater &&
      uncertainty <= this.policy.maxUncertaintyMs, 'ROUGHTIME_UNCERTAINTY');
    this.highWater = low;
    return {timeMs: midpoint, uncertaintyMs: uncertainty,
      validForMs: this.policy.deviceCheckpointValidityMs - uncertainty};
  }
  isQualified(): boolean { try { this.time(); return true; } catch { return false; } }
}
