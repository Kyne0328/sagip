import assert from 'node:assert/strict';
import {createHash, randomUUID, sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import type {Pool, PoolClient} from 'pg';
import {
  canonicalizeNewReceiptSignature, decodeReceipt, encodeReceipt, receiptSigningInput,
  type ResponderReceiptFields,
} from '../../src/protocol/receiptV2.js';
import {actionDigest, issuerProviderId} from '../../src/responder/receiptAuthority.js';
import {GatewayReceiptFeed, MAX_GATEWAY_RECEIPT_PAGE_BYTES} from '../../src/responder/gatewayReceiptFeed.js';
import {createTestIdentity} from '../support/envelopeFactory.js';
import {createOfflineReceiptRuntime} from '../../src/responder/offlineReceiptRuntime.js';

const now = 1700000000000, NIL = '00000000-0000-0000-0000-000000000000';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
type Row = {event_id: string; report_id: string; event_digest: Buffer; object_bytes: Buffer; recorded_at_ms: string};
function fixture(reportId = randomUUID()) {
  const root = createTestIdentity(), origin = createTestIdentity();
  const actor = {responderId: randomUUID(), callsign: 'SYNTHETIC', role: 'RESPONDER', registeredAt: ''};
  let publicRoot = root.publicKeyDer, allowed = true, registered = true, failStorage = false;
  let latest = now, timeCalls = 0, expireAtFinal = false;
  let report = {revision: 1, payload_digest: Buffer.alloc(32, 7), origin_key_id: hash(origin.publicKeyDer),
    public_key_der: origin.publicKeyDer, envelope_bytes: Buffer.from([0, 0, 0, 0, 1])};
  const rows: Row[] = [], queries: string[] = [];
  const grants = new Map<string, {object_bytes: Buffer; revoked_at_ms: string | null}>();
  let revokeOnFinalRead = false;
  const client = {
    release: () => undefined,
    query: async (sql: string, args: unknown[] = []) => {
      queries.push(sql);
      if (failStorage) throw new Error('database offline');
      if (sql.includes('FROM responder_identities')) return {rows: registered ? [actor] : []};
      if (sql.includes('FROM accepted_messages')) return {rows: [report]};
      if (sql.includes('FROM receipt_authority_grants')) {
        const grant = grants.get(String(args[0]));
        if (sql.startsWith('SELECT revoked_at_ms') && revokeOnFinalRead && grant) grant.revoked_at_ms = '1';
        return {rows: grant ? [grant] : []};
      }
      if (sql.includes('FROM receipt_records')) {
        if (sql.includes('event_digest=$2')) return {rows: rows.filter(row =>
          row.report_id === args[0] && row.event_digest.equals(args[1] as Buffer))};
        if (sql.includes('event_id=$1')) return {rows: rows.filter(row =>
          row.event_id === args[0] && row.report_id === args[1])};
        assert.ok(sql.includes('LIMIT 33'));
        return {rows: rows.filter(row => row.report_id === args[0] &&
          (args.length === 1 || Number(row.recorded_at_ms) > Number(args[1]) ||
            (row.recorded_at_ms === args[1] && row.event_id > String(args[2])))).slice(0, 33)};
      }
      throw new Error('Unexpected query: ' + sql);
    },
  } as unknown as PoolClient;
  const pool = {connect: async () => client} as unknown as Pick<Pool, 'connect'>;
  const feed = () => new GatewayReceiptFeed(pool, publicRoot, () => {
    timeCalls++;
    const time = expireAtFinal && timeCalls > 1 ? latest + 1000 : latest;
    return {earliestMs: time, latestMs: time};
  }, {allowedRoles: new Set(['RESPONDER']), isReportAuthorized: (who, id) =>
    allowed && who.responderId === actor.responderId && id === reportId});
  const add = (overrides: Partial<ResponderReceiptFields> = {}) => {
    const fields: ResponderReceiptFields = {
      purpose: 1, actionId: randomUUID(), providerKind: 1, issuerKeyId: hash(root.publicKeyDer),
      issuerProviderId: issuerProviderId(1, hash(root.publicKeyDer), NIL),
      grantId: NIL, reportId, reportProtocolVersion: 1, revision: 1,
      payloadDigest: report.payload_digest, originKeyId: report.origin_key_id,
      responderId: actor.responderId, callsign: actor.callsign,
      observedIncidentVersion: 1n, sequence: BigInt(rows.length + 1), status: 1,
      note: 'Synthetic private note', issuedAtMs: now, forwardingExpiresAtMs: now + 1000,
      actionDigest: Buffer.alloc(32), ...overrides,
    };
    fields.actionDigest = actionDigest(fields);
    const bytes = encodeReceipt(fields, canonicalizeNewReceiptSignature(sign(
      'sha256', receiptSigningInput(fields, Buffer.alloc(0)),
      {key: root.privateKey, dsaEncoding: 'ieee-p1363'},
    )), Buffer.alloc(0));
    const row = {event_id: fields.actionId, report_id: reportId,
      event_digest: hash(bytes), object_bytes: bytes, recorded_at_ms: String(rows.length + 1)};
    rows.push(row);
    return row;
  };
  const runtimeFeed = () => createOfflineReceiptRuntime(pool, {SAGIP_OFFLINE_RECEIPTS_MODE: 'ADAPTER'}, {
    signer: {publicKeyDer: publicRoot, sign: async () => {throw new Error('RETRIEVAL_MUST_NOT_SIGN');}},
    pinnedRootKeyId: hash(publicRoot).toString('hex'),
    qualifiedTime: () => ({timeMs: latest, uncertaintyMs: 10, validForMs: 60000}),
    isQualified: () => true,
    authorityPolicy: {approvedIssuerKeyIds: new Set(), allowedScopes: new Set(['SYNTHETIC_ONLY']),
      allowedResponderRoles: new Set(['RESPONDER']), verifierOwners: new Map(), statusMask: 15, purposeMask: 9},
    gatewayAccess: {allowedRoles: new Set(['RESPONDER']), isReportAuthorized: (who, id) =>
      allowed && who.responderId === actor.responderId && id === reportId},
  }).gatewayReceiptFeed!;
  return {actor, reportId, rows, queries, grants, feed, runtimeFeed, add,
    deny: () => {allowed = false;}, unregister: () => {registered = false;},
    storageFailure: () => {failStorage = true;},
    expireDuringRead: () => {expireAtFinal = true;},
    delegated: () => {
      const golden = JSON.parse(readFileSync(new URL('../../../fixtures/receipts-v2/golden.json', import.meta.url), 'utf8'));
      const ctx = golden.trustedContext;
      const bytes = Buffer.from(golden.vectors.find((v: {name: string}) => v.name === 'valid_offline_ack').hex, 'hex');
      const fields = decodeReceipt(bytes).fields;
      if (fields.purpose !== 1) throw new Error('Expected ACK');
      publicRoot = Buffer.from(ctx.rootPublicKeyDerHex, 'hex');
      latest = ctx.trustedTime.latestMs;
      report = {...report, payload_digest: Buffer.from(ctx.payloadDigest, 'hex'),
        origin_key_id: Buffer.from(ctx.originKeyId, 'hex'),
        public_key_der: Buffer.from(ctx.originPublicKeyDerHex, 'hex')};
      const proof = decodeReceipt(bytes).proof;
      const grantBytes = proof.subarray(3, 3 + proof.readUInt16BE(1));
      grants.set(fields.grantId, {object_bytes: grantBytes, revoked_at_ms: null});
      rows.push({event_id: fields.actionId, report_id: reportId, event_digest: hash(bytes),
        object_bytes: bytes, recorded_at_ms: '1'});
      return {fields, bytes, useReport: fields.reportId};
    },
    revokeDuringRead: () => {revokeOnFinalRead = true;},
  };
}
test('scoped feed preserves exact signed bytes and returns no report or authority claim', async () => {
  const f = fixture(), row = f.add(), feed = f.runtimeFeed();
  const page = await feed.list(f.reportId, null, f.actor);
  assert.deepEqual(page, {entries: [{eventId: row.event_id, eventDigest: row.event_digest.toString('hex'),
    bytesBase64: row.object_bytes.toString('base64')}], nextCursor: null});
  assert.deepEqual(await f.feed().list(f.reportId, null, f.actor), page);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MAX_GATEWAY_RECEIPT_PAGE_BYTES);
});
test('scope and current actor are mandatory, before report/cursor lookup', async () => {
  const f = fixture(); f.add();
  await assert.rejects(f.feed().list(randomUUID(), 'bad', f.actor), /SCOPE_DENIED/);
  assert.equal(f.queries.length, 0);
  await assert.rejects(f.feed().list(f.reportId, null, {...f.actor, role: 'CIVILIAN'}), /SCOPE_DENIED/);
  f.unregister();
  await assert.rejects(f.feed().list(f.reportId, null, f.actor), /UNAUTHORIZED/);
  assert.equal(f.queries.some(q => q.includes('FROM receipt_records')), false);
});
test('pagination is bounded, restart-safe and rejects unknown or wrong-report cursors', async () => {
  const f = fixture();
  for (let i = 0; i < 35; i++) f.add();
  const first = await f.feed().list(f.reportId, null, f.actor);
  assert.equal(first.entries.length, 32); assert.ok(first.nextCursor);
  const second = await f.feed().list(f.reportId, first.nextCursor, f.actor);
  assert.equal(second.entries.length, 3); assert.equal(second.nextCursor, null);
  await assert.rejects(f.feed().list(f.reportId, 'ff'.repeat(32), f.actor), /INVALID_CURSOR/);
  await assert.rejects(f.feed().list(f.reportId, 'x'.repeat(10000), f.actor), /INVALID_CURSOR/);
});
test('malformed, expired and signature-mismatched records cannot poison bounded progress', async () => {
  const f = fixture();
  for (let i = 0; i < 32; i++) {
    const row = f.add();
    row.object_bytes = Buffer.alloc(i + 1, 9);
    row.event_digest = hash(row.object_bytes);
  }
  f.add({issuedAtMs: now - 1000, forwardingExpiresAtMs: now});
  const tampered = f.add(); tampered.object_bytes[tampered.object_bytes.length - 1] = tampered.object_bytes[tampered.object_bytes.length - 1]! ^ 1;
  tampered.event_digest = hash(tampered.object_bytes);
  const good = f.add();
  const first = await f.feed().list(f.reportId, null, f.actor);
  assert.equal(first.entries.length, 0); assert.ok(first.nextCursor);
  const second = await f.feed().list(f.reportId, first.nextCursor, f.actor);
  assert.deepEqual(second.entries.map(e => e.eventId), [good.event_id]);
  assert.equal(second.nextCursor, null);
});
test('expiry during database reads and policy withdrawal fail closed', async () => {
  const f = fixture(); f.add(); f.expireDuringRead();
  assert.equal((await f.feed().list(f.reportId, null, f.actor)).entries.length, 0);
  f.deny();
  await assert.rejects(f.feed().list(f.reportId, null, f.actor), /SCOPE_DENIED/);
});
test('delegated receipts require known active grants, including final revocation read', async () => {
  const golden = JSON.parse(readFileSync(new URL('../../../fixtures/receipts-v2/golden.json', import.meta.url), 'utf8'));
  const f = fixture(golden.trustedContext.reportId);
  const sample = f.delegated();
  const page = await f.feed().list(f.reportId, null, f.actor);
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0]!.bytesBase64, sample.bytes.toString('base64'));
  f.revokeDuringRead();
  assert.equal((await f.feed().list(f.reportId, null, f.actor)).entries.length, 0);
  f.grants.clear();
  assert.equal((await f.feed().list(f.reportId, null, f.actor)).entries.length, 0);
});
test('requester receipts require the exact linked acknowledgement and inherit its revocation', async () => {
  const golden = JSON.parse(readFileSync(new URL('../../../fixtures/receipts-v2/golden.json', import.meta.url), 'utf8'));
  const f = fixture(golden.trustedContext.reportId);
  f.delegated();
  const bytes = Buffer.from(golden.vectors.find((v: {name: string}) => v.name === 'valid_requester_receipt').hex, 'hex');
  const fields = decodeReceipt(bytes).fields;
  if (fields.purpose !== 2) throw new Error('Expected requester receipt');
  f.rows.push({event_id: fields.eventId, report_id: f.reportId,
    event_digest: hash(bytes), object_bytes: bytes, recorded_at_ms: '2'});
  const page = await f.feed().list(f.reportId, null, f.actor);
  assert.equal(page.entries.length, 2);
  assert.equal(page.entries[1]!.bytesBase64, bytes.toString('base64'));
  f.rows.shift();
  assert.equal((await f.feed().list(f.reportId, null, f.actor)).entries.length, 0);
});
test('database failure is surfaced, not returned as a successful empty page', async () => {
  const f = fixture(); f.add(); f.storageFailure();
  await assert.rejects(f.feed().list(f.reportId, null, f.actor), /database offline/);
});
