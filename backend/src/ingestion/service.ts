import type {Pool} from 'pg';

import {verifyEnvelopeV1} from '../protocol/envelopeV1.js';
import {IngestionConflictError, IngestionRepository} from './repository.js';
import type {ServerReceipt} from './types.js';

export {IngestionConflictError} from './repository.js';
export type {ServerReceipt} from './types.js';

export class IngestionTransientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IngestionTransientError';
  }
}

export class IngestionService {
  private readonly repository: IngestionRepository;

  constructor(pool: Pick<Pool, 'connect'>) {
    this.repository = new IngestionRepository(pool);
  }

  async ingestEnvelope(bytes: Buffer, acceptedAt: Date = new Date()): Promise<ServerReceipt> {
    if (Number.isNaN(acceptedAt.getTime())) {
      throw new TypeError('acceptedAt must be a valid Date');
    }
    const envelope = verifyEnvelopeV1(bytes);
    try {
      return await this.repository.accept({bytes, envelope, acceptedAt});
    } catch (error) {
      if (error instanceof IngestionConflictError) throw error;
      if (isTransientDatabaseFailure(error)) {
        throw new IngestionTransientError('Database is temporarily unavailable', {cause: error});
      }
      throw error;
    }
  }
}

function isTransientDatabaseFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as {code?: unknown}).code;
  if (typeof code !== 'string') return false;
  return (
    code.startsWith('08') ||
    code === '40001' ||
    code === '40P01' ||
    code === '53300' ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH'
  );
}
