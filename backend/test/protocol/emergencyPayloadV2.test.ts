import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import {decodeEmergencyPayload} from '../../src/protocol/emergencyPayload.js';
import {decodeEmergencyPayloadV2} from '../../src/protocol/emergencyPayloadV2.js';
import {ProtocolValidationError} from '../../src/protocol/errors.js';

interface Fixture {
  name: string;
  hex: string;
  byteLength: number;
  expected: {
    accepted: boolean;
    emergencyType?: number;
    urgency?: number;
    location?: {capturedAtMs: number};
    message?: string | null;
  };
}
const fixtures = JSON.parse(readFileSync(new URL('../../../fixtures/srp1-details-v2.json', import.meta.url), 'utf8')) as {cases: Fixture[]};

for (const fixture of fixtures.cases) {
  test(`frozen SRP1 vector: ${fixture.name}`, () => {
    const bytes = Buffer.from(fixture.hex, 'hex');
    assert.equal(bytes.length, fixture.byteLength);
    if (!fixture.expected.accepted) {
      assert.throws(() => decodeEmergencyPayload(bytes), (error: unknown) =>
        error instanceof ProtocolValidationError && error.code === 'MALFORMED_PAYLOAD');
      return;
    }
    const expected = fixture.expected;
    assert.deepEqual(decodeEmergencyPayload(bytes), {
      emergencyType: expected.emergencyType,
      urgency: expected.urgency,
      message: expected.message,
      location: expected.location ? {...expected.location, capturedAtMs: BigInt(expected.location.capturedAtMs)} : null,
    });
    if (bytes[4] === 2) {
      assert.deepEqual(decodeEmergencyPayloadV2(bytes), decodeEmergencyPayload(bytes));
    }
  });
}

for (const message of ['\uFEFFHelp', '\uFFFD', '  Help  ']) {
  test(`preserves valid UTF-8 text verbatim: ${JSON.stringify(message)}`, () => {
    const text = Buffer.from(message, 'utf8');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(text.length);
    const bytes = Buffer.concat([Buffer.from('5352503102060100', 'hex'), length, text]);
    assert.equal(decodeEmergencyPayloadV2(bytes).message, message);
  });
}

test('rejects every truncation of a nonempty location-bearing v2 payload', () => {
  const fixture = fixtures.cases.find(value => value.name === 'v2_ascii_fresh_location');
  assert.ok(fixture);
  const bytes = Buffer.from(fixture.hex, 'hex');
  for (let length = 0; length < bytes.length; length++) {
    assert.throws(() => decodeEmergencyPayload(bytes.subarray(0, length)), ProtocolValidationError);
  }
});

test('direct v2 decoder rejects v1 and unknown versions', () => {
  for (const hex of ['5352503101010100', '53525031030601000000']) {
    assert.throws(() => decodeEmergencyPayloadV2(Buffer.from(hex, 'hex')), ProtocolValidationError);
  }
});
