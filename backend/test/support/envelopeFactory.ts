import {createHash, generateKeyPairSync, sign, type KeyObject} from 'node:crypto';

export interface TestIdentity {
  privateKey: KeyObject;
  publicKeyDer: Buffer;
}

export interface EnvelopeFactoryOptions {
  messageId?: string;
  reportId?: string;
  revision?: number;
  priority?: number;
  emergencyType?: number;
  urgency?: number;
  identity?: TestIdentity;
}

export function createTestIdentity(): TestIdentity {
  const {privateKey, publicKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  return {
    privateKey,
    publicKeyDer: publicKey.export({type: 'spki', format: 'der'}),
  };
}

export function buildSignedEnvelope(options: EnvelopeFactoryOptions = {}): Buffer {
  const messageId = options.messageId ?? '11111111-1111-1111-1111-111111111111';
  const reportId = options.reportId ?? '22222222-2222-2222-2222-222222222222';
  const revision = options.revision ?? 1;
  const priority = options.priority ?? 0;
  const emergencyType = options.emergencyType ?? 1;
  const urgency = options.urgency ?? 1;
  const identity = options.identity ?? createTestIdentity();
  const payload = Buffer.from([0x53, 0x52, 0x50, 0x31, 0x01, emergencyType, urgency, 0x00]);
  const keyId = createHash('sha256').update(identity.publicKeyDer).digest();
  const payloadDigest = createHash('sha256').update(payload).digest();
  const unsigned = Buffer.concat([
    Buffer.from('SGP1', 'ascii'),
    Buffer.from([1, 1]),
    uuidBytes(messageId),
    uuidBytes(reportId),
    u32(revision),
    i64(1_000n),
    i64(-1n),
    i32(priority),
    keyId,
    u16(identity.publicKeyDer.length),
    identity.publicKeyDer,
    payloadDigest,
    u32(payload.length),
    payload,
  ]);
  const signature = sign('sha256', unsigned, identity.privateKey);
  return Buffer.concat([unsigned, u16(signature.length), signature]);
}

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
