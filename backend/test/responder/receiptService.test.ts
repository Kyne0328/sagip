import assert from 'node:assert/strict';
import { createHash, randomUUID, sign } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, copyFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { applyMigrations } from '../../src/db/migrate.js';
import { IngestionRepository } from '../../src/ingestion/repository.js';
import { verifyEnvelopeV1 } from '../../src/protocol/envelopeV1.js';
import {
  decodeReceipt,
  verifyReceiptSignature,
} from '../../src/protocol/receiptV2.js';
import {
  actionDigest,
  issuerProviderId,
  verifyReceipt,
} from '../../src/responder/receiptAuthority.js';
import {
  ReceiptService,
  type ActionIntent,
  type AuthoritySigner,
} from '../../src/responder/receiptService.js';
import { ResponderService } from '../../src/responder/service.js';
import {
  buildSignedEnvelope,
  createTestIdentity,
} from '../support/envelopeFactory.js';
import { createIsolatedPostgres } from '../support/realPostgres.js';

const NIL = '00000000-0000-0000-0000-000000000000';
const N = BigInt(
  '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
);
async function setup() {
  const database = await createIsolatedPostgres(),
    pool = database.pool;
  try {
    await applyMigrations(
      pool,
      fileURLToPath(new URL('../../migrations/', import.meta.url)),
    );
    const identity = createTestIdentity(),
      root = createTestIdentity();
    const bytes = buildSignedEnvelope({ identity }),
      envelope = verifyEnvelopeV1(bytes);
    const ingestion = new IngestionRepository(pool);
    await ingestion.accept({ bytes, envelope, acceptedAt: new Date() });
    const responder = {
      responderId: randomUUID(),
      callsign: 'TEST TEAM',
      role: 'RESPONDER',
      registeredAt: new Date().toISOString(),
    };
    await pool.query(
      'INSERT INTO responder_identities VALUES ($1,$2,$3,$4,$5)',
      [
        responder.responderId,
        responder.callsign,
        responder.role,
        'a'.repeat(64),
        responder.registeredAt,
      ],
    );
    let now = 1700000000000,
      failures = 0,
      calls = 0;
    const signer: AuthoritySigner = {
      publicKeyDer: root.publicKeyDer,
      sign: async input => {
        calls++;
        if (failures-- > 0) throw new Error('signer unavailable');
        const result = sign('sha256', input, {
          key: root.privateKey,
          dsaEncoding: 'ieee-p1363',
        });
        const s = BigInt('0x' + result.subarray(32).toString('hex'));
        if (s > N / 2n)
          Buffer.from((N - s).toString(16).padStart(64, '0'), 'hex').copy(
            result,
            32,
          );
        return result;
      },
    };
    const service = new ReceiptService(pool, signer, () => now);
    const provider = issuerProviderId(
      1,
      createHash('sha256').update(root.publicKeyDer).digest(),
      NIL,
    );
    const intent = (overrides: Partial<ActionIntent> = {}) => {
      const i = {
        actionId: randomUUID(),
        providerKind: 1,
        issuerProviderId: provider,
        reportId: envelope.reportId,
        reportProtocolVersion: 1,
        revision: 1,
        payloadDigest: envelope.payloadDigest,
        originKeyId: envelope.originKeyId,
        responderId: responder.responderId,
        observedIncidentVersion: 1n,
        status: 1,
        note: '',
        actionDigest: Buffer.alloc(32),
        ...overrides,
      };
      i.actionDigest = actionDigest({
        ...i,
        purpose: 1,
        issuerKeyId: Buffer.alloc(32),
        grantId: NIL,
        callsign: responder.callsign,
        sequence: 1n,
        issuedAtMs: now,
        forwardingExpiresAtMs: now + 604800000,
      });
      return i;
    };
    return {
      pool,
      service,
      signer,
      intent,
      responder,
      envelope,
      identity,
      ingestion,
      advance: () => {
        now += 60001;
      },
      failNext: () => {
        failures = 1;
      },
      calls: () => calls,
      close: database.close,
    };
  } catch (e) {
    await database.close();
    throw e;
  }
}
test('action_identity_and_crash_recovery with real concurrent transactions', async () => {
  const f = await setup();
  try {
    const i = f.intent();
    const allocated = await Promise.all(
      Array.from({ length: 8 }, () => f.service.allocateAction(i, f.responder)),
    );
    assert.ok(
      allocated.every(a => a.sequence === 1n && a.actionId === i.actionId),
    );
    f.failNext();
    assert.equal(
      (await f.service.prepareReceipt(i.actionId)).state,
      'PREPARING',
    );
    f.advance();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => f.service.prepareReceipt(i.actionId)),
    );
    assert.ok(results.some(r => r.state === 'SIGNED'));
    const bytes = await f.service.getReceipt(i.actionId);
    assert.ok(bytes);
    const restarted = new ReceiptService(f.pool, f.signer, () => 1700000060001);
    assert.deepEqual(await restarted.getReceipt(i.actionId), bytes);
    assert.equal((await restarted.prepareReceipt(i.actionId)).state, 'SIGNED');
    assert.deepEqual(await restarted.getReceipt(i.actionId), bytes);
    assert.equal(
      verifyReceiptSignature(decodeReceipt(bytes), f.signer.publicKeyDer),
      true,
    );
    assert.equal(
      (await restarted.allocateAction(i, f.responder)).actionId,
      i.actionId,
    );
    await assert.rejects(
      restarted.allocateAction(
        f.intent({ actionId: i.actionId, note: 'changed' }),
        f.responder,
      ),
      /ACTION_CONFLICT/,
    );
    await assert.rejects(
      restarted.allocateAction(
        f.intent({ actionId: i.actionId, issuerProviderId: Buffer.alloc(32) }),
        f.responder,
      ),
      /PROVIDER_CONFLICT/,
    );
    assert.equal(f.calls(), 2);
  } finally {
    await f.close();
  }
});
test('untrusted identities and stale revisions cannot reserve action UUIDs or sequences', async () => {
  const f = await setup();
  try {
    const i = f.intent();
    await assert.rejects(
      f.service.allocateAction(i, {
        ...f.responder,
        responderId: randomUUID(),
      }),
      /UNAUTHORIZED/,
    );
    await assert.rejects(
      f.service.allocateAction(
        { ...i, actionDigest: Buffer.alloc(32) },
        f.responder,
      ),
      /DIGEST_CONFLICT/,
    );
    await assert.rejects(
      f.service.allocateAction(
        f.intent({ observedIncidentVersion: 0n }),
        f.responder,
      ),
      /INCIDENT_VERSION_CONFLICT/,
    );
    assert.equal(
      (await f.pool.query('SELECT * FROM receipt_actions')).rowCount,
      0,
    );
    const a = await f.service.allocateAction(i, f.responder);
    assert.equal(a.sequence, 1n);
    await f.service.prepareReceipt(i.actionId);
    await assert.rejects(
      f.service.allocateAction(f.intent(), f.responder),
      /INCIDENT_VERSION_CONFLICT/,
    );
    const next = await f.service.allocateAction(
      f.intent({ observedIncidentVersion: 2n, status: 2 }),
      f.responder,
    );
    assert.equal(next.sequence, 2n);
    const bytes = buildSignedEnvelope({
      identity: f.identity,
      reportId: f.envelope.reportId,
      messageId: randomUUID(),
      revision: 2,
    });
    await f.ingestion.accept({
      bytes,
      envelope: verifyEnvelopeV1(bytes),
      acceptedAt: new Date(),
    });
    await assert.rejects(
      f.service.allocateAction(
        f.intent({ observedIncidentVersion: 3n }),
        f.responder,
      ),
      /REPORT_IDENTITY_CONFLICT/,
    );
    assert.equal(
      (await f.pool.query('SELECT receipt_version FROM incidents')).rows[0]
        .receipt_version,
      '3',
    );
    await f.ingestion.accept({
      bytes,
      envelope: verifyEnvelopeV1(bytes),
      acceptedAt: new Date(),
    });
    assert.equal(
      (await f.pool.query('SELECT receipt_version FROM incidents')).rows[0]
        .receipt_version,
      '3',
    );
  } finally {
    await f.close();
  }
});
test('expired lease cannot overwrite canonical signature and late sequence stays historical', async () => {
  const f = await setup();
  try {
    const i = f.intent(),
      second = f.intent({ status: 2 });
    await f.service.allocateAction(i, f.responder);
    await f.service.allocateAction(second, f.responder);
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(r => {
      entered = r;
    });
    const slow = new ReceiptService(
      f.pool,
      {
        publicKeyDer: f.signer.publicKeyDer,
        sign: async input => {
          const signature = await f.signer.sign(input);
          entered();
          return new Promise<Uint8Array>(r => {
            release = () => r(signature);
          });
        },
      },
      () => 1700000000000,
    );
    const pending = slow.prepareReceipt(i.actionId);
    await ready;
    f.advance();
    await f.service.prepareReceipt(second.actionId);
    await f.service.prepareReceipt(i.actionId);
    const winner = await f.service.getReceipt(i.actionId);
    release();
    await pending;
    assert.deepEqual(await f.service.getReceipt(i.actionId), winner);
    const projection = await f.pool.query(
      'SELECT sequence FROM receipt_projections',
    );
    assert.equal(projection.rows[0].sequence, '2');
    assert.equal(
      (await f.pool.query('SELECT receipt_version FROM incidents')).rows[0]
        .receipt_version,
      '2',
    );
    await assert.rejects(
      f.pool.query('UPDATE receipt_records SET object_bytes=$1', [
        Buffer.alloc(1),
      ]),
    );
  } finally {
    await f.close();
  }
});
function failingPool(
  pool: Pool,
  match: (sql: string) => boolean,
  after = false,
): Pick<Pool, 'connect'> {
  let armed = true;
  return {
    connect: async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, key) {
          if (key === 'query')
            return async (sql: string, values?: unknown[]) => {
              if (armed && match(sql)) {
                armed = false;
                if (after) await target.query(sql, values);
                throw new Error('injected crash');
              }
              return target.query(sql, values);
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as PoolClient;
    },
  };
}
test('allocation and signed-record rollback leave no partial side effects; unknown commit is idempotent', async () => {
  const f = await setup();
  try {
    const i = f.intent();
    const before = new ReceiptService(
      failingPool(f.pool, s => s.startsWith('INSERT INTO receipt_actions')),
      f.signer,
      () => 1700000000000,
    );
    await assert.rejects(
      before.allocateAction(i, f.responder),
      /injected crash/,
    );
    assert.equal(
      (await f.pool.query('SELECT * FROM receipt_sequences')).rowCount,
      0,
    );
    assert.equal(
      (await f.pool.query('SELECT * FROM receipt_actions')).rowCount,
      0,
    );
    const lostAllocation = new ReceiptService(
      failingPool(f.pool, s => s === 'COMMIT', true),
      f.signer,
      () => 1700000000000,
    );
    await assert.rejects(
      lostAllocation.allocateAction(i, f.responder),
      /injected crash/,
    );
    assert.equal((await f.service.allocateAction(i, f.responder)).sequence, 1n);
    const beforeCommit = new ReceiptService(
      failingPool(f.pool, s =>
        s.startsWith('UPDATE receipt_actions SET preparation_state'),
      ),
      f.signer,
      () => 1700000000000,
    );
    await assert.rejects(
      beforeCommit.prepareReceipt(i.actionId),
      /injected crash/,
    );
    assert.equal(await f.service.getReceipt(i.actionId), null);
    assert.equal(
      (await f.pool.query('SELECT * FROM receipt_projections')).rowCount,
      0,
    );
    assert.equal(
      (await f.pool.query('SELECT receipt_version FROM incidents')).rows[0]
        .receipt_version,
      '1',
    );
    f.advance();
    // Lease claim is one transaction; inject the lost acknowledgement only on
    // the later signed-record COMMIT, after its bytes really become durable.
    let commits = 0;
    const lostCommit = new ReceiptService(
      failingPool(f.pool, s => s === 'COMMIT' && ++commits === 2, true),
      f.signer,
      () => 1700000060001,
    );
    await assert.rejects(
      lostCommit.prepareReceipt(i.actionId),
      /injected crash/,
    );
    const canonical = await f.service.getReceipt(i.actionId);
    assert.ok(canonical);
    assert.equal((await f.service.prepareReceipt(i.actionId)).state, 'SIGNED');
    assert.deepEqual(await f.service.getReceipt(i.actionId), canonical);
    await applyMigrations(
      f.pool,
      fileURLToPath(new URL('../../migrations/', import.meta.url)),
    );
    assert.deepEqual(await f.service.getReceipt(i.actionId), canonical);
  } finally {
    await f.close();
  }
});
test('verified foreign action reservation blocks cloud reissuance', async () => {
  const f = await setup();
  try {
    const golden = JSON.parse(
      readFileSync(
        new URL(
          '../../../sagip-docs/fixtures/receipts-v2/golden.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const expected = golden.trustedContext;
    const bytes = Buffer.from(
      golden.vectors.find(
        (v: { name: string }) => v.name === 'valid_offline_ack',
      ).hex,
      'hex',
    );
    assert.equal(
      verifyReceipt(bytes, {
        roots: new Map([
          [
            expected.rootKeyId,
            Buffer.from(expected.rootPublicKeyDerHex, 'hex'),
          ],
        ]),
        revokedGrants: new Set(),
        allowedScopes: new Set(expected.allowedScopes),
        trustedTime: expected.trustedTime,
        authorityCheckedAtMs: expected.authorityCheckedAtMs,
        currentAuthorityChecked: true,
        pairedTimeProviderId: expected.gatewayProviderId,
        report: {
          reportId: expected.reportId,
          reportProtocolVersion: 1,
          revision: 1,
          payloadDigest: Buffer.from(expected.payloadDigest, 'hex'),
          originKeyId: Buffer.from(expected.originKeyId, 'hex'),
          originPublicKeyDer: Buffer.from(
            expected.originPublicKeyDerHex,
            'hex',
          ),
        },
      }).kind,
      'VERIFIED_OFFLINE_AUTHORITY',
    );
    const fields = decodeReceipt(bytes).fields;
    assert.equal(fields.purpose, 1);
    if (fields.purpose !== 1) throw new Error('Expected ACK');
    // Model only the durable output of the later G04 authenticated importer.
    await f.pool.query(
      'INSERT INTO receipt_records VALUES ($1,$2,$3,$4,$5,$6)',
      [
        fields.actionId,
        Buffer.from(fields.issuerProviderId),
        Buffer.from(fields.actionDigest),
        createHash('sha256').update(bytes).digest(),
        bytes,
        fields.forwardingExpiresAtMs,
      ],
    );
    await assert.rejects(
      f.service.allocateAction(
        f.intent({ actionId: fields.actionId }),
        f.responder,
      ),
      /ACTION_CONFLICT/,
    );
    assert.equal(
      (await f.pool.query('SELECT * FROM receipt_actions')).rowCount,
      0,
    );
    assert.equal(
      (await f.pool.query('SELECT * FROM receipt_sequences')).rowCount,
      0,
    );
  } finally {
    await f.close();
  }
});
test('allocation owns a bounded copy of the authenticated intent', async () => {
  const f = await setup();
  try {
    const i = f.intent();
    const hostile = Object.assign(i, { unrecognized: 'x'.repeat(100000) });
    const allocated = await f.service.allocateAction(hostile, f.responder);
    assert.equal(Object.hasOwn(allocated, 'unrecognized'), false);
    const stored = (await f.pool.query('SELECT fields FROM receipt_actions'))
      .rows[0].fields;
    assert.equal(Object.hasOwn(stored, 'unrecognized'), false);
    const next = f.intent({ status: 2 }),
      expected = Buffer.from(next.actionDigest);
    const caller = { ...f.responder };
    const pending = f.service.allocateAction(next, caller);
    next.actionDigest.fill(0);
    next.payloadDigest.fill(0);
    next.issuerProviderId.fill(0);
    next.note = 'mutated';
    caller.callsign = 'mutated';
    const owned = await pending;
    assert.deepEqual(owned.actionDigest, expected);
    assert.equal(owned.callsign, f.responder.callsign);
    assert.equal(owned.note, '');
  } finally {
    await f.close();
  }
});
test('sequence exhaustion, expired forwarding and wrong signer never publish evidence', async () => {
  const f = await setup();
  try {
    const i = f.intent();
    await f.service.allocateAction(i, f.responder);
    await f.pool.query(
      "UPDATE receipt_sequences SET sequence='9223372036854775807'",
    );
    await assert.rejects(
      f.service.allocateAction(f.intent({ status: 2 }), f.responder),
      /bigint out of range/,
    );
    assert.equal(
      (await f.pool.query('SELECT * FROM receipt_actions')).rowCount,
      1,
    );
    const wrong = createTestIdentity();
    const invalid = new ReceiptService(
      f.pool,
      {
        publicKeyDer: f.signer.publicKeyDer,
        sign: async input => {
          const bytes = sign('sha256', input, {
            key: wrong.privateKey,
            dsaEncoding: 'ieee-p1363',
          });
          const s = BigInt('0x' + bytes.subarray(32).toString('hex'));
          if (s > N / 2n)
            Buffer.from((N - s).toString(16).padStart(64, '0'), 'hex').copy(
              bytes,
              32,
            );
          return bytes;
        },
      },
      () => 1700000000000,
    );
    assert.equal((await invalid.prepareReceipt(i.actionId)).state, 'REJECTED');
    assert.equal(await f.service.getReceipt(i.actionId), null);
    const expired = new ReceiptService(
      f.pool,
      f.signer,
      () => 1700000000000 + 604800000,
    );
    assert.equal(
      (await expired.prepareReceipt(i.actionId)).reason,
      'FORWARDING_EXPIRED',
    );
    assert.equal(await expired.getReceipt(i.actionId), null);
  } finally {
    await f.close();
  }
});
test('real additive migration backfills accepted revisions and preserves legacy bytes and queries', async () => {
  const database = await createIsolatedPostgres(),
    { pool } = database;
  const directory = await mkdtemp(
    path.join(tmpdir(), 'sagip-receipt-upgrade-'),
  );
  try {
    const migrations = fileURLToPath(
      new URL('../../migrations/', import.meta.url),
    );
    for (const name of [
      '001_ingestion_v1.sql',
      '002_responder_v1.sql',
      '003_distributed_rate_limit.sql',
      '004_responder_sessions.sql',
    ])
      await copyFile(path.join(migrations, name), path.join(directory, name));
    await applyMigrations(pool, directory);
    const identity = createTestIdentity(),
      bytes = buildSignedEnvelope({ identity }),
      e = verifyEnvelopeV1(bytes);
    // Seed the pre-005 accepted rows using their unchanged legacy SQL shapes.
    await pool.query('INSERT INTO origin_keys VALUES ($1,$2,NOW(),NOW())', [
      e.originKeyId,
      e.originPublicKeyDer,
    ]);
    await pool.query('INSERT INTO incidents VALUES ($1,$2,$3,NOW())', [
      e.reportId,
      e.originKeyId,
      e.createdAtMs.toString(),
    ]);
    await pool.query(
      'INSERT INTO incident_revisions(report_id,revision,emergency_type,urgency,payload_digest) VALUES ($1,1,1,1,$2)',
      [e.reportId, e.payloadDigest],
    );
    await pool.query(
      'INSERT INTO accepted_messages VALUES ($1,$2,1,$3,$4,$5,$6,NULL,0,NOW())',
      [
        e.messageId,
        e.reportId,
        e.originKeyId,
        createHash('sha256').update(bytes).digest(),
        bytes,
        e.createdAtMs.toString(),
      ],
    );
    await pool.query(
      "INSERT INTO server_receipts VALUES ($1,$2,1,'SERVER_ACCEPTED',NOW())",
      [e.messageId, randomUUID()],
    );
    await applyMigrations(pool, migrations);
    await applyMigrations(pool, migrations);
    assert.equal(
      (await pool.query('SELECT receipt_version FROM incidents')).rows[0]
        .receipt_version,
      '1',
    );
    assert.deepEqual(
      (await pool.query('SELECT envelope_bytes FROM accepted_messages')).rows[0]
        .envelope_bytes,
      bytes,
    );
    // The unchanged legacy responder implementation still reads the expanded
    // schema and its canonical v1 receipt independently of v2 evidence.
    const legacy = new ResponderService(pool);
    assert.equal(
      (await legacy.getIncidentDetail(e.reportId))?.latestRevision,
      1,
    );
    assert.equal(
      (await legacy.getReportStatus(e.reportId))?.reportId,
      e.reportId,
    );
    const accepted = await new IngestionRepository(pool).accept({
      bytes,
      envelope: e,
      acceptedAt: new Date(),
    });
    assert.equal(accepted.messageId, e.messageId);
    assert.equal(
      (await pool.query('SELECT receipt_version FROM incidents')).rows[0]
        .receipt_version,
      '1',
    );
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('migration ledger stays isolated when a public ledger already exists', async () => {
  assert.ok(process.env.SAGIP_TEST_DATABASE_URL);
  const admin = new Pool({
    connectionString: process.env.SAGIP_TEST_DATABASE_URL,
  });
  const name = 'sagip_migration_test_' + randomUUID().replaceAll('-', '');
  let created = false;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    created = true;
    const url = new URL(process.env.SAGIP_TEST_DATABASE_URL);
    url.pathname = '/' + name;
    const publicPool = new Pool({ connectionString: url.toString() });
    try {
      await publicPool.query(
        'CREATE TABLE public.schema_migrations (name TEXT PRIMARY KEY,checksum_sha256 TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL)',
      );
      await publicPool.query(
        "INSERT INTO public.schema_migrations VALUES ('untouched','marker',NOW())",
      );
      const isolated = await createIsolatedPostgres(url.toString());
      try {
        await applyMigrations(
          isolated.pool,
          fileURLToPath(new URL('../../migrations/', import.meta.url)),
        );
        assert.equal(
          (await isolated.pool.query('SELECT * FROM schema_migrations'))
            .rowCount,
          6,
        );
        assert.deepEqual(
          (
            await publicPool.query(
              'SELECT name,checksum_sha256 FROM public.schema_migrations',
            )
          ).rows,
          [{ name: 'untouched', checksum_sha256: 'marker' }],
        );
      } finally {
        await isolated.close();
      }
    } finally {
      await publicPool.end();
    }
  } finally {
    if (created) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
});
