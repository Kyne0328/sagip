import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {offlineRootServiceFixture, T} from '../support/offlineRootServiceFixture.js';
import {decodeOfflineRootBundle, decodeOfflineRootSnapshot, verifyOfflineRootRevocation} from '../../src/protocol/offlineRootSnapshot.js';
import {decodeReceipt} from '../../src/protocol/receiptV2.js';
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

test('signed server status automatically produces immutable snapshot; restart feed keeps exact bytes', async () => {
  const f = await offlineRootServiceFixture();
  try {
    await f.snapshots.enrollDomain(f.admin);
    const action = await f.createAction();
    assert.equal(action.result.state, 'SIGNED'); assert.equal(action.result.reason, null);
    assert.equal(Number((await f.pool.query('SELECT COUNT(*) AS count FROM offline_root_snapshots')).rows[0].count), 1);
    const first = await f.snapshots.issueCommitted(action.actionId);
    assert.ok(first);
    const restarted = f.makeRuntime();
    assert.deepEqual(await restarted.offlineRootSnapshotService!.issueCommitted(action.actionId), first);
    const page = await restarted.gatewayReceiptFeed!.list(f.envelope.reportId, null, f.responder);
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0]!.offlineBundleBase64, first.toString('base64'));
    assert.equal(page.entries[0]!.bytesBase64, action.receipt.toString('base64'));
    const decoded = decodeOfflineRootBundle(first), proof = decodeOfflineRootSnapshot(decoded.proof).fields;
    assert.equal(proof.receiptDigest, hash(action.receipt));
    assert.equal(proof.authorityCheckedAtMs, T);
    assert.equal(proof.authorityTimeUncertaintyMs, 10);
    assert.equal(decodeReceipt(action.receipt).fields.purpose, 1);
    assert.equal(Number((await f.pool.query('SELECT COUNT(*) AS count FROM offline_root_snapshots')).rows[0].count), 1);
  } finally {await f.close();}
});

test('registry enrollment is explicit; missing registry never changes committed status into success offline', async () => {
  const f = await offlineRootServiceFixture();
  try {
    await assert.rejects(f.snapshots.enrollDomain(f.responder), /UNAUTHORIZED/);
    await assert.rejects(f.createAction(), /REGISTRY_UNAVAILABLE/);
    await f.snapshots.enrollDomain(f.admin);
    const action = await f.createAction();
    assert.ok(await f.snapshots.issueCommitted(action.actionId));
  } finally {await f.close();}
});

test('checkpoint outage retains status and retries once without duplicate action or proof', async () => {
  const f = await offlineRootServiceFixture();
  try {
    await f.snapshots.enrollDomain(f.admin); f.failSigner(true);
    const action = await f.createAction();
    assert.equal(action.result.state, 'SIGNED');
    assert.equal(action.result.reason, 'OFFLINE_SNAPSHOT_PENDING');
    await assert.rejects(f.runtime.gatewayReceiptFeed!.list(f.envelope.reportId, null, f.responder), /checkpoint outage/);
    f.failSigner(false);
    const retried = await f.service.prepareReceipt(action.actionId);
    assert.equal(retried.state, 'SIGNED'); assert.equal(retried.reason, null);
    assert.equal(Number((await f.pool.query('SELECT COUNT(*) AS count FROM receipt_actions')).rows[0].count), 1);
    assert.equal(Number((await f.pool.query('SELECT COUNT(*) AS count FROM offline_root_snapshots')).rows[0].count), 1);
  } finally {await f.close();}
});

test('private note receipts are never put in the responder relay feed', async () => {
  const f = await offlineRootServiceFixture();
  try {
    await f.snapshots.enrollDomain(f.admin);
    const action = await f.createAction(2, 'SYNTHETIC PERSONAL NOTE');
    assert.equal(action.result.state, 'SIGNED');
    assert.equal(action.result.reason, 'OFFLINE_SNAPSHOT_UNAVAILABLE');
    assert.equal(await f.snapshots.issueCommitted(action.actionId), null);
    const page = await f.runtime.gatewayReceiptFeed!.list(f.envelope.reportId, null, f.responder);
    assert.equal(page.entries.length, 0);
    assert.equal(JSON.stringify(page).includes('SYNTHETIC PERSONAL'), false);
  } finally {await f.close();}
});

test('registry key revocation is durable, monotonic and defeats previously issued positive bytes', async () => {
  const f = await offlineRootServiceFixture();
  try {
    await f.snapshots.enrollDomain(f.admin);
    const action = await f.createAction(), before = await f.snapshots.issueCommitted(action.actionId);
    assert.ok(before);
    f.setTime(T + 1000);
    const rootId = hash(f.root.publicKeyDer), bytes = await f.snapshots.revoke('KEY', rootId, f.admin);
    assert.deepEqual(await f.snapshots.revoke('KEY', rootId, f.admin), bytes);
    const fields = verifyOfflineRootRevocation(bytes, f.policy, new Map([[hash(f.signer.publicKeyDer), f.signer.publicKeyDer]]));
    assert.equal(fields.revocationEpoch, '2'); assert.equal(fields.targetId, rootId);
    const restarted = f.makeRuntime();
    assert.equal(await restarted.offlineRootSnapshotService!.issueCommitted(action.actionId), null);
    await assert.rejects(f.createAction(), /ROOT_AUTHORITY_REVOKED/);
    const page = await restarted.gatewayReceiptFeed!.list(f.envelope.reportId, null, f.responder);
    assert.equal(page.entries.length, 0);
    assert.deepEqual(page.revocationsBase64, [bytes.toString('base64')]);
    assert.equal(Number((await f.pool.query('SELECT COUNT(*) AS count FROM offline_root_revocations')).rows[0].count), 1);
  } finally {await f.close();}
});

test('expired checkpoint proof renews with new proof identity and unchanged receipt; status age never refreshes', async () => {
  const f = await offlineRootServiceFixture();
  try {
    await f.snapshots.enrollDomain(f.admin);
    const action = await f.createAction(), first = (await f.snapshots.issueCommitted(action.actionId))!;
    f.setTime(T + 900000);
    const renewed = (await f.snapshots.issueCommitted(action.actionId))!;
    assert.ok(renewed);
    const a = decodeOfflineRootBundle(first), b = decodeOfflineRootBundle(renewed);
    assert.deepEqual(a.receipt, b.receipt);
    assert.notEqual(decodeOfflineRootSnapshot(a.proof).fields.proofId, decodeOfflineRootSnapshot(b.proof).fields.proofId);
    assert.equal(Number((await f.pool.query('SELECT COUNT(*) AS count FROM offline_root_snapshots')).rows[0].count), 2);
    f.setTime(T + 86400000);
    assert.equal(await f.snapshots.issueCommitted(action.actionId), null);
  } finally {await f.close();}
});

test('same epoch other receipt does not churn earlier proof; registry corruption fails closed', async () => {
  const f = await offlineRootServiceFixture();
  try {
    await f.snapshots.enrollDomain(f.admin);
    const a = await f.createAction(), original = await f.snapshots.issueCommitted(a.actionId);
    f.setTime(T + 1000); await f.createAction(4);
    assert.deepEqual(await f.snapshots.issueCommitted(a.actionId), original);
    await f.pool.query('UPDATE offline_root_domains SET authority_state_digest=$1', ['ee'.repeat(32)]);
    await assert.rejects(f.snapshots.issueCommitted(a.actionId), /REGISTRY_CONFLICT/);
  } finally {await f.close();}
});
