const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const WEEK_MS = 604_800_000;
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const SIGNING_DOMAIN = new TextEncoder().encode('SAGIP-SIGNED-V2\0');
const PROVIDER_DOMAIN = new TextEncoder().encode('SAGIP-PROVIDER-V2\0');

export interface BrowserVerificationContext {
  roots: ReadonlyMap<string, Uint8Array>;
  revokedGrants: ReadonlySet<string>;
  allowedScopes: ReadonlySet<string>;
  pairedTimeProviderId: string | null;
}

export interface BrowserTimeChallenge {
  challengeId: string;
  verifierId: Uint8Array;
  verifierBootSessionId: string;
  nonce: Uint8Array;
  sentElapsedMs: number;
  currentElapsedMs?: number;
  highWaterEarliestMs: number | null;
}

export interface BrowserTimeCheckpoint {
  earliestMs: number;
  latestMs: number;
  validUntilMs: number;
  proofDigest: string;
  signerProviderId: string;
  signerBootSessionId: string;
  grantId: string;
}

export type TimeAcceptance =
  | {kind: 'ACCEPTED'; checkpoint: BrowserTimeCheckpoint}
  | {kind: 'REJECTED'; reason: string};

interface GrantFields {
  purpose: 3;
  rootKeyId: Uint8Array;
  grantId: string;
  issuerKeyId: Uint8Array;
  issuerPublicKeyDer: Uint8Array;
  issuerProviderId: Uint8Array;
  responderId: string;
  callsign: string;
  statusMask: number;
  purposeMask: number;
  scope: string;
  notBeforeMs: number;
  expiresAtMs: number;
}

interface TimeFields {
  purpose: 4;
  signerProviderId: Uint8Array;
  signerKeyId: Uint8Array;
  grantId: string;
  signerBootSessionId: string;
  verifierId: Uint8Array;
  verifierBootSessionId: string;
  nonce: Uint8Array;
  parentCheckpointDigest: Uint8Array;
  signedTimeMs: number;
  elapsedSinceCheckpointMs: number;
  uncertaintyMs: number;
  validUntilMs: number;
}

interface Decoded {
  bytes: Uint8Array;
  fields: GrantFields | TimeFields;
  signature: Uint8Array;
  proofMembers: Decoded[];
}

export async function verifyTimeProof(
  bytes: Uint8Array,
  challenge: BrowserTimeChallenge,
  context: BrowserVerificationContext,
): Promise<TimeAcceptance> {
  const reject = (reason: string): TimeAcceptance => ({kind: 'REJECTED', reason});
  try {
    const decoded = decodeReceipt(bytes);
    if (decoded.fields.purpose !== 4) return reject('TIME_PROFILE');
    const fields = decoded.fields;
    const nowElapsed = challenge.currentElapsedMs ?? performance.now();
    const age = nowElapsed - challenge.sentElapsedMs;
    if (
      !Number.isFinite(nowElapsed) ||
      !Number.isFinite(challenge.sentElapsedMs) ||
      challenge.sentElapsedMs < 0 ||
      age < 0 ||
      age > 60_000 ||
      fields.verifierBootSessionId !== challenge.verifierBootSessionId ||
      !equalBytes(fields.verifierId, challenge.verifierId) ||
      !equalBytes(fields.nonce, challenge.nonce)
    ) {
      return reject(age > 60_000 ? 'CHALLENGE_AGE' : 'CHALLENGE_BINDING');
    }

    let start = 0;
    let end = fields.validUntilMs;
    if (fields.grantId === NIL_UUID) {
      if (!(await validRootTime(decoded, context))) return reject('ROOT_TIME_INVALID');
    } else {
      const grantReceipt = decoded.proofMembers[0];
      const parentReceipt = decoded.proofMembers[1];
      if (!grantReceipt || !parentReceipt || grantReceipt.fields.purpose !== 3) {
        return reject('DELEGATED_TIME_PROOF');
      }
      const grant = await validGrant(grantReceipt, context);
      if (!grant) return reject('GRANT_INVALID');
      const parent = await validRootTime(parentReceipt, context);
      if (!parent || parentReceipt.fields.purpose !== 4) return reject('PARENT_TIME_INVALID');

      const signerProviderHex = bytesToHex(fields.signerProviderId);
      if (
        context.pairedTimeProviderId !== signerProviderHex ||
        fields.grantId !== grant.grantId ||
        !equalBytes(fields.signerKeyId, grant.issuerKeyId) ||
        !equalBytes(fields.signerProviderId, grant.issuerProviderId) ||
        (grant.purposeMask & 8) === 0 ||
        !equalBytes(parent.verifierId, grant.issuerKeyId) ||
        fields.signerBootSessionId !== parent.verifierBootSessionId
      ) {
        return reject('DELEGATED_TIME_BINDING');
      }

      const parentDigest = await sha256(parentReceipt.bytes);
      if (
        !equalBytes(parentDigest, fields.parentCheckpointDigest) ||
        fields.signedTimeMs !== parent.signedTimeMs + fields.elapsedSinceCheckpointMs ||
        fields.uncertaintyMs < parent.uncertaintyMs + Math.ceil(fields.elapsedSinceCheckpointMs / 10_000) ||
        fields.uncertaintyMs > 86_400_000 ||
        fields.validUntilMs !== Math.min(grant.expiresAtMs, parent.validUntilMs) ||
        !(await verifySignature(decoded, grant.issuerPublicKeyDer))
      ) {
        return reject('DELEGATED_TIME_INVALID');
      }
      start = grant.notBeforeMs;
      end = Math.min(grant.expiresAtMs, parent.validUntilMs);
    }

    const uncertainty = fields.uncertaintyMs + age;
    const earliestMs = fields.signedTimeMs - uncertainty;
    const latestMs = fields.signedTimeMs + uncertainty;
    if (
      !validInterval(earliestMs, latestMs) ||
      earliestMs < start ||
      latestMs >= end ||
      (challenge.highWaterEarliestMs !== null && earliestMs < challenge.highWaterEarliestMs)
    ) {
      return reject(challenge.highWaterEarliestMs !== null && earliestMs < challenge.highWaterEarliestMs
        ? 'TIME_ROLLBACK'
        : 'TIME_INTERVAL');
    }

    return {
      kind: 'ACCEPTED',
      checkpoint: {
        earliestMs,
        latestMs,
        validUntilMs: end,
        proofDigest: bytesToHex(await sha256(bytes)),
        signerProviderId: bytesToHex(fields.signerProviderId),
        signerBootSessionId: fields.signerBootSessionId,
        grantId: fields.grantId,
      },
    };
  } catch {
    return reject('MALFORMED_TIME');
  }
}

async function validGrant(decoded: Decoded, context: BrowserVerificationContext): Promise<GrantFields | null> {
  if (decoded.fields.purpose !== 3) return null;
  const grant = decoded.fields;
  const root = context.roots.get(bytesToHex(grant.rootKeyId));
  if (
    !root ||
    !equalBytes(await sha256(root), grant.rootKeyId) ||
    !(await verifySignature(decoded, root)) ||
    !equalBytes(await sha256(grant.issuerPublicKeyDer), grant.issuerKeyId) ||
    !equalBytes(
      await providerId(2, grant.issuerKeyId, grant.grantId),
      grant.issuerProviderId,
    ) ||
    grant.expiresAtMs <= grant.notBeforeMs ||
    grant.expiresAtMs - grant.notBeforeMs > WEEK_MS ||
    context.revokedGrants.has(grant.grantId) ||
    !context.allowedScopes.has(grant.scope)
  ) {
    return null;
  }
  return grant;
}

async function validRootTime(
  decoded: Decoded,
  context: BrowserVerificationContext,
): Promise<TimeFields | null> {
  if (decoded.fields.purpose !== 4 || decoded.fields.grantId !== NIL_UUID) return null;
  const fields = decoded.fields;
  const root = context.roots.get(bytesToHex(fields.signerKeyId));
  if (
    !root ||
    !equalBytes(await sha256(root), fields.signerKeyId) ||
    !(await verifySignature(decoded, root)) ||
    !equalBytes(await providerId(1, fields.signerKeyId, NIL_UUID), fields.signerProviderId) ||
    fields.elapsedSinceCheckpointMs !== 0 ||
    fields.parentCheckpointDigest.some(value => value !== 0) ||
    fields.uncertaintyMs > 60_000 ||
    fields.validUntilMs <= fields.signedTimeMs + fields.uncertaintyMs ||
    fields.validUntilMs - fields.signedTimeMs > WEEK_MS
  ) {
    return null;
  }
  return fields;
}

async function verifySignature(decoded: Decoded, publicKeyDer: Uint8Array): Promise<boolean> {
  if (!canonicalSignature(decoded.signature)) return false;
  try {
    const key = await crypto.subtle.importKey(
      'spki',
      ownedArrayBuffer(publicKeyDer),
      {name: 'ECDSA', namedCurve: 'P-256'},
      false,
      ['verify'],
    );
    const input = concatBytes(SIGNING_DOMAIN, decoded.bytes.slice(0, -64));
    return crypto.subtle.verify(
      {name: 'ECDSA', hash: 'SHA-256'},
      key,
      ownedArrayBuffer(decoded.signature),
      ownedArrayBuffer(input),
    );
  } catch {
    return false;
  }
}

function decodeReceipt(source: Uint8Array, member = false): Decoded {
  if (source.length < 80 || source.length > 8192) throw new Error('receipt size');
  const reader = new Reader(source);
  const magic = reader.takeText(4);
  const version = reader.u8();
  const algorithm = reader.u8();
  const purpose = reader.u8();
  const flags = reader.u8();
  const bodyLength = reader.u16();
  const proofLength = reader.u16();
  const signatureLength = reader.u16();
  const reserved = reader.u16();
  const expectedMagic = purpose === 3 ? 'SGG2' : purpose === 4 ? 'SGT2' : '';
  if (
    version !== 2 ||
    algorithm !== 1 ||
    (purpose !== 3 && purpose !== 4) ||
    magic !== expectedMagic ||
    flags !== 0 ||
    signatureLength !== 64 ||
    reserved !== 0 ||
    16 + bodyLength + proofLength + signatureLength !== source.length ||
    (member && proofLength !== 0)
  ) {
    throw new Error('receipt header');
  }

  const body = new Reader(reader.take(bodyLength));
  const fields = purpose === 3 ? readGrant(body) : readTime(body);
  body.finish();
  const proof = new Reader(reader.take(proofLength));
  const proofMembers: Decoded[] = [];
  if (proofLength > 0) {
    const count = proof.u8();
    if (count < 1 || count > 2) throw new Error('proof count');
    const digests = new Set<string>();
    for (let index = 0; index < count; index += 1) {
      const memberBytes = proof.take(proof.u16());
      const digest = bytesToHexFast(memberBytes);
      if (digests.has(digest)) throw new Error('duplicate proof');
      digests.add(digest);
      proofMembers.push(decodeReceipt(memberBytes, true));
    }
    proof.finish();
  }
  const signature = reader.take(64);
  reader.finish();

  if (
    fields.purpose === 4 &&
    fields.grantId !== NIL_UUID &&
    (proofMembers.length !== 2 ||
      proofMembers[0]?.fields.purpose !== 3 ||
      proofMembers[1]?.fields.purpose !== 4 ||
      proofMembers[1].fields.grantId !== NIL_UUID)
  ) {
    throw new Error('delegated proof profile');
  }
  if (fields.purpose === 3 && proofMembers.length !== 0) throw new Error('grant proof profile');
  return {bytes: source.slice(), fields, signature, proofMembers};
}

function readGrant(reader: Reader): GrantFields {
  const rootKeyId = reader.take(32);
  const grantId = reader.uuid();
  const issuerKeyId = reader.take(32);
  const issuerPublicKeyDer = reader.take(91);
  const issuerProviderId = reader.take(32);
  const responderId = reader.uuid();
  const callsign = reader.string(64);
  const statusMask = reader.u8();
  const purposeMask = reader.u8();
  const scope = reader.string(64);
  const notBeforeMs = reader.time();
  const expiresAtMs = reader.time();
  if (!callsign || !scope || expiresAtMs <= notBeforeMs) throw new Error('grant');
  return {
    purpose: 3,
    rootKeyId,
    grantId,
    issuerKeyId,
    issuerPublicKeyDer,
    issuerProviderId,
    responderId,
    callsign,
    statusMask,
    purposeMask,
    scope,
    notBeforeMs,
    expiresAtMs,
  };
}

function readTime(reader: Reader): TimeFields {
  reader.uuid(); // proofId
  const signerProviderId = reader.take(32);
  const signerKeyId = reader.take(32);
  const grantId = reader.uuid(true);
  const signerBootSessionId = reader.uuid(true);
  const verifierId = reader.take(32);
  const verifierBootSessionId = reader.uuid();
  const nonce = reader.take(32);
  const parentCheckpointDigest = reader.take(32);
  const signedTimeMs = reader.time();
  const elapsedSinceCheckpointMs = reader.time();
  const uncertaintyMs = reader.u32();
  const validUntilMs = reader.time();
  if ((grantId === NIL_UUID) !== (signerBootSessionId === NIL_UUID)) throw new Error('time boot');
  return {
    purpose: 4,
    signerProviderId,
    signerKeyId,
    grantId,
    signerBootSessionId,
    verifierId,
    verifierBootSessionId,
    nonce,
    parentCheckpointDigest,
    signedTimeMs,
    elapsedSinceCheckpointMs,
    uncertaintyMs,
    validUntilMs,
  };
}

async function providerId(kind: number, keyId: Uint8Array, grantId: string): Promise<Uint8Array> {
  return sha256(concatBytes(
    PROVIDER_DOMAIN,
    Uint8Array.of(kind),
    keyId,
    uuidBytes(grantId),
  ));
}

function canonicalSignature(signature: Uint8Array): boolean {
  if (signature.length !== 64) return false;
  const r = bytesBigInt(signature.slice(0, 32));
  const s = bytesBigInt(signature.slice(32));
  return r > 0n && r < P256_ORDER && s > 0n && s <= P256_ORDER / 2n;
}

function validInterval(earliestMs: number, latestMs: number): boolean {
  return Number.isSafeInteger(earliestMs) &&
    Number.isSafeInteger(latestMs) &&
    earliestMs >= 0 &&
    latestMs >= earliestMs;
}

function uuidBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error('uuid');
  }
  return hexToBytes(value.replaceAll('-', ''));
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', ownedArrayBuffer(bytes)));
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) different |= left[index]! ^ right[index]!;
  return different === 0;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function bytesBigInt(bytes: Uint8Array): bigint {
  return BigInt(`0x${bytesToHex(bytes)}`);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

function bytesToHexFast(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/u.test(value)) throw new Error('hex');
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  take(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0 || this.offset + length > this.bytes.length) {
      throw new Error('truncated');
    }
    const result = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  takeText(length: number): string {
    return new TextDecoder('latin1').decode(this.take(length));
  }

  u8(): number {
    return this.take(1)[0]!;
  }

  u16(): number {
    const value = this.take(2);
    return (value[0]! << 8) | value[1]!;
  }

  u32(): number {
    const value = this.take(4);
    return new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(0, false);
  }

  time(): number {
    const value = this.take(8);
    const parsed = new DataView(value.buffer, value.byteOffset, value.byteLength).getBigUint64(0, false);
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('time');
    return Number(parsed);
  }

  uuid(allowNil = false): string {
    const hex = bytesToHex(this.take(16));
    const value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    if (!allowNil && value === NIL_UUID) throw new Error('nil uuid');
    return value;
  }

  string(maxBytes: number): string {
    const length = this.u16();
    if (length > maxBytes) throw new Error('string');
    return new TextDecoder('utf-8', {fatal: true}).decode(this.take(length));
  }

  finish(): void {
    if (this.offset !== this.bytes.length) throw new Error('trailing bytes');
  }
}
