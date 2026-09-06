import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';

import {decodeEmergencyPayloadV1, type DecodedEmergencyPayloadV1} from './emergencyPayloadV1.js';
import {protocolFailure, ProtocolValidationError} from './errors.js';

export const MAX_ENVELOPE_BYTES = 8192;
const MAX_PUBLIC_KEY_BYTES = 512;
const MAX_PAYLOAD_BYTES = 4096;
const MAX_SIGNATURE_BYTES = 256;
const SHA256_BYTES = 32;
const MIN_ENVELOPE_BYTES = 4 + 2 + 16 + 16 + 4 + 8 + 8 + 4 + SHA256_BYTES + 2 + 1 + SHA256_BYTES + 4 + 1 + 2 + 1;

export interface DecodedEnvelopeV1 {
  messageId: string;
  reportId: string;
  revision: number;
  createdAtMs: bigint;
  expiresAtMs: bigint | null;
  priority: number;
  originKeyId: Buffer;
  originPublicKeyDer: Buffer;
  payloadDigest: Buffer;
  payload: Buffer;
  canonicalUnsignedBody: Buffer;
  signature: Buffer;
}

export interface VerifiedEnvelopeV1 extends DecodedEnvelopeV1 {
  emergencyPayload: DecodedEmergencyPayloadV1;
}

class BufferCursor {
  private offset = 0;

  constructor(private readonly bytes: Buffer) {}

  position(): number {
    return this.offset;
  }

  remaining(): number {
    return this.bytes.length - this.offset;
  }

  take(length: number, field: string): Buffer {
    if (!Number.isInteger(length) || length < 0 || this.remaining() < length) {
      throw protocolFailure('MALFORMED_ENVELOPE', `${field} is truncated`);
    }
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  u8(field: string): number {
    return this.take(1, field)[0] as number;
  }

  u16(field: string): number {
    return this.take(2, field).readUInt16BE(0);
  }

  u32(field: string): number {
    return this.take(4, field).readUInt32BE(0);
  }

  i32(field: string): number {
    return this.take(4, field).readInt32BE(0);
  }

  i64(field: string): bigint {
    return this.take(8, field).readBigInt64BE(0);
  }
}

export function decodeEnvelopeV1(bytes: Buffer): DecodedEnvelopeV1 {
  if (bytes.length > MAX_ENVELOPE_BYTES) {
    throw protocolFailure('ENVELOPE_TOO_LARGE', 'Envelope is too large');
  }
  if (bytes.length < MIN_ENVELOPE_BYTES) {
    throw protocolFailure('MALFORMED_ENVELOPE', 'Envelope is truncated');
  }

  const cursor = new BufferCursor(bytes);
  if (cursor.take(4, 'magic').toString('ascii') !== 'SGP1') {
    throw protocolFailure('MALFORMED_ENVELOPE', 'Invalid envelope magic');
  }
  if (cursor.u8('protocol version') !== 1) {
    throw protocolFailure('UNSUPPORTED_PROTOCOL', 'Unsupported envelope version');
  }
  if (cursor.u8('signature algorithm') !== 1) {
    throw protocolFailure('UNSUPPORTED_PROTOCOL', 'Unsupported signature algorithm');
  }

  const messageId = uuidFromBytes(cursor.take(16, 'message ID'));
  const reportId = uuidFromBytes(cursor.take(16, 'report ID'));
  const revision = cursor.u32('revision');
  if (revision < 1) {
    throw protocolFailure('MALFORMED_ENVELOPE', 'Revision must be at least 1');
  }
  const createdAtMs = cursor.i64('created timestamp');
  if (createdAtMs < 0n) {
    throw protocolFailure('MALFORMED_ENVELOPE', 'createdAtMs must not be negative');
  }
  const expiresRaw = cursor.i64('expiry timestamp');
  if (expiresRaw < -1n) {
    throw protocolFailure('MALFORMED_ENVELOPE', 'expiresAtMs is invalid');
  }
  const priority = cursor.i32('priority');
  const originKeyId = Buffer.from(cursor.take(SHA256_BYTES, 'origin key ID'));

  const publicKeyLength = cursor.u16('public key length');
  if (publicKeyLength < 1 || publicKeyLength > MAX_PUBLIC_KEY_BYTES) {
    throw protocolFailure('MALFORMED_ENVELOPE', 'Public key length is out of range');
  }
  const originPublicKeyDer = Buffer.from(cursor.take(publicKeyLength, 'public key'));
  const payloadDigest = Buffer.from(cursor.take(SHA256_BYTES, 'payload digest'));
  const payloadLength = cursor.u32('payload length');
  if (payloadLength < 1 || payloadLength > MAX_PAYLOAD_BYTES) {
    throw protocolFailure('MALFORMED_ENVELOPE', 'Payload length is out of range');
  }
  const payload = Buffer.from(cursor.take(payloadLength, 'payload'));
  const unsignedEnd = cursor.position();

  const signatureLength = cursor.u16('signature length');
  if (signatureLength < 1 || signatureLength > MAX_SIGNATURE_BYTES) {
    throw protocolFailure('MALFORMED_ENVELOPE', 'Signature length is out of range');
  }
  if (cursor.remaining() !== signatureLength) {
    throw protocolFailure('MALFORMED_ENVELOPE', 'Trailing or truncated signature bytes');
  }
  const signature = Buffer.from(cursor.take(signatureLength, 'signature'));

  return {
    messageId,
    reportId,
    revision,
    createdAtMs,
    expiresAtMs: expiresRaw === -1n ? null : expiresRaw,
    priority,
    originKeyId,
    originPublicKeyDer,
    payloadDigest,
    payload,
    canonicalUnsignedBody: Buffer.from(bytes.subarray(0, unsignedEnd)),
    signature,
  };
}

export function verifyEnvelopeV1(bytes: Buffer): VerifiedEnvelopeV1 {
  const decoded = decodeEnvelopeV1(bytes);
  const computedKeyId = sha256(decoded.originPublicKeyDer);
  if (!timingSafeEqual(decoded.originKeyId, computedKeyId)) {
    throw protocolFailure('INVALID_DIGEST', 'Origin public-key digest verification failed');
  }
  const computedPayloadDigest = sha256(decoded.payload);
  if (!timingSafeEqual(decoded.payloadDigest, computedPayloadDigest)) {
    throw protocolFailure('INVALID_DIGEST', 'Payload digest verification failed');
  }

  let publicKey;
  try {
    publicKey = createPublicKey({
      key: decoded.originPublicKeyDer,
      format: 'der',
      type: 'spki',
    });
  } catch (error) {
    throw protocolFailure('INVALID_PUBLIC_KEY', 'Origin public key is invalid', error);
  }
  if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw protocolFailure('INVALID_PUBLIC_KEY', 'Origin public key must use P-256');
  }

  let signatureValid = false;
  try {
    signatureValid = verifySignature(
      'sha256',
      decoded.canonicalUnsignedBody,
      publicKey,
      decoded.signature,
    );
  } catch (error) {
    throw protocolFailure('INVALID_SIGNATURE', 'Origin signature verification failed', error);
  }
  if (!signatureValid) {
    throw protocolFailure('INVALID_SIGNATURE', 'Origin signature verification failed');
  }

  let emergencyPayload: DecodedEmergencyPayloadV1;
  try {
    emergencyPayload = decodeEmergencyPayloadV1(decoded.payload);
  } catch (error) {
    if (error instanceof ProtocolValidationError) {
      throw error;
    }
    throw protocolFailure('MALFORMED_PAYLOAD', 'Emergency payload is invalid', error);
  }

  return {...decoded, emergencyPayload};
}

function sha256(bytes: Buffer): Buffer {
  return createHash('sha256').update(bytes).digest();
}

function uuidFromBytes(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
