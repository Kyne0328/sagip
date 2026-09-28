import {verifyEnvelopeV1, type VerifiedEnvelopeV1} from './envelopeV1.js';
import {verifyEnvelopeV2, type VerifiedEnvelopeV2} from './envelopeV2.js';
import {protocolFailure} from './errors.js';

export type VerifiedTransportEnvelope =
  | {protocolVersion: 1; envelope: VerifiedEnvelopeV1}
  | {protocolVersion: 2; envelope: VerifiedEnvelopeV2};

export function verifyTransportEnvelope(bytes: Buffer): VerifiedTransportEnvelope {
  if (bytes.length < 4) {
    throw protocolFailure('MALFORMED_ENVELOPE', 'Envelope is truncated');
  }
  const magic = bytes.subarray(0, 4).toString('ascii');
  if (magic === 'SGP1') {
    return {protocolVersion: 1, envelope: verifyEnvelopeV1(bytes)};
  }
  if (magic === 'SGP2') {
    return {protocolVersion: 2, envelope: verifyEnvelopeV2(bytes)};
  }
  throw protocolFailure('UNSUPPORTED_PROTOCOL', 'Unsupported transport envelope magic');
}
