import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID, sign} from 'node:crypto';
import test from 'node:test';
import {handleSagipRequest, type SagipServerDependencies} from '../../src/http/handleRequest.js';
import {canonicalizeNewReceiptSignature, decodeReceipt, verifyReceiptSignature} from '../../src/protocol/receiptV2.js';
import {decodeOfflineRootBundle} from '../../src/protocol/offlineRootSnapshot.js';
import {custodyRequestSigningInput, type CustodyOperation} from '../../src/responder/reportCustodyAccess.js';
import type {GatewayReceiptPage} from '../../src/responder/gatewayReceiptFeed.js';
import {createTestIdentity} from '../support/envelopeFactory.js';
import {offlineRootServiceFixture, T} from '../support/offlineRootServiceFixture.js';

test('accepted SOS custody automatically obtains verifier-bound time and note-free signed return without a responder token', async () => {
  const f = await offlineRootServiceFixture();
  try {
    await f.snapshots.enrollDomain(f.admin);
    const action = await f.createAction();
    await f.createAction(3, 'PRIVATE RESPONDER NOTE');
    const relay = createTestIdentity(), boot = randomUUID(), nonce = randomBytes(32);
    let refreshes = 0;
    const deps: SagipServerDependencies = {ingestEnvelope: async () => {throw new Error('not ingestion');},
      ...f.runtime, refreshAuthorityTime: async () => {refreshes++;}};
    const signed = (operation: CustodyOperation, overrides = {}, id = f.envelope.reportId) => {
      const body = Buffer.from(JSON.stringify({verifierId: createHash('sha256').update(relay.publicKeyDer).digest('base64'),
        verifierBootSessionId: boot, nonce: nonce.toString('base64'), verifierPublicKeyDer: relay.publicKeyDer.toString('base64'),
        envelopeBase64: f.envelopeBytes.toString('base64'), ...(operation === 'receipts' ? {cursor: null} : {}), ...overrides}));
      const signature = canonicalizeNewReceiptSignature(sign('sha256', custodyRequestSigningInput(id, operation, body),
        {key: relay.privateKey, dsaEncoding: 'ieee-p1363'})).toString('base64');
      const request = () => new Request('https://sagip.test/v2/custody/reports/' + id + '/' + operation, {
        method: 'POST', headers: {'content-type': 'application/json', 'x-sagip-custody-signature': signature}, body});
      return {body, signature, request};
    };
    for (const operation of ['receipts', 'authority/time'] as const) {
      const request = signed(operation);
      const unauthenticated = new Request(request.request(), {headers: {'content-type': 'application/json'}});
      assert.equal((await handleSagipRequest(unauthenticated, deps)).status, 401);
      assert.equal((await handleSagipRequest(signed(operation, {}, randomUUID()).request(), deps)).status, 401);
      assert.equal((await handleSagipRequest(signed(operation, {envelopeBase64: Buffer.from('not the SOS').toString('base64')}).request(), deps)).status, 401);
      assert.equal((await handleSagipRequest(signed(operation, {verifierId: randomBytes(32).toString('base64')}).request(), deps)).status, 401);
    }
    assert.equal(refreshes, 0);
    const time = signed('authority/time');
    const timeResponse = await handleSagipRequest(time.request(), deps);
    assert.equal(timeResponse.status, 200);
    const proof = Buffer.from(await timeResponse.arrayBuffer()), decoded = decodeReceipt(proof);
    assert.ok(verifyReceiptSignature(decoded, f.root.publicKeyDer));
    if (decoded.fields.purpose !== 4) throw new Error('Expected time proof');
    assert.deepEqual(decoded.fields.verifierId, createHash('sha256').update(relay.publicKeyDer).digest());
    assert.equal(decoded.fields.verifierBootSessionId, boot);
    assert.deepEqual(decoded.fields.nonce, nonce);
    assert.deepEqual(Buffer.from(await (await handleSagipRequest(time.request(), deps)).arrayBuffer()), proof);
    assert.equal((await handleSagipRequest(signed('authority/time', {verifierBootSessionId: randomUUID()}).request(), deps)).status, 409);
    const response = await handleSagipRequest(signed('receipts').request(), deps);
    assert.equal(response.status, 200);
    const page = await response.json() as GatewayReceiptPage;
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0]!.eventId, action.actionId);
    assert.equal(JSON.stringify(page).includes('PRIVATE RESPONDER NOTE'), false);
    const bundle = decodeOfflineRootBundle(Buffer.from(page.entries[0]!.offlineBundleBase64!, 'base64'));
    assert.deepEqual(bundle.receipt, action.receipt);
    // A source-bound signature cannot authorize another route or altered pagination.
    const original = signed('receipts');
    const altered = new Request('https://sagip.test/v2/custody/reports/' + f.envelope.reportId + '/receipts', {
      method: 'POST', headers: {'content-type': 'application/json', 'x-sagip-custody-signature': original.signature},
      body: Buffer.from(original.body.toString().replace('"cursor":null', '"cursor":"' + '0'.repeat(64) + '"'))});
    assert.equal((await handleSagipRequest(altered, deps)).status, 401);
    f.setTime(T + 1000);
    await f.snapshots.revoke('KEY', createHash('sha256').update(f.root.publicKeyDer).digest('hex'), f.admin);
    assert.equal((await handleSagipRequest(time.request(), deps)).status, 403);
  } finally {await f.close();}
});

test('dashboard status signs a new note-free receipt and includes its matching offline snapshot', async () => {
  const f = await offlineRootServiceFixture();
  try {
    await f.snapshots.enrollDomain(f.admin);
    const actionId = randomUUID();
    const result = await f.service.prepareDashboardStatus(actionId, f.envelope.reportId, 2, f.responder);
    assert.equal(result.state, 'SIGNED'); assert.equal(result.reason, null);
    const bytes = Buffer.from((await f.service.getReceipt(actionId))!);
    const fields = decodeReceipt(bytes).fields;
    if (fields.purpose !== 1) throw new Error('Expected responder receipt');
    assert.equal(fields.note, ''); assert.equal(fields.status, 2);
    const bundle = await f.snapshots.issueCommitted(actionId);
    assert.ok(bundle); assert.deepEqual(decodeOfflineRootBundle(bundle).receipt, bytes);
  } finally {await f.close();}
});
