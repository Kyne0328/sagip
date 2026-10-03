import {TextDecoder} from 'node:util';

import type {DecodedEmergencyPayload} from './emergencyPayload.js';
import {decodeEmergencyPayloadV1} from './emergencyPayloadV1.js';
import {protocolFailure} from './errors.js';

const MAX_MESSAGE_BYTES = 500;
const MAX_PAYLOAD_BYTES = 532;

export function decodeEmergencyPayloadV2(bytes: Buffer): DecodedEmergencyPayload {
  if (bytes.length < 10 || bytes.length > MAX_PAYLOAD_BYTES) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Invalid emergency payload length');
  }
  if (bytes[4] !== 2) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Unsupported emergency payload version');
  }

  const prefixLength = bytes[7] === 1 ? 30 : 8;
  if (bytes.length < prefixLength + 2) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Truncated location or message length');
  }
  // Reuse the unchanged v1 enum, magic and location validation on a bounded copy.
  const prefix = Buffer.from(bytes.subarray(0, prefixLength));
  prefix[4] = 1;
  const decoded = decodeEmergencyPayloadV1(prefix);
  const messageLength = bytes.readUInt16BE(prefixLength);
  if (messageLength > MAX_MESSAGE_BYTES || bytes.length !== prefixLength + 2 + messageLength) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Invalid message length or trailing bytes');
  }
  if (messageLength === 0) {
    return {...decoded, message: null};
  }

  let message: string;
  try {
    // ignoreBOM preserves a valid leading U+FEFF; fatal rejects malformed bytes.
    message = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true})
      .decode(bytes.subarray(prefixLength + 2));
  } catch (error) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Message is not valid UTF-8', error);
  }
  return {...decoded, message};
}
