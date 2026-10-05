import {createServer, type Server} from 'node:http';
import {expect, test} from '@playwright/test';
import {previewResponse} from './fixtures/consolePreview.js';

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    void previewResponse(new Request(origin + request.url, {method: request.method ?? 'GET'})).then(async result => {
      response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
      response.end(Buffer.from(await result.arrayBuffer()));
    }).catch(() => {response.writeHead(500); response.end('Isolated test server error');});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_UNAVAILABLE');
  origin = 'http://127.0.0.1:' + address.port;
});
test.afterAll(async () => {await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));});

test('prepare on Streets warms runtime and survives a real network outage and offline reload', async ({page, context}) => {
  test.setTimeout(60000);
  // Only the external basemap is mocked. Local app/assets use real HTTP, so
  // context.setOffline cannot accidentally receive fulfilled local routes.
  await context.route('https://tiles.openfreemap.org/**', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({version: 8, sources: {}, layers: [{id:'test-only',type:'background',paint:{'background-color':'#edf1eb'}}]}),
  }));
  await page.goto(origin + '/responder');
  await expect(page.locator('#incidentMapCanvas')).toHaveAttribute('data-map-source', 'online');
  expect(await page.evaluate('!!globalThis.pmtiles')).toBe(false);
  await page.getByRole('button', {name:'Prepare Tagum offline map',exact:true}).click();
  await expect(page.locator('#mapReadinessStatus')).toContainText('offline reload ready', {timeout:20000});
  await expect(page.locator('#incidentMapCanvas')).toHaveAttribute('data-map-source', 'online');
  expect(await page.evaluate('!!globalThis.pmtiles')).toBe(true);
  expect(await page.evaluate('navigator.serviceWorker.controller !== null')).toBe(true);
  const protectedCached = await page.evaluate(`(async () => {
    const result=[];
    for(const key of await caches.keys()) for(const req of await (await caches.open(key)).keys()) {
      if(new URL(req.url).pathname.startsWith('/v1/')) result.push(req.url);
    }
    return result;
  })()`);
  expect(protectedCached).toEqual([]);
  await context.setOffline(true);
  await expect(page.locator('#incidentMapCanvas')).toHaveAttribute('data-map-source', 'offline');
  await expect(page.locator('.map-marker')).toHaveCount(5);

  const reload = await page.reload();
  expect(reload?.status()).toBe(200);
  // Offline map/shell survive reload; protected incident access remains locked.
  await expect(page.getByLabel('Provisioned responder token', {exact:true})).toBeVisible();
  await expect.poll(() => page.evaluate('!!globalThis.pmtiles')).toBe(true);
  await page.evaluate(`document.getElementById('consolePanel').classList.remove('hidden'); document.getElementById('authPanel').classList.add('hidden');`);
  await expect(page.locator('#incidentMapCanvas')).toHaveAttribute('data-map-source', 'offline');
  await expect(page.locator('.map-marker')).toHaveCount(0);
  expect(await page.evaluate(`fetch('/v1/incidents').then(()=>false,()=>true)`)).toBe(true);
  await page.screenshot({path:'artifacts/openfreemap-repair/offline-reload-public-map.png',fullPage:true});
});

test('without service-worker support readiness is explicitly limited to this open page', async ({page, context}) => {
  await page.addInitScript("Object.defineProperty(navigator, 'serviceWorker', {value: undefined});");
  // A blocked service-worker context has an API but cannot install; test its
  // absence directly with the unsupported-browser condition.
  await context.route('https://tiles.openfreemap.org/**', route => route.abort());
  await page.goto(origin + '/responder');
  await page.getByRole('button', {name:'Prepare Tagum offline map',exact:true}).click();
  await expect(page.locator('#mapReadinessStatus')).toContainText('this open page only', {timeout:20000});
  await page.getByRole('button', {name:'Offline',exact:true}).click();
  await expect(page.locator('#prepareMapButton')).toBeVisible();
  await expect(page.locator('#prepareMapButton')).toBeEnabled();
});
