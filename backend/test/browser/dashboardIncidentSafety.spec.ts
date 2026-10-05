import {expect, test, type Page} from '@playwright/test';
import {handleSagipRequest} from '../../src/http/handleRequest.js';

const ORIGIN = 'https://sagip.test';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const incidents = [A, B].map((reportId, index) => ({
  reportId, createdAtMs: Date.now() - 120000,
  firstReceivedAt: new Date(Date.now() - 60000).toISOString(),
  latestRevision: 1, emergencyType: index ? 'MEDICAL' : 'TRAPPED',
  urgency: 'IMMEDIATE_DANGER', location: null, latestAck: null,
  revisions: [], acknowledgements: [],
}));

async function setup(page: Page, options: {failB?: boolean; delayB?: boolean; delayAck?: boolean; failLogout?: boolean; unauthorizedB?: boolean; delayRestore?: boolean} = {}) {
  const posts: {id: string; body: unknown}[] = [];
  let releaseDetail: (() => void) | undefined;
  let releaseAck: (() => void) | undefined;
  let details = 0;
  let releaseRestore: (() => void) | undefined;
  let lists = 0;
  let deferList = false;
  let releaseList: (() => void) | undefined;
  await page.context().route(ORIGIN + '/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({status, contentType: 'application/json', body: JSON.stringify(body)});
    if (url.pathname === '/v1/responder/session' && request.method() === 'GET' && options.delayRestore) {
      await new Promise<void>(resolve => {releaseRestore = resolve;});
      return json({error: 'UNAUTHORIZED'}, 401);
    }
    if (url.pathname === '/v1/responder/session' && request.method() === 'DELETE' && options.failLogout) return json({error: 'UNAVAILABLE'}, 503);
    if (url.pathname === '/v1/responder/session') return json({responder: {responderId: A, callsign: 'SYNTHETIC-TEST', role: 'DISPATCHER'}, expiresAt: new Date(Date.now() + 3600000).toISOString()});
    if (url.pathname === '/v1/incidents/summary') return json({total: 2, pending: 2, acknowledged: 0, enRoute: 0, onScene: 0, resolved: 0, immediateDanger: 2});
    if (url.pathname === '/v1/incidents') {
      lists++;
      const result = url.searchParams.get('status') === 'RESOLVED' ? [incidents[1]] : incidents;
      if (deferList) { deferList = false; await new Promise<void>(resolve => {releaseList = resolve;}); }
      return json(result);
    }
    if (url.pathname.endsWith('/ack')) {
      posts.push({id: url.pathname.split('/')[3]!, body: request.postDataJSON()});
      if (options.delayAck) await new Promise<void>(resolve => { releaseAck = resolve; });
      return json({status: 'ACKNOWLEDGED'});
    }
    const incident = incidents.find(item => url.pathname === '/v1/incidents/' + item.reportId);
    if (incident) {
      details++;
      if (incident.reportId === B && options.delayB) await new Promise<void>(resolve => { releaseDetail = resolve; });
      if (incident.reportId === B && options.unauthorizedB) return json({error: 'UNAUTHORIZED'}, 401);
      if (incident.reportId === B && options.failB) return json({error: 'UNAVAILABLE'}, 503);
      return json(incident);
    }
    const response = await handleSagipRequest(new Request(request.url(), {method: request.method()}), {ingestEnvelope: async () => { throw new Error('unused'); }});
    return route.fulfill({status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.from(await response.arrayBuffer())});
  });
  await page.goto(ORIGIN + '/responder');
  if (!options.delayRestore) {
    await page.locator('[data-report-id="' + A + '"]').first().click();
    await expect(page.locator('#detailFacts')).toContainText(A);
    await page.locator('#responseTab').click();
  }
  return {releaseRestore: () => releaseRestore?.(), posts, releaseDetail: () => releaseDetail?.(), releaseAck: () => releaseAck?.(), details: () => details, lists: () => lists, deferNextList: () => {deferList = true;}, releaseList: () => releaseList?.()};
}

test('late initial session restore cannot overwrite an explicit login', async ({page}) => {
  const state = await setup(page, {delayRestore: true});
  await page.locator('#tokenInput').fill('synthetic-test-token-not-a-real-credential');
  await page.locator('#connectButton').click();
  await expect(page.locator('#consolePanel')).toBeVisible();
  const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/responder/session' && response.request().method() === 'GET');
  state.releaseRestore();
  await (await lateResponse).finished();
  await page.waitForTimeout(50);
  await expect(page.locator('#consolePanel')).toBeVisible();
});

test('untouched response defaults follow newly observed server status', async ({page}) => {
  await setup(page);
  await expect(page.locator('#ackStatus')).toHaveValue('ACKNOWLEDGED');
  await page.route(ORIGIN + '/v1/incidents/' + A, route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({...incidents[0], latestAck: {status: 'EN_ROUTE'}}),
  }));
  await page.locator('#refreshButton').click();
  await expect(page.locator('#detailStatus')).toHaveText('En Route');
  await expect(page.locator('#ackStatus')).toHaveValue('ON_SCENE');
});

test('old session acknowledgement cannot clear a new session draft for the same report', async ({page}) => {
  const state = await setup(page, {delayAck: true});
  await page.locator('#ackNote').fill('Same text in two sessions');
  await page.locator('#ackButton').click();
  await expect.poll(() => state.posts.length).toBe(1);
  await page.locator('#logoutButton').click();
  await page.locator('#tokenInput').fill('synthetic-test-token-not-a-real-credential');
  await page.locator('#connectButton').click();
  await expect(page.locator('#consolePanel')).toBeVisible();
  await page.locator('[data-report-id="' + A + '"]').first().click();
  await expect(page.locator('#detailFacts')).toContainText(A);
  await page.locator('#responseTab').click();
  await page.locator('#ackNote').fill('Same text in two sessions');
  const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/ack'));
  state.releaseAck();
  await (await lateResponse).finished();
  await page.waitForTimeout(50);
  await expect(page.locator('#ackNote')).toHaveValue('Same text in two sessions');
  await expect(page.locator('#ackResult')).not.toContainText('Saved');
  await expect(page.locator('#ackButton')).toBeEnabled();
});

test('stale refresh cannot replace the current status-filter results', async ({page}) => {
  const state = await setup(page);
  state.deferNextList();
  await page.locator('#refreshButton').click();
  await expect.poll(state.lists).toBe(2);
  const cancelledList = page.waitForEvent('requestfailed', request => {
    const url = new URL(request.url());
    return url.pathname === '/v1/incidents' && !url.searchParams.has('status');
  });
  await page.locator('#statusFilter').selectOption('RESOLVED');
  await expect(page.locator('#incidentList .incident-card')).toHaveCount(1);
  // Changing view cancels the obsolete request. Release its delayed route anyway
  // and verify it cannot replace the active results, even if the handler finishes.
  state.releaseList();
  await cancelledList;
  await expect(page.locator('#incidentList .incident-card')).toHaveCount(1);
  await expect(page.locator('#statusFilter')).toHaveValue('RESOLVED');
});

test('old unauthorized detail cannot terminate a newly connected session', async ({page}) => {
  const state = await setup(page, {delayB: true, unauthorizedB: true});
  await page.locator('[data-report-id="' + B + '"]').first().click();
  await expect.poll(state.details).toBe(2);
  const cancelledDetail = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === '/v1/incidents/' + B);
  await page.locator('#logoutButton').click();
  await page.locator('#tokenInput').fill('synthetic-test-token-not-a-real-credential');
  await page.locator('#connectButton').click();
  await expect(page.locator('#consolePanel')).toBeVisible();
  await page.locator('[data-report-id="' + A + '"]').first().click();
  await expect(page.locator('#detailFacts')).toContainText(A);
  await page.locator('#responseTab').click();
  await page.locator('#ackNote').fill('New session draft');
  // New selection/session cancels this obsolete request before its 401 arrives.
  state.releaseDetail();
  await cancelledDetail;
  await expect(page.locator('#consolePanel')).toBeVisible();
  await expect(page.locator('#ackNote')).toHaveValue('New session draft');
});

test('an obsolete cloud 401 cannot lock an independently selected offline snapshot', async ({page}) => {
  const state = await setup(page, {delayB: true, unauthorizedB: true});
  await page.locator('[data-report-id="' + B + '"]').first().click();
  await expect.poll(state.details).toBe(2);
  await page.evaluate(incident => {
    const snapshot = {entries: [{...incident, revision: 1, reportCreatedAtMs: incident.createdAtMs, receivedAtMs: Date.now()}],
      total: 1, summary: {total: 1, pending: 1}, createdAtMs: Date.now()};
    (globalThis as unknown as {SagipResponderBridge: {useOfflineSnapshot(snapshot: unknown): void}}).SagipResponderBridge.useOfflineSnapshot(snapshot);
  }, incidents[0]!);
  const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/incidents/' + B);
  state.releaseDetail();
  await (await lateResponse).finished();
  await page.waitForTimeout(50);
  await expect(page.locator('#consolePanel')).toBeVisible();
  await expect(page.locator('#connectionText')).toHaveText('Offline snapshot');
});

test('offline snapshots preserve civilian message through provider parsing and dashboard rendering', async ({page}) => {
  await setup(page);
  const message = 'SYNTHETIC: trapped by the stairwell.\\nUse the north entrance <not markup>.';
  await page.route(ORIGIN + '/v2/responder/snapshots/**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({
      snapshotId: A, createdAtMs: Date.now(), expiresAtMs: Date.now() + 60000,
      total: 2, summary: {total: 2}, nextCursor: null,
      entries: incidents.map((incident, index) => ({
        ...incident, reportProtocolVersion: 1, revision: 1,
        payloadDigest: Buffer.alloc(32, 1).toString('base64'),
        originKeyId: Buffer.alloc(32, 2).toString('base64'),
        observedIncidentVersion: '1', reportCreatedAtMs: incident.createdAtMs,
        receivedAtMs: Date.now(), syncedAtMs: Date.now(), receiptEvidence: [], pendingActions: [],
        ...(index === 0 ? {message} : {}),
      })),
    }),
  }));
  const messages = await page.evaluate(async (reportId) => {
    const path = '/responder/assets/browser/gatewayClient.js';
    const {GatewayClient} = await import(path);
    const provider = new GatewayClient({providerKind: 1, providerId: new Uint8Array(32), responderId: reportId});
    const snapshot = await provider.readSnapshotPage(reportId, 'page-1');
    (globalThis as unknown as {SagipResponderBridge: {useOfflineSnapshot(snapshot: unknown): void}}).SagipResponderBridge.useOfflineSnapshot(snapshot);
    return snapshot.entries.map((entry: {message?: string | null}) => entry.message);
  }, A);
  expect(messages).toEqual([message, null]);
  await page.locator('#overviewTab').click();
  await expect(page.locator('#detailFacts .civilian-message')).toHaveText(message);
});

test('disconnect failure does not claim the browser session ended', async ({page}) => {
  await setup(page, {failLogout: true});
  await page.locator('#logoutButton').click();
  await expect(page.locator('#consolePanel')).toBeVisible();
  await expect(page.locator('#serverError')).toContainText('Disconnect could not be confirmed');
});

test('queue labels identify reports and focus survives refresh without stealing form focus', async ({page}) => {
  const state = await setup(page);
  const card = page.locator('#incidentList [data-report-id="' + B + '"]');
  await expect(card).toHaveAttribute('aria-label', /report 22222222/u);
  await card.focus();
  let before = state.details();
  await page.locator('#refreshButton').evaluate(button => (button as unknown as {click(): void}).click());
  await expect.poll(state.details).toBeGreaterThan(before);
  await expect(card).toBeFocused();
  await page.locator('#ackNote').focus();
  before = state.details();
  await page.locator('#refreshButton').evaluate(button => (button as unknown as {click(): void}).click());
  await expect.poll(state.details).toBeGreaterThan(before);
  await expect(page.locator('#ackNote')).toBeFocused();
});

test('switching incidents hides stale actionable detail while loading and after failure', async ({page}) => {
  const state = await setup(page, {delayB: true, failB: true});
  await page.locator('#ackNote').fill('Only for first incident');
  await page.locator('[data-report-id="' + B + '"]').first().click();
  await expect(page.locator('#detailContent')).toBeHidden();
  await expect(page.locator('#ackButton')).toBeDisabled();
  await page.locator('#ackForm').evaluate(form => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  expect(state.posts).toEqual([]);
  await page.setViewportSize({width: 1440, height: 960});
  await page.screenshot({path: 'artifacts/full-app-review/console-loading-desktop.png', fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: 'artifacts/full-app-review/console-loading-mobile.png', fullPage: true});
  state.releaseDetail();
  await expect(page.locator('#serverError')).toContainText('Could not load');
  await expect(page.locator('#detailContent')).toBeHidden();
});

test('refresh preserves a responder status and note draft', async ({page}) => {
  const state = await setup(page);
  await page.locator('#ackStatus').selectOption('ON_SCENE');
  await page.locator('#ackNote').fill('Draft for first incident');
  const before = state.details();
  await page.locator('#refreshButton').click();
  await expect.poll(state.details).toBeGreaterThan(before);
  await expect(page.locator('#ackStatus')).toHaveValue('ON_SCENE');
  await expect(page.locator('#ackNote')).toHaveValue('Draft for first incident');
  await page.setViewportSize({width: 1440, height: 960});
  await page.screenshot({path: 'artifacts/full-app-review/console-response-desktop.png', fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: 'artifacts/full-app-review/console-response-mobile.png', fullPage: true});
});

test('switching reports clears notes instead of attaching them to another incident', async ({page}) => {
  await setup(page);
  await page.locator('#ackNote').fill('Only for first incident');
  await page.locator('[data-report-id="' + B + '"]').first().click();
  await expect(page.locator('#detailFacts')).toContainText(B);
  await expect(page.locator('#ackNote')).toHaveValue('');
});

test('in-flight acknowledgement cannot clear or report success on another incident', async ({page}) => {
  const state = await setup(page, {delayAck: true});
  await page.locator('#ackNote').fill('First report');
  await page.locator('#ackForm').evaluate(form => form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})));
  await expect.poll(() => state.posts.length).toBe(1);
  await page.locator('[data-report-id="' + B + '"]').first().click();
  await expect(page.locator('#detailFacts')).toContainText(B);
  await page.locator('#responseTab').click();
  await page.locator('#ackNote').fill('Second report draft');
  state.releaseAck();
  await expect(page.locator('#ackButton')).toBeEnabled();
  await expect(page.locator('#ackNote')).toHaveValue('Second report draft');
  await expect(page.locator('#ackResult')).not.toContainText('Saved');
  expect(state.posts[0]?.id).toBe(A);
});

test('late detail responses and duplicate submissions stay bound to their report', async ({page}) => {
  const state = await setup(page, {delayB: true, delayAck: true});
  await page.locator('[data-report-id="' + B + '"]').first().click();
  await expect.poll(state.details).toBe(2);
  await page.locator('[data-report-id="' + A + '"]').first().click();
  await expect(page.locator('#detailFacts')).toContainText(A);
  state.releaseDetail();
  await expect(page.locator('#detailTitle')).toHaveText('Trapped emergency');
  await page.locator('#responseTab').click();
  await page.locator('#ackNote').fill('Original draft');
  await page.locator('#ackForm').evaluate(form => {
    form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
    form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true}));
  });
  await expect.poll(() => state.posts.length).toBe(1);
  await page.locator('#ackNote').fill('Newer draft during save');
  state.releaseAck();
  await expect(page.locator('#ackButton')).toBeEnabled();
  await expect(page.locator('#ackNote')).toHaveValue('Newer draft during save');
  expect(state.posts).toHaveLength(1);
});

test('logout invalidates pending incident detail and preserves accepted login reflow', async ({page}) => {
  const state = await setup(page, {delayB: true});
  await page.locator('[data-report-id="' + B + '"]').first().click();
  await expect.poll(state.details).toBe(2);
  await page.locator('#logoutButton').click();
  await expect(page.locator('#authPanel')).toBeVisible();
  state.releaseDetail();
  await expect(page.locator('#detailContent')).toBeHidden();
  for (const [label, width, height] of [['desktop', 1440, 960], ['mobile', 390, 844], ['narrow', 320, 740]] as const) {
    await page.setViewportSize({width, height});
    await expect(page.locator('#tokenInput')).toBeVisible();
    await expect(page.locator('#connectButton')).toBeVisible();
    expect(await page.evaluate(() => {
      const doc = (globalThis as unknown as {document: {documentElement: {scrollWidth: number; clientWidth: number}}}).document.documentElement;
      return doc.scrollWidth <= doc.clientWidth;
    })).toBe(true);
    await page.screenshot({path: 'artifacts/full-app-review/login-' + label + '.png', fullPage: true});
  }
});
