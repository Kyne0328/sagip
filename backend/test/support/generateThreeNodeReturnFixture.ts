// TEST ONLY: source-produced signed objects. No private key or bearer is written.
import assert from 'node:assert/strict';
import {createHash, sign} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {offlineRootServiceFixture, T} from './offlineRootServiceFixture.js';
import {canonicalizeNewReceiptSignature, decodeReceipt, verifyReceiptSignature} from '../../src/protocol/receiptV2.js';
import {decodeOfflineRootBundle, decodeOfflineRootSnapshot, offlineRootPolicyDigest} from '../../src/protocol/offlineRootSnapshot.js';
import {GrantProvisioningService} from '../../src/responder/grantProvisioning.js';
import {ResponderService} from '../../src/responder/service.js';
import {originTimeRequestSigningInput} from '../../src/responder/originAuthorityTimeService.js';
import {handleSagipRequest, type SagipServerDependencies} from '../../src/http/handleRequest.js';
import type {AuthoritySigner} from '../../src/responder/receiptService.js';
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const goldenPath=new URL('../../../fixtures/offline-root-v1/golden.json',import.meta.url);
const originalGolden=hash(readFileSync(goldenPath));
const f=await offlineRootServiceFixture();
try {
  await f.snapshots.enrollDomain(f.admin);
  const action=await f.createAction(2,'','55555555-5555-4555-8555-555555555555');
  assert.equal(action.result.state,'SIGNED');assert.equal(action.result.reason,null);
  const bundle=await f.snapshots.issueCommitted(action.actionId);assert.ok(bundle);
  const page=await f.runtime.gatewayReceiptFeed!.list(f.envelope.reportId,null,f.responder);
  assert.equal(page.entries[0]!.offlineBundleBase64,bundle.toString('base64'));
  const {proof}=decodeOfflineRootBundle(bundle), fields=decodeOfflineRootSnapshot(proof).fields;
  const gatewayVerifier=Buffer.alloc(32,0x71), relayVerifier=Buffer.alloc(32,0x72);
  const bearer='SYNTHETIC-THREE-NODE-RESPONDER-BEARER';
  await f.pool.query('UPDATE responder_identities SET api_key_hash=$2 WHERE responder_id=$1',
    [f.responder.responderId,hash(Buffer.from(bearer))]);
  const rawSigner:AuthoritySigner={publicKeyDer:f.root.publicKeyDer,
    sign:async bytes=>canonicalizeNewReceiptSignature(sign('sha256',bytes,
      {key:f.root.privateKey,dsaEncoding:'ieee-p1363'}))};
  const guarded:AuthoritySigner={publicKeyDer:f.root.publicKeyDer,
    assertActive:c=>f.snapshots.assertRootActive(c),
    sign:(bytes,c)=>f.snapshots.signWithRootAuthority(bytes,rawSigner,c)};
  f.setTime(T+100);
  const authority=new GrantProvisioningService(f.pool,guarded,
    ()=>({timeMs:T+100,uncertaintyMs:10,validForMs:3600000}),{
      approvedIssuerKeyIds:new Set(),allowedScopes:new Set(['SYNTHETIC_SCOPE']),
      allowedResponderRoles:new Set(['RESPONDER']),
      verifierOwners:new Map([[gatewayVerifier.toString('hex'),f.responder.responderId],
        [relayVerifier.toString('hex'),f.responder.responderId]]),statusMask:15,purposeMask:9});
  const deps:SagipServerDependencies={ingestEnvelope:async()=>{throw new Error('NO_LIVE_SOS');},
    responderService:new ResponderService(f.pool),authorityService:authority,
    originAuthorityTimeService:f.runtime.originAuthorityTimeService!};
  const timeProofs=[];
  for (const [index,role,verifier] of [[1,'gateway',gatewayVerifier],[2,'relay',relayVerifier],
    [3,'origin',Buffer.from(f.envelope.originKeyId)]] as const) {
    const bootId='aaaaaaa'+index+'-1111-4111-8111-111111111111';
    const challengeId='bbbbbbb'+index+'-1111-4111-8111-111111111111';
    const nonce=Buffer.alloc(32,0x60+index);
    const requestBody=Buffer.from(JSON.stringify({verifierId:verifier.toString('base64'),
      verifierBootSessionId:bootId,nonce:nonce.toString('base64')}));
    const path=role==='origin'?'/v2/reports/'+f.envelope.reportId+'/authority/time':'/v2/authority/time';
    const headers:Record<string,string>={'content-type':'application/json'};
    if(role==='origin') headers['x-sagip-origin-time-signature']=canonicalizeNewReceiptSignature(
      sign('sha256',originTimeRequestSigningInput(f.envelope.reportId,requestBody),
        {key:f.origin.privateKey,dsaEncoding:'ieee-p1363'})).toString('base64');
    else headers.authorization='Bearer '+bearer;
    const response=await handleSagipRequest(new Request('https://synthetic.sagip.test'+path,
      {method:'POST',headers,body:requestBody.toString('utf8')}),deps);
    assert.equal(response.status,200,role+' real source time route failed');
    const bytes=Buffer.from(await response.arrayBuffer()), decoded=decodeReceipt(bytes);
    assert.equal(verifyReceiptSignature(decoded,f.root.publicKeyDer),true);
    if(decoded.fields.purpose!==4)throw new Error('Signed SGT2 required');
    assert.deepEqual(decoded.fields.verifierId,verifier);assert.deepEqual(decoded.fields.nonce,nonce);
    assert.equal(decoded.fields.verifierBootSessionId,bootId);
    timeProofs.push({role,verifierIdHex:verifier.toString('hex'),bootId,verifierBootSessionId:bootId,
      challengeId,nonceHex:nonce.toString('hex'),sentElapsedMs:100,receiveElapsedMs:120,receivedElapsedMs:120,
      elapsedMs:120,highWaterEarliestMs:null,bytesHex:bytes.toString('hex'),timeProofHex:bytes.toString('hex'),
      timeProofDigest:hash(bytes),sourceRoute:path});
  }
  const context={rootPublicKeyDerHex:f.root.publicKeyDer.toString('hex'),
    checkpointPublicKeyDerHex:f.signer.publicKeyDer.toString('hex'),
    originPublicKeyDerHex:f.origin.publicKeyDer.toString('hex'),reportId:f.envelope.reportId,
    reportProtocolVersion:1,revision:1,activeReportRevision:1,payloadDigest:f.envelope.payloadDigest.toString('hex'),
    originKeyId:f.envelope.originKeyId.toString('hex'),qualifiedSourceId:'SYNTHETIC_QUALIFIED_SOURCE'};
  const vector={schemaVersion:1,syntheticOnly:true,
    storageBackend:process.env.SAGIP_TEST_DATABASE_URL?'ISOLATED_POSTGRES_TEST':'PG_MEM_TEST',
    timeSource:'SIMULATED_TEST_CLOCK',notLiveAssurance:true,
    generatedBy:'ReceiptService -> OfflineRootSnapshotService -> GatewayReceiptFeed; authenticated HTTP time endpoints',
    policy:f.policy,policyDigest:offlineRootPolicyDigest(f.policy),trustedContext:context,
    envelopeHex:f.envelopeBytes.toString('hex'),receiptHex:action.receipt.toString('hex'),
    proofHex:proof.toString('hex'),bundleHex:bundle.toString('hex'),proofFields:fields,
    proofDigest:hash(proof),bundleDigest:hash(bundle),receiptDigest:hash(action.receipt),
    feedPage:page,timeProofs,
    expected:{kind:'VERIFIED_OFFLINE_ROOT_SNAPSHOT',status:'EN_ROUTE',statusCode:2,revision:1,
      reportId:f.envelope.reportId,automaticClosure:false,statusIsIssuerReportOnly:true,
      revocationNotCheckedWhileOffline:true,receiptDigest:hash(action.receipt),bundleDigest:hash(bundle)}};
  mkdirSync(new URL('../../../fixtures/offline-root-v1/',import.meta.url),{recursive:true});
  const output=new URL('../../../fixtures/offline-root-v1/three-node.json',import.meta.url);
  writeFileSync(output,JSON.stringify(vector,null,2)+'\n');
  assert.equal(hash(readFileSync(goldenPath)),originalGolden,'Main golden must remain unchanged');
  console.log(JSON.stringify({fixture:'fixtures/offline-root-v1/three-node.json',bytes:readFileSync(output).length,
    mainGoldenDigest:originalGolden,receiptDigest:vector.receiptDigest,proofDigest:vector.proofDigest,
    bundleDigest:vector.bundleDigest,timeProofs:timeProofs.map(t=>({role:t.role,timeProofDigest:t.timeProofDigest}))}));
} finally {await f.close();}
