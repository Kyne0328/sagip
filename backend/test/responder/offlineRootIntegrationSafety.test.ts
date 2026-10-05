import assert from 'node:assert/strict';
import {createHash, sign} from 'node:crypto';
import test from 'node:test';
import type {PoolClient} from 'pg';
import {offlineRootServiceFixture, T} from '../support/offlineRootServiceFixture.js';
import {canonicalizeNewReceiptSignature, decodeReceipt, verifyReceiptSignature} from '../../src/protocol/receiptV2.js';
import {decodeOfflineRootBundle, decodeOfflineRootSnapshot} from '../../src/protocol/offlineRootSnapshot.js';
import {originTimeRequestSigningInput} from '../../src/responder/originAuthorityTimeService.js';
import {handleSagipRequest, type SagipServerDependencies} from '../../src/http/handleRequest.js';
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');

test('max-one connection pool supports two concurrent relay feed reads without nested checkout', {timeout:5000}, async()=>{
  const f=await offlineRootServiceFixture();
  try {
    await f.snapshots.enrollDomain(f.admin); await f.createAction();
    const connect=f.pool.connect.bind(f.pool); let tail=Promise.resolve(), active=0, max=0;
    f.pool.connect=(async()=>{
      const prior=tail; let unlock!:()=>void; tail=new Promise<void>(resolve=>{unlock=resolve;});
      await prior; const c=await connect(); active++; max=Math.max(max,active);
      return {query:c.query.bind(c),release:()=>{active--;c.release();unlock();}} as PoolClient;
    }) as typeof f.pool.connect;
    const [a,b]=await Promise.all([f.runtime.gatewayReceiptFeed!.list(f.envelope.reportId,null,f.responder),
      f.makeRuntime().gatewayReceiptFeed!.list(f.envelope.reportId,null,f.responder)]);
    assert.equal(a.entries.length,1);assert.equal(b.entries.length,1);assert.equal(max,1);assert.equal(active,0);
  } finally {await f.close();}
});

test('same-sample nonzero 4.5 second uncertainty supports committed status and bounded snapshot', async()=>{
  const f=await offlineRootServiceFixture(4500);
  try {
    await f.snapshots.enrollDomain(f.admin);const a=await f.createAction();
    assert.equal(a.result.reason,null);
    const b=decodeOfflineRootBundle((await f.snapshots.issueCommitted(a.actionId))!);
    const r=decodeReceipt(b.receipt).fields, p=decodeOfflineRootSnapshot(b.proof).fields;
    assert.equal(p.authorityTimeUncertaintyMs,4500);
    if(r.purpose!==1)throw new Error('ACK required');
    assert.equal(r.issuedAtMs,T-4500);assert.equal(p.notBeforeMs,T-4500);
  } finally {await f.close();}
});

test('final disclosure rechecks checkpoint signer revocation and expires without silently advancing', async()=>{
  const f=await offlineRootServiceFixture();
  try {
    await f.snapshots.enrollDomain(f.admin);const a=await f.createAction();
    const b=(await f.snapshots.issueCommitted(a.actionId))!;
    f.setTime(T+900000);
    const c=await f.pool.connect();
    try {assert.equal(await f.snapshots.validateBundleForDisclosure(c,b),'REFRESH');}finally{c.release();}
    const fresh=(await f.snapshots.issueCommitted(a.actionId))!;
    f.setTime(T+901000);await f.snapshots.revoke('KEY',hash(f.signer.publicKeyDer),f.admin);
    const d=await f.pool.connect();
    try {assert.equal(await f.snapshots.validateBundleForDisclosure(d,fresh),'REVOKED');}finally{d.release();}
    const page=await f.runtime.gatewayReceiptFeed!.list(f.envelope.reportId,null,f.responder);
    assert.equal(page.entries.length,0);assert.equal(page.revocationsBase64!.length,1);
  } finally {await f.close();}
});

test('origin-owned HTTP time bootstrap binds method/path/body without wall-clock prerequisite or responder credentials', async()=>{
  const f=await offlineRootServiceFixture();
  try {
    await f.snapshots.enrollDomain(f.admin);
    const challenge={verifierId:f.envelope.originKeyId.toString('base64'),
      verifierBootSessionId:'88888888-8888-4888-8888-888888888888',nonce:Buffer.alloc(32,7).toString('base64')};
    const body=Buffer.from(JSON.stringify(challenge));
    const signature=canonicalizeNewReceiptSignature(sign('sha256',originTimeRequestSigningInput(f.envelope.reportId,body),
      {key:f.origin.privateKey,dsaEncoding:'ieee-p1363'})).toString('base64');
    let refreshes=0;
    const deps:SagipServerDependencies={ingestEnvelope:async()=>{throw new Error('not ingestion');},
      originAuthorityTimeService:f.runtime.originAuthorityTimeService!,refreshAuthorityTime:async()=>{refreshes++;}};
    const request=(id=f.envelope.reportId, payload=body.toString(), sig:string|null=signature)=>new Request(
      'https://sagip.test/v2/reports/'+id+'/authority/time',{method:'POST',headers:{
        'content-type':'application/json',...(sig?{'x-sagip-origin-time-signature':sig}:{})},body:payload});
    assert.equal((await handleSagipRequest(request(f.envelope.reportId,body.toString(),null),deps)).status,401);
    assert.equal((await handleSagipRequest(request('99999999-9999-4999-8999-999999999999'),deps)).status,401);
    assert.equal((await handleSagipRequest(request(f.envelope.reportId,JSON.stringify({...challenge,nonce:Buffer.alloc(32,8).toString('base64')})),deps)).status,401);
    assert.equal(refreshes,0);
    const first=await handleSagipRequest(request(),deps);assert.equal(first.status,200);
    const bytes=Buffer.from(await first.arrayBuffer());const decoded=decodeReceipt(bytes);
    assert.equal(verifyReceiptSignature(decoded,f.root.publicKeyDer),true);
    if(decoded.fields.purpose!==4)throw new Error('timeproof required');
    assert.deepEqual(decoded.fields.verifierId,f.envelope.originKeyId);
    assert.deepEqual(decoded.fields.nonce,Buffer.alloc(32,7));
    assert.deepEqual(Buffer.from(await (await handleSagipRequest(request(),deps)).arrayBuffer()),bytes);
    assert.equal(Number((await f.pool.query('SELECT COUNT(*) AS count FROM origin_authority_time_proofs')).rows[0].count),1);
    const wrongBoot=Buffer.from(JSON.stringify({...challenge,verifierBootSessionId:'77777777-7777-4777-8777-777777777777'}));
    const wrongSignature=canonicalizeNewReceiptSignature(sign('sha256',originTimeRequestSigningInput(f.envelope.reportId,wrongBoot),
      {key:f.origin.privateKey,dsaEncoding:'ieee-p1363'})).toString('base64');
    await assert.rejects(f.runtime.originAuthorityTimeService!.issue(f.envelope.reportId,wrongBoot,wrongSignature),/TIME_CHALLENGE_REUSED/);
    f.setTime(T+1000);await f.snapshots.revoke('KEY',hash(f.root.publicKeyDer),f.admin);
    assert.equal((await handleSagipRequest(request(),deps)).status,403);
    await assert.rejects(f.createAction(),/ROOT_AUTHORITY_REVOKED/);
  } finally {await f.close();}
});
