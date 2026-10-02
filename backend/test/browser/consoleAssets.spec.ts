import {expect, test} from '@playwright/test';

import {handleSagipRequest} from '../../src/http/handleRequest.js';
import {RESPONDER_MAP_ASSET_PATHS} from '../../src/responder/consoleAssets.js';

const ORIGIN = 'https://sagip.test';
const deps = {
  ingestEnvelope: async () => {
    throw new Error('not used');
  },
};

const fixtureHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="${RESPONDER_MAP_ASSET_PATHS.maplibreCss}">
  <link rel="stylesheet" href="/fixture.css">
  <script src="${RESPONDER_MAP_ASSET_PATHS.pmtilesScript}" defer></script>
  <script type="module" src="/fixture.mjs"></script>
  <title>SAGIP map asset fixture</title>
</head>
<body>
  <main>
    <div id="map" aria-label="Map fixture"></div>
  </main>
</body>
</html>`;

const fixtureModule = `
import * as maplibregl from '${RESPONDER_MAP_ASSET_PATHS.maplibreModule}';

maplibregl.setWorkerUrl('${RESPONDER_MAP_ASSET_PATHS.maplibreWorker}');

const map = new maplibregl.Map({
  container: 'map',
  center: [125.807, 7.447],
  zoom: 10,
  attributionControl: false,
  style: {
    version: 8,
    sources: {},
    layers: [{
      id: 'background',
      type: 'background',
      paint: {'background-color': '#eef2f5'}
    }]
  }
});

map.once('load', () => {
  document.body.dataset.mapReady = 'true';
});

map.on('error', event => {
  document.body.dataset.mapError = String(event.error?.message ?? event.error ?? 'unknown');
});
`;

test('map assets obey strict CSP and render an empty local map without network dependencies', async ({page}) => {
  const unexpectedOrigins = new Set<string>();
  const browserErrors: string[] = [];

  page.on('request', request => {
    const origin = new URL(request.url()).origin;
    if (origin !== ORIGIN) unexpectedOrigins.add(origin);
  });
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', error => {
    browserErrors.push(error.message);
  });

  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/fixture') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        headers: {
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        },
        body: fixtureHtml,
      });
      return;
    }

    if (url.pathname === '/fixture.css') {
      await route.fulfill({
        status: 200,
        contentType: 'text/css; charset=utf-8',
        body: '#map { width: 320px; height: 240px; }',
      });
      return;
    }

    if (url.pathname === '/fixture.mjs') {
      await route.fulfill({
        status: 200,
        contentType: 'text/javascript; charset=utf-8',
        body: fixtureModule,
      });
      return;
    }

    const response = await handleSagipRequest(
      new Request(request.url(), {method: request.method()}),
      deps,
    );
    const body = Buffer.from(await response.arrayBuffer());
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    });
  });

  const navigation = await page.goto(`${ORIGIN}/fixture`, {waitUntil: 'domcontentloaded'});
  expect(navigation).not.toBeNull();

  const csp = navigation?.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("worker-src 'self'");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(csp).not.toContain('blob:');
  expect(csp).not.toContain('*');

  await expect(page.locator('body')).toHaveAttribute('data-map-ready', 'true');
  await expect
    .poll(() => page.evaluate(() => typeof (globalThis as {pmtiles?: {Protocol?: unknown}}).pmtiles?.Protocol))
    .toBe('function');

  expect(await page.locator('body').getAttribute('data-map-error')).toBeNull();
  expect([...unexpectedOrigins]).toEqual([]);
  expect(browserErrors).toEqual([]);
});
