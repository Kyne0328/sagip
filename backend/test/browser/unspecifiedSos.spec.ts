import {expect, test} from '@playwright/test';
import {handleSagipRequest} from '../../src/http/handleRequest.js';

const ORIGIN = 'https://sagip.test';
const REPORT_ID = '55555555-5555-4555-8555-555555555555';

test('one-tap SOS displays honest unknowns online, after same-ID detail update, and offline', async ({page, context}) => {
  const initial = {
    reportId: REPORT_ID, createdAtMs: Date.now() - 120000,
    firstReceivedAt: new Date(Date.now() - 60000).toISOString(),
    latestRevision: 1, emergencyType: 'UNSPECIFIED', urgency: 'UNSPECIFIED',
    message: null as string | null, location: null, latestAck: null,
    revisions: [{revision: 1, emergencyType: 'UNSPECIFIED', urgency: 'UNSPECIFIED', message: null as string | null, location: null}],
    acknowledgements: [],
  };
  let current = initial;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route(ORIGIN + '/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown) => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(body)});
    if (url.pathname === '/v1/responder/session') return json({responder: {responderId: REPORT_ID, callsign: 'SYNTHETIC-TEST', role: 'DISPATCHER'}, expiresAt: new Date(Date.now() + 3600000).toISOString()});
    if (url.pathname === '/v1/incidents/summary') return json({total: 1, pending: 1, acknowledged: 0, enRoute: 0, onScene: 0, resolved: 0, immediateDanger: current.urgency === 'IMMEDIATE_DANGER' ? 1 : 0});
    if (url.pathname === '/v1/incidents') return json([current]);
    if (url.pathname === '/v1/incidents/' + REPORT_ID) return json(current);
    const response = await handleSagipRequest(new Request(request.url(), {method: request.method()}),
      {ingestEnvelope: async () => {throw new Error('unused');}});
    await route.fulfill({status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.from(await response.arrayBuffer())});
  });
  await page.goto(ORIGIN + '/responder');
  const card = page.locator('#incidentList [data-report-id="' + REPORT_ID + '"]');
  await expect(card).toContainText('SOS · details not provided');
  await expect(card).toContainText('Not specified');
  await expect(card).not.toContainText('Needs assistance');
  await expect(card).not.toContainText('Immediate danger');
  await card.click();
  await expect(page.locator('#detailTitle')).toHaveText('SOS · details not provided');
  await expect(page.locator('#detailFacts')).toContainText('CategoryNot specified');
  await expect(page.locator('#detailFacts')).toContainText('UrgencyNot specified');
  await expect(page.locator('#urgencyBanner')).toBeHidden();
  await page.locator('#historyTab').click();
  await expect(page.locator('#revisionHistory')).toContainText('Revision 1 · Not specified');
  await expect(page.locator('#revisionHistory')).not.toContainText('Needs assistance');

  current = {...initial, latestRevision: 2, emergencyType: 'FIRE', urgency: 'IMMEDIATE_DANGER',
    message: 'Smoke at the side entrance', revisions: [...initial.revisions,
      {revision: 2, emergencyType: 'FIRE', urgency: 'IMMEDIATE_DANGER', message: 'Smoke at the side entrance', location: null}]};
  await page.locator('#refreshButton').click();
  await expect(page.locator('#detailTitle')).toHaveText('Fire emergency');
  await expect(page.locator('#incidentList .incident-card')).toHaveCount(1);
  await expect(card).toContainText('Immediate danger');
  await expect(page.locator('#revisionHistory')).toContainText('Revision 1 · Not specified');
  await expect(page.locator('#revisionHistory')).toContainText('Revision 2 · Fire');
  await page.locator('#overviewTab').click();
  await expect(page.locator('#urgencyBanner')).toBeVisible();
  await expect(page.locator('#detailFacts')).toContainText('Smoke at the side entrance');
  await expect(page.locator('#detailFacts')).toContainText(REPORT_ID);

  await page.evaluate(incident => {
    const snapshot = {entries: [{...incident, revision: 1, reportCreatedAtMs: incident.createdAtMs, receivedAtMs: Date.now()}],
      total: 1, summary: {total: 1, pending: 1}, createdAtMs: Date.now()};
    (globalThis as unknown as {SagipResponderBridge: {useOfflineSnapshot(snapshot: unknown): void}}).SagipResponderBridge.useOfflineSnapshot(snapshot);
  }, initial);
  await expect(card).toContainText('SOS · details not provided');
  await card.click();
  await expect(page.locator('#detailTitle')).toHaveText('SOS · details not provided');
  await expect(page.locator('#detailFacts')).toContainText('UrgencyNot specified');
  await expect(page.locator('#urgencyBanner')).toBeHidden();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({width, height: 844});
    expect(await page.evaluate(() => {
      const document = (globalThis as unknown as {document: {documentElement: {scrollWidth: number; clientWidth: number}}}).document;
      return document.documentElement.scrollWidth <= document.documentElement.clientWidth;
    })).toBe(true);
  }
  await page.setViewportSize({width: 1440, height: 960});
  await page.screenshot({path: 'artifacts/one-tap-sos/unspecified-dashboard-desktop.png', fullPage: true});
  expect(errors).toEqual([]);
});

test('category-only and urgency-only SOS remain honestly partially specified', async ({page, context}) => {
  const initial = {reportId: REPORT_ID, createdAtMs: Date.now(), firstReceivedAt: new Date().toISOString(),
    latestRevision: 1, emergencyType: 'FLOOD', urgency: 'UNSPECIFIED', message: null, location: null, latestAck: null};
  let current = initial;
  await context.route(ORIGIN + '/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown) => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(body)});
    if (url.pathname === '/v1/responder/session') return json({responder: {responderId: REPORT_ID, callsign: 'SYNTHETIC-TEST', role: 'DISPATCHER'}});
    if (url.pathname === '/v1/incidents/summary') return json({total: 1, pending: 1});
    if (url.pathname === '/v1/incidents') return json([current]);
    if (url.pathname === '/v1/incidents/' + REPORT_ID) return json({...current, revisions: [], acknowledgements: []});
    const response = await handleSagipRequest(new Request(request.url(), {method: request.method()}), {ingestEnvelope: async () => {throw new Error('unused');}});
    await route.fulfill({status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.from(await response.arrayBuffer())});
  });
  await page.goto(ORIGIN + '/responder');
  await page.locator('#incidentList .incident-card').click();
  await expect(page.locator('#detailTitle')).toHaveText('Flood emergency');
  await expect(page.locator('#detailFacts')).toContainText('UrgencyNot specified');
  await expect(page.locator('#urgencyBanner')).toBeHidden();
  current = {...initial, emergencyType: 'UNSPECIFIED', urgency: 'NEED_ASSISTANCE'};
  await page.locator('#refreshButton').click();
  await expect(page.locator('#detailTitle')).toHaveText('SOS · category not specified');
  await expect(page.locator('#detailFacts')).toContainText('CategoryNot specified');
  await expect(page.locator('#detailFacts')).toContainText('UrgencyNeeds assistance');
  await expect(page.locator('#detailTitle')).not.toContainText('Other');
});
