import assert from 'node:assert/strict';
import test from 'node:test';

import {decodeEmergencyPayloadV1} from '../../src/protocol/emergencyPayloadV1.js';

function hex(value: string): Buffer {
  return Buffer.from(value, 'hex');
}

test('decodes the Android SRP1 no-location golden vector', () => {
  const decoded = decodeEmergencyPayloadV1(hex('5352503101010100'));

  assert.deepEqual(decoded, {
    emergencyType: 1,
    urgency: 1,
    location: null,
  });
});

test('decodes the Android SRP1 GPS-location golden vector', () => {
  const decoded = decodeEmergencyPayloadV1(
    hex('535250310102020100dec54c073612880000032000000000000004b00101'),
  );

  assert.deepEqual(decoded, {
    emergencyType: 2,
    urgency: 2,
    location: {
      latitude: 14.5995,
      longitude: 120.9842,
      accuracyMeters: 8,
      capturedAtMs: 1200n,
      source: 1,
      freshness: 1,
    },
  });
});

test('rejects invalid SRP1 enum values and coordinate ranges', () => {
  assert.throws(
    () => decodeEmergencyPayloadV1(hex('5352503101090100')),
    /emergency type/i,
  );

  const invalidLatitude = Buffer.from(
    '5352503101010101' +
      '055d4a81' +
      '00000000' +
      'ffffffff' +
      '0000000000000000' +
      '01' +
      '01',
    'hex',
  );
  assert.throws(() => decodeEmergencyPayloadV1(invalidLatitude), /latitude/i);
});

test('rejects trailing SRP1 bytes', () => {
  assert.throws(
    () => decodeEmergencyPayloadV1(hex('535250310101010000')),
    /payload length|trailing/i,
  );
});
