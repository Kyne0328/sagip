import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {applyMigrations} from '../../src/db/migrate.js';
import {IngestionService} from '../../src/ingestion/service.js';
import {IncidentSnapshotService} from '../../src/responder/incidentSnapshot.js';
import type {ResponderIdentity} from '../../src/responder/types.js';
import {buildSignedEnvelope, createTestIdentity} from '../support/envelopeFactory.js';
import {createMemoryPostgresPool} from '../support/postgres.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

async function seedResponder(
  pool: ReturnType<typeof createMemoryPostgresPool>,
  identity: ResponderIdentity,
): Promise<void> {
  const tokenHash = createHash('sha256').update(identity.callsign, 'utf8').digest('hex');
  await pool.query(
    `INSERT INTO responder_identities(responder_id,callsign,role,api_key_hash,registered_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [identity.responderId, identity.callsign, identity.role, tokenHash, identity.registeredAt],
  );
}

test('cloud incident snapshot is complete, immutable, owner-bound, cursor-bound, and expires', async () => {
  const pool = createMemoryPostgresPool();
  try {
    await applyMigrations(pool, MIGRATIONS_DIR);
    const ingestion = new IngestionService(pool);
    const origin = createTestIdentity();
    const baseTime = new Date('2026-10-02T12:00:00.000Z');

    for (let index = 0; index < 205; index += 1) {
      await ingestion.ingestEnvelope(
        buildSignedEnvelope({
          identity: origin,
          messageId: randomUUID(),
          reportId: randomUUID(),
          emergencyType: index % 5 + 1,
          urgency: index % 2 + 1,
        }),
        new Date(baseTime.getTime() + index),
      );
    }

    const owner: ResponderIdentity = {
      responderId: randomUUID(),
      callsign: 'SNAPSHOT-OWNER',
      role: 'DISPATCHER',
      registeredAt: baseTime.toISOString(),
    };
    const other: ResponderIdentity = {
      responderId: randomUUID(),
      callsign: 'SNAPSHOT-OTHER',
      role: 'DISPATCHER',
      registeredAt: baseTime.toISOString(),
    };
    await seedResponder(pool, owner);
    await seedResponder(pool, other);

    let now = baseTime.getTime() + 60_000;
    const service = new IncidentSnapshotService(pool, () => now);
    const descriptor = await service.createIncidentSnapshot(owner);
    assert.equal(descriptor.total, 205);
    assert.equal(descriptor.summary.total, 205);
    assert.ok(descriptor.nextCursor);

    await ingestion.ingestEnvelope(
      buildSignedEnvelope({identity: origin, messageId: randomUUID(), reportId: randomUUID()}),
      new Date(baseTime.getTime() + 500_000),
    );

    let cursor: string | null = descriptor.nextCursor;
    const reportIds = new Set<string>();
    let pages = 0;
    while (cursor) {
      await assert.rejects(
        service.readIncidentSnapshotPage(descriptor.snapshotId, cursor, other),
        /SNAPSHOT_NOT_FOUND/u,
      );
      await assert.rejects(
        service.readIncidentSnapshotPage(descriptor.snapshotId, cursor + 'x', owner),
        /SNAPSHOT_NOT_FOUND/u,
      );

      const page = await service.readIncidentSnapshotPage(descriptor.snapshotId, cursor, owner);
      pages += 1;
      assert.equal(page.snapshotId, descriptor.snapshotId);
      assert.equal(page.total, 205);
      assert.equal(page.createdAtMs, descriptor.createdAtMs);
      assert.equal(page.expiresAtMs, descriptor.expiresAtMs);
      assert.deepEqual(page.summary, descriptor.summary);
      assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 4 * 1024 * 1024);
      for (const raw of page.entries) {
        const entry = raw as {reportId: string; payloadDigest: string; originKeyId: string};
        assert.equal(reportIds.has(entry.reportId), false);
        reportIds.add(entry.reportId);
        assert.equal(Buffer.from(entry.payloadDigest, 'base64').length, 32);
        assert.equal(Buffer.from(entry.originKeyId, 'base64').length, 32);
      }
      cursor = page.nextCursor;
    }
    assert.equal(reportIds.size, 205);
    assert.ok(pages >= 3);

    now = descriptor.expiresAtMs;
    await assert.rejects(
      service.readIncidentSnapshotPage(
        descriptor.snapshotId,
        descriptor.nextCursor as string,
        owner,
      ),
      /SNAPSHOT_EXPIRED/u,
    );
  } finally {
    await pool.end();
  }
});

test('cloud incident snapshot capacity is bounded per responder', async () => {
  const pool = createMemoryPostgresPool();
  try {
    await applyMigrations(pool, MIGRATIONS_DIR);
    const ingestion = new IngestionService(pool);
    await ingestion.ingestEnvelope(buildSignedEnvelope(), new Date('2026-10-02T12:00:00.000Z'));
    const owner: ResponderIdentity = {
      responderId: randomUUID(),
      callsign: 'CAPACITY-OWNER',
      role: 'DISPATCHER',
      registeredAt: '2026-10-02T12:00:00.000Z',
    };
    await seedResponder(pool, owner);
    const service = new IncidentSnapshotService(pool, () => Date.parse('2026-10-02T12:01:00.000Z'));

    await service.createIncidentSnapshot(owner);
    await service.createIncidentSnapshot(owner);
    await assert.rejects(service.createIncidentSnapshot(owner), /CAPACITY_FULL/u);
  } finally {
    await pool.end();
  }
});
