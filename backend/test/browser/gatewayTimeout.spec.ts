import {expect, test} from '@playwright/test';
import {handleSagipRequest} from '../../src/http/handleRequest.js';
const ORIGIN='https://sagip.test';

test('a timed-out native authorizer never sends a late request', async ({page}) => {
  await page.clock.install();
  await page.route(ORIGIN + '/**', async route => {
    if (new URL(route.request().url()).pathname === '/fixture') return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Synthetic timeout fixture</title>'});
    const response=await handleSagipRequest(new Request(route.request().url()),{ingestEnvelope:async()=>{throw new Error('unused');}});
    return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers.entries()),body:Buffer.from(await response.arrayBuffer())});
  });
  await page.goto(ORIGIN + '/fixture');
  await page.evaluate(`(async () => {
    AbortSignal.timeout = delay => {const controller=new AbortController();setTimeout(()=>controller.abort(new Error('TIMEOUT')),delay);return controller.signal;};
    const {GatewayClient}=await import('/responder/assets/browser/gatewayClient.js');
    window.gatewayCalls=0;
    const original=window.fetch;
    window.fetch=(...args)=>{window.gatewayCalls++;return original(...args);};
    const provider=new GatewayClient({providerKind:2,providerId:new Uint8Array(32).fill(9),responderId:'33333333-3333-4333-8333-333333333333',
      authorizeNativeRequest:()=>new Promise(resolve=>{window.releaseAuthorization=()=>resolve({});})});
    window.nativeOutcome='pending';
    provider.getAction('22222222-2222-4222-8222-222222222222').then(()=>{window.nativeOutcome='unexpected';},()=>{window.nativeOutcome='timeout';});
  })()`);
  await page.clock.runFor(30001);
  expect(await page.evaluate('window.nativeOutcome')).toBe('timeout');
  await page.evaluate('window.releaseAuthorization()');
  expect(await page.evaluate('window.gatewayCalls')).toBe(0);
});

test('a timed-out commit retains its exact durable intent and reconciles on retry', async ({page}) => {
  await page.clock.install();
  let remote: Record<string, unknown> | null=null;
  let commitRequests=0;
  let release: (()=>void) | undefined;
  await page.route(ORIGIN+'/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/fixture')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Synthetic timeout fixture</title>'});
    if(url.pathname==='/v2/responder/actions'){
      commitRequests++;
      remote=route.request().postDataJSON() as Record<string,unknown>;
      await new Promise<void>(resolve=>{release=resolve;});
      return route.fulfill({status:503,body:'synthetic delayed response'});
    }
    if(url.pathname.startsWith('/v2/responder/actions/')){
      return route.fulfill({status:remote?200:404,contentType:'application/json',body:JSON.stringify(remote?{
        actionId:remote.actionId,issuerProviderId:remote.issuerProviderId,actionDigest:remote.actionDigest,
        state:'PREPARING',eventDigest:null,reason:null,
      }:{error:'NOT_FOUND'})});
    }
    const response=await handleSagipRequest(new Request(route.request().url()),{ingestEnvelope:async()=>{throw new Error('unused');}});
    return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers.entries()),body:Buffer.from(await response.arrayBuffer())});
  });
  await page.goto(ORIGIN+'/fixture');
  await page.evaluate(`(async()=>{
    AbortSignal.timeout=delay=>{const controller=new AbortController();setTimeout(()=>controller.abort(new Error('TIMEOUT')),delay);return controller.signal;};
    const {GatewayClient}=await import('/responder/assets/browser/gatewayClient.js');
    const {ConsoleStore}=await import('/responder/assets/browser/consoleStore.js');
    const {ActionOutbox}=await import('/responder/assets/browser/actionOutbox.js');
    const responderId='33333333-3333-4333-8333-333333333333',providerId=new Uint8Array(32).fill(9),providerKey='09'.repeat(32);
    window.store=await ConsoleStore.open();
    window.store.unlock({responderId,providerKey,earliestMs:1000,latestMs:1001,validUntilMs:9999999999999,bootId:'66666666-6666-4666-8666-666666666666',receivedElapsedMs:performance.now()});
    window.outbox=new ActionOutbox(window.store,new GatewayClient({providerKind:1,providerId,responderId}));
    window.queued=await window.outbox.queue({providerKind:1,issuerProviderId:providerId,reportId:'22222222-2222-4222-8222-222222222222',reportProtocolVersion:1,
      revision:1,payloadDigest:new Uint8Array(32).fill(1),originKeyId:new Uint8Array(32).fill(2),responderId,observedIncidentVersion:'7',status:4,note:'Synthetic timeout resolution'});
    window.drainResult=null;
    window.outbox.drain().then(result=>{window.drainResult=result;});
  })()`);
  await expect.poll(()=>commitRequests).toBe(1);
  await page.clock.runFor(30001);
  await expect.poll(()=>page.evaluate('window.drainResult?.remaining')).toBe(1);
  expect(await page.evaluate('window.drainResult.items[0].reason')).toBe('COMMIT_OUTCOME_UNKNOWN');
  release?.();
  const result=await page.evaluate<{retried: {remaining: number; items: Array<{state: string}>}; beforeId: string; afterId: string; queuedId: string}>(`(async()=>{
    const before=await window.store.listIntents();
    const retried=await window.outbox.drain();
    const after=await window.store.listIntents();
    window.store.close();
    return {retried,beforeId:before[0].actionId,afterId:after[0].actionId,queuedId:window.queued.actionId};
  })()`);
  expect(result.retried.remaining).toBe(0);
  expect(result.retried.items[0]?.state).toBe('PREPARING');
  expect(result.afterId).toBe(result.beforeId);
  expect(result.afterId).toBe(result.queuedId);
  expect(commitRequests).toBe(1);
});
