import {protocolFailure} from './errors.js';

export interface DecodedLocationV1 {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  capturedAtMs: bigint;
  source: 1 | 2;
  freshness: 1 | 2;
}

export interface DecodedEmergencyPayloadV1 {
  emergencyType: 1 | 2 | 3 | 4 | 5 | 6;
  urgency: 1 | 2;
  location: DecodedLocationV1 | null;
}

const HEADER_BYTES = 8;
const LOCATION_BYTES = 22;

export function decodeEmergencyPayloadV1(bytes: Buffer): DecodedEmergencyPayloadV1 {
  if (bytes.length !== HEADER_BYTES && bytes.length !== HEADER_BYTES + LOCATION_BYTES) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Invalid emergency payload length');
  }
  if (bytes.subarray(0, 4).toString('ascii') !== 'SRP1') {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Invalid emergency payload magic');
  }
  if (bytes[4] !== 1) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Unsupported emergency payload version');
  }

  const emergencyType = bytes[5];
  if (emergencyType === undefined || emergencyType < 1 || emergencyType > 6) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Unknown emergency type code');
  }
  const urgency = bytes[6];
  if (urgency !== 1 && urgency !== 2) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Unknown urgency code');
  }
  const locationPresent = bytes[7];
  if (locationPresent !== 0 && locationPresent !== 1) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Invalid location flag');
  }

  if (locationPresent === 0) {
    if (bytes.length !== HEADER_BYTES) {
      throw protocolFailure('MALFORMED_PAYLOAD', 'Unexpected trailing location bytes');
    }
    return {
      emergencyType: emergencyType as DecodedEmergencyPayloadV1['emergencyType'],
      urgency,
      location: null,
    };
  }

  if (bytes.length !== HEADER_BYTES + LOCATION_BYTES) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Missing location bytes');
  }

  const latitudeE6 = bytes.readInt32BE(8);
  const longitudeE6 = bytes.readInt32BE(12);
  const accuracyCm = bytes.readInt32BE(16);
  const capturedAtMs = bytes.readBigInt64BE(20);
  const source = bytes[28];
  const freshness = bytes[29];

  if (latitudeE6 < -90_000_000 || latitudeE6 > 90_000_000) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Latitude is out of range');
  }
  if (longitudeE6 < -180_000_000 || longitudeE6 > 180_000_000) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Longitude is out of range');
  }
  if (accuracyCm < -1) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Accuracy is out of range');
  }
  if (capturedAtMs < 0n) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'capturedAtMs must not be negative');
  }
  if (source !== 1 && source !== 2) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Unknown location source code');
  }
  if (freshness !== 1 && freshness !== 2) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Unknown location freshness code');
  }

  return {
    emergencyType: emergencyType as DecodedEmergencyPayloadV1['emergencyType'],
    urgency,
    location: {
      latitude: latitudeE6 / 1_000_000,
      longitude: longitudeE6 / 1_000_000,
      accuracyMeters: accuracyCm === -1 ? null : accuracyCm / 100,
      capturedAtMs,
      source,
      freshness,
    },
  };
}
