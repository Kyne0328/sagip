import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  verifyReceipt,
  acceptTimeProof,
  advanceCheckpoint,
  type VerificationContext,
  type TimeChallenge,
} from '../../src/responder/receiptAuthority.js';
const f = JSON.parse(
  readFileSync(
    new URL(
      '../../../fixtures/receipts-v2/golden.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const bytes = (name: string): Buffer =>
  Buffer.from(
    f.vectors.find((v: { name: string }) => v.name === name).hex,
    'hex',
  );
const expected = f.trustedContext;
function context(): VerificationContext {
  return {
    roots: new Map([
      [expected.rootKeyId, Buffer.from(expected.rootPublicKeyDerHex, 'hex')],
    ]),
    revokedGrants: new Set(),
    allowedScopes: new Set(expected.allowedScopes),
    trustedTime: expected.trustedTime,
    authorityCheckedAtMs: expected.authorityCheckedAtMs,
    currentAuthorityChecked: true,
    report: {
      reportId: expected.reportId,
      reportProtocolVersion: 1,
      revision: 1,
      payloadDigest: Buffer.from(expected.payloadDigest, 'hex'),
      originKeyId: Buffer.from(expected.originKeyId, 'hex'),
      originPublicKeyDer: Buffer.from(expected.originPublicKeyDerHex, 'hex'),
    },
    pairedTimeProviderId: expected.gatewayProviderId,
  };
}
test('offline authority and revision matrix never promotes unknown evidence', () => {
  assert.equal(
    verifyReceipt(bytes('valid_offline_ack'), context()).kind,
    'VERIFIED_OFFLINE_AUTHORITY',
  );
  assert.equal(
    verifyReceipt(bytes('valid_cloud_ack'), context()).kind,
    'VERIFIED_CURRENT',
  );
  const unknown = context();
  unknown.roots.clear();
  assert.equal(
    verifyReceipt(bytes('valid_offline_ack'), unknown).kind,
    'UNVERIFIED_AUTHORITY',
  );
  const time = context();
  time.trustedTime = null;
  assert.equal(
    verifyReceipt(bytes('valid_offline_ack'), time).kind,
    'UNVERIFIED_AUTHORITY',
  );
  const scope = context();
  scope.allowedScopes.clear();
  assert.equal(
    verifyReceipt(bytes('valid_offline_ack'), scope).kind,
    'UNVERIFIED_AUTHORITY',
  );
  const revoked = context();
  revoked.revokedGrants.add('11111111-1111-4111-8111-111111111111');
  assert.equal(
    verifyReceipt(bytes('valid_offline_ack'), revoked).kind,
    'UNVERIFIED_AUTHORITY',
  );
  assert.equal(
    verifyReceipt(bytes('valid_signature_wrong_revision'), context()).kind,
    'UNVERIFIED_AUTHORITY',
  );
  assert.equal(
    verifyReceipt(bytes('valid_signature_ack_invalid_grant'), context()).kind,
    'REJECTED',
  );
  assert.equal(
    verifyReceipt(bytes('corrupted_signature'), context()).kind,
    'REJECTED',
  );
  const old = context();
  old.trustedTime = {
    earliestMs: expected.authorityCheckedAtMs + 604800000,
    latestMs: expected.authorityCheckedAtMs + 604800000,
  };
  assert.equal(
    verifyReceipt(bytes('valid_offline_ack'), old).kind,
    'UNVERIFIED_AUTHORITY',
  );
  const requester = context();
  requester.linkedAck = bytes('valid_offline_ack');
  assert.equal(
    verifyReceipt(bytes('valid_requester_receipt'), requester).kind,
    'VERIFIED_OFFLINE_AUTHORITY',
  );
  assert.equal(
    verifyReceipt(bytes('valid_requester_receipt'), context()).kind,
    'UNVERIFIED_AUTHORITY',
  );
});
test('fresh time consumption, boot, monotonic and high-water matrix', () => {
  let committed = false;
  const challenge: TimeChallenge = {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    verifierId: Buffer.from(expected.challenge.verifierId, 'hex'),
    verifierBootSessionId: expected.challenge.verifierBootSessionId,
    nonce: Buffer.from(expected.challenge.nonce, 'hex'),
    sentElapsedMs: 100,
    highWaterEarliestMs: null,
    context: context(),
    commitCheckpoint: () => {
      if (committed) return false;
      committed = true;
      return true;
    },
  };
  const clock = { bootId: challenge.verifierBootSessionId, elapsedMs: 110 };
  const accepted = acceptTimeProof(
    bytes('valid_gateway_time'),
    challenge,
    clock,
  );
  assert.equal(accepted.kind, 'ACCEPTED');
  if (accepted.kind !== 'ACCEPTED') throw new Error('expected checkpoint');
  assert.equal(
    accepted.checkpoint.earliestMs,
    expected.authorityCheckedAtMs + 9889,
  );
  assert.equal(
    acceptTimeProof(bytes('valid_gateway_time'), challenge, clock).kind,
    'REJECTED',
  );
  assert.equal(
    advanceCheckpoint(accepted.checkpoint, {
      bootId: 'different',
      elapsedMs: 120,
    }),
    null,
  );
  assert.equal(
    advanceCheckpoint(accepted.checkpoint, { ...clock, elapsedMs: 109 }),
    null,
  );
  const advanced = advanceCheckpoint(accepted.checkpoint, {
    ...clock,
    elapsedMs: 10110,
  });
  assert.equal(advanced?.earliestMs, expected.authorityCheckedAtMs + 19888);
  const fresh = { ...challenge, commitCheckpoint: () => true };
  assert.equal(
    acceptTimeProof(
      bytes('valid_gateway_time'),
      { ...fresh, nonce: Buffer.alloc(32) },
      clock,
    ).kind,
    'REJECTED',
  );
  assert.equal(
    acceptTimeProof(bytes('valid_gateway_time'), fresh, {
      ...clock,
      elapsedMs: 60101,
    }).kind,
    'REJECTED',
  );
  assert.equal(
    acceptTimeProof(
      bytes('valid_gateway_time'),
      { ...fresh, highWaterEarliestMs: expected.authorityCheckedAtMs + 9890 },
      clock,
    ).kind,
    'REJECTED',
  );
  assert.equal(
    acceptTimeProof(bytes('valid_gateway_time'), fresh, {
      ...clock,
      bootId: 'changed',
    }).kind,
    'REJECTED',
  );
});

test('known cryptographic failures reject even when report/time policy is unavailable', () => {
  const corrupted = Buffer.from(bytes('valid_offline_ack'));
  corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
  const unknown = context();
  unknown.trustedTime = null;
  assert.equal(verifyReceipt(corrupted, unknown).kind, 'REJECTED');
  const noReport = context();
  noReport.report = null;
  assert.equal(
    verifyReceipt(bytes('corrupted_signature'), noReport).kind,
    'REJECTED',
  );
});

test('root challenge, expiry equality, stale checks and paired-provider bounds', () => {
  const q: TimeChallenge = {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    verifierId: Buffer.from(expected.gatewayKeyId, 'hex'),
    verifierBootSessionId: '66666666-6666-4666-8666-666666666666',
    nonce: Buffer.from(expected.challenge.nonce, 'hex'),
    sentElapsedMs: 100,
    highWaterEarliestMs: null,
    context: context(),
    commitCheckpoint: () => true,
  };
  const root = acceptTimeProof(bytes('valid_root_time_checkpoint'), q, {
    bootId: q.verifierBootSessionId,
    elapsedMs: 120,
  });
  assert.equal(root.kind, 'ACCEPTED');
  if (root.kind !== 'ACCEPTED') throw new Error('expected root checkpoint');
  assert.equal(root.checkpoint.earliestMs, expected.authorityCheckedAtMs - 120);
  assert.equal(root.checkpoint.latestMs, expected.authorityCheckedAtMs + 120);
  assert.equal(
    advanceCheckpoint(
      { ...root.checkpoint, validUntilMs: root.checkpoint.latestMs },
      { bootId: q.verifierBootSessionId, elapsedMs: 120 },
    ),
    null,
  );
  assert.equal(
    acceptTimeProof(
      bytes('valid_root_time_checkpoint'),
      { ...q, highWaterEarliestMs: -1 },
      { bootId: q.verifierBootSessionId, elapsedMs: 120 },
    ).kind,
    'REJECTED',
  );
  const stale = context();
  stale.authorityCheckedAtMs = expected.authorityCheckedAtMs - 2 * 86400000;
  assert.equal(
    verifyReceipt(bytes('valid_offline_ack'), stale).kind,
    'VERIFIED_OFFLINE_AUTHORITY',
  );
  const rotated = context();
  rotated.roots.set(
    expected.rootKeyId,
    Buffer.from(expected.originPublicKeyDerHex, 'hex'),
  );
  assert.equal(
    verifyReceipt(bytes('valid_offline_ack'), rotated).kind,
    'UNVERIFIED_AUTHORITY',
  );
});

test('shared time-policy matrix, pairing and parent-verifier isolation',()=>{
 const q:TimeChallenge={id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',verifierId:Buffer.from(expected.gatewayKeyId,'hex'),verifierBootSessionId:'66666666-6666-4666-8666-666666666666',nonce:Buffer.from(expected.challenge.nonce,'hex'),sentElapsedMs:0,highWaterEarliestMs:null,context:context(),commitCheckpoint:()=>true};
 const clock={bootId:q.verifierBootSessionId,elapsedMs:0};
 const accepted=acceptTimeProof(bytes('valid_root_time_checkpoint'),q,clock);
 if(accepted.kind!=='ACCEPTED')throw new Error('fixture root');
 for(const policy of f.timePolicyCases){
  switch(policy.name){
   case 'root_response_interval':{
    const r=acceptTimeProof(bytes('valid_root_time_checkpoint'),q,{...clock,elapsedMs:policy.rttMs});
    if(r.kind!=='ACCEPTED')throw new Error(policy.name);
    assert.deepEqual({earliestMs:r.checkpoint.earliestMs,latestMs:r.checkpoint.latestMs},policy.expectedInterval);break;
   }
   case 'gateway_same_boot_advance':{
    const r=advanceCheckpoint({...accepted.checkpoint,...policy.checkpoint}, {...clock,elapsedMs:policy.elapsedMs});assert.deepEqual(r,policy.expectedInterval);break;
   }
   case 'upper_equal_expiry_rejects':{
    const r=advanceCheckpoint({...accepted.checkpoint,...policy.interval,validUntilMs:policy.expiresAtMs},clock);assert.equal(r===null?'REJECT':'ACCEPT',policy.expected);break;
   }
   case 'lower_below_high_water_rejects':case 'same_lower_high_water_accepts':{
    // Translate the shared inequality to this fixture's signed center; preserve its exact delta.
    const highWater=accepted.checkpoint.earliestMs+policy.highWaterMs-policy.interval.earliestMs;
    const r=acceptTimeProof(bytes('valid_root_time_checkpoint'),{...q,highWaterEarliestMs:highWater},clock);assert.equal(r.kind==='ACCEPTED'?'ACCEPT':'REJECT',policy.expected);break;
   }
   case 'changed_boot_rejects_elapsed':assert.equal(advanceCheckpoint({...accepted.checkpoint,bootId:policy.checkpointBootId},{...clock,bootId:policy.currentBootId})===null?'REJECT':'ACCEPT',policy.expected);break;
   case 'consumed_nonce_rejects':assert.equal(acceptTimeProof(bytes('valid_root_time_checkpoint'),{...q,commitCheckpoint:()=>!policy.consumed},clock).kind==='ACCEPTED'?'ACCEPT':'REJECT',policy.expected);break;
   case 'old_response_rejects':assert.equal(acceptTimeProof(bytes('valid_root_time_checkpoint'),q,{...clock,elapsedMs:policy.rttMs}).kind==='ACCEPTED'?'ACCEPT':'REJECT',policy.expected);break;
   default:throw new Error('uncovered policy '+policy.name);
  }
 }
 assert.equal(acceptTimeProof(bytes('valid_root_time_checkpoint'),q,{...clock,elapsedMs:60000}).kind,'ACCEPTED');
 const browser={...q,verifierId:Buffer.from(expected.challenge.verifierId,'hex'),verifierBootSessionId:expected.challenge.verifierBootSessionId};
 const browserClock={bootId:browser.verifierBootSessionId,elapsedMs:10};
 assert.equal(acceptTimeProof(bytes('valid_gateway_time'),{...browser,context:{...context(),pairedTimeProviderId:null}},browserClock).kind,'REJECTED');
 assert.equal(acceptTimeProof(bytes('valid_signature_gateway_time_wrong_parent_verifier'),browser,browserClock).kind,'REJECTED');
});
