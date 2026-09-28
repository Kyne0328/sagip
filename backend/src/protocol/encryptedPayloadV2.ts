import {protocolFailure} from './errors.js';

export const MAX_SRE2_RECIPIENTS = 8;
export const MAX_SRE2_CIPHERTEXT_BYTES = 1024;
export const MAX_SRE2_BYTES = 4096;

export interface EncryptedRecipientEntryV2 {
  keyId: Buffer;
  ciphertext: Buffer;
}

export interface DecodedEncryptedPayloadV2 {
  plaintextFormat: number;
  recipients: EncryptedRecipientEntryV2[];
}

export function decodeEncryptedPayloadV2(bytes: Buffer): DecodedEncryptedPayloadV2 {
  if (bytes.length > MAX_SRE2_BYTES) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Encrypted payload is too large');
  }
  let offset = 0;
  const take = (length: number, field: string): Buffer => {
    if (length < 0 || offset + length > bytes.length) {
      throw protocolFailure('MALFORMED_PAYLOAD', `${field} is truncated`);
    }
    const out = bytes.subarray(offset, offset + length);
    offset += length;
    return out;
  };
  const u8 = (field: string): number => take(1, field)[0] as number;
  const u16 = (field: string): number => take(2, field).readUInt16BE(0);

  if (take(4, 'encrypted payload magic').toString('ascii') !== 'SRE2') {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Invalid encrypted payload magic');
  }
  if (u8('encrypted payload version') !== 1) {
    throw protocolFailure('UNSUPPORTED_PROTOCOL', 'Unsupported encrypted payload version');
  }
  const plaintextFormat = u8('plaintext format');
  if (plaintextFormat !== 1) {
    throw protocolFailure('UNSUPPORTED_PROTOCOL', 'Unsupported encrypted plaintext format');
  }
  const count = u8('recipient count');
  if (count < 1 || count > MAX_SRE2_RECIPIENTS) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Recipient count is out of range');
  }

  const recipients: EncryptedRecipientEntryV2[] = [];
  let previousKeyId: Buffer | null = null;
  for (let i = 0; i < count; i += 1) {
    const keyId = Buffer.from(take(32, 'recipient key ID'));
    const length = u16('recipient ciphertext length');
    if (length < 1 || length > MAX_SRE2_CIPHERTEXT_BYTES) {
      throw protocolFailure('MALFORMED_PAYLOAD', 'Recipient ciphertext length is out of range');
    }
    const ciphertext = Buffer.from(take(length, 'recipient ciphertext'));
    if (previousKeyId !== null && Buffer.compare(previousKeyId, keyId) >= 0) {
      throw protocolFailure('MALFORMED_PAYLOAD', 'Recipient key IDs must be unique and canonically ordered');
    }
    previousKeyId = keyId;
    recipients.push({keyId, ciphertext});
  }

  if (offset !== bytes.length) {
    throw protocolFailure('MALFORMED_PAYLOAD', 'Trailing encrypted payload bytes');
  }
  return {plaintextFormat, recipients};
}
