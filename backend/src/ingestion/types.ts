import type {VerifiedEnvelopeV1} from '../protocol/envelopeV1.js';

export interface ServerReceipt {
  receiptVersion: 1;
  state: 'SERVER_ACCEPTED';
  receiptId: string;
  messageId: string;
  reportId: string;
  revision: number;
  acceptedAt: string;
}

export interface AcceptedEnvelopeInput {
  bytes: Buffer;
  envelope: VerifiedEnvelopeV1;
  acceptedAt: Date;
}
