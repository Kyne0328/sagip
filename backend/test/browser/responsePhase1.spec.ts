import {expect, test, type Page} from '@playwright/test';
import {handleSagipRequest} from '../../src/http/handleRequest.js';

const ORIGIN = 'https://sagip.test';
const ids = Array.from({length: 5}, (_, index) => 'abcdabcd-abcd-4abc-8abc-' + String(index + 1).padStart(12, '0'));
const statuses = ['PENDING', 'ACKNOWLEDGED', 'EN_ROUTE', 'ON_SCENE', 'RESOLVED'];
const runtime = `
export class Map {
  constructor(options) { this.container = options.container; this.events = {}; this.fitCalls=0; this.panCalls=0; globalThis.__phase1map=this; const label=document.createElement('p'); label.textContent='SYNTHETIC QA · Illustrative map positions'; label.style.cssText='position:absolute;top:100px;left:24px;font:12px sans-serif;color:#345'; this.container.append(label); }
  on(name, callback) { this.events[name]=callback; }
  setStyle() { queueMicrotask(()=>this.events.idle?.()); }
  fitBounds() { this.fitCalls++; }
  panTo() { this.panCalls++; }
  resize() {}
  getBounds() { return {getWest:()=>125.7,getEast:()=>125.9,getSouth:()=>7.3,getNorth:()=>7.5}; }
  addControl() {}
  remove() {}
}
export class Marker {
  constructor({element}) { this.element=element; }
  setLngLat(value) { this.element.style.position='absolute'; this.element.style.left=(80+(value[0]-125.8)*9000)+'px'; this.element.style.top='170px'; return this; }
  addTo(map) { map.container.append(this.element); return this; }
  remove() { this.element.remove(); }
}
export class NavigationControl {}
export class ScaleControl {}
export function addProtocol() {}
`;

async function setup(page: Page) {
  const received = Date.UTC(2026, 9, 5, 9);
  const incidents = ids.map((reportId, index) => ({
    reportId, createdAtMs: received - (5 - index) * 100000,
    firstReceivedAt: new Date(received - index * 60000).toISOString(),
    latestRevision: 1, emergencyType: index ? 'MEDICAL' : 'TRAPPED',
    urgency: index === 3 ? 'IMMEDIATE_DANGER' : 'NEED_ASSISTANCE',
    message: 'SYNTHETIC test incident. No operational emergency.',
    location: {latitude: 7.4477, longitude: 125.8 + index * 0.009, accuracyMeters: 9, capturedAtMs: received, source: 'GPS', freshness: 'FRESH'},
    latestAck: index ? {ackId: 'ack-' + index, status: statuses[index]!, callsign: 'SYNTHETIC', acknowledgedAt: new Date(received).toISOString(), note: 'Synthetic status'} : null,
    revisions: [], acknowledgements: [] as unknown[],
  }));
  const posts: {id: string; status: string; note: string}[] = [];
  const queries: string[] = [];
  let deferList = false, deferAck = false, failList = false;
  let releaseList: (() => void) | undefined, releaseAck: (() => void) | undefined;
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN) return route.abort();
    const json = (body: unknown, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
    if (url.pathname.endsWith('/maplibre-gl.mjs')) return route.fulfill({contentType: 'text/javascript', body: runtime});
    if (url.pathname === '/v1/responder/session') return json({responder: {responderId: ids[0], callsign: 'SYNTHETIC QA', role: 'DISPATCHER'}, expiresAt: new Date(Date.now()+3600000).toISOString()});
    if (url.pathname === '/v1/incidents/summary') return json({total: 5, pending: 1, acknowledged: 1, enRoute: 1, onScene: 1, resolved: 1, immediateDanger: 1});
    if (url.pathname === '/v1/incidents') {
      queries.push(url.search);
      if (deferList) { deferList=false; await new Promise<void>(resolve => {releaseList=resolve;}); }
      if (failList) return json({error: 'UNAVAILABLE'}, 503);
      const filtered = incidents.filter(item => !url.searchParams.get('status') || (item.latestAck?.status ?? 'PENDING') === url.searchParams.get('status'));
      if (url.searchParams.get('sort') === 'urgency') filtered.sort((a,b) => Number(b.urgency === 'IMMEDIATE_DANGER') - Number(a.urgency === 'IMMEDIATE_DANGER'));
      return json(filtered);
    }
    if (url.pathname.endsWith('/ack')) {
      const body = request.postDataJSON() as {status: string; note: string};
      const id = url.pathname.split('/')[3]!;
      posts.push({id, ...body});
      if (deferAck) { deferAck=false; await new Promise<void>(resolve => {releaseAck=resolve;}); }
      const incident = incidents.find(item => item.reportId === id)!;
      incident.latestAck = {ackId: 'saved-ack', callsign: 'SYNTHETIC', acknowledgedAt: new Date(Date.now()).toISOString(), ...body};
      incident.acknowledgements.push(incident.latestAck);
      return json(incident.latestAck);
    }
    const incident = incidents.find(item => url.pathname === '/v1/incidents/' + item.reportId);
    if (incident) return json(incident);
    const response = await handleSagipRequest(new Request(request.url(), {method: request.method()}), {ingestEnvelope: async () => {throw new Error('unused');}});
    return route.fulfill({status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.from(await response.arrayBuffer())});
  });
  await page.goto(ORIGIN + '/responder');
  await expect(page.locator('#incidentList .incident-card')).toHaveCount(5);
  await expect(page.locator('.map-marker')).toHaveCount(4);
  return {incidents, posts, queries,
    deferNextList: () => {deferList=true;}, releaseList: () => releaseList?.(),
    deferNextAck: () => {deferAck=true;}, releaseAck: () => releaseAck?.(),
    failList: (fail: boolean) => {failList=fail;},
  };
}
async function select(page: Page, index = 0) {
  await page.locator('#incidentList [data-report-id="' + ids[index] + '"]').click();
  await expect(page.locator('#detailFacts')).toContainText(ids[index]!);
  await page.locator('#responseTab').click();
}
async function resolve(page: Page) {
  await page.locator('#ackStatus').selectOption('RESOLVED');
  await page.locator('#ackButton').click();
  await expect(page.locator('#resolveDialog')).toBeVisible();
}

test('separate sort/filter controls align queue and active map with accessible status pins', async ({page}) => {
  const state = await setup(page);
  expect(state.queries[0]).toContain('sort=newest_received');
  await expect(page.locator('#sortOrder')).toHaveValue('newest_received');
  const colors = ['rgb(198, 40, 40)', 'rgb(22, 113, 60)', 'rgb(8, 101, 195)', 'rgb(120, 59, 180)'];
  const symbols = ['!', '✓', '→', '◆'];
  for (let index=0; index<4; index++) {
    const pin=page.locator('.map-marker[data-report-id="' + ids[index] + '"]');
    await expect(pin).toHaveAttribute('data-status', statuses[index]!);
    await expect(pin).toHaveText(symbols[index]!);
    await expect(pin).toHaveCSS('background-color', colors[index]!);
    await expect(pin).toHaveAttribute('aria-label', new RegExp('report ' + ids[index]));
  }
  await page.setViewportSize({width: 1440, height: 960});
  await page.screenshot({path: 'artifacts/response-phase1/console-status-pins-desktop.png', fullPage: true});
  await page.locator('#sortOrder').selectOption('urgency');
  await expect.poll(() => state.queries.at(-1)).toContain('sort=urgency');
  await expect(page.locator('#statusFilter')).toHaveValue('');
  await expect(page.locator('#incidentList .incident-card').first()).toHaveAttribute('data-report-id', ids[3]!);
  await page.locator('#statusFilter').selectOption('EN_ROUTE');
  await expect(page.locator('#incidentList .incident-card')).toHaveCount(1);
  await expect(page.locator('.map-marker')).toHaveCount(1);
  await expect(page.locator('.map-marker')).toHaveAttribute('data-status', 'EN_ROUTE');
  await expect(page.locator('#sortOrder')).toHaveValue('urgency');
  await page.locator('#statusFilter').selectOption('RESOLVED');
  await expect(page.locator('#incidentList .incident-card')).toHaveCount(1);
  await expect(page.locator('.map-marker')).toHaveCount(0);
});

test('resolve confirms exact identity, supports cancel, retains pin until acceptance and keeps history', async ({page}) => {
  const state=await setup(page);
  await select(page);
  await page.locator('#ackNote').fill('Synthetic resolution note');
  await resolve(page);
  await expect(page.locator('#resolveIdentity')).toContainText(ids[0]!);
  await expect(page.locator('#resolveIdentity')).toContainText('Current status: Pending');
  expect(state.posts).toHaveLength(0);
  await page.locator('#cancelResolveButton').click();
  expect(state.posts).toHaveLength(0);
  await expect(page.locator('#ackNote')).toHaveValue('Synthetic resolution note');
  state.deferNextAck();
  await page.locator('#ackButton').click();
  await expect(page.locator('#resolveDialog')).toBeVisible();
  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: 'artifacts/response-phase1/console-resolve-confirm-mobile.png', fullPage: true});
  await page.locator('#confirmResolveButton').click();
  await expect.poll(() => state.posts.length).toBe(1);
  await expect(page.locator('.map-marker[data-report-id="' + ids[0] + '"]')).toHaveCount(1);
  state.releaseAck();
  await expect(page.locator('.map-marker[data-report-id="' + ids[0] + '"]')).toHaveCount(0);
  await expect(page.locator('#incidentList [data-report-id="' + ids[0] + '"]')).toBeVisible();
  await expect(page.locator('#detailStatus')).toContainText('Resolved');
  await page.locator('#historyTab').click();
  await expect(page.locator('#ackHistory')).toContainText('Synthetic resolution note');
  expect(state.posts[0]?.id).toBe(ids[0]);
});

test('selection or authoritative state changes cancel an open resolution confirmation', async ({page}) => {
  const state=await setup(page);
  await select(page);
  await resolve(page);
  await page.evaluate(id => (globalThis as unknown as {SagipResponderBridge: {selectReport(id: string): void}}).SagipResponderBridge.selectReport(id), ids[1]!);
  await expect(page.locator('#resolveDialog')).toBeHidden();
  expect(state.posts).toHaveLength(0);
  await select(page);
  await resolve(page);
  state.incidents[0]!.latestRevision=2;
  await page.locator('#refreshButton').evaluate(button => (button as unknown as {click(): void}).click());
  await expect(page.locator('#resolveDialog')).toBeHidden();
  expect(state.posts).toHaveLength(0);
});

test('slow refresh coalesces timer ticks and preserves drafts, selection and map camera', async ({page}) => {
  await page.clock.install();
  const state=await setup(page);
  await select(page);
  await page.locator('#ackStatus').selectOption('ON_SCENE');
  await page.locator('#ackNote').fill('Unsaved synthetic draft');
  const cameraBefore=await page.evaluate('({fit: window.__phase1map.fitCalls, pan: window.__phase1map.panCalls})');
  state.deferNextList();
  await page.locator('#refreshButton').click();
  await expect.poll(() => state.queries.length).toBe(2);
  await page.clock.runFor(21000);
  expect(state.queries).toHaveLength(2);
  await expect(page.locator('#lastUpdated')).toContainText('Refresh delayed');
  state.releaseList();
  await expect(page.locator('#lastUpdated')).toContainText('Updated');
  await expect(page.locator('#ackNote')).toHaveValue('Unsaved synthetic draft');
  await expect(page.locator('#ackStatus')).toHaveValue('ON_SCENE');
  await expect(page.locator('#detailFacts')).toContainText(ids[0]!);
  expect(await page.evaluate('({fit: window.__phase1map.fitCalls, pan: window.__phase1map.panCalls})')).toEqual(cameraBefore);
});

test('bfcache return and reconnect resume one refresh timer with unsaved notes intact', async ({page}) => {
  await page.clock.install();
  const state=await setup(page);
  await select(page);
  await page.locator('#ackNote').fill('Kept through lifecycle changes');
  await page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}))");
  await page.clock.runFor(21000);
  expect(state.queries).toHaveLength(1);
  await page.evaluate("window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true}))");
  await expect.poll(() => state.queries.length).toBe(2);
  await expect(page.locator('#lastUpdated')).toContainText('Updated');
  await page.clock.runFor(10001);
  await expect.poll(() => state.queries.length).toBe(3);
  await page.evaluate("window.dispatchEvent(new Event('online'))");
  await expect.poll(() => state.queries.length).toBe(4);
  await expect(page.locator('#ackNote')).toHaveValue('Kept through lifecycle changes');
  await page.locator('#sortOrder').selectOption('urgency');
  await expect.poll(() => state.queries.at(-1)).toContain('sort=urgency');
});

test('refresh errors retain freshness, notes and pins, then reconnect clears the error', async ({page}) => {
  const state=await setup(page);
  await select(page);
  await page.locator('#ackNote').fill('Draft remains on failure');
  state.failList(true);
  await page.locator('#refreshButton').click();
  await expect(page.locator('#lastUpdated')).toContainText('Refresh failed · last success');
  await expect(page.locator('#serverError')).toBeVisible();
  await expect(page.locator('#ackNote')).toHaveValue('Draft remains on failure');
  await expect(page.locator('.map-marker')).toHaveCount(4);
  state.failList(false);
  await page.evaluate("window.dispatchEvent(new Event('online'))");
  await expect(page.locator('#serverError')).toBeHidden();
  await expect(page.locator('#lastUpdated')).toContainText('Updated');
});

test('offline PREPARING provider custody never removes a pending resolution pin', async ({page}) => {
  await page.clock.install();
  const state=await setup(page);
  await page.evaluate(incidents => {
    const target=globalThis as unknown as {
      SagipResponderBridge: {useOfflineSnapshot(snapshot: unknown): void};
      SagipOfflineConsole: {queueStatus(...args: unknown[]): Promise<unknown>};
    };
    target.SagipOfflineConsole={queueStatus: async () => ({queued:{kind:'SAVED_LOCAL'},drain:{remaining:0,items:[{kind:'PROVIDER_COMMITTED',state:'PREPARING'}]}})};
    target.SagipResponderBridge.useOfflineSnapshot({
      entries: incidents.map(item => ({...item, revision:1, reportCreatedAtMs:item.createdAtMs, receivedAtMs:Date.parse(item.firstReceivedAt), pendingActions:[]})),
      createdAtMs:Date.now(), total:incidents.length, summary:{total:incidents.length},
    });
  }, state.incidents);
  await select(page);
  await resolve(page);
  await page.locator('#confirmResolveButton').click();
  await expect(page.locator('#ackResult')).toContainText('Resolution pending server confirmation');
  await expect(page.locator('.map-marker[data-report-id="' + ids[0] + '"]')).toHaveAttribute('data-resolution-pending','true');
  await expect(page.locator('.map-marker[data-report-id="' + ids[0] + '"]')).toHaveAttribute('data-status','PENDING');
  expect(state.posts).toHaveLength(0);
});

test('hanging detail cannot starve list refresh or overwrite a newly selected incident', async ({page}) => {
  await page.clock.install();
  const state=await setup(page);
  await select(page);
  await page.locator('#ackNote').fill('First report draft');
  let release: (() => void) | undefined;
  let detailStarted = false;
  await page.route(ORIGIN + '/v1/incidents/' + ids[0], async route => {
    detailStarted = true;
    await new Promise<void>(resolve => {release=resolve;});
    await route.fulfill({contentType:'application/json',body:JSON.stringify(state.incidents[0])});
  });
  await page.locator('#refreshButton').click();
  await expect.poll(() => detailStarted).toBe(true);
  await expect(page.locator('#lastUpdated')).toContainText('Updated');
  await page.clock.runFor(21000);
  await expect.poll(() => state.queries.length).toBeGreaterThanOrEqual(3);
  await select(page,1);
  await page.locator('#ackNote').fill('Second report draft');
  release?.();
  await expect(page.locator('#detailFacts')).toContainText(ids[1]!);
  await expect(page.locator('#ackNote')).toHaveValue('Second report draft');
});

test('new queue state invalidates confirmation before a delayed detail response arrives', async ({page}) => {
  const state=await setup(page);
  await select(page);
  await resolve(page);
  let release: (() => void) | undefined;
  await page.route(ORIGIN + '/v1/incidents/' + ids[0], async route => {
    await new Promise<void>(finish => {release=finish;});
    await route.fulfill({contentType:'application/json',body:JSON.stringify(state.incidents[0])});
  });
  state.incidents[0]!.latestRevision=2;
  await page.locator('#refreshButton').evaluate(button => (button as unknown as {click():void}).click());
  await expect(page.locator('#resolveDialog')).toBeHidden();
  await expect(page.locator('#ackButton')).toBeDisabled();
  expect(state.posts).toHaveLength(0);
  release?.();
});

test('accepted lower-stage acknowledgement never resurrects an already resolved pin', async ({page}) => {
  const state=await setup(page);
  await select(page,4);
  state.deferNextList();
  await page.locator('#ackStatus').selectOption('EN_ROUTE');
  await page.locator('#ackButton').click();
  await expect.poll(() => state.posts.length).toBe(1);
  await expect(page.locator('.map-marker[data-report-id="' + ids[4] + '"]')).toHaveCount(0);
  // Keep fixture canonical just as the real service computes highest stage.
  state.incidents[4]!.latestAck!.status='RESOLVED';
  state.releaseList();
  await expect(page.locator('#detailStatus')).toContainText('Resolved');
});

test('durable PREPARING resolution rehydrates pending label after browser reload', async ({page}) => {
  await page.clock.install();
  await setup(page);
  await page.evaluate(async reportId => {
    const storePath='/responder/assets/browser/consoleStore.js';
    const codecPath='/responder/assets/browser/actionCodec.js';
    const {ConsoleStore}=await import(storePath);
    const {createActionIntent}=await import(codecPath);
    const store=await ConsoleStore.open();
    const providerKey='09'.repeat(32);
    store.unlock({responderId:reportId,providerKey,earliestMs:1000,latestMs:1001,validUntilMs:9999999999999,bootId:'66666666-6666-4666-8666-666666666666',receivedElapsedMs:performance.now()});
    const intent=await createActionIntent({
      providerKind:2,issuerProviderId:new Uint8Array(32).fill(9),reportId,reportProtocolVersion:1,
      revision:1,payloadDigest:new Uint8Array(32).fill(1),originKeyId:new Uint8Array(32).fill(2),
      responderId:reportId,observedIncidentVersion:'7',status:4,note:'Synthetic pending resolution',
    });
    await store.saveIntent(intent,providerKey);
    await store.markProviderCommitted(intent.actionId,providerKey,'PREPARING',null);
    store.close();
  },ids[0]!);
  await page.reload();
  await expect(page.locator('.map-marker')).toHaveCount(4);
  const pending=await page.evaluate(async reportId => {
    const storePath='/responder/assets/browser/consoleStore.js';
    const statePath='/responder/assets/browser/resolutionState.js';
    const {ConsoleStore}=await import(storePath);
    const {pendingResolutionReportIds}=await import(statePath);
    const store=await ConsoleStore.open();
    store.unlock({responderId:reportId,providerKey:'09'.repeat(32),earliestMs:1000,latestMs:1001,validUntilMs:9999999999999,bootId:'66666666-6666-4666-8666-666666666666',receivedElapsedMs:performance.now()});
    const reportIds=await pendingResolutionReportIds(store);
    (globalThis as unknown as {SagipResponderBridge:{setPendingResolutions(ids:string[]):void}}).SagipResponderBridge.setPendingResolutions(reportIds);
    store.close();
    return reportIds;
  },ids[0]!);
  expect(pending).toEqual([ids[0]]);
  await expect(page.locator('.map-marker[data-report-id="' + ids[0] + '"]')).toHaveAttribute('data-resolution-pending','true');
  await expect(page.locator('#incidentList [data-report-id="' + ids[0] + '"]')).toContainText('Resolution pending');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth')).toBe(true);
  await page.screenshot({path:'artifacts/response-phase1/console-pending-resolution-mobile.png',fullPage:true});
});

test('late offline resolution cannot mark a newly opened session pending', async ({page}) => {
  await page.clock.install();
  const state=await setup(page);
  await page.evaluate(incidents => {
    const target=globalThis as unknown as {
      releaseOldQueue: () => void;
      oldQueueStarted: boolean;
      SagipResponderBridge: {useOfflineSnapshot(snapshot: unknown): void};
      SagipOfflineConsole: {queueStatus(...args: unknown[]): Promise<unknown>};
    };
    target.SagipOfflineConsole={queueStatus: () => new Promise(resolve => {
      target.oldQueueStarted=true;
      target.releaseOldQueue=() => resolve({queued:{kind:'SAVED_LOCAL'},drain:{remaining:1}});
    })};
    target.SagipResponderBridge.useOfflineSnapshot({
      entries:incidents.map(item=>({...item,revision:1,reportCreatedAtMs:item.createdAtMs,receivedAtMs:Date.parse(item.firstReceivedAt),pendingActions:[]})),
      createdAtMs:Date.now(),total:incidents.length,summary:{total:incidents.length},
    });
  },state.incidents);
  await select(page);
  await resolve(page);
  await page.locator('#confirmResolveButton').click();
  await expect.poll(()=>page.evaluate('window.oldQueueStarted')).toBe(true);
  await page.evaluate("window.SagipResponderBridge.finishOfflineLogout(''); window.SagipOfflineConsole=undefined;");
  await page.locator('#tokenInput').fill('synthetic-test-token-not-a-real-credential');
  await page.locator('#connectButton').click();
  await expect(page.locator('#consolePanel')).toBeVisible();
  await select(page);
  await page.locator('#ackNote').fill('New session draft');
  await page.evaluate('window.releaseOldQueue()');
  await expect(page.locator('#ackNote')).toHaveValue('New session draft');
  await expect(page.locator('.map-marker[data-report-id="' + ids[0] + '"]')).toHaveAttribute('data-resolution-pending','false');
  await expect(page.locator('#ackResult')).not.toContainText('Resolution pending');
});

test('old serialized detail cannot re-enable resolution after a newer summary is known', async ({page}) => {
  const state=await setup(page);
  await select(page);
  await page.locator('#ackNote').fill('Draft through revised incident');
  const oldDetail=JSON.stringify(state.incidents[0]);
  let release: (() => void) | undefined;
  let calls=0;
  await page.route(ORIGIN + '/v1/incidents/' + ids[0], async route => {
    calls++;
    if (calls === 1) {
      await new Promise<void>(finish => {release=finish;});
      return route.fulfill({contentType:'application/json',body:oldDetail});
    }
    return route.fulfill({contentType:'application/json',body:JSON.stringify(state.incidents[0])});
  });
  await page.locator('#refreshButton').click();
  await expect.poll(() => calls).toBe(1);
  state.incidents[0]!.latestRevision=2;
  state.incidents[0]!.message='SYNTHETIC revised incident';
  await page.locator('#refreshButton').click();
  await expect.poll(() => calls).toBe(2);
  await expect(page.locator('#detailSubtitle')).toContainText('Revision 2');
  release?.();
  await expect(page.locator('#ackNote')).toHaveValue('Draft through revised incident');
  await expect(page.locator('#detailSubtitle')).toContainText('Revision 2');
  await resolve(page);
  await page.locator('#cancelResolveButton').click();
  expect(state.posts).toHaveLength(0);
});
