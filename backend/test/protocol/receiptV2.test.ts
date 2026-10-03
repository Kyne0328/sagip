import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
// Boundary mutations supplement the shared signed vectors.
import {
  decodeReceipt,
  encodeReceipt,
  verifyReceiptSignature,
  canonicalizeNewReceiptSignature,
} from '../../src/protocol/receiptV2.js';
const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../fixtures/receipts-v2/golden.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  vectors: Array<{
    name: string;
    hex: string;
    publicKeyDerHex: string;
    expected: { parse: string; signature?: boolean };
  }>;
};
test('new signature normalization preserves crypto validity; received high-S still rejects', () => {
  const cloud = fixture.vectors.find(v => v.name === 'valid_cloud_ack')!;
  const high = Buffer.from(
    fixture.vectors.find(v => v.name === 'high_s_signature')!.hex,
    'hex',
  );
  const original = decodeReceipt(Buffer.from(cloud.hex, 'hex'));
  assert.throws(() => decodeReceipt(high));
  const raw = Buffer.from(high.subarray(-64));
  const normalized = canonicalizeNewReceiptSignature(raw);
  assert.deepEqual(normalized, original.signature);
  assert.deepEqual(raw, high.subarray(-64));
  assert.equal(
    verifyReceiptSignature(
      { ...original, signature: normalized },
      Buffer.from(cloud.publicKeyDerHex, 'hex'),
    ),
    true,
  );
  assert.throws(() => canonicalizeNewReceiptSignature(Buffer.alloc(64)));
  assert.throws(() => canonicalizeNewReceiptSignature(Buffer.alloc(65)));
});
for (const v of fixture.vectors) {
  test(`shared vector: ${v.name}`, () => {
    const bytes = Buffer.from(v.hex, 'hex');
    if (v.expected.parse === 'REJECT') {
      assert.throws(() => decodeReceipt(bytes));
      return;
    }
    const decoded = decodeReceipt(bytes);
    assert.deepEqual(
      encodeReceipt(decoded.fields, decoded.signature, decoded.proof),
      bytes,
    );

    assert.equal(
      verifyReceiptSignature(decoded, Buffer.from(v.publicKeyDerHex, 'hex')),
      v.expected.signature,
    );
  });
}
test('field mutations cannot retain valid signature and boundaries reject', () => {
  const v = fixture.vectors.find(x => x.name === 'valid_cloud_ack')!;
  const bytes = Buffer.from(v.hex, 'hex');
  const decoded = decodeReceipt(bytes);
  assert.equal(decoded.fields.purpose, 1);
  if (decoded.fields.purpose !== 1) throw new Error('wrong fixture purpose');
  decoded.fields.status = 2;
  assert.equal(
    verifyReceiptSignature(decoded, Buffer.from(v.publicKeyDerHex, 'hex')),
    false,
  );
  decoded.fields.note = 'x'.repeat(1025);
  assert.throws(() =>
    encodeReceipt(decoded.fields, decoded.signature, decoded.proof),
  );
  decoded.fields.note = '\ud800';
  assert.throws(() =>
    encodeReceipt(decoded.fields, decoded.signature, decoded.proof),
  );
  assert.throws(() => decodeReceipt(Buffer.alloc(8193)));
  assert.equal(
    verifyReceiptSignature(decodeReceipt(bytes), Buffer.alloc(91)),
    false,
  );
});

test('hostile field encodings and nested proofs reject before authority', () => {
  const raw = Buffer.from(
    fixture.vectors.find(x => x.name === 'valid_cloud_ack')!.hex,
    'hex',
  );
  const rejectMutation = (mutate: (b: Buffer) => void) => {
    const b = Buffer.from(raw);
    mutate(b);
    assert.throws(() => decodeReceipt(b));
  };
  rejectMutation(b => {
    b[0] = b[0]! | 0x80;
  });
  rejectMutation(b => {
    b.fill(0, 49, 65);
  });
  rejectMutation(b => {
    b[113] = 3;
  });
  const status = 248 + raw.readUInt16BE(246) + 8;
  rejectMutation(b => {
    b[status] = 0;
  });
  rejectMutation(b => {
    b.fill(0xff, status + 1, status + 9);
  });
  rejectMutation(b => {
    b[status + 27] = 0xc0;
  });
  const grant = Buffer.from(
    fixture.vectors.find(x => x.name === 'valid_grant')!.hex,
    'hex',
  );
  const badKey = Buffer.from(grant);
  badKey.fill(0, 123, 187);
  assert.throws(() => decodeReceipt(badKey));
  const nested = Buffer.concat([
    Buffer.from([1, grant.length >> 8, grant.length & 255]),
    grant,
  ]);
  const nestedGrant = Buffer.concat([
    grant.subarray(0, -64),
    nested,
    grant.subarray(-64),
  ]);
  nestedGrant.writeUInt16BE(nested.length, 10);
  const proof = Buffer.concat([
    Buffer.from([1, nestedGrant.length >> 8, nestedGrant.length & 255]),
    nestedGrant,
  ]);
  const offline = decodeReceipt(
    Buffer.from(
      fixture.vectors.find(x => x.name === 'valid_offline_ack')!.hex,
      'hex',
    ),
  );
  assert.throws(() => encodeReceipt(offline.fields, offline.signature, proof));
});

test('UTF-8 byte order marker is preserved inside signed note', () => {
  const v = fixture.vectors.find(x => x.name === 'valid_cloud_ack')!;
  const decoded = decodeReceipt(Buffer.from(v.hex, 'hex'));
  if (decoded.fields.purpose !== 1) throw new Error('fixture purpose');
  decoded.fields.note = '\ufeffnotice';
  const bytes = encodeReceipt(decoded.fields, decoded.signature, decoded.proof);
  const roundTrip = decodeReceipt(bytes);
  assert.equal(roundTrip.fields.purpose, 1);
  if (roundTrip.fields.purpose === 1)
    assert.equal(roundTrip.fields.note, '\ufeffnotice');
});
