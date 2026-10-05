import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadConfiguredOfflineReceiptRuntime, parseOfflineReceiptConfiguration} from '../../src/responder/offlineReceiptConfiguration.js';
const root = '1'.repeat(64), checkpoint = '2'.repeat(64), provider = '3'.repeat(64);
const responder = '11111111-1111-4111-8111-111111111111', report = '22222222-2222-4222-8222-222222222222';
function config() {
  return {
    schema: 1, pinnedRootKeyId: root,
    authorityPolicy: {approvedIssuerKeyIds: [], allowedScopes: ['TAGUM'], allowedResponderRoles: ['RESPONDER'],
      verifierOwners: [[root, responder]], statusMask: 15, purposeMask: 9},
    gatewayAccess: {allowedRoles: ['RESPONDER'], assignments: [{responderId: responder, reportIds: [report]}]},
    offlineRoot: {pinnedCheckpointSignerKeyId: checkpoint, scope: 'TAGUM', allowedResponderRoles: ['RESPONDER'],
      qualifiedSourceId: 'SYNTHETIC_TIME',
      policy: {mode: 'BOUNDED_OFFLINE_ROOT_SNAPSHOT', authorityDomainId: 'SYNTHETIC_DOMAIN',
        signerBindings: [{receiptRootKeyId: root, checkpointSignerKeyId: checkpoint, issuerProviderId: provider}],
        allowedScopes: ['TAGUM'], allowedStatuses: [1, 2, 3, 4], maxAuthorityStalenessMs: 900000,
        maxReceiptIssuanceAgeMs: 86400000, maxProofValidityMs: 900000,
        qualifiedTimeSourceIds: ['SYNTHETIC_TIME'], disseminationAudience: 'ORIGIN_AND_CUSTODY_RELAYS',
        providerConflictHandling: 'KEEP_SEPARATE_NO_AUTOMATIC_CLOSURE',
        resolvedHandling: 'REPORTED_STATUS_ONLY_NO_AUTOMATIC_CLOSURE', maxReplayRecords: 10000}},
    time: {profile: 'IETF_DRAFT11', sourceId: 'SYNTHETIC_TIME', host: 'time.invalid', port: 2003,
      rootPublicKeyBase64: Buffer.alloc(32, 42).toString('base64'), maxRoundTripMs: 2000,
      maxRadiusMs: 5000, maxSampleAgeMs: 30000, maxUncertaintyMs: 10000,
      monotonicDriftPpm: 1000, deviceCheckpointValidityMs: 86400000},
  };
}
test('public manifest pins scope, owner mapping and exact gateway report assignments', () => {
  const result = parseOfflineReceiptConfiguration(JSON.stringify(config()));
  assert.equal(result.trust.pinnedRootKeyId, root);
  assert.equal(result.trust.authorityPolicy.verifierOwners.get(root), responder);
  const actor = {responderId: responder, callsign: 'UNIT-1', role: 'RESPONDER', registeredAt: '2026-01-01T00:00:00.000Z'};
  assert.equal(result.trust.gatewayAccess.isReportAuthorized(actor, report), true);
  assert.equal(result.trust.gatewayAccess.isReportAuthorized({...actor, role: 'AUTHORITY_ADMIN'}, report), false);
  assert.equal(result.trust.gatewayAccess.isReportAuthorized({...actor, responderId: report}, report), false);
  assert.equal(result.trust.gatewayAccess.isReportAuthorized(actor, responder), false);
  assert.equal(result.time.rootPublicKey.length, 32);
});
test('manifest rejects missing fields, unknown private fields and oversized JSON', () => {
  const missing = config() as unknown as Record<string, unknown>; delete missing.time;
  assert.throws(() => parseOfflineReceiptConfiguration(JSON.stringify(missing)));
  assert.throws(() => parseOfflineReceiptConfiguration(JSON.stringify({...config(), privateKey: 'secret'})));
  assert.throws(() => parseOfflineReceiptConfiguration(' '.repeat(65537)));
});
test('manifest refuses mismatched pins, policy source, duplicate verifier or broad audience role', () => {
  const pin = config(); pin.pinnedRootKeyId = checkpoint;
  assert.throws(() => parseOfflineReceiptConfiguration(JSON.stringify(pin)));
  const time = config(); time.time.sourceId = 'other-source';
  assert.throws(() => parseOfflineReceiptConfiguration(JSON.stringify(time)));
  const duplicate = config(); duplicate.authorityPolicy.verifierOwners.push([root, report]);
  assert.throws(() => parseOfflineReceiptConfiguration(JSON.stringify(duplicate)));
  const broad = config(); broad.gatewayAccess.allowedRoles = ['*'];
  assert.throws(() => parseOfflineReceiptConfiguration(JSON.stringify(broad)));
});
test('manifest enforces bounded source clock policy and canonical public key encoding', () => {
  const badTime = config(); badTime.time.monotonicDriftPpm = 0;
  assert.throws(() => parseOfflineReceiptConfiguration(JSON.stringify(badTime)));
  const badKey = config(); badKey.time.rootPublicKeyBase64 = 'AAAA';
  assert.throws(() => parseOfflineReceiptConfiguration(JSON.stringify(badKey)));
  const lifetime = config(); lifetime.offlineRoot.policy.maxProofValidityMs = 900001;
  assert.throws(() => parseOfflineReceiptConfiguration(JSON.stringify(lifetime)));
});
test('disabled loader reads no secret/config, contacts no provider and connects no database', async () => {
  const env = new Proxy({}, {get: (_target, name) => {
    if (name === 'SAGIP_OFFLINE_RECEIPTS_MODE') return 'DISABLED';
    throw new Error('UNEXPECTED_ENV_ACCESS');
  }});
  const pool = {connect: async () => {throw new Error('UNEXPECTED_DATABASE');}};
  assert.deepEqual(await loadConfiguredOfflineReceiptRuntime(pool, env), {});
});
test('invalid optional authority config remains disabled and cannot break SOS dependency construction', async t => {
  const warning = t.mock.method(console, 'warn', () => {});
  const pool = {connect: async () => {throw new Error('UNEXPECTED_DATABASE');}};
  assert.deepEqual(await loadConfiguredOfflineReceiptRuntime(pool, {
    SAGIP_OFFLINE_RECEIPTS_MODE: 'ADAPTER', SAGIP_OFFLINE_RECEIPTS_CONFIG_JSON: '{invalid secret value',
  }), {});
  assert.deepEqual(warning.mock.calls[0]?.arguments, ['Optional offline receipt authority is unavailable']);
});
