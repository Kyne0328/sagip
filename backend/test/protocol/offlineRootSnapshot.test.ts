import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {
  canonicalizeNewReceiptSignature,
  decodeReceipt,
  encodeReceipt,
  receiptSigningInput,
  type ResponderReceiptFields,
} from '../../src/protocol/receiptV2.js';
import {
  actionDigest, issuerProviderId, verifyReceipt,
} from '../../src/responder/receiptAuthority.js';
import {
  encodeOfflineRootBundle, decodeOfflineRootBundle, decodeOfflineRootSnapshot,
  encodeOfflineRootRevocation, decodeOfflineRootRevocation, verifyOfflineRootRevocation, offlineRootRevocationSigningInput,
  encodeOfflineRootSnapshot,
  evaluateOfflineRootSnapshot,
  offlineRootPolicyDigest,
  offlineRootProofSigningInput,
  type OfflineRootProofFields,
  type OfflineRootSnapshotContext,
  type OfflineRootSnapshotResult,
} from '../../src/protocol/offlineRootSnapshot.js';

const NIL = '00000000-0000-0000-0000-000000000000';
const id = (n: number) => n.toString(16).padStart(8, '0') + '-1111-4111-8111-111111111111';
const hash = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
const hex = (v: Uint8Array) => Buffer.from(v).toString('hex');
const T = 1700000000000;
function identity() {
  // Existing test idiom: ephemeral P-256 keys, no files, credentials or live service.
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyDer = pair.publicKey.export({ format: 'der', type: 'spki' });
  return { ...pair, publicKeyDer, keyId: hash(publicKeyDer) };
}
function fixture() {
  const root = identity(), signer = identity(), origin = identity();
  const provider = issuerProviderId(1, Buffer.from(root.keyId, 'hex'), NIL);
  const report = {
    reportId: id(1), reportProtocolVersion: 2, revision: 3,
    payloadDigest: Buffer.alloc(32, 9), originKeyId: Buffer.from(origin.keyId, 'hex'),
    originPublicKeyDer: origin.publicKeyDer,
  };
  const context: OfflineRootSnapshotContext = {
    policy: {
      mode: 'BOUNDED_OFFLINE_ROOT_SNAPSHOT', authorityDomainId: 'SYNTHETIC_AUTHORITY',
      signerBindings: [{ checkpointSignerKeyId: signer.keyId,
        receiptRootKeyId: root.keyId, issuerProviderId: hex(provider) }],
      allowedScopes: ['SYNTHETIC_SCOPE'], allowedStatuses: [1, 2, 3],
      maxAuthorityStalenessMs: 5000, maxReceiptIssuanceAgeMs: 8000,
      maxProofValidityMs: 6000, qualifiedTimeSourceIds: ['SYNTHETIC_QUALIFIED_SOURCE'],
      disseminationAudience: 'ORIGIN_ONLY',
      providerConflictHandling: 'KEEP_SEPARATE_NO_AUTOMATIC_CLOSURE',
      resolvedHandling: 'EXCLUDE', maxReplayRecords: 32,
    },
    checkpointSignerKeys: new Map([[signer.keyId, signer.publicKeyDer]]),
    receiptRootKeys: new Map([[root.keyId, root.publicKeyDer]]),
    revokedKeyIds: new Set(), revokedProviderIds: new Set(), report, activeReportRevision: 3,
    trustedTime: {
      checkpoint: { earliestMs: T + 1000, latestMs: T + 1020, bootId: id(8),
        receivedElapsedMs: 100, validUntilMs: T + 100000, proofDigest: '11'.repeat(32) },
      clock: { bootId: id(8), elapsedMs: 100 }, qualifiedSourceId: 'SYNTHETIC_QUALIFIED_SOURCE',
    },
    state: { authorityDomainId: 'SYNTHETIC_AUTHORITY', generation: 0,
      epochHighWater: '0', authorityStateDigest: null, checkedAtEarliestHighWaterMs: 0,
      timeEarliestHighWaterMs: 0, proofs: [], receipts: [] },
  };
  function receipt(overrides: Partial<ResponderReceiptFields> = {}) {
    const fields: ResponderReceiptFields = {
      purpose: 1, providerKind: 1, issuerProviderId: provider, actionId: id(2),
      actionDigest: Buffer.alloc(32), reportId: report.reportId, reportProtocolVersion: 2,
      revision: 3, payloadDigest: report.payloadDigest, originKeyId: report.originKeyId,
      issuerKeyId: Buffer.from(root.keyId, 'hex'), grantId: NIL, responderId: id(3),
      callsign: 'SYNTHETIC TEST', observedIncidentVersion: 7n, status: 2, sequence: 1n,
      issuedAtMs: T - 1000, forwardingExpiresAtMs: T + 10000, note: '', ...overrides,
    };
    fields.actionDigest = actionDigest(fields);
    const signature = canonicalizeNewReceiptSignature(sign('sha256',
      receiptSigningInput(fields, Buffer.alloc(0)),
      { key: root.privateKey, dsaEncoding: 'ieee-p1363' }));
    return encodeReceipt(fields, signature, Buffer.alloc(0));
  }
  function proofFields(ack: Uint8Array, overrides: Partial<OfflineRootProofFields> = {}) {
    const r = decodeReceipt(ack).fields;
    if (r.purpose !== 1) throw new Error('test ACK');
    const fields: OfflineRootProofFields = {
      format: 'SAGIP_OFFLINE_ROOT_SNAPSHOT', version: 1, algorithm: 1,
      proofId: id(4), policyDigest: offlineRootPolicyDigest(context.policy!),
      authorityDomainId: 'SYNTHETIC_AUTHORITY', checkpointSignerKeyId: signer.keyId,
      receiptRootKeyId: root.keyId, issuerProviderId: hex(provider), receiptDigest: hash(ack),
      eventId: r.actionId, actionDigest: hex(r.actionDigest), reportId: r.reportId,
      reportProtocolVersion: r.reportProtocolVersion, revision: r.revision,
      payloadDigest: hex(r.payloadDigest), originKeyId: hex(r.originKeyId),
      scope: 'SYNTHETIC_SCOPE', status: r.status, authorityState: 'ACTIVE_AT_CHECKPOINT',
      authorityStateDigest: '22'.repeat(32), revocationEpoch: '9',
      notBeforeMs: T - 100, authorityCheckedAtMs: T, authorityTimeUncertaintyMs: 10,
      expiresAtMs: T + 4900, ...overrides,
    };
    return fields;
  }
  function signed(fields: OfflineRootProofFields) {
    return encodeOfflineRootSnapshot(fields, canonicalizeNewReceiptSignature(
      sign('sha256', offlineRootProofSigningInput(fields),
        { key: signer.privateKey, dsaEncoding: 'ieee-p1363' })));
  }
  const ack = receipt(), fields = proofFields(ack), proof = signed(fields);
  return { context, ack, fields, proof, receipt, proofFields, signed, root, signer, provider };
}
function candidate(result: OfflineRootSnapshotResult) {
  assert.equal(result.kind, 'CANDIDATE', JSON.stringify(result));
  if (result.kind !== 'CANDIDATE') throw new Error('expected candidate');
  return result;
}
function reason(result: OfflineRootSnapshotResult, expected: string) {
  assert.notEqual(result.kind, 'CANDIDATE');
  if (result.kind === 'CANDIDATE') throw new Error('unexpected candidate');
  assert.equal(result.reason, expected);
}

test('proposal produces only a pending candidate; existing root verification stays unchecked', () => {
  const f = fixture();
  const r = candidate(evaluateOfflineRootSnapshot(f.ack, f.proof, f.context));
  assert.equal(r.proposedVerification.kind, 'VERIFIED_OFFLINE_ROOT_SNAPSHOT');
  assert.equal(r.requiresAtomicCommit, true);
  assert.equal(r.proposedVerification.revocationNotCheckedWhileOffline, true);
  assert.equal(r.proposedVerification.statusIsIssuerReportOnly, true);
  assert.equal(r.application, 'NEW');
  assert.equal(r.validUntilExclusiveMs, T + 4900);
  assert.equal(f.context.state!.generation, 0);
  reason(verifyReceipt(f.ack, {
    roots: new Map(f.context.receiptRootKeys), revokedGrants: new Set(),
    allowedScopes: new Set(), trustedTime: { earliestMs: T + 1000, latestMs: T + 1020 },
    authorityCheckedAtMs: null, currentAuthorityChecked: false,
    report: f.context.report, pairedTimeProviderId: null,
  }) as OfflineRootSnapshotResult, 'ROOT_AUTHORITY_UNCHECKED');
});

test('omitted, incomplete or unsafe operator policy fails closed', () => {
  const f = fixture();
  reason(evaluateOfflineRootSnapshot(f.ack, f.proof, { ...f.context, policy: null }), 'POLICY_MISSING');
  reason(evaluateOfflineRootSnapshot(f.ack, f.proof, {
    ...f.context, policy: { ...f.context.policy!, maxAuthorityStalenessMs: 0 },
  }), 'POLICY_INVALID');
  assert.throws(() => offlineRootPolicyDigest({
    ...f.context.policy!, signerBindings: [{
      checkpointSignerKeyId: f.root.keyId, receiptRootKeyId: f.root.keyId,
      issuerProviderId: hex(f.provider),
    }],
  }));
  assert.throws(() => offlineRootPolicyDigest({
    ...f.context.policy!, allowedStatuses: [4], resolvedHandling: 'EXCLUDE',
  }));
});

test('missing pins, arbitrary embedded identity, and substituted pinned key fail', () => {
  const f = fixture();
  reason(evaluateOfflineRootSnapshot(f.ack, f.proof, {
    ...f.context, checkpointSignerKeys: new Map(),
  }), 'UNKNOWN_PINNED_KEY');
  reason(evaluateOfflineRootSnapshot(f.ack, f.proof, {
    ...f.context, receiptRootKeys: new Map([[f.root.keyId, f.signer.publicKeyDer]]),
  }), 'UNKNOWN_PINNED_KEY');
});

test('forged proof and forged receipt fail cryptographic verification', () => {
  const f = fixture(), proof = Buffer.from(f.proof), ack = Buffer.from(f.ack);
  proof[proof.length - 1] = proof[proof.length - 1]! ^ 1;
  reason(evaluateOfflineRootSnapshot(f.ack, proof, f.context), 'PROOF_SIGNATURE');
  ack[ack.length - 1] = ack[ack.length - 1]! ^ 1;
  reason(evaluateOfflineRootSnapshot(ack, f.proof, f.context), 'RECEIPT_SIGNATURE');
});

test('exact receipt digest, action, root and provider bindings cannot be substituted', () => {
  const f = fixture();
  for (const key of ['receiptDigest', 'actionDigest', 'issuerProviderId'] as const) {
    reason(evaluateOfflineRootSnapshot(f.ack,
      f.signed({ ...f.fields, [key]: 'ab'.repeat(32) }), f.context), 'RECEIPT_BINDING');
  }
  reason(evaluateOfflineRootSnapshot(f.ack,
    f.signed({ ...f.fields, eventId: id(99) }), f.context), 'RECEIPT_BINDING');
});

test('proof report, protocol, revision, payload, origin and status must match exact ACK', () => {
  const f = fixture();
  const changes: Partial<OfflineRootProofFields>[] = [
    { reportId: id(99) }, { reportProtocolVersion: 1 }, { revision: 4 },
    { payloadDigest: 'ab'.repeat(32) }, { originKeyId: 'ab'.repeat(32) }, { status: 3 },
  ];
  for (const change of changes) reason(evaluateOfflineRootSnapshot(f.ack,
    f.signed({ ...f.fields, ...change }), f.context), 'PROOF_REPORT_BINDING');
});

test('expected verified SOS identity and original public key are mandatory', () => {
  const f = fixture();
  for (const report of [null, { ...f.context.report!, revision: 4 },
    { ...f.context.report!, originPublicKeyDer: f.signer.publicKeyDer }])
    reason(evaluateOfflineRootSnapshot(f.ack, f.proof, { ...f.context, report }), 'REPORT_LINKAGE');
});

test('signed policy digest, scope and domain require exact operator approval', () => {
  const f = fixture();
  for (const change of [{ policyDigest: 'ab'.repeat(32) }, { scope: 'UNAPPROVED' },
    { authorityDomainId: 'OTHER_AUTHORITY' }])
    reason(evaluateOfflineRootSnapshot(f.ack,
      f.signed({ ...f.fields, ...change }), f.context), 'POLICY_MISMATCH');
});

test('RESOLVED needs explicit acceptance and still cannot close the SOS', () => {
  const f = fixture();
  const ack = f.receipt({ status: 4 });
  reason(evaluateOfflineRootSnapshot(ack, f.signed(f.proofFields(ack)), f.context), 'POLICY_MISMATCH');
  f.context.policy = { ...f.context.policy!, allowedStatuses: [4],
    resolvedHandling: 'REPORTED_STATUS_ONLY_NO_AUTOMATIC_CLOSURE' };
  const r = candidate(evaluateOfflineRootSnapshot(ack, f.signed(f.proofFields(ack)), f.context));
  assert.equal(r.proposedVerification.statusIsIssuerReportOnly, true);
  assert.equal('closeReport' in r, false);
});

test('signed or locally known revocation defeats old positive evidence', () => {
  const f = fixture();
  reason(evaluateOfflineRootSnapshot(f.ack, f.signed({
    ...f.fields, authorityState: 'REVOKED_AT_CHECKPOINT',
  }), f.context), 'KNOWN_REVOKED');
  for (const keyId of [f.root.keyId, f.signer.keyId]) reason(evaluateOfflineRootSnapshot(
    f.ack, f.proof, { ...f.context, revokedKeyIds: new Set([keyId]) }), 'KNOWN_REVOKED');
  reason(evaluateOfflineRootSnapshot(f.ack, f.proof, {
    ...f.context, revokedProviderIds: new Set([hex(f.provider)]),
  }), 'KNOWN_REVOKED');
});

test('unqualified clock, missing checkpoint, reboot and monotonic rollback remain pending', () => {
  const f = fixture(), t = f.context.trustedTime!;
  reason(evaluateOfflineRootSnapshot(f.ack, f.proof, {
    ...f.context, trustedTime: null,
  }), 'QUALIFIED_TIME_MISSING');
  reason(evaluateOfflineRootSnapshot(f.ack, f.proof, {
    ...f.context, trustedTime: { ...t, qualifiedSourceId: 'UNQUALIFIED' },
  }), 'QUALIFIED_TIME_MISSING');
  for (const clock of [{ ...t.clock, bootId: id(77) }, { ...t.clock, elapsedMs: 99 }])
    reason(evaluateOfflineRootSnapshot(f.ack, f.proof, {
      ...f.context, trustedTime: { ...t, clock },
    }), 'SAME_BOOT_TIME_UNAVAILABLE');
});

test('whole trusted interval rejects future/overlapping checkpoint and expiry equality', () => {
  const f = fixture(), t = f.context.trustedTime!;
  for (const bounds of [{ earliestMs: T + 9, latestMs: T + 20 },
    { earliestMs: T + 4890, latestMs: T + 4900 }])
    reason(evaluateOfflineRootSnapshot(f.ack, f.proof, {
      ...f.context, trustedTime: { ...t, checkpoint: { ...t.checkpoint, ...bounds } },
    }), 'TIME_OUTSIDE_PROOF');
});

test('authority age includes signed uncertainty and rejects equality conservatively', () => {
  const f = fixture();
  f.context.policy = { ...f.context.policy!, maxAuthorityStalenessMs: 1030 };
  reason(evaluateOfflineRootSnapshot(f.ack, f.signed(f.proofFields(f.ack)), f.context),
    'AUTHORITY_SNAPSHOT_STALE');
});

test('fresh authority check cannot make an old receipt issuance fresh', () => {
  const f = fixture();
  f.context.policy = { ...f.context.policy!, maxReceiptIssuanceAgeMs: 2020 };
  reason(evaluateOfflineRootSnapshot(f.ack, f.signed(f.proofFields(f.ack)), f.context),
    'RECEIPT_ISSUANCE_STALE');
});

test('proof lifetime cannot outlive signed receipt or approved duration', () => {
  const f = fixture();
  for (const expiresAtMs of [T + 10001, T + 6000])
    reason(evaluateOfflineRootSnapshot(f.ack,
      f.signed({ ...f.fields, expiresAtMs }), f.context), 'PROOF_LIFETIME');
  reason(evaluateOfflineRootSnapshot(f.ack, f.signed({
    ...f.fields, authorityCheckedAtMs: T - 995, notBeforeMs: T - 2000,
  }), f.context), 'PROOF_LIFETIME');
});

test('arithmetic overflow, invalid source interval and missing durable state fail closed', () => {
  const f = fixture();
  f.context.policy = { ...f.context.policy!, maxAuthorityStalenessMs: Number.MAX_SAFE_INTEGER };
  reason(evaluateOfflineRootSnapshot(f.ack, f.proof, f.context), 'POLICY_INVALID');
  const g = fixture();
  reason(evaluateOfflineRootSnapshot(g.ack, g.proof, { ...g.context, state: null }),
    'DURABLE_STATE_MISSING_OR_INVALID');
  const t = g.context.trustedTime!;
  reason(evaluateOfflineRootSnapshot(g.ack, g.proof, { ...g.context,
    trustedTime: { ...t, checkpoint: { ...t.checkpoint, earliestMs: -1 } },
  }), 'TRUSTED_CHECKPOINT_INVALID');
});

test('restart replay is duplicate and preserves epoch/check/time high-water', () => {
  const f = fixture();
  const first = candidate(evaluateOfflineRootSnapshot(f.ack, f.proof, f.context));
  const reloaded = JSON.parse(JSON.stringify(first.nextState));
  const second = candidate(evaluateOfflineRootSnapshot(f.ack, f.proof,
    { ...f.context, state: reloaded }));
  assert.equal(second.application, 'DUPLICATE');
  assert.equal(second.notificationEligibleAfterCommit, false);
  assert.equal(second.nextState.proofs.length, 1);
  assert.equal(second.nextState.receipts.length, 1);
  assert.equal(second.nextState.epochHighWater, '9');
  assert.equal(second.nextState.timeEarliestHighWaterMs, T + 1000);
  assert.equal(second.nextState.checkedAtEarliestHighWaterMs, T - 10);
  assert.equal(second.expectedStateGeneration, 1);
});

test('two pure concurrent evaluations have no authority or durable side effects', () => {
  const f = fixture();
  const a = candidate(evaluateOfflineRootSnapshot(f.ack, f.proof, f.context));
  const b = candidate(evaluateOfflineRootSnapshot(f.ack, f.proof, f.context));
  assert.equal(a.expectedStateGeneration, b.expectedStateGeneration);
  assert.equal(a.requiresAtomicCommit, true);
  assert.deepEqual(f.context.state!.receipts, []);
  // Future adapter must CAS this generation and recompute the losing candidate.
});

test('known higher epoch, checked time and trusted time cannot roll back', () => {
  const f = fixture(), s = f.context.state!;
  for (const state of [{ ...s, epochHighWater: '10', authorityStateDigest: '22'.repeat(32) },
    { ...s, checkedAtEarliestHighWaterMs: T }, { ...s, timeEarliestHighWaterMs: T + 1001 }])
    reason(evaluateOfflineRootSnapshot(f.ack, f.proof, { ...f.context, state }), 'ROLLBACK');
});

test('same epoch conflicting authority snapshot is equivocation', () => {
  const f = fixture();
  reason(evaluateOfflineRootSnapshot(f.ack, f.proof, { ...f.context, state: {
    ...f.context.state!, epochHighWater: '9', authorityStateDigest: '33'.repeat(32),
  } }), 'EPOCH_EQUIVOCATION');
});

test('proof ID and receipt event ID cannot reserve conflicting canonical bytes', () => {
  const f = fixture();
  const accepted = candidate(evaluateOfflineRootSnapshot(f.ack, f.proof, f.context));
  f.context.state = accepted.nextState;
  reason(evaluateOfflineRootSnapshot(f.ack,
    f.signed({ ...f.fields, expiresAtMs: T + 4800 }), f.context), 'PROOF_ID_CONFLICT');
  const altered = f.receipt({ status: 3 });
  reason(evaluateOfflineRootSnapshot(altered,
    f.signed(f.proofFields(altered, { proofId: id(77) })), f.context), 'EVENT_ID_CONFLICT');
});

test('out-of-order sequence is historical; equal sequence with another action conflicts', () => {
  const f = fixture();
  const newer = f.receipt({ sequence: 3n, actionId: id(30) });
  f.context.state = candidate(evaluateOfflineRootSnapshot(newer,
    f.signed(f.proofFields(newer, { proofId: id(40) })), f.context)).nextState;
  const historical = candidate(evaluateOfflineRootSnapshot(f.ack, f.proof, f.context));
  assert.equal(historical.application, 'HISTORICAL');
  assert.equal(historical.notificationEligibleAfterCommit, false);
  const sameSequence = f.receipt({ sequence: 3n, actionId: id(31) });
  reason(evaluateOfflineRootSnapshot(sameSequence,
    f.signed(f.proofFields(sameSequence, { proofId: id(41) })), f.context), 'SEQUENCE_CONFLICT');
});

test('sequence conflicts are checked across revisions; providers stay independent', () => {
  const f = fixture();
  f.context.state = { ...f.context.state!, receipts: [{
    eventId: id(90), receiptDigest: '90'.repeat(32), issuerProviderId: hex(f.provider),
    reportId: f.fields.reportId, revision: 2, sequence: '1',
  }] };
  reason(evaluateOfflineRootSnapshot(f.ack, f.proof, f.context), 'SEQUENCE_CONFLICT');
  f.context.state = { ...f.context.state, receipts: [{
    ...f.context.state.receipts[0]!, issuerProviderId: '91'.repeat(32),
  }] };
  assert.equal(candidate(evaluateOfflineRootSnapshot(f.ack, f.proof, f.context)).application, 'NEW');
});

test('newer sequence cannot promote an older SOS revision', () => {
  const f = fixture();
  const laterSequence = f.receipt({ sequence: 10n });
  const proof = f.signed(f.proofFields(laterSequence));
  f.context.activeReportRevision = 4;
  assert.equal(candidate(evaluateOfflineRootSnapshot(laterSequence, proof, f.context))
    .application, 'HISTORICAL');
  f.context.activeReportRevision = 3;
  f.context.state = { ...f.context.state!, receipts: [{
    eventId: id(90), receiptDigest: '90'.repeat(32), issuerProviderId: hex(f.provider),
    reportId: f.fields.reportId, revision: 4, sequence: '2',
  }] };
  const result = candidate(evaluateOfflineRootSnapshot(laterSequence, proof, f.context));
  assert.equal(result.application, 'HISTORICAL');
  assert.equal(result.notificationEligibleAfterCommit, false);
  reason(evaluateOfflineRootSnapshot(laterSequence, proof, {
    ...f.context, activeReportRevision: null,
  }), 'REPORT_LINKAGE');
});

test('separately persisted known revocation survives restart and defeats replay', () => {
  const f = fixture();
  const accepted = candidate(evaluateOfflineRootSnapshot(f.ack, f.proof, f.context));
  // This simulates already-authorized durable revocation ingestion, not proof parsing.
  const saved = JSON.stringify({ state: accepted.nextState, revokedKeyIds: [f.root.keyId] });
  const loaded = JSON.parse(saved);
  reason(evaluateOfflineRootSnapshot(f.ack, f.proof, {
    ...f.context, state: loaded.state, revokedKeyIds: new Set<string>(loaded.revokedKeyIds),
  }), 'KNOWN_REVOKED');
});

test('full replay capacity refuses admission without evicting protected evidence', () => {
  const f = fixture();
  f.context.policy = { ...f.context.policy!, maxReplayRecords: 1 };
  reason(evaluateOfflineRootSnapshot(f.ack, f.signed(f.proofFields(f.ack)), f.context),
    'REPLAY_CAPACITY');
  assert.equal(f.context.state!.proofs.length, 0);
});

test('strict version, algorithm, keys, integer types and trailing bytes reject', () => {
  const f = fixture();
  for (const change of [{ version: 2 }, { algorithm: 2 }, { revision: '3' },
    { unknown: 1 }, { revocationEpoch: '09' }, { receiptDigest: f.fields.receiptDigest.toUpperCase() }])
    assert.throws(() => offlineRootProofSigningInput({
      ...f.fields, ...change,
    } as OfflineRootProofFields));
  reason(evaluateOfflineRootSnapshot(f.ack, Buffer.concat([f.proof, Buffer.from([0])]),
    f.context), 'MALFORMED_SNAPSHOT');
});

test('duplicate JSON keys, noncanonical JSON, high-S and oversized evidence reject', () => {
  const f = fixture();
  const original = f.proof.subarray(8, -64).toString();
  for (const encoded of [original.replace('{', '{"version":1,'), ' ' + original]) {
    const b = Buffer.from(encoded), h = Buffer.from(f.proof.subarray(0, 8));
    h.writeUInt32BE(b.length, 4);
    reason(evaluateOfflineRootSnapshot(f.ack,
      Buffer.concat([h, b, f.proof.subarray(-64)]), f.context), 'MALFORMED_SNAPSHOT');
  }
  const high = Buffer.from(f.proof);
  const n = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  const s = BigInt('0x' + high.subarray(-32).toString('hex'));
  Buffer.from((n - s).toString(16).padStart(64, '0'), 'hex').copy(high, high.length - 32);
  reason(evaluateOfflineRootSnapshot(f.ack, high, f.context), 'MALFORMED_SNAPSHOT');
  reason(evaluateOfflineRootSnapshot(f.ack, Buffer.alloc(4097), f.context), 'MALFORMED_SNAPSHOT');
});

test('same epoch and state permits older check evidence without rolling audit or time backwards',()=>{
  const f=fixture();
  const state={...f.context.state!,epochHighWater:'9',authorityStateDigest:'22'.repeat(32),checkedAtEarliestHighWaterMs:T+100};
  const r=candidate(evaluateOfflineRootSnapshot(f.ack,f.proof,{...f.context,state}));
  assert.equal(r.nextState.checkedAtEarliestHighWaterMs,T+100);assert.equal(r.application,'NEW');
});

test('shared backend feed golden binds exact bytes, hashes and independent policy pins',()=>{
  const f=JSON.parse(readFileSync(new URL('../../../fixtures/offline-root-v1/golden.json',import.meta.url),'utf8'));
  const bundle=Buffer.from(f.bundleHex,'hex'), parts=decodeOfflineRootBundle(bundle);
  assert.equal(parts.receipt.toString('hex'),f.receiptHex);assert.equal(parts.proof.toString('hex'),f.proofHex);
  assert.equal(hash(bundle),f.bundleDigest);assert.equal(offlineRootPolicyDigest(f.policy),f.policyDigest);
  assert.deepEqual(decodeOfflineRootSnapshot(parts.proof).fields,f.proofFields);
  assert.equal(f.feedPage.entries[0].offlineBundleBase64,bundle.toString('base64'));
  assert.equal(verifyOfflineRootRevocation(Buffer.from(f.revocationHex,'hex'),f.policy,
    new Map([[f.proofFields.checkpointSignerKeyId,Buffer.from(f.trustedContext.checkpointPublicKeyDerHex,'hex')]])).targetId,
    f.proofFields.receiptRootKeyId);
});

test('bundle framing and revocation exact magic reject high-bit aliases and trailing bytes',()=>{
  const f=fixture(), b=encodeOfflineRootBundle(f.ack,f.proof);
  const bad=Buffer.from(b);bad[0]=bad[0]!|128;
  assert.throws(()=>decodeOfflineRootBundle(bad));
  assert.throws(()=>decodeOfflineRootBundle(Buffer.concat([b,Buffer.from([0])])));
  const fields={format:'SAGIP_OFFLINE_ROOT_REVOCATION' as const,version:1 as const,algorithm:1 as const,
    revocationId:id(90),policyDigest:offlineRootPolicyDigest(f.context.policy!),authorityDomainId:'SYNTHETIC_AUTHORITY',
    checkpointSignerKeyId:f.signer.keyId,targetKind:'KEY' as const,targetId:f.root.keyId,revocationEpoch:'10',
    authorityStateDigest:'cc'.repeat(32),revokedAtMs:T};
  const v=encodeOfflineRootRevocation(fields,canonicalizeNewReceiptSignature(sign('sha256',
    offlineRootRevocationSigningInput(fields),{key:f.signer.privateKey,dsaEncoding:'ieee-p1363'})));
  assert.equal(verifyOfflineRootRevocation(v,f.context.policy!,f.context.checkpointSignerKeys).targetId,f.root.keyId);
  const high=Buffer.from(v);high[0]=high[0]!|128;assert.throws(()=>decodeOfflineRootRevocation(high));
  assert.throws(()=>offlineRootRevocationSigningInput({...fields,revocationEpoch:'0'}));
  const foreign={...fields,targetId:'aa'.repeat(32)};
  const signed=encodeOfflineRootRevocation(foreign,canonicalizeNewReceiptSignature(sign('sha256',
    offlineRootRevocationSigningInput(foreign),{key:f.signer.privateKey,dsaEncoding:'ieee-p1363'})));
  assert.throws(()=>verifyOfflineRootRevocation(signed,f.context.policy!,f.context.checkpointSignerKeys),/REVOCATION_POLICY/);
});
