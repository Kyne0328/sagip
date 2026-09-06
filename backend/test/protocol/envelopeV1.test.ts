import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import test from 'node:test';

import {
  decodeEnvelopeV1,
  verifyEnvelopeV1,
} from '../../src/protocol/envelopeV1.js';

const PAYLOAD = Buffer.from('5352503101010100', 'hex');

function uuidBytes(value: string): Buffer {
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function u16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function i32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
}

function i64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64BE(value);
  return bytes;
}

function buildSignedEnvelope(overrides?: {messageId?: string; reportId?: string}): Buffer {
  const messageId = overrides?.messageId ?? '11111111-1111-1111-1111-111111111111';
  const reportId = overrides?.reportId ?? '22222222-2222-2222-2222-222222222222';
  const {privateKey, publicKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const publicKeyDer = publicKey.export({type: 'spki', format: 'der'});
  const keyId = createHash('sha256').update(publicKeyDer).digest();
  const payloadDigest = createHash('sha256').update(PAYLOAD).digest();

  const unsigned = Buffer.concat([
    Buffer.from('SGP1', 'ascii'),
    Buffer.from([1, 1]),
    uuidBytes(messageId),
    uuidBytes(reportId),
    u32(1),
    i64(1_000n),
    i64(-1n),
    i32(0),
    keyId,
    u16(publicKeyDer.length),
    publicKeyDer,
    payloadDigest,
    u32(PAYLOAD.length),
    PAYLOAD,
  ]);
  const signature = sign('sha256', unsigned, privateKey);
  return Buffer.concat([unsigned, u16(signature.length), signature]);
}

test('decodes the Android canonical SGP1 field-order golden vector', () => {
  const expectedUnsigned =
    '534750310101' +
    '00000000000000000000000000000001' +
    '00000000000000000000000000000002' +
    '00000001' +
    '00000000000003e8' +
    'ffffffffffffffff' +
    '00000000' +
    '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81' +
    '0003' +
    '010203' +
    '59e7a04bc21b40e90cd86d92d2d41ce93196b26d0da7112c5b689e4647bee7fc' +
    '00000008' +
    '5352503101010100';
  const bytes = Buffer.from(expectedUnsigned + '00023000', 'hex');

  const decoded = decodeEnvelopeV1(bytes);

  assert.equal(decoded.messageId, '00000000-0000-0000-0000-000000000001');
  assert.equal(decoded.reportId, '00000000-0000-0000-0000-000000000002');
  assert.equal(decoded.revision, 1);
  assert.equal(decoded.createdAtMs, 1000n);
  assert.equal(decoded.expiresAtMs, null);
  assert.equal(decoded.priority, 0);
  assert.equal(decoded.canonicalUnsignedBody.toString('hex'), expectedUnsigned);
  assert.equal(decoded.signature.toString('hex'), '3000');
});

test('verifies a valid P-256 envelope and decodes its SRP1 payload', () => {
  const verified = verifyEnvelopeV1(buildSignedEnvelope());

  assert.equal(verified.messageId, '11111111-1111-1111-1111-111111111111');
  assert.equal(verified.reportId, '22222222-2222-2222-2222-222222222222');
  assert.deepEqual(verified.emergencyPayload, {
    emergencyType: 1,
    urgency: 1,
    location: null,
  });
});

test('rejects unsupported protocol versions', () => {
  const unsupported = Buffer.from(buildSignedEnvelope());
  unsupported[4] = 2;

  assert.throws(() => decodeEnvelopeV1(unsupported), /unsupported envelope version/i);
});

test('rejects payload digest corruption before signature acceptance', () => {
  const valid = buildSignedEnvelope();
  const decoded = decodeEnvelopeV1(valid);
  const corrupted = Buffer.from(valid);
  const payloadOffset = decoded.canonicalUnsignedBody.length - decoded.payload.length;
  corrupted[payloadOffset] = (corrupted[payloadOffset] ?? 0) ^ 1;

  assert.throws(() => verifyEnvelopeV1(corrupted), /payload digest verification failed/i);
});

test('rejects signature corruption and trailing bytes', () => {
  const valid = buildSignedEnvelope();
  const corrupted = Buffer.from(valid);
  corrupted[20] = (corrupted[20] ?? 0) ^ 1;

  assert.throws(() => verifyEnvelopeV1(corrupted), /signature|verification/i);
  assert.throws(() => decodeEnvelopeV1(Buffer.concat([valid, Buffer.from([0])])), /signature|trailing/i);
});

test('rejects envelopes larger than the protocol maximum', () => {
  assert.throws(() => decodeEnvelopeV1(Buffer.alloc(8193)), /too large/i);
});
