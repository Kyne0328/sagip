import {expect, test, type BrowserContext} from '@playwright/test';
import {previewResponse} from './fixtures/consolePreview.js';

const ORIGIN = 'https://sagip.test';
const PROVIDER = 'https://tiles.openfreemap.org';
async function fixture(context: BrowserContext): Promise<void> {
  await context.route(ORIGIN + '/**', async route => {
    const request = route.request();
    const response = await previewResponse(new Request(request.url(), {method: request.method()}));
    await route.fulfill({status: response.status, headers: Object.fromEntries(response.headers.entries()), body: Buffer.from(await response.arrayBuffer())});
  });
}
// Deterministic lifecycle tests use a minimal provider style. Visual QA below
// deliberately uses actual hosted tiles, never this fixture as map evidence.
const style = {version: 8, sources: {}, layers: [{id: 'test-background', type: 'background', paint: {'background-color': '#eef1eb'}}]};

test('online map works without a prepared pack and keeps attribution, selected markers and camera', async ({page, context}) => {
  await fixture(context);
  const requests: Array<{url: string; headers: Record<string, string>}> = [];
  await context.route(PROVIDER + '/**', async route => {
    requests.push({url: route.request().url(), headers: route.request().headers()});
    await route.fulfill({contentType: 'application/json', body: JSON.stringify(style)});
  });
  await page.setViewportSize({width: 1440, height: 900});
  await page.goto(ORIGIN + '/responder');
  await expect(page.locator('#incidentMapCanvas')).toHaveAttribute('data-map-source', 'online');
  await expect(page.locator('.map-marker')).toHaveCount(5);
  await expect(page.locator('#mapReadinessStatus')).toHaveText('Not prepared');
  await expect(page.locator('button[data-map-source="offline"]')).toBeDisabled();
  await page.getByRole('button', {name: /^Trapped incident, Immediate danger, Pending, report /u}).click();
  await page.getByRole('button', {name: 'Show on map', exact: true}).click();
  await expect(page.locator('#consolePanel')).toHaveClass(/map-focus-mode/u);
  await expect(page.locator('.map-marker[aria-pressed="true"]')).toHaveCount(1);
  await expect(page.locator('.map-attribution')).toContainText('OpenFreeMap');
  await expect(page.locator('.map-attribution')).toContainText('© OpenMapTiles');
  await expect(page.locator('.map-attribution')).toContainText('© OpenStreetMap contributors');
  await expect(page.locator('.map-attribution')).toBeVisible();
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(new URL(request.url).origin).toBe(PROVIDER);
    expect(request.url).not.toMatch(/11111111|reportId|token|note|message/u);
    expect(request.headers.referer).toBeUndefined();
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers.cookie).toBeUndefined();
  }
  for (const width of [390, 320]) {
    await page.setViewportSize({width, height: 844});
    await expect(page.locator('button[data-map-source="online"]')).toBeVisible();
    await expect(page.locator('.map-attribution')).toBeVisible();
    expect(await page.evaluate(() => (globalThis as unknown as {document: {documentElement: {scrollWidth: number}}}).document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

test('blocked provider falls back to real prepared pack and explicit offline mode stays local', async ({page, context}) => {
  await fixture(context);
  let providerRequests = 0;
  await context.route(PROVIDER + '/**', route => { providerRequests++; return route.abort(); });
  await page.goto(ORIGIN + '/responder');
  await expect(page.locator('#incidentMapCanvas')).toHaveAttribute('data-map-source', 'unavailable');
  await expect(page.locator('#incidentMapPlaceholder')).toContainText('No offline map prepared');
  await page.getByRole('button', {name: 'Prepare Tagum offline map', exact: true}).click();
  await expect(page.locator('#incidentMapCanvas')).toHaveAttribute('data-map-source', 'offline');
  await expect(page.locator('.map-marker')).toHaveCount(5);
  await page.locator('button[data-map-source="offline"]').click();
  await expect(page.locator('#incidentMapCanvas')).toHaveAttribute('data-map-source', 'offline');
  const count = providerRequests;
  await context.setOffline(true);
  await context.setOffline(false);
  await page.waitForTimeout(200);
  expect(providerRequests).toBe(count);
  await expect(page.locator('[data-map-source-status]')).toContainText('offline coverage');
});

test('live OpenFreeMap desktop/mobile and outage visual QA', async ({page, context}) => {
  test.skip(process.env.SAGIP_LIVE_MAP_QA !== '1', 'Explicit live-provider QA only');
  test.setTimeout(90000);
  await fixture(context);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const providers = new Set<string>();
  page.on('request', request => { if (!request.url().startsWith(ORIGIN)) providers.add(new URL(request.url()).origin); });
  await page.setViewportSize({width: 1672, height: 941});
  await page.goto(ORIGIN + '/responder');
  await expect(page.locator('#incidentMapCanvas')).toHaveAttribute('data-map-source', 'online', {timeout: 25000});
  await page.screenshot({path: 'artifacts/openfreemap/desktop-online.png'});
  await page.getByRole('button', {name: 'Prepare Tagum offline map', exact: true}).click();
  await expect(page.locator('#mapReadinessStatus')).toContainText('Ready');
  await page.getByRole('button', {name: /^Trapped incident, Immediate danger, Pending, report /u}).click();
  await page.getByRole('button', {name: 'Show on map', exact: true}).click();
  await page.screenshot({path: 'artifacts/openfreemap/desktop-focus.png'});
  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: 'artifacts/openfreemap/mobile-online.png', fullPage: true});
  await context.setOffline(true);
  await expect(page.locator('#incidentMapCanvas')).toHaveAttribute('data-map-source', 'offline');
  await page.screenshot({path: 'artifacts/openfreemap/mobile-offline.png', fullPage: true});
  await context.setOffline(false);
  await context.route(PROVIDER + '/**', route => route.abort());
  await page.locator('button[data-map-source="online"]').click();
  await expect(page.locator('#incidentMapCanvas')).toHaveAttribute('data-map-source', 'offline');
  await page.setViewportSize({width: 1672, height: 941});
  await page.screenshot({path: 'artifacts/openfreemap/desktop-provider-blocked.png'});
  expect([...providers]).toEqual([PROVIDER]);
  expect(errors).toEqual([]);
});
