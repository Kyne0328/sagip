import { createHash, createPublicKey, verify } from 'node:crypto';
export const MAX_RECEIPT_BYTES = 8192;
const MAX_TIME = BigInt(Number.MAX_SAFE_INTEGER),
  MAX_COUNTER = 9223372036854775807n;
const N = BigInt(
  '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
);
const P = BigInt(
  '0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff',
);
const B = BigInt(
  '0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b',
);
const SPKI = Buffer.from(
  '3059301306072a8648ce3d020106082a8648ce3d03010703420004',
  'hex',
);
const NIL = '00000000-0000-0000-0000-000000000000',
  DOMAIN = Buffer.from('SAGIP-SIGNED-V2\0');
const MAGIC = ['SGA2', 'SGR2', 'SGG2', 'SGT2'];
type Bytes = Uint8Array;
interface ReportBinding {
  reportId: string;
  reportProtocolVersion: number;
  revision: number;
  originKeyId: Bytes;
}
export interface ResponderReceiptFields extends ReportBinding {
  purpose: 1;
  providerKind: number;
  issuerProviderId: Bytes;
  actionId: string;
  actionDigest: Bytes;
  payloadDigest: Bytes;
  issuerKeyId: Bytes;
  grantId: string;
  responderId: string;
  callsign: string;
  observedIncidentVersion: bigint;
  status: number;
  sequence: bigint;
  issuedAtMs: number;
  forwardingExpiresAtMs: number;
  note: string;
}
export interface RequesterReceiptFields extends ReportBinding {
  purpose: 2;
  eventId: string;
  originPublicKeyDer: Bytes;
  ackEventId: string;
  ackDigest: Bytes;
  receivedAtMs: number;
  forwardingExpiresAtMs: number;
}
export interface AuthorityGrantFields {
  purpose: 3;
  rootKeyId: Bytes;
  grantId: string;
  issuerKeyId: Bytes;
  issuerPublicKeyDer: Bytes;
  issuerProviderId: Bytes;
  responderId: string;
  callsign: string;
  statusMask: number;
  purposeMask: number;
  scope: string;
  notBeforeMs: number;
  expiresAtMs: number;
}
export interface TimeProofFields {
  purpose: 4;
  proofId: string;
  signerProviderId: Bytes;
  signerKeyId: Bytes;
  grantId: string;
  signerBootSessionId: string;
  verifierId: Bytes;
  verifierBootSessionId: string;
  nonce: Bytes;
  parentCheckpointDigest: Bytes;
  signedTimeMs: number;
  elapsedSinceCheckpointMs: number;
  uncertaintyMs: number;
  validUntilMs: number;
}
export type ReceiptFields =
  | ResponderReceiptFields
  | RequesterReceiptFields
  | AuthorityGrantFields
  | TimeProofFields;
export interface DecodedReceipt {
  fields: ReceiptFields;
  signature: Buffer;
  proof: Buffer;
}
function check(ok: boolean, why: string): asserts ok {
  if (!ok) throw new Error('Invalid receipt: ' + why);
}
export function validateReceiptPublicKey(bytes: Bytes): void {
  const b = Buffer.from(bytes);
  check(b.length === 91 && b.subarray(0, 27).equals(SPKI), 'key encoding');
  const x = BigInt('0x' + b.subarray(27, 59).toString('hex')),
    y = BigInt('0x' + b.subarray(59).toString('hex'));
  check(
    x < P &&
      y < P &&
      (y * y) % P === (((((x * x) % P) * x - 3n * x + B) % P) + P) % P,
    'key curve',
  );
}
function signatureCheck(bytes: Bytes): void {
  check(bytes.length === 64, 'signature length');
  const b = Buffer.from(bytes),
    r = BigInt('0x' + b.subarray(0, 32).toString('hex')),
    s = BigInt('0x' + b.subarray(32).toString('hex'));
  check(r > 0n && r < N && s > 0n && s <= N / 2n, 'signature canonicality');
}
type StringKind = 'callsign' | 'scope' | 'note';
function stringCheck(s: string, kind: StringKind): void {
  check(
    typeof s === 'string' && Buffer.from(s).toString('utf8') === s,
    'UTF-8 input',
  );
  const n = Buffer.byteLength(s);
  if (kind === 'note') check(n <= 1024 && !s.includes('\0'), 'note');
  else if (kind === 'scope')
    check(n >= 1 && n <= 64 && /^[A-Z0-9_:-]+$/.test(s), 'scope');
  else
    check(
      n >= 1 && n <= 64 && /^[\x20-\x7e]+$/.test(s) && s.trim() === s,
      'callsign',
    );
}
class Reader {
  offset = 0;
  constructor(readonly bytes: Buffer) {}
  take(n: number): Buffer {
    check(n >= 0 && n <= this.bytes.length - this.offset, 'truncated');
    const b = Buffer.from(this.bytes.subarray(this.offset, this.offset + n));
    this.offset += n;
    return b;
  }
  u8(): number {
    return this.take(1)[0]!;
  }
  u16(): number {
    return this.take(2).readUInt16BE();
  }
  u32(): number {
    return this.take(4).readUInt32BE();
  }
  u64(max = MAX_COUNTER): bigint {
    const v = this.take(8).readBigUInt64BE();
    check(v <= max, 'integer bound');
    return v;
  }
  time(): number {
    return Number(this.u64(MAX_TIME));
  }
  uuid(nil = false): string {
    const h = this.take(16).toString('hex'),
      s = [
        h.slice(0, 8),
        h.slice(8, 12),
        h.slice(12, 16),
        h.slice(16, 20),
        h.slice(20),
      ].join('-');
    check(nil || s !== NIL, 'nil UUID');
    return s;
  }
  string(kind: StringKind): string {
    const n = this.u16();
    check(n <= (kind === 'note' ? 1024 : 64), 'string bound');
    const s = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      this.take(n),
    );
    stringCheck(s, kind);
    return s;
  }
  finish(): void {
    check(this.offset === this.bytes.length, 'trailing bytes');
  }
}
class Writer {
  chunks: Buffer[] = [];
  bytes(v: Bytes, n?: number): void {
    check(
      v instanceof Uint8Array && (n === undefined || v.length === n),
      'bytes',
    );
    this.chunks.push(Buffer.from(v));
  }
  uint(v: number, n: 1 | 2 | 4): void {
    check(Number.isInteger(v) && v >= 0 && v < 2 ** (8 * n), 'integer');
    const b = Buffer.alloc(n);
    b.writeUIntBE(v, 0, n);
    this.chunks.push(b);
  }
  u64(v: bigint, max = MAX_COUNTER): void {
    check(typeof v === 'bigint' && v >= 0n && v <= max, 'integer bound');
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(v);
    this.chunks.push(b);
  }
  time(v: number): void {
    check(Number.isSafeInteger(v) && v >= 0, 'time');
    this.u64(BigInt(v), MAX_TIME);
  }
  uuid(s: string, nil = false): void {
    check(
      typeof s === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          s,
        ) &&
        (nil || s !== NIL),
      'UUID',
    );
    this.bytes(Buffer.from(s.replaceAll('-', ''), 'hex'), 16);
  }
  string(s: string, k: StringKind): void {
    stringCheck(s, k);
    const b = Buffer.from(s);
    this.uint(b.length, 2);
    this.bytes(b);
  }
  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
function readBody(purpose: number, body: Buffer): ReceiptFields {
  const r = new Reader(body);
  let f: ReceiptFields;
  if (purpose === 1) {
    const providerKind = r.u8(),
      issuerProviderId = r.take(32),
      actionId = r.uuid(),
      actionDigest = r.take(32),
      reportId = r.uuid(),
      reportProtocolVersion = r.u8(),
      revision = r.u32(),
      payloadDigest = r.take(32),
      originKeyId = r.take(32),
      issuerKeyId = r.take(32),
      grantId = r.uuid(true),
      responderId = r.uuid(),
      callsign = r.string('callsign'),
      observedIncidentVersion = r.u64(),
      status = r.u8(),
      sequence = r.u64(),
      issuedAtMs = r.time(),
      forwardingExpiresAtMs = r.time(),
      note = r.string('note');
    check(
      (providerKind === 1 || providerKind === 2) &&
        (reportProtocolVersion === 1 || reportProtocolVersion === 2) &&
        revision >= 1 &&
        revision <= 2147483647,
      'ACK codes',
    );
    check(
      status >= 1 &&
        status <= 4 &&
        sequence >= 1n &&
        (providerKind === 1 ? grantId === NIL : grantId !== NIL),
      'ACK fields',
    );
    check(
      forwardingExpiresAtMs > issuedAtMs &&
        forwardingExpiresAtMs - issuedAtMs <= 604800000,
      'ACK expiry',
    );
    f = {
      purpose: 1,
      providerKind,
      issuerProviderId,
      actionId,
      actionDigest,
      reportId,
      reportProtocolVersion,
      revision,
      payloadDigest,
      originKeyId,
      issuerKeyId,
      grantId,
      responderId,
      callsign,
      observedIncidentVersion,
      status,
      sequence,
      issuedAtMs,
      forwardingExpiresAtMs,
      note,
    };
  } else if (purpose === 2) {
    const eventId = r.uuid(),
      reportId = r.uuid(),
      reportProtocolVersion = r.u8(),
      revision = r.u32(),
      originKeyId = r.take(32),
      originPublicKeyDer = r.take(91);
    validateReceiptPublicKey(originPublicKeyDer);
    check(
      (reportProtocolVersion === 1 || reportProtocolVersion === 2) &&
        revision >= 1 &&
        revision <= 2147483647,
      'report binding',
    );
    f = {
      purpose: 2,
      eventId,
      reportId,
      reportProtocolVersion,
      revision,
      originKeyId,
      originPublicKeyDer,
      ackEventId: r.uuid(),
      ackDigest: r.take(32),
      receivedAtMs: r.time(),
      forwardingExpiresAtMs: r.time(),
    };
  } else if (purpose === 3) {
    const rootKeyId = r.take(32),
      grantId = r.uuid(),
      issuerKeyId = r.take(32),
      issuerPublicKeyDer = r.take(91);
    validateReceiptPublicKey(issuerPublicKeyDer);
    const issuerProviderId = r.take(32),
      responderId = r.uuid(),
      callsign = r.string('callsign'),
      statusMask = r.u8(),
      purposeMask = r.u8(),
      scope = r.string('scope'),
      notBeforeMs = r.time(),
      expiresAtMs = r.time();
    check(
      (statusMask & 1) === 1 &&
        (statusMask & ~15) === 0 &&
        (purposeMask & 1) === 1 &&
        (purposeMask & ~9) === 0,
      'grant purposes',
    );
    f = {
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
  } else {
    const proofId = r.uuid(),
      signerProviderId = r.take(32),
      signerKeyId = r.take(32),
      grantId = r.uuid(true),
      signerBootSessionId = r.uuid(true),
      verifierId = r.take(32),
      verifierBootSessionId = r.uuid(),
      nonce = r.take(32),
      parentCheckpointDigest = r.take(32),
      signedTimeMs = r.time(),
      elapsedSinceCheckpointMs = r.time(),
      uncertaintyMs = r.u32(),
      validUntilMs = r.time();
    check(
      grantId === NIL
        ? signerBootSessionId === NIL
        : signerBootSessionId !== NIL,
      'time boot',
    );
    f = {
      purpose: 4,
      proofId,
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
  r.finish();
  return f;
}
function writeBody(f: ReceiptFields): Buffer {
  const w = new Writer();
  if (f.purpose === 1) {
    w.uint(f.providerKind, 1);
    w.bytes(f.issuerProviderId, 32);
    w.uuid(f.actionId);
    w.bytes(f.actionDigest, 32);
    w.uuid(f.reportId);
    w.uint(f.reportProtocolVersion, 1);
    w.uint(f.revision, 4);
    w.bytes(f.payloadDigest, 32);
    w.bytes(f.originKeyId, 32);
    w.bytes(f.issuerKeyId, 32);
    w.uuid(f.grantId, true);
    w.uuid(f.responderId);
    w.string(f.callsign, 'callsign');
    w.u64(f.observedIncidentVersion);
    w.uint(f.status, 1);
    w.u64(f.sequence);
    w.time(f.issuedAtMs);
    w.time(f.forwardingExpiresAtMs);
    w.string(f.note, 'note');
  } else if (f.purpose === 2) {
    w.uuid(f.eventId);
    w.uuid(f.reportId);
    w.uint(f.reportProtocolVersion, 1);
    w.uint(f.revision, 4);
    w.bytes(f.originKeyId, 32);
    w.bytes(f.originPublicKeyDer, 91);
    w.uuid(f.ackEventId);
    w.bytes(f.ackDigest, 32);
    w.time(f.receivedAtMs);
    w.time(f.forwardingExpiresAtMs);
  } else if (f.purpose === 3) {
    w.bytes(f.rootKeyId, 32);
    w.uuid(f.grantId);
    w.bytes(f.issuerKeyId, 32);
    w.bytes(f.issuerPublicKeyDer, 91);
    w.bytes(f.issuerProviderId, 32);
    w.uuid(f.responderId);
    w.string(f.callsign, 'callsign');
    w.uint(f.statusMask, 1);
    w.uint(f.purposeMask, 1);
    w.string(f.scope, 'scope');
    w.time(f.notBeforeMs);
    w.time(f.expiresAtMs);
  } else if (f.purpose === 4) {
    w.uuid(f.proofId);
    w.bytes(f.signerProviderId, 32);
    w.bytes(f.signerKeyId, 32);
    w.uuid(f.grantId, true);
    w.uuid(f.signerBootSessionId, true);
    w.bytes(f.verifierId, 32);
    w.uuid(f.verifierBootSessionId);
    w.bytes(f.nonce, 32);
    w.bytes(f.parentCheckpointDigest, 32);
    w.time(f.signedTimeMs);
    w.time(f.elapsedSinceCheckpointMs);
    w.uint(f.uncertaintyMs, 4);
    w.time(f.validUntilMs);
  } else throw new Error('Invalid receipt purpose');
  return w.build();
}
function decode(bytes: Bytes, member: boolean): DecodedReceipt {
  check(
    bytes.length >= 80 && bytes.length <= MAX_RECEIPT_BYTES,
    'total length',
  );
  const r = new Reader(Buffer.from(bytes));
  const magic = r.take(4).toString('latin1'),
    version = r.u8(),
    algorithm = r.u8(),
    purpose = r.u8(),
    flags = r.u8();
  check(
    version === 2 &&
      algorithm === 1 &&
      purpose >= 1 &&
      purpose <= 4 &&
      magic === MAGIC[purpose - 1] &&
      flags === 0,
    'header',
  );
  const bl = r.u16(),
    pl = r.u16(),
    sl = r.u16(),
    reserved = r.u16();
  check(
    sl === 64 && reserved === 0 && 16 + bl + pl + 64 === bytes.length,
    'lengths',
  );
  check(!member || pl === 0, 'proof depth');
  const fields = readBody(purpose, r.take(bl)),
    proof = r.take(pl),
    signature = r.take(64);
  r.finish();
  signatureCheck(signature);
  const members: DecodedReceipt[] = [];
  if (pl) {
    const pr = new Reader(proof),
      count = pr.u8();
    check(count >= 1 && count <= 2, 'proof count');
    const seen = new Set<string>();
    for (let i = 0; i < count; i++) {
      const b = pr.take(pr.u16()),
        id = createHash('sha256').update(b).digest('hex');
      check(!seen.has(id), 'duplicate proof');
      seen.add(id);
      members.push(decode(b, true));
    }
    pr.finish();
  }
  if (fields.purpose === 1)
    check(
      fields.providerKind === 1
        ? members.length === 0
        : members.length === 1 && members[0]!.fields.purpose === 3,
      'ACK proof',
    );
  else if (fields.purpose === 4 && fields.grantId !== NIL)
    check(
      members.length === 2 &&
        members[0]!.fields.purpose === 3 &&
        members[1]!.fields.purpose === 4 &&
        members[1]!.fields.grantId === NIL,
      'time proof',
    );
  else check(members.length === 0, 'proof profile');
  return { fields, signature, proof };
}
export function decodeReceipt(bytes: Bytes): DecodedReceipt {
  return decode(bytes, false);
}
export function encodeReceipt(
  fields: ReceiptFields,
  signature: Bytes,
  proof: Bytes,
): Buffer {
  const body = writeBody(fields),
    w = new Writer();
  check(
    fields.purpose >= 1 &&
      fields.purpose <= 4 &&
      body.length + proof.length + 80 <= MAX_RECEIPT_BYTES,
    'total length',
  );
  w.bytes(Buffer.from(MAGIC[fields.purpose - 1]!));
  w.uint(2, 1);
  w.uint(1, 1);
  w.uint(fields.purpose, 1);
  w.uint(0, 1);
  w.uint(body.length, 2);
  w.uint(proof.length, 2);
  w.uint(64, 2);
  w.uint(0, 2);
  w.bytes(body);
  w.bytes(proof);
  w.bytes(signature, 64);
  const bytes = w.build();
  decodeReceipt(bytes);
  return bytes;
}
export function verifyReceiptSignature(
  receipt: DecodedReceipt,
  publicKey: Bytes,
): boolean {
  try {
    validateReceiptPublicKey(publicKey);
    const b = encodeReceipt(receipt.fields, receipt.signature, receipt.proof);
    return verify(
      'sha256',
      Buffer.concat([DOMAIN, b.subarray(0, -64)]),
      {
        key: createPublicKey({
          key: Buffer.from(publicKey),
          format: 'der',
          type: 'spki',
        }),
        dsaEncoding: 'ieee-p1363',
      },
      receipt.signature,
    );
  } catch {
    return false;
  }
}
