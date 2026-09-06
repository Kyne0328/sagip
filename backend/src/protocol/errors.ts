export type ProtocolValidationCode =
  | 'ENVELOPE_TOO_LARGE'
  | 'MALFORMED_ENVELOPE'
  | 'UNSUPPORTED_PROTOCOL'
  | 'INVALID_DIGEST'
  | 'INVALID_PUBLIC_KEY'
  | 'INVALID_SIGNATURE'
  | 'MALFORMED_PAYLOAD';

export class ProtocolValidationError extends Error {
  readonly code: ProtocolValidationCode;

  constructor(code: ProtocolValidationCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProtocolValidationError';
    this.code = code;
  }
}

export function protocolFailure(
  code: ProtocolValidationCode,
  message: string,
  cause?: unknown,
): ProtocolValidationError {
  return new ProtocolValidationError(
    code,
    message,
    cause === undefined ? undefined : {cause},
  );
}
