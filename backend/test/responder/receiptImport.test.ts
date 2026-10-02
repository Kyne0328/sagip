import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, randomUUID, sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {applyMigrations} from '../../src/db/migrate.js';
import {createMemoryPostgresPool} from '../../src/db/memoryPool.js';
import {canonicalizeNewReceiptSignature, decodeReceipt} from '../../src/protocol/receiptV2.js';
import {ReceiptService, type AuthoritySigner} from '../../src/responder/receiptService.js';

const golden = JSON.parse(
  readFileSync(
    new URL('../../../sagip-docs/fixtures/receipts-v2/golden.json', import.meta.url),
    'utf8',
  ),
) as {
  trustedContext: {
    rootPublicKeyDerHex: string;
    rootKeyId: string;
    originPublicKeyDerHex: string;
    originKeyId: string;
    reportId: string;
    payloadDigest: string;
    allowedScopes: string[];
    trustedTime: {earliestMs: number; latestMs: number};
  };
  vectors: Array<{name: string; hex: string}>;
};

function vector(name: string): Buffer {
  const found = golden.vectors.find(v => v.name === name);
  if (!found) throw new Error(`missing fixture ${name}`);
  return Buffer.from(found.hex, 'hex');
}

async function setup(options: {
  newerRevision?: boolean;
  gatewayGrant?: 'active' | 'revoked';
} = {}) {
  const pool = createMemoryPostgresPool();
  await applyMigrations(
    pool,
    fileURLToPath(new URL('../../migrations/', import.meta.url)),
  );
  const context = golden.trustedContext;
  const originKeyId = Buffer.from(context.originKeyId, 'hex');
  const originPublicKeyDer = Buffer.from(context.originPublicKeyDerHex, 'hex');
  const payloadDigest = Buffer.from(context.payloadDigest, 'hex');
  await pool.query('INSERT INTO origin_keys VALUES ($1,$2,NOW(),NOW())', [originKeyId, originPublicKeyDer]);
  await pool.query(
    'INSERT INTO incidents(report_id,origin_key_id,created_at_ms,first_received_at) VALUES ($1,$2,1,NOW())',
    [context.reportId, originKeyId],
  );
  await pool.query(
    'INSERT INTO incident_revisions(report_id,revision,emergency_type,urgency,payload_digest) VALUES ($1,1,1,1,$2)',
    [context.reportId, payloadDigest],
  );
  const envelope1 = Buffer.alloc(5);
  envelope1[4] = 1;
  await pool.query(
    'INSERT INTO accepted_messages(message_id,report_id,revision,origin_key_id,envelope_sha256,envelope_bytes,created_at_ms,expires_at_ms,priority,accepted_at) VALUES ($1,$2,1,$3,$4,$5,1,NULL,1,NOW())',
    [randomUUID(), context.reportId, originKeyId, createHash('sha256').update(envelope1).digest(), envelope1],
  );
  if (options.newerRevision) {
    const payload2 = createHash('sha256').update('revision-2').digest();
    const envelope2 = Buffer.alloc(5);
    envelope2[4] = 1;
    await pool.query(
      'INSERT INTO incident_revisions(report_id,revision,emergency_type,urgency,payload_digest) VALUES ($1,2,1,1,$2)',
      [context.reportId, payload2],
    );
    await pool.query(
      'INSERT INTO accepted_messages(message_id,report_id,revision,origin_key_id,envelope_sha256,envelope_bytes,created_at_ms,expires_at_ms,priority,accepted_at) VALUES ($1,$2,2,$3,$4,$5,2,NULL,1,NOW())',
      [randomUUID(), context.reportId, originKeyId, createHash('sha256').update(envelope2).digest(), envelope2],
    );
  }
  const importer = {
    responderId: randomUUID(),
    callsign: 'IMPORTER-1',
    role: 'RESPONDER',
    registeredAt: new Date().toISOString(),
  };
  await pool.query('INSERT INTO responder_identities VALUES ($1,$2,$3,$4,$5)', [
    importer.responderId,
    importer.callsign,
    importer.role,
    'b'.repeat(64),
    importer.registeredAt,
  ]);
  const signer: AuthoritySigner = {
    publicKeyDer: Buffer.from(context.rootPublicKeyDerHex, 'hex'),
    sign: async () => {
      throw new Error('not used by importer');
    },
  };
  if (options.gatewayGrant) {
    const grantBytes = vector('valid_grant');
    const grant = decodeReceipt(grantBytes).fields;
    assert.equal(grant.purpose, 3);
    if (grant.purpose !== 3) throw new Error('expected grant');
    await pool.query(
      `INSERT INTO receipt_authority_grants(grant_id,provisioning_request_id,request_digest,issuer_provider_id,issuer_key_id,root_key_id,object_bytes,not_before_ms,expires_at_ms,revoked_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
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
        options.gatewayGrant === 'revoked'
          ? golden.trustedContext.trustedTime.earliestMs
          : null,
      ],
    );
  }
  return {
    pool,
    importer,
    service: new ReceiptService(pool, signer, () => context.trustedTime.earliestMs),
    close: () => pool.end(),
  };
}

test('import_is_atomic_immutable_and_conflict_explicit', async () => {
  const f = await setup();
  try {
    const bytes = vector('valid_cloud_ack');
    const first = await f.service.importGatewayReceipt(bytes, f.importer);
    assert.equal(first.state, 'IMPORTED');
    assert.equal(first.projection, 'APPLIED');
    const stored = await f.pool.query('SELECT event_id,event_digest,object_bytes FROM receipt_records');
    assert.equal(stored.rowCount, 1);
    assert.deepEqual(stored.rows[0].object_bytes, bytes);

    const duplicate = await f.service.importGatewayReceipt(bytes, f.importer);
    assert.equal(duplicate.state, 'DUPLICATE');
    assert.equal((await f.pool.query('SELECT * FROM receipt_records')).rowCount, 1);

    await f.pool.query('UPDATE receipt_records SET event_digest=$1 WHERE event_id=$2', [Buffer.alloc(32, 7), first.eventId]);
    const conflict = await f.service.importGatewayReceipt(bytes, f.importer);
    assert.equal(conflict.state, 'REJECTED');
    assert.equal(conflict.projection, 'CONFLICT');
    assert.equal(conflict.reason, 'EVENT_EQUIVOCATION');
    assert.deepEqual(
      (await f.pool.query('SELECT object_bytes FROM receipt_records WHERE event_id=$1', [first.eventId])).rows[0].object_bytes,
      bytes,
    );
    const quarantined = await f.pool.query('SELECT object_bytes,reason FROM receipt_quarantine');
    assert.equal(quarantined.rowCount, 1);
    assert.deepEqual(quarantined.rows[0].object_bytes, bytes);
    assert.equal(quarantined.rows[0].reason, 'EVENT_EQUIVOCATION');
  } finally {
    await f.close();
  }
});

test('revoked issuer is quarantined without replacing current projection', async () => {
  const f = await setup({gatewayGrant: 'revoked'});
  try {
    const result = await f.service.importGatewayReceipt(vector('valid_offline_ack'), f.importer);
    assert.equal(result.state, 'QUARANTINED');
    assert.equal(result.projection, 'NONE');
    assert.equal(result.reason, 'REVOKED_GRANT');
    assert.equal((await f.pool.query('SELECT * FROM receipt_records')).rowCount, 0);
    const quarantine = await f.pool.query('SELECT object_bytes,reason FROM receipt_quarantine');
    assert.equal(quarantine.rowCount, 1);
    assert.deepEqual(quarantine.rows[0].object_bytes, vector('valid_offline_ack'));
    assert.equal(quarantine.rows[0].reason, 'REVOKED_GRANT');
    assert.equal((await f.pool.query('SELECT * FROM receipt_projections')).rowCount, 0);

    await f.pool.query('UPDATE receipt_authority_grants SET revoked_at_ms=NULL');
    const promoted = await f.service.importGatewayReceipt(vector('valid_offline_ack'), f.importer);
    assert.equal(promoted.state, 'IMPORTED');
    assert.equal(promoted.projection, 'APPLIED');
    assert.equal((await f.pool.query('SELECT * FROM receipt_quarantine')).rowCount, 0);
    assert.equal((await f.pool.query('SELECT * FROM receipt_records')).rowCount, 1);
  } finally {
    await f.close();
  }
});

test('stale revision remains immutable history and does not replace a newer report projection', async () => {
  const f = await setup({newerRevision: true});
  try {
    const bytes = vector('valid_cloud_ack');
    const result = await f.service.importGatewayReceipt(bytes, f.importer);
    assert.equal(result.state, 'IMPORTED');
    assert.equal(result.projection, 'HISTORICAL');
    assert.deepEqual((await f.pool.query('SELECT object_bytes FROM receipt_records')).rows[0].object_bytes, bytes);
    assert.equal((await f.pool.query('SELECT * FROM receipt_projections')).rowCount, 0);
  } finally {
    await f.close();
  }
});


test('requester receipt derives provider from exact linked ack and missing linkage stays unclaimed', async () => {
  const f = await setup({gatewayGrant: 'active'});
  try {
    const ackBytes = vector('valid_offline_ack');
    const ack = await f.service.importGatewayReceipt(ackBytes, f.importer);
    assert.equal(ack.state, 'IMPORTED');
    assert.equal(ack.projection, 'APPLIED');

    const requesterBytes = vector('valid_requester_receipt');
    const requester = await f.service.importGatewayReceipt(requesterBytes, f.importer);
    assert.equal(requester.state, 'IMPORTED');
    assert.equal(requester.projection, 'NONE');
    assert.deepEqual(requester.issuerProviderId, ack.issuerProviderId);
    assert.deepEqual(
      (await f.pool.query('SELECT object_bytes FROM receipt_records WHERE event_id=$1', [requester.eventId])).rows[0].object_bytes,
      requesterBytes,
    );
  } finally {
    await f.close();
  }

  const missing = await setup({gatewayGrant: 'active'});
  try {
    const result = await missing.service.importGatewayReceipt(
      vector('valid_requester_receipt'),
      missing.importer,
    );
    assert.equal(result.state, 'QUARANTINED');
    assert.equal(result.projection, 'NONE');
    assert.equal(result.reason, 'ACK_LINKAGE');
    assert.equal(result.issuerProviderId, null);
    const quarantined = await missing.pool.query('SELECT object_bytes,reason FROM receipt_quarantine');
    assert.equal(quarantined.rowCount, 1);
    assert.deepEqual(quarantined.rows[0].object_bytes, vector('valid_requester_receipt'));
    assert.equal(quarantined.rows[0].reason, 'ACK_LINKAGE');
    assert.equal((await missing.pool.query('SELECT * FROM receipt_records')).rowCount, 0);
  } finally {
    await missing.close();
  }
});


test('action status is scoped to the authenticated responder owner', async () => {
  const f = await setup();
  try {
    const fields = decodeReceipt(vector('valid_cloud_ack')).fields;
    assert.equal(fields.purpose, 1);
    if (fields.purpose !== 1) throw new Error('expected responder receipt');
    const owner = {
      responderId: fields.responderId,
      callsign: fields.callsign,
      role: 'RESPONDER',
      registeredAt: new Date(0).toISOString(),
    };
    await f.pool.query('INSERT INTO responder_identities VALUES ($1,$2,$3,$4,$5)', [
      owner.responderId, owner.callsign, owner.role, 'c'.repeat(64), owner.registeredAt,
    ]);
    const jsonFields = {
      ...fields,
      issuerProviderId: Buffer.from(fields.issuerProviderId).toString('hex'),
      actionDigest: Buffer.from(fields.actionDigest).toString('hex'),
      payloadDigest: Buffer.from(fields.payloadDigest).toString('hex'),
      originKeyId: Buffer.from(fields.originKeyId).toString('hex'),
      issuerKeyId: Buffer.from(fields.issuerKeyId).toString('hex'),
      sequence: fields.sequence.toString(),
      observedIncidentVersion: fields.observedIncidentVersion.toString(),
    };
    await f.pool.query(
      'INSERT INTO receipt_actions(action_id,issuer_provider_id,action_digest,issuer_key_id,grant_id,report_id,responder_id,sequence,fields,preparation_state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [fields.actionId, Buffer.from(fields.issuerProviderId), Buffer.from(fields.actionDigest), Buffer.from(fields.issuerKeyId), fields.grantId, fields.reportId, fields.responderId, fields.sequence.toString(), jsonFields, 'PREPARING'],
    );

    const own = await f.service.getActionResult(fields.actionId, owner);
    assert.equal(own?.state, 'PREPARING');
    assert.equal(own?.actionId, fields.actionId);
    assert.equal(await f.service.getActionResult(fields.actionId, f.importer), null);
  } finally {
    await f.close();
  }
});


test('receipt import persists report metadata required for bounded authorized polling', async () => {
  const f = await setup();
  try {
    const result = await f.service.importGatewayReceipt(vector('valid_cloud_ack'), f.importer);
    assert.equal(result.state, 'IMPORTED');
    const row = (await f.pool.query(
      'SELECT report_id,revision,object_kind,verification,recorded_at_ms FROM receipt_records WHERE event_id=$1',
      [result.eventId],
    )).rows[0];
    assert.equal(row.report_id, golden.trustedContext.reportId);
    assert.equal(Number(row.revision), 1);
    assert.equal(row.object_kind, 'SGA2');
    assert.equal(row.verification, 'VERIFIED_CURRENT');
    assert.equal(Number(row.recorded_at_ms), golden.trustedContext.trustedTime.earliestMs);
  } finally {
    await f.close();
  }
});


function uuidBytes(value: string): Buffer {
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}
function u64(value: number): Buffer {
  const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value)); return b;
}

test('origin receipt access challenge is one-use and gates bounded exact polling', async () => {
  const pool = createMemoryPostgresPool();
  await applyMigrations(pool, fileURLToPath(new URL('../../migrations/', import.meta.url)));
  const pair = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const publicDer = pair.publicKey.export({format: 'der', type: 'spki'}) as Buffer;
  const originKeyId = createHash('sha256').update(publicDer).digest();
  const reportId = '77777777-7777-4777-8777-777777777777';
  const payloadDigest = createHash('sha256').update('origin-access-report').digest();
  await pool.query('INSERT INTO origin_keys VALUES ($1,$2,NOW(),NOW())', [originKeyId, publicDer]);
  await pool.query('INSERT INTO incidents(report_id,origin_key_id,created_at_ms,first_received_at) VALUES ($1,$2,1,NOW())', [reportId, originKeyId]);
  await pool.query('INSERT INTO incident_revisions(report_id,revision,emergency_type,urgency,payload_digest) VALUES ($1,1,1,1,$2)', [reportId, payloadDigest]);
  const envelope = Buffer.alloc(5); envelope[4] = 1;
  await pool.query('INSERT INTO accepted_messages(message_id,report_id,revision,origin_key_id,envelope_sha256,envelope_bytes,created_at_ms,expires_at_ms,priority,accepted_at) VALUES ($1,$2,1,$3,$4,$5,1,NULL,1,NOW())', [randomUUID(), reportId, originKeyId, createHash('sha256').update(envelope).digest(), envelope]);
  const receiptBytes = vector('valid_cloud_ack');
  const eventId = '88888888-8888-4888-8888-888888888888';
  await pool.query(
    'INSERT INTO receipt_records(event_id,issuer_provider_id,action_digest,event_digest,object_bytes,forwarding_expires_at_ms,report_id,revision,object_kind,verification,recorded_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10)',
    [eventId, Buffer.alloc(32,9), Buffer.alloc(32,8), createHash('sha256').update(receiptBytes).digest(), receiptBytes, 9999999999999, reportId, 'SGA2', 'VERIFIED_CURRENT', 1790812810000],
  );
  const signer: AuthoritySigner = {publicKeyDer: Buffer.from(golden.trustedContext.rootPublicKeyDerHex, 'hex'), sign: async () => { throw new Error('unused'); }};
  const now = 1790812810000;
  const service = new ReceiptService(pool, signer, () => now);
  try {
    const challenge = await service.createReceiptAccessChallenge(reportId);
    assert.deepEqual(challenge.originKeyId, originKeyId);
    const domain = Buffer.concat([
      Buffer.from('SAGIP-ORIGIN-READ-V1', 'ascii'), Buffer.from([0]),
      uuidBytes(challenge.challengeId), uuidBytes(reportId), originKeyId, challenge.nonce, u64(challenge.expiresAtMs),
    ]);
    const signature = canonicalizeNewReceiptSignature(sign('sha256', domain, {key: pair.privateKey, dsaEncoding: 'ieee-p1363'}));
    const session = await service.authorizeReceiptAccess(reportId, challenge.challengeId, signature);
    assert.equal(typeof session.sessionToken, 'string');
    await assert.rejects(() => service.authorizeReceiptAccess(reportId, challenge.challengeId, signature), /CHALLENGE_CONSUMED/);
    const page = await service.listReportReceipts(reportId, session.sessionToken, null);
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0]?.eventId, eventId);
    assert.equal(page.entries[0]?.bytesBase64, receiptBytes.toString('base64'));
    assert.equal(page.entries[0]?.verification, 'VERIFIED_CURRENT');

    for (let i = 0; i < 33; i += 1) {
      const nextId = `90000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      await pool.query(
        'INSERT INTO receipt_records(event_id,issuer_provider_id,action_digest,event_digest,object_bytes,forwarding_expires_at_ms,report_id,revision,object_kind,verification,recorded_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10)',
        [nextId, Buffer.alloc(32,9), Buffer.alloc(32,8), createHash('sha256').update(receiptBytes).digest(), receiptBytes, 9999999999999, reportId, 'SGA2', 'VERIFIED_CURRENT', now + i + 1],
      );
    }
    const firstPage = await service.listReportReceipts(reportId, session.sessionToken, null);
    assert.equal(firstPage.entries.length, 32);
    assert.ok(firstPage.nextCursor);
    const secondPage = await service.listReportReceipts(reportId, session.sessionToken, firstPage.nextCursor);
    assert.equal(secondPage.entries.length, 2);
    assert.equal(secondPage.nextCursor, null);

    const tamperedCursor = firstPage.nextCursor.slice(0, -1) +
      (firstPage.nextCursor.endsWith('A') ? 'B' : 'A');
    await assert.rejects(
      () => service.listReportReceipts(reportId, session.sessionToken, tamperedCursor),
      /INVALID_CURSOR/,
    );

    const secondChallenge = await service.createReceiptAccessChallenge(reportId);
    const secondDomain = Buffer.concat([
      Buffer.from('SAGIP-ORIGIN-READ-V1', 'ascii'), Buffer.from([0]),
      uuidBytes(secondChallenge.challengeId), uuidBytes(reportId), originKeyId,
      secondChallenge.nonce, u64(secondChallenge.expiresAtMs),
    ]);
    const secondSignature = canonicalizeNewReceiptSignature(sign('sha256', secondDomain, {
      key: pair.privateKey, dsaEncoding: 'ieee-p1363',
    }));
    const secondSession = await service.authorizeReceiptAccess(
      reportId, secondChallenge.challengeId, secondSignature,
    );
    await assert.rejects(
      () => service.listReportReceipts(reportId, secondSession.sessionToken, firstPage.nextCursor),
      /INVALID_CURSOR/,
    );
    await assert.rejects(() => service.listReportReceipts(reportId, 'not-the-session', null), /UNAUTHORIZED/);
  } finally {
    await pool.end();
  }
});
