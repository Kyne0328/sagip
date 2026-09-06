import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';

import type {Pool, PoolClient, QueryResultRow} from 'pg';

import type {AcceptedEnvelopeInput, ServerReceipt} from './types.js';

export class IngestionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestionConflictError';
  }
}

interface AcceptedMessageRow extends QueryResultRow {
  message_id: string;
  report_id: string;
  revision: number;
  origin_key_id: Buffer;
  envelope_sha256: Buffer;
}

interface ReceiptRow extends QueryResultRow {
  receipt_version: number;
  state: 'SERVER_ACCEPTED';
  receipt_id: string;
  message_id: string;
  report_id: string;
  revision: number;
  accepted_at: Date | string;
}

export class IngestionRepository {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}

  async accept(input: AcceptedEnvelopeInput): Promise<ServerReceipt> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const receipt = await this.acceptInTransaction(client, input);
        await client.query('COMMIT');
        return receipt;
      } catch (error) {
        await rollbackQuietly(client);
        throw error;
      }
    } finally {
      client.release();
    }
  }

  private async acceptInTransaction(
    client: PoolClient,
    input: AcceptedEnvelopeInput,
  ): Promise<ServerReceipt> {
    const {envelope, acceptedAt, bytes} = input;
    const envelopeSha256 = createHash('sha256').update(bytes).digest();

    await client.query(
      `INSERT INTO origin_keys(origin_key_id, public_key_der, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (origin_key_id) DO NOTHING`,
      [envelope.originKeyId, envelope.originPublicKeyDer, acceptedAt],
    );
    await this.requireOriginKeyContinuity(client, envelope.originKeyId, envelope.originPublicKeyDer);
    await client.query(
      `UPDATE origin_keys SET last_seen_at = $2
       WHERE origin_key_id = $1 AND last_seen_at < $2`,
      [envelope.originKeyId, acceptedAt],
    );

    const existingMessage = await this.findAcceptedMessage(client, envelope.messageId);
    if (existingMessage !== null) {
      this.requireSameAcceptedMessage(existingMessage, input, envelopeSha256);
      return this.requireReceipt(client, envelope.messageId);
    }

    await client.query(
      `INSERT INTO incidents(report_id, origin_key_id, created_at_ms, first_received_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (report_id) DO NOTHING`,
      [envelope.reportId, envelope.originKeyId, envelope.createdAtMs.toString(), acceptedAt],
    );
    await this.requireIncidentOrigin(client, envelope.reportId, envelope.originKeyId);

    const location = envelope.emergencyPayload.location;
    await client.query(
      `INSERT INTO incident_revisions(
         report_id, revision, emergency_type, urgency, payload_digest,
         location_latitude_e6, location_longitude_e6, location_accuracy_cm,
         location_captured_at_ms, location_source, location_freshness
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (report_id, revision) DO NOTHING`,
      [
        envelope.reportId,
        envelope.revision,
        envelope.emergencyPayload.emergencyType,
        envelope.emergencyPayload.urgency,
        envelope.payloadDigest,
        location === null ? null : Math.round(location.latitude * 1_000_000),
        location === null ? null : Math.round(location.longitude * 1_000_000),
        location?.accuracyMeters === null || location === null
          ? null
          : Math.round(location.accuracyMeters * 100),
        location === null ? null : location.capturedAtMs.toString(),
        location?.source ?? null,
        location?.freshness ?? null,
      ],
    );

    await client.query(
      `INSERT INTO accepted_messages(
         message_id, report_id, revision, origin_key_id, envelope_sha256, envelope_bytes,
         created_at_ms, expires_at_ms, priority, accepted_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING`,
      [
        envelope.messageId,
        envelope.reportId,
        envelope.revision,
        envelope.originKeyId,
        envelopeSha256,
        bytes,
        envelope.createdAtMs.toString(),
        envelope.expiresAtMs?.toString() ?? null,
        envelope.priority,
        acceptedAt,
      ],
    );

    const acceptedMessage = await this.findAcceptedMessage(client, envelope.messageId);
    if (acceptedMessage === null) {
      const owner = await client.query<{message_id: string}>(
        `SELECT message_id FROM accepted_messages
         WHERE report_id = $1 AND revision = $2`,
        [envelope.reportId, envelope.revision],
      );
      if ((owner.rowCount ?? 0) > 0) {
        throw new IngestionConflictError('Report revision is already bound to another message');
      }
      throw new Error('Accepted message insert did not persist and no conflicting owner was found');
    }
    this.requireSameAcceptedMessage(acceptedMessage, input, envelopeSha256);

    await client.query(
      `INSERT INTO server_receipts(
         message_id, receipt_id, receipt_version, state, accepted_at
       ) VALUES ($1, $2, 1, 'SERVER_ACCEPTED', $3)
       ON CONFLICT (message_id) DO NOTHING`,
      [envelope.messageId, randomUUID(), acceptedAt],
    );

    return this.requireReceipt(client, envelope.messageId);
  }

  private async requireOriginKeyContinuity(
    client: PoolClient,
    keyId: Buffer,
    publicKeyDer: Buffer,
  ): Promise<void> {
    const result = await client.query<{public_key_der: Buffer}>(
      'SELECT public_key_der FROM origin_keys WHERE origin_key_id = $1',
      [keyId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('Origin key disappeared during ingestion');
    }
    if (!buffersEqual(row.public_key_der, publicKeyDer)) {
      throw new IngestionConflictError('Origin key ID is bound to different public-key bytes');
    }
  }

  private async requireIncidentOrigin(
    client: PoolClient,
    reportId: string,
    originKeyId: Buffer,
  ): Promise<void> {
    const result = await client.query<{origin_key_id: Buffer}>(
      'SELECT origin_key_id FROM incidents WHERE report_id = $1',
      [reportId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('Incident disappeared during ingestion');
    }
    if (!buffersEqual(row.origin_key_id, originKeyId)) {
      throw new IngestionConflictError('Report ID is already bound to another origin key');
    }
  }

  private async findAcceptedMessage(
    client: PoolClient,
    messageId: string,
  ): Promise<AcceptedMessageRow | null> {
    const result = await client.query<AcceptedMessageRow>(
      `SELECT message_id, report_id, revision, origin_key_id, envelope_sha256
       FROM accepted_messages WHERE message_id = $1`,
      [messageId],
    );
    return result.rows[0] ?? null;
  }

  private requireSameAcceptedMessage(
    existing: AcceptedMessageRow,
    input: AcceptedEnvelopeInput,
    envelopeSha256: Buffer,
  ): void {
    const {envelope} = input;
    if (
      existing.report_id !== envelope.reportId ||
      existing.revision !== envelope.revision ||
      !buffersEqual(existing.origin_key_id, envelope.originKeyId) ||
      !buffersEqual(existing.envelope_sha256, envelopeSha256)
    ) {
      throw new IngestionConflictError('Message ID is already bound to different immutable content');
    }
  }

  private async requireReceipt(client: PoolClient, messageId: string): Promise<ServerReceipt> {
    const result = await client.query<ReceiptRow>(
      `SELECT r.receipt_version, r.state, r.receipt_id, r.message_id,
              m.report_id, m.revision, r.accepted_at
       FROM server_receipts r
       JOIN accepted_messages m ON m.message_id = r.message_id
       WHERE r.message_id = $1`,
      [messageId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('Accepted message has no canonical server receipt');
    }
    if (row.receipt_version !== 1 || row.state !== 'SERVER_ACCEPTED') {
      throw new Error('Stored server receipt has an unsupported canonical state');
    }
    return {
      receiptVersion: 1,
      state: 'SERVER_ACCEPTED',
      receiptId: row.receipt_id,
      messageId: row.message_id,
      reportId: row.report_id,
      revision: row.revision,
      acceptedAt: toIsoTimestamp(row.accepted_at),
    };
  }
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
  const normalizedLeft = Buffer.from(left);
  const normalizedRight = Buffer.from(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    timingSafeEqual(normalizedLeft, normalizedRight)
  );
}

function toIsoTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Stored receipt timestamp is invalid');
  }
  return date.toISOString();
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original ingestion failure.
  }
}
