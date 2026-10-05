import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import test from 'node:test';

import {decodeEncryptedPayloadV2} from '../../src/protocol/encryptedPayloadV2.js';
import {verifyTransportEnvelope} from '../../src/protocol/envelope.js';
import {decodeEnvelopeV2, verifyEnvelopeV2} from '../../src/protocol/envelopeV2.js';
import {buildSignedEnvelope} from '../support/envelopeFactory.js';

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

function encryptedPayload(): Buffer {
  return Buffer.concat([
    Buffer.from('SRE2', 'ascii'),
    Buffer.from([1, 1, 1]),
    Buffer.alloc(32, 1),
    u16(4),
    Buffer.from([1, 2, 3, 4]),
  ]);
}

function buildSignedEnvelopeV2(revision = 1): Buffer {
  const {privateKey, publicKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const publicKeyDer = publicKey.export({type: 'spki', format: 'der'});
  const payload = encryptedPayload();
  const unsigned = Buffer.concat([
    Buffer.from('SGP2', 'ascii'),
    Buffer.from([2, 1]),
    uuidBytes('11111111-1111-1111-1111-111111111111'),
    uuidBytes('22222222-2222-2222-2222-222222222222'),
    u32(revision),
    i64(1_000n),
    i64(-1n),
    i32(0),
    createHash('sha256').update(publicKeyDer).digest(),
    u16(publicKeyDer.length),
    publicKeyDer,
    createHash('sha256').update(payload).digest(),
    u32(payload.length),
    payload,
  ]);
  const signature = sign('sha256', unsigned, privateKey);
  return Buffer.concat([unsigned, u16(signature.length), signature]);
}

test('SRE2 canonical framing matches the Android golden vector', () => {
  const goldenHex =
    '53524532010101' +
    '01'.repeat(32) +
    '0004' +
    '01020304';
  const decoded = decodeEncryptedPayloadV2(Buffer.from(goldenHex, 'hex'));
  assert.equal(decoded.plaintextFormat, 1);
  assert.equal(decoded.recipients.length, 1);
  assert.equal(decoded.recipients[0]?.keyId.toString('hex'), '01'.repeat(32));
  assert.equal(decoded.recipients[0]?.ciphertext.toString('hex'), '01020304');
});

test('SRE2 rejects duplicate or non-canonical recipient key IDs', () => {
  const duplicate = Buffer.concat([
    Buffer.from('SRE2', 'ascii'),
    Buffer.from([1, 1, 2]),
    Buffer.alloc(32, 1), u16(1), Buffer.from([1]),
    Buffer.alloc(32, 1), u16(1), Buffer.from([2]),
  ]);
  assert.throws(() => decodeEncryptedPayloadV2(duplicate), /unique|ordered/i);
});

test('SGP1 and SGP2 dispatch explicitly without changing legacy verification', () => {
  assert.equal(verifyTransportEnvelope(buildSignedEnvelope()).protocolVersion, 1);
  assert.equal(verifyTransportEnvelope(buildSignedEnvelopeV2()).protocolVersion, 2);
});

test('SGP2 verifies P-256 signature and ciphertext digest without decoding SRP1', () => {
  const envelope = buildSignedEnvelopeV2();
  const verified = verifyEnvelopeV2(envelope);
  assert.equal(verified.messageId, '11111111-1111-1111-1111-111111111111');
  assert.equal(verified.reportId, '22222222-2222-2222-2222-222222222222');
  assert.equal(verified.encryptedPayloadContainer.recipients.length, 1);
  assert.equal(verified.encryptedPayload.subarray(0, 4).toString('ascii'), 'SRE2');
});

test('SGP2 revision matches the positive signed 32-bit Android and storage range', () => {
  assert.equal(verifyEnvelopeV2(buildSignedEnvelopeV2(0x7fff_ffff)).revision, 0x7fff_ffff);
  for (const revision of [0, 0x8000_0000, 0xffff_ffff]) {
    assert.throws(() => verifyEnvelopeV2(buildSignedEnvelopeV2(revision)), /revision/i);
  }
});

test('SGP2 rejects digest/signature tampering and oversized envelopes', () => {
  const envelope = buildSignedEnvelopeV2();
  const decoded = decodeEnvelopeV2(envelope);
  const payloadOffset = decoded.canonicalUnsignedBody.length - decoded.encryptedPayload.length;
  const payloadTampered = Buffer.from(envelope);
  payloadTampered[payloadOffset] = (payloadTampered[payloadOffset] ?? 0) ^ 1;
  assert.throws(() => verifyEnvelopeV2(payloadTampered), /digest|payload|signature/i);

  const signedMetadataTampered = Buffer.from(envelope);
  signedMetadataTampered[20] = (signedMetadataTampered[20] ?? 0) ^ 1;
  assert.throws(() => verifyEnvelopeV2(signedMetadataTampered), /signature/i);

  assert.throws(
    () => decodeEnvelopeV2(Buffer.alloc(8192)),
    error => error instanceof Error && /Invalid envelope magic/i.test(error.message),
  );
  assert.throws(() => decodeEnvelopeV2(Buffer.alloc(8193)), /too large/i);
});
