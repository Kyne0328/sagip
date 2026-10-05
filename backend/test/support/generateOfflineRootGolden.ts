// Synthetic offline test vectors only. Private keys are ephemeral and never written.
import {createHash, sign} from 'node:crypto';
import {canonicalizeNewReceiptSignature} from '../../src/protocol/receiptV2.js';
import {mkdirSync, writeFileSync} from 'node:fs';
import {offlineRootServiceFixture, T} from './offlineRootServiceFixture.js';
import {decodeOfflineRootBundle, decodeOfflineRootSnapshot, offlineRootPolicyDigest, encodeOfflineRootSnapshot, offlineRootProofSigningInput, encodeOfflineRootBundle} from '../../src/protocol/offlineRootSnapshot.js';
const f = await offlineRootServiceFixture();
try {
  await f.snapshots.enrollDomain(f.admin);
  const action = await f.createAction(2, '', '55555555-5555-4555-8555-555555555555');
  if (action.result.state !== 'SIGNED') throw new Error('Committed backend receipt required');
  const bundle = await f.snapshots.issueCommitted(action.actionId);
  if (!bundle) throw new Error('Snapshot issuance required');
  const page = await f.runtime.gatewayReceiptFeed!.list(f.envelope.reportId, null, f.responder);
  if (page.entries[0]?.offlineBundleBase64 !== bundle.toString('base64')) throw new Error('Complete backend feed required');
  const {proof} = decodeOfflineRootBundle(bundle);
  const fields = decodeOfflineRootSnapshot(proof).fields;
  const rootId = createHash('sha256').update(f.root.publicKeyDer).digest('hex');
  f.setTime(T + 60000);
  const resolved = await f.createAction(4, '', '66666666-6666-4666-8666-666666666666');
  const resolvedBundle = await f.snapshots.issueCommitted(resolved.actionId);
  f.setTime(T + 900000);
  const renewedBundle = await f.snapshots.issueCommitted(action.actionId);
  if (!resolvedBundle || !renewedBundle) throw new Error('Required signed variants');
  const equivocationFields = {...fields, proofId: '77777777-7777-4777-8777-777777777777', authorityStateDigest: 'ee'.repeat(32)};
  const equivocationProof = encodeOfflineRootSnapshot(equivocationFields, canonicalizeNewReceiptSignature(sign(
    'sha256', offlineRootProofSigningInput(equivocationFields), {key: f.signer.privateKey, dsaEncoding: 'ieee-p1363'})));
  f.setTime(T + 901000);
  const revocation = await f.snapshots.revoke('KEY', rootId, f.admin);
  const context = {
    rootPublicKeyDerHex: f.root.publicKeyDer.toString('hex'),
    checkpointPublicKeyDerHex: f.signer.publicKeyDer.toString('hex'),
    originPublicKeyDerHex: f.origin.publicKeyDer.toString('hex'),
    reportId: f.envelope.reportId, reportProtocolVersion: 1, revision: 1,
    payloadDigest: f.envelope.payloadDigest.toString('hex'), originKeyId: f.envelope.originKeyId.toString('hex'),
    activeReportRevision: 1, qualifiedSourceId: 'SYNTHETIC_QUALIFIED_SOURCE',
    checkpoint: {earliestMs:T+100,latestMs:T+120,bootId:'88888888-8888-4888-8888-888888888888',
      receivedElapsedMs:100,validUntilMs:T+3600000,proofDigest:'11'.repeat(32)},
    clock: {bootId:'88888888-8888-4888-8888-888888888888',elapsedMs:100},
  };
  const vector = {schemaVersion:1,syntheticOnly:true,generatedBy:'ReceiptService -> OfflineRootSnapshotService -> GatewayReceiptFeed',
    policy:f.policy,policyDigest:offlineRootPolicyDigest(f.policy),trustedContext:context,
    envelopeHex:f.envelopeBytes.toString('hex'),receiptHex:action.receipt.toString('hex'),
    proofHex:proof.toString('hex'),bundleHex:bundle.toString('hex'),proofFields:fields,
    proofDigest:createHash('sha256').update(proof).digest('hex'),
    bundleDigest:createHash('sha256').update(bundle).digest('hex'),
    receiptDigest:createHash('sha256').update(action.receipt).digest('hex'),
    revocationHex:revocation.toString('hex'),feedPage:page,
    variants:{renewedBundleHex:renewedBundle.toString('hex'),resolvedBundleHex:resolvedBundle.toString('hex'),
      equivocationBundleHex:encodeOfflineRootBundle(action.receipt,equivocationProof).toString('hex'),
      laterCheckpoint:{...context.checkpoint,earliestMs:T+900100,latestMs:T+900120},
      laterClock:context.clock},
    expected:{kind:'CANDIDATE',verification:'VERIFIED_OFFLINE_ROOT_SNAPSHOT',application:'NEW',automaticClosure:false}};
  mkdirSync(new URL('../../../fixtures/offline-root-v1/', import.meta.url),{recursive:true});
  writeFileSync(new URL('../../../fixtures/offline-root-v1/golden.json',import.meta.url),JSON.stringify(vector,null,2)+'\n');
  console.log(JSON.stringify({fixture:'fixtures/offline-root-v1/golden.json',bundleBytes:bundle.length,receiptBytes:action.receipt.length}));
} finally {await f.close();}
