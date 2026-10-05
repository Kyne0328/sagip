import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {applyMigrations} from '../../src/db/migrate.js';
import {handleSagipRequest} from '../../src/http/handleRequest.js';
import {ResponderService} from '../../src/responder/service.js';
import type {ReceiptService} from '../../src/responder/receiptService.js';
import {parseReportStatusAccessProof, reportStatusAccessDomain} from '../../src/responder/reportStatusAccess.js';
import {createCompatibilityPostgres} from '../support/compatibilityPostgres.js';
import {statusProofHeaders, statusTestIdentity} from '../support/statusProof.js';

test('private victim status requires fresh owner proof, binds report/page, and preserves complete history', async () => {
  const {pool, close} = await createCompatibilityPostgres();
  const owner = statusTestIdentity(), otherOwner = statusTestIdentity();
  const reportId = randomUUID(), otherReportId = randomUUID(), absent = randomUUID();
  const service = new ResponderService(pool);
  const deps = {
    ingestEnvelope: async () => { throw new Error('unused'); },
    responderService: service,
    rateLimiter: {isAllowed: () => true},
  };
  const request = async (id = reportId, headers: Record<string, string> = {}, cursor: string | null = null) =>
    handleSagipRequest(new Request('https://sagip.test/v1/reports/' + id + '/status' +
      (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), {headers}), deps);
  try {
    await applyMigrations(pool, fileURLToPath(new URL('../../migrations/', import.meta.url)));
    for (const [id, identity] of [[reportId, owner], [otherReportId, otherOwner]] as const) {
      const publicKey = identity.publicKey.export({format: 'der', type: 'spki'});
      const keyId = createHash('sha256').update(publicKey).digest();
      await pool.query('INSERT INTO origin_keys VALUES ($1,$2,NOW(),NOW())', [keyId, publicKey]);
      await pool.query('INSERT INTO incidents(report_id,origin_key_id,created_at_ms,first_received_at) VALUES ($1,$2,1,NOW())', [id, keyId]);
      await pool.query('INSERT INTO incident_revisions(report_id,revision,emergency_type,urgency,payload_digest) VALUES ($1,2,1,1,$2)', [id, Buffer.alloc(32, 1)]);
    }
    const eventIds: string[] = [];
    for (let index = 0; index < 103; index += 1) {
      const responderId = randomUUID(), ackId = randomUUID();
      eventIds.push(ackId);
      await pool.query('INSERT INTO responder_identities(responder_id,callsign,role,api_key_hash,registered_at) VALUES ($1,$2,$3,$4,NOW())',
        [responderId, 'UNIT-' + index, 'FIELD_LEAD', String(index).padStart(64, '0')]);
      await pool.query('INSERT INTO responder_acknowledgements(ack_id,report_id,responder_id,status,note,acknowledged_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [ackId, reportId, responderId, index === 0 ? 'RESOLVED' : 'EN_ROUTE', 'Owner-only note ' + index, new Date('2026-10-01T00:00:00.000Z')]);
      if (index === 0) {
        await pool.query('INSERT INTO responder_acknowledgements(ack_id,report_id,responder_id,status,note,acknowledged_at) VALUES ($1,$2,$3,$4,$5,$6)',
          [randomUUID(), otherReportId, responderId, 'ACKNOWLEDGED', 'OTHER_REPORT_PRIVATE_NOTE', new Date('2026-10-01T00:00:00.000Z')]);
      }
    }
    const missing = await request();
    assert.equal(missing.status, 401);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await missing.json(), {error: 'ORIGIN_PROOF_REQUIRED'});
    for (const id of [reportId, absent]) {
      const response = await request(id, statusProofHeaders(id, otherOwner.privateKey));
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {error: 'ORIGIN_PROOF_REQUIRED'});
    }
    for (const age of [-120000, 120000]) {
      assert.equal((await request(reportId, statusProofHeaders(reportId, owner.privateKey, null, Date.now() + age))).status, 401);
    }
    const tampered = statusProofHeaders(reportId, owner.privateKey);
    tampered['x-sagip-status-nonce'] = Buffer.alloc(32, 9).toString('base64');
    assert.equal((await request(reportId, tampered)).status, 401);
    const highS = statusProofHeaders(reportId, owner.privateKey);
    const signature = Buffer.from(highS['x-sagip-status-signature']!, 'base64');
    const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
    Buffer.from((n - BigInt('0x' + signature.subarray(32).toString('hex'))).toString(16).padStart(64, '0'), 'hex').copy(signature, 32);
    highS['x-sagip-status-signature'] = signature.toString('base64');
    assert.equal((await request(reportId, highS)).status, 401);
    assert.equal((await request(otherReportId, statusProofHeaders(reportId, owner.privateKey))).status, 401);

    const replayableProof = statusProofHeaders(reportId, owner.privateKey);
    const firstResponse = await request(reportId, replayableProof);
    // Reads intentionally allow a replay of the identical report/page within 60 seconds.
    assert.equal((await request(reportId, replayableProof)).status, 200);
    assert.equal(firstResponse.status, 200);
    assert.equal(firstResponse.headers.get('cache-control'), 'no-store');
    const first = await firstResponse.json() as {
      reportId: string; currentRevision: number; transport: string; statusScope: string;
      latestAck: {status: string; revision: null}; checkedAt: string;
      acknowledgements: {ackId: string; revision: null}[]; nextCursor: string;
    };
    assert.equal(first.reportId, reportId);
    assert.equal(first.currentRevision, 2);
    assert.equal(first.transport, 'AUTHENTICATED_SERVER');
    assert.equal(first.statusScope, 'REPORT');
    assert.equal(first.latestAck.status, 'RESOLVED');
    assert.equal(first.latestAck.revision, null);
    assert.ok(Number.isFinite(Date.parse(first.checkedAt)));
    assert.equal(first.acknowledgements.length, 100);
    assert.ok(first.acknowledgements.every(event => event.revision === null));
    assert.ok(first.nextCursor);
    assert.doesNotMatch(JSON.stringify(first), /OTHER_REPORT_PRIVATE_NOTE|Owner-only note/u);
    assert.ok(first.acknowledgements.every(event => (event as {note?: unknown}).note === null));
    assert.equal((first.latestAck as {note?: unknown}).note, null);
    assert.equal((await request(reportId, statusProofHeaders(reportId, owner.privateKey), first.nextCursor)).status, 401);
    const secondResponse = await request(reportId, statusProofHeaders(reportId, owner.privateKey, first.nextCursor), first.nextCursor);
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json() as {acknowledgements: {ackId: string}[]; nextCursor: null};
    assert.equal(second.acknowledgements.length, 3);
    assert.equal(second.nextCursor, null);
    assert.deepEqual([...first.acknowledgements, ...second.acknowledgements].map(event => event.ackId), eventIds.sort());
    const otherCursor = await request(otherReportId, statusProofHeaders(otherReportId, otherOwner.privateKey, first.nextCursor), first.nextCursor);
    assert.equal(otherCursor.status, 400);
    assert.equal(otherCursor.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await otherCursor.json(), {error: 'INVALID_CURSOR'});
    // A completed nextCursor=null means a subsequent pass starts at the beginning.
    assert.equal((await request(reportId, statusProofHeaders(reportId, owner.privateKey))).status, 200);
    assert.equal((await handleSagipRequest(new Request('https://sagip.test/v2/reports/' + reportId + '/receipt-access/challenges', {method: 'POST'}), deps)).status, 501);
    let challengeCalls = 0;
    const challengeDeps = {...deps, receiptService: {
      createReceiptAccessChallenge: async () => { challengeCalls += 1; return {}; },
    } as unknown as ReceiptService};
    for (const id of [reportId, absent]) {
      const denial = await handleSagipRequest(new Request('https://sagip.test/v2/reports/' + id + '/receipt-access/challenges', {method: 'POST'}), challengeDeps);
      assert.equal(denial.status, 401);
      assert.deepEqual(await denial.json(), {error: 'ORIGIN_PROOF_REQUIRED'});
    }
    assert.equal(challengeCalls, 0);
    // Even large internal Unicode notes stay private; responder detail retains them.
    const unicodeNote = '援'.repeat(1000);
    await pool.query('UPDATE responder_acknowledgements SET note=$2 WHERE report_id=$1', [reportId, unicodeNote]);
    let cursor: string | null = null;
    const recovered: string[] = [];
    let pages = 0;
    do {
      const response = await request(reportId, statusProofHeaders(reportId, owner.privateKey, cursor), cursor);
      assert.equal(response.status, 200);
      const raw = await response.text();
      assert.ok(Buffer.byteLength(raw, 'utf8') < 262144);
      const page = JSON.parse(raw) as {acknowledgements: {ackId: string; note: string}[]; nextCursor: string | null};
      assert.ok(page.acknowledgements.length > 0 && page.acknowledgements.length <= 100);
      assert.ok(page.acknowledgements.every(entry => entry.note === null));
      assert.doesNotMatch(raw, /援/u);
      recovered.push(...page.acknowledgements.map(entry => entry.ackId));
      cursor = page.nextCursor;
      pages += 1;
      assert.ok(pages < 4);
    } while (cursor);
    assert.deepEqual(recovered, eventIds.sort());
    const responderDetail = await service.getIncidentDetail(reportId);
    assert.equal(responderDetail?.latestAck?.note, unicodeNote);
  } finally {
    await close();
  }
});

test('status proof wire domain and strict malformed-header rejection', () => {
  const id = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  const proof = {timestamp: '1791169200000', nonce: Buffer.alloc(32).toString('base64')};
  assert.equal(reportStatusAccessDomain(id, proof, null).toString('utf8'),
    'SAGIP-REPORT-STATUS-V1\naaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n1791169200000\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n\n');
  for (const timestamp of ['01', '1e12', '-1', 'Infinity', '9007199254740992']) {
    assert.equal(parseReportStatusAccessProof(new Headers({'x-sagip-status-timestamp': timestamp})), null);
  }
});
