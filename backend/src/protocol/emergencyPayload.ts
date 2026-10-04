import {decodeEmergencyPayloadV1, type DecodedEmergencyPayloadV1} from './emergencyPayloadV1.js';
import {decodeEmergencyPayloadV2} from './emergencyPayloadV2.js';
import {protocolFailure} from './errors.js';

export interface DecodedEmergencyPayload extends DecodedEmergencyPayloadV1 {
  message: string | null;
}

export function decodeEmergencyPayload(bytes: Buffer): DecodedEmergencyPayload {
  switch (bytes[4]) {
    case 1:
      return {...decodeEmergencyPayloadV1(bytes), message: null};
    case 2:
      return decodeEmergencyPayloadV2(bytes);
    default:
      throw protocolFailure('MALFORMED_PAYLOAD', 'Unsupported emergency payload version');
  }
}
