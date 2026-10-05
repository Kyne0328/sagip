import {expect, test} from '@playwright/test';

import {handleSagipRequest} from '../../src/http/handleRequest.js';

const ORIGIN = 'https://sagip.test';
const REPORT_ID = '11111111-1111-4111-8111-111111111111';
const deps = {
  ingestEnvelope: async () => {
    throw new Error('not used');
  },
};

const incident = {
  reportId: REPORT_ID,
  createdAtMs: Date.now() - 120_000,
  firstReceivedAt: new Date(Date.now() - 60_000).toISOString(),
  latestRevision: 1,
  emergencyType: 'TRAPPED',
  urgency: 'IMMEDIATE_DANGER',
  location: {
    latitude: 7.4477,
    longitude: 125.8078,
    accuracyMeters: 9,
    capturedAtMs: Date.now() - 120_000,
    source: 'GPS',
    freshness: 'FRESH',
  },
  latestAck: null,
};

test('Show on map centers the prepared local map on the selected incident', async ({page, context}) => {
  await context.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/v1/responder/session' && request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          responder: {responderId: '22222222-2222-4222-8222-222222222222', callsign: 'TEST-RESPONDER', role: 'DISPATCHER'},
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      });
      return;
    }
    if (url.pathname === '/v1/incidents/summary') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          total: 1,
          pending: 1,
          acknowledged: 0,
          enRoute: 0,
          onScene: 0,
          resolved: 0,
          immediateDanger: 1,
        }),
      });
      return;
    }
    if (url.pathname === '/v1/incidents') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([incident]),
      });
      return;
    }
    if (url.pathname === `/v1/incidents/${REPORT_ID}`) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...incident,
          revisions: [{
            revision: 1,
            emergencyType: incident.emergencyType,
            urgency: incident.urgency,
            location: incident.location,
          }],
          acknowledgements: [],
        }),
      });
      return;
    }

    const response = await handleSagipRequest(
      new Request(request.url(), {method: request.method()}),
      deps,
    );
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });

  await context.route('https://tiles.openfreemap.org/**', route => route.abort());
  await page.goto(`${ORIGIN}/responder`);

  await expect(page.getByRole('button', {name: 'Prepare Tagum offline map'})).toBeVisible();
  await page.getByRole('button', {name: /Trapped incident/u}).click();
  await expect(page.getByRole('button', {name: 'Show on map'})).toBeVisible();

  await page.getByRole('button', {name: 'Show on map'}).click();

  await expect(page.getByText(/Ready · Tagum map stored/u)).toBeVisible();
  await expect(page.locator('#consolePanel')).toHaveClass(/map-focus-mode/u);
  await expect(page.locator('#mapFocusStatus')).toBeVisible();
  await expect(page.locator('#mapFocusTitle')).toHaveText('Trapped incident');
  await expect(page.locator('#mapFocusLocation')).toHaveText('7.44770, 125.80780');
  await expect(page.locator('#incidentMapPanel')).toBeFocused();
  await expect.poll(async () => {
    const box = await page.locator('#incidentMapCanvas').boundingBox();
    return box?.height ?? 0;
  }).toBeGreaterThan(500);
  await expect.poll(async () => {
    const box = await page.locator('#incidentMapCanvas .maplibregl-canvas').boundingBox();
    return box?.height ?? 0;
  }).toBeGreaterThan(500);
  await expect(page.locator('#mapAnnouncement')).toContainText(
    'Map centered on the selected incident location.',
  );
  await expect(page.locator('.map-marker[data-report-id="' + REPORT_ID + '"]')).toHaveAttribute(
    'data-selected',
    'true',
  );

  await page.getByRole('button', {name: 'Back to incident details'}).click();
  await expect(page.locator('#consolePanel')).not.toHaveClass(/map-focus-mode/u);
  await expect(page.locator('#mapFocusStatus')).toBeHidden();
  await expect(page.getByRole('button', {name: 'Show on map'})).toBeFocused();
});
