import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {applyMigrations} from '../src/db/migrate.js';
import {decodeReceipt} from '../src/protocol/receiptV2.js';
import {ReceiptService, type AuthoritySigner} from '../src/responder/receiptService.js';

const golden = JSON.parse(
  readFileSync(new URL('../../fixtures/receipts-v2/golden.json', import.meta.url), 'utf8'),
) as {
  trustedContext: {
    rootPublicKeyDerHex: string;
    originPublicKeyDerHex: string;
    originKeyId: string;
    reportId: string;
    payloadDigest: string;
    trustedTime: {earliestMs: number};
  };
  vectors: Array<{name: string; hex: string}>;
};

function vector(name: string): Buffer {
  const found = golden.vectors.find(v => v.name === name);
  if (!found) throw new Error(`missing fixture ${name}`);
  return Buffer.from(found.hex, 'hex');
}

async function seed(pool: Pool): Promise<{importer: {responderId: string; callsign: string; role: string; registeredAt: string}}> {
  const context = golden.trustedContext;
  const originKeyId = Buffer.from(context.originKeyId, 'hex');
  await pool.query('INSERT INTO origin_keys VALUES ($1,$2,NOW(),NOW())', [
    originKeyId,
    Buffer.from(context.originPublicKeyDerHex, 'hex'),
  ]);
  await pool.query(
    'INSERT INTO incidents(report_id,origin_key_id,created_at_ms,first_received_at) VALUES ($1,$2,1,NOW())',
    [context.reportId, originKeyId],
  );
  await pool.query(
    'INSERT INTO incident_revisions(report_id,revision,emergency_type,urgency,payload_digest) VALUES ($1,1,1,1,$2)',
    [context.reportId, Buffer.from(context.payloadDigest, 'hex')],
  );
  const envelope = Buffer.alloc(5);
  envelope[4] = 1;
  await pool.query(
    `INSERT INTO accepted_messages(message_id,report_id,revision,origin_key_id,envelope_sha256,envelope_bytes,created_at_ms,expires_at_ms,priority,accepted_at)
     VALUES ($1,$2,1,$3,$4,$5,1,NULL,1,NOW())`,
    [randomUUID(), context.reportId, originKeyId, createHash('sha256').update(envelope).digest(), envelope],
  );
  const importer = {
    responderId: randomUUID(),
    callsign: 'G04-IMPORTER',
    role: 'RESPONDER',
    registeredAt: new Date().toISOString(),
  };
  await pool.query('INSERT INTO responder_identities VALUES ($1,$2,$3,$4,$5)', [
    importer.responderId,
    importer.callsign,
    importer.role,
    'd'.repeat(64),
    importer.registeredAt,
  ]);
  const grantBytes = vector('valid_grant');
  const grant = decodeReceipt(grantBytes).fields;
  assert.equal(grant.purpose, 3);
  if (grant.purpose !== 3) throw new Error('expected grant fixture');
  await pool.query(
    `INSERT INTO receipt_authority_grants(grant_id,provisioning_request_id,request_digest,issuer_provider_id,issuer_key_id,root_key_id,object_bytes,not_before_ms,expires_at_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      grant.grantId,
      randomUUID(),
      createHash('sha256').update(grantBytes).digest(),
      Buffer.from(grant.issuerProviderId),
      Buffer.from(grant.issuerKeyId),
      Buffer.from(grant.rootKeyId),
      grantBytes,
      grant.notBeforeMs,
      grant.expiresAtMs,
    ],
  );
  return {importer};
}

test('G04 real PostgreSQL reconciliation preserves exact bytes under concurrency, rollback and reconnect', async () => {
  const connectionString = process.env.SAGIP_ACCEPTANCE_DATABASE_URL;
  assert.ok(
    connectionString,
    'G04 acceptance requires isolated real PostgreSQL: set SAGIP_ACCEPTANCE_DATABASE_URL',
  );
  const admin = new Pool({connectionString});
  const schema = 'g04_acceptance_' + randomUUID().replaceAll('-', '');
  await admin.query(`CREATE SCHEMA ${schema}`);
  let pool = new Pool({connectionString, options: `-c search_path=${schema}`});
  const signer: AuthoritySigner = {
    publicKeyDer: Buffer.from(golden.trustedContext.rootPublicKeyDerHex, 'hex'),
    sign: async () => {
      throw new Error('acceptance import must not sign or re-sign foreign receipts');
    },
  };
  try {
    const migrations = fileURLToPath(new URL('../migrations/', import.meta.url));
    await applyMigrations(pool, migrations);
    await applyMigrations(pool, migrations);
    const {importer} = await seed(pool);
    const service = new ReceiptService(pool, signer, () => golden.trustedContext.trustedTime.earliestMs);
    const cloud = vector('valid_cloud_ack');

    const results = await Promise.all(
      Array.from({length: 8}, () => service.importGatewayReceipt(cloud, importer)),
    );
    assert.equal(results.filter(r => r.state === 'IMPORTED').length, 1);
    assert.equal(results.filter(r => r.state === 'DUPLICATE').length, 7);
    assert.equal((await pool.query('SELECT * FROM receipt_records')).rowCount, 1);
    assert.equal((await pool.query('SELECT * FROM receipt_projections')).rowCount, 1);
    assert.equal(Number((await pool.query('SELECT receipt_version FROM incidents WHERE report_id=$1', [golden.trustedContext.reportId])).rows[0].receipt_version), 1);
    const stored = (await pool.query('SELECT issuer_provider_id,object_bytes FROM receipt_records')).rows[0];
    assert.deepEqual(stored.object_bytes, cloud);
    assert.deepEqual(stored.issuer_provider_id, Buffer.from(decodeReceipt(cloud).fields.purpose === 1 ? decodeReceipt(cloud).fields.issuerProviderId : Buffer.alloc(0)));

    const beforeRollback = (await pool.query('SELECT COUNT(*)::int AS count FROM receipt_records')).rows[0].count;
    await pool.query('ALTER TABLE receipt_projections RENAME TO receipt_projections_unavailable');
    await assert.rejects(() => service.importGatewayReceipt(vector('valid_offline_ack'), importer));
    await pool.query('ALTER TABLE receipt_projections_unavailable RENAME TO receipt_projections');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM receipt_records')).rows[0].count, beforeRollback);

    await pool.end();
    pool = new Pool({connectionString, options: `-c search_path=${schema}`});
    const afterReconnect = (await pool.query('SELECT issuer_provider_id,object_bytes,event_digest FROM receipt_records')).rows[0];
    assert.deepEqual(afterReconnect.object_bytes, cloud);
    assert.deepEqual(afterReconnect.issuer_provider_id, stored.issuer_provider_id);
    assert.deepEqual(afterReconnect.event_digest, createHash('sha256').update(cloud).digest());
  } finally {
    await pool.end().catch(() => undefined);
    try {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await admin.end();
    }
  }
});
