import assert from 'node:assert/strict';
import {createHash, sign} from 'node:crypto';
import test from 'node:test';
import type {Pool} from 'pg';
import {canonicalizeNewReceiptSignature} from '../../src/protocol/receiptV2.js';
import {
  createOfflineReceiptRuntime, offlineReceiptRuntimeMode, type OfflineReceiptRuntimeAdapter,
} from '../../src/responder/offlineReceiptRuntime.js';
import {createTestIdentity} from '../support/envelopeFactory.js';

const noDatabase = {connect: async () => {throw new Error('DATABASE_MUST_NOT_BE_USED');}} as unknown as Pick<Pool, 'connect'>;
function fixture(): OfflineReceiptRuntimeAdapter {
  const root = createTestIdentity();
  return {
    signer: {
      publicKeyDer: root.publicKeyDer,
      sign: async bytes => canonicalizeNewReceiptSignature(sign('sha256', bytes, {
        key: root.privateKey, dsaEncoding: 'ieee-p1363',
      })),
    },
    pinnedRootKeyId: createHash('sha256').update(root.publicKeyDer).digest('hex'),
    qualifiedTime: () => ({timeMs: 1700000000000, uncertaintyMs: 50, validForMs: 60000}),
    isQualified: () => true,
    authorityPolicy: {
      approvedIssuerKeyIds: new Set(), allowedScopes: new Set(['SYNTHETIC_ONLY']),
      allowedResponderRoles: new Set(['RESPONDER']), verifierOwners: new Map(),
      statusMask: 15, purposeMask: 9,
    },
    gatewayAccess: {allowedRoles: new Set(['RESPONDER']), isReportAuthorized: () => false},
  };
}
test('offline runtime defaults off and cannot be activated by an environment toggle', () => {
  assert.equal(offlineReceiptRuntimeMode({}), 'DISABLED');
  assert.deepEqual(createOfflineReceiptRuntime(noDatabase, {}), {});
  assert.deepEqual(createOfflineReceiptRuntime(noDatabase, {SAGIP_OFFLINE_RECEIPTS_MODE: 'DISABLED'}, fixture()), {});
  assert.throws(() => createOfflineReceiptRuntime(noDatabase, {SAGIP_OFFLINE_RECEIPTS_MODE: 'ADAPTER'}), /ADAPTER_REQUIRED/);
  for (const value of ['', 'true', '1', 'adapter', ' ADAPTER ', 'ENABLED']) {
    assert.throws(() => createOfflineReceiptRuntime(noDatabase, {SAGIP_OFFLINE_RECEIPTS_MODE: value}), /INVALID_OFFLINE_RECEIPTS_MODE/);
  }
});
test('enabled in-memory fixture reuses custody services without querying storage or signing at startup', async () => {
  const adapter = fixture();
  let signatures = 0;
  adapter.signer.sign = async () => {signatures++; throw new Error('NO_STARTUP_SIGNING');};
  const runtime = createOfflineReceiptRuntime(noDatabase, {SAGIP_OFFLINE_RECEIPTS_MODE: 'ADAPTER'}, adapter);
  assert.ok(runtime.receiptService);
  assert.ok(runtime.authorityService);
  assert.ok(runtime.gatewayReceiptFeed);
  assert.equal(signatures, 0);
  await assert.rejects(runtime.gatewayReceiptFeed.list(
    '22222222-2222-4222-8222-222222222222', null,
    {responderId: '33333333-3333-4333-8333-333333333333', callsign: 'TEST', role: 'RESPONDER', registeredAt: ''},
  ), /SCOPE_DENIED/);
});
test('adapter refuses unqualified custody, wrong pins, unsafe time and invalid role policy', () => {
  const env = {SAGIP_OFFLINE_RECEIPTS_MODE: 'ADAPTER'};
  assert.throws(() => createOfflineReceiptRuntime(noDatabase, env, {...fixture(), isQualified: () => false}), /AUTHORITY_UNAVAILABLE/);
  assert.throws(() => createOfflineReceiptRuntime(noDatabase, env, {...fixture(), pinnedRootKeyId: '00'.repeat(32)}), /ROOT_MISMATCH/);
  const badTimes = [
    {timeMs: 1, uncertaintyMs: 2, validForMs: 100},
    {timeMs: NaN, uncertaintyMs: 0, validForMs: 100},
    {timeMs: 1700000000000, uncertaintyMs: 60001, validForMs: 100000},
    {timeMs: 1700000000000, uncertaintyMs: 50, validForMs: 50},
    {timeMs: 1700000000000, uncertaintyMs: 0, validForMs: 604800001},
  ];
  for (const time of badTimes)
    assert.throws(() => createOfflineReceiptRuntime(noDatabase, env, {...fixture(), qualifiedTime: () => time}), /TIME_UNAVAILABLE/);
  assert.throws(() => createOfflineReceiptRuntime(noDatabase, env, {
    ...fixture(), gatewayAccess: {allowedRoles: new Set(), isReportAuthorized: () => true},
  }), /INVALID_GATEWAY_ACCESS_POLICY/);
});
test('qualification withdrawal is enforced by already-created runtime feed and clock', async () => {
  const adapter = fixture();
  let qualified = true;
  adapter.isQualified = () => qualified;
  adapter.gatewayAccess.isReportAuthorized = () => true;
  const runtime = createOfflineReceiptRuntime(noDatabase, {SAGIP_OFFLINE_RECEIPTS_MODE: 'ADAPTER'}, adapter);
  qualified = false;
  await assert.rejects(runtime.gatewayReceiptFeed!.list(
    '22222222-2222-4222-8222-222222222222', null,
    {responderId: '33333333-3333-4333-8333-333333333333', callsign: 'TEST', role: 'RESPONDER', registeredAt: ''},
  ), /AUTHORITY_UNAVAILABLE/);
  await assert.rejects(runtime.receiptService!.createReceiptAccessChallenge('22222222-2222-4222-8222-222222222222'), /AUTHORITY_UNAVAILABLE/);
});
