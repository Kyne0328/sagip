import {expect, test} from '@playwright/test';
import {previewResponse} from './fixtures/consolePreview.js';

const ORIGIN = 'https://sagip.test';

test('real prepared Tagum renders synthetic status pins and an identity-bound resolution confirmation', async ({page, context}) => {
  test.setTimeout(60000);
  const received = Date.now();
  const stages = ['PENDING', 'ACKNOWLEDGED', 'EN_ROUTE', 'ON_SCENE', 'RESOLVED'];
  const incidents = stages.map((status, index) => ({
    reportId: 'abcdabcd-abcd-4abc-8abc-' + String(index + 1).padStart(12, '0'),
    createdAtMs: received - (5 - index) * 60000,
    firstReceivedAt: new Date(received - index * 60000).toISOString(),
    latestRevision: 1, emergencyType: index ? 'MEDICAL' : 'TRAPPED',
    urgency: 'NEEDS_ASSISTANCE',
    message: 'SYNTHETIC QA only. No actual emergency.',
    location: {latitude: 7.4477 + index * 0.002, longitude: 125.8078 + index * 0.002,
      accuracyMeters: 9, capturedAtMs: received, source: 'GPS', freshness: 'FRESH'},
    latestAck: index ? {status, callsign: 'SYNTHETIC TEST TEAM', acknowledgedAt: new Date(received).toISOString(), note: 'Synthetic status'} : null,
    revisions: [], acknowledgements: [],
  }));
  // Use the real local map runtime/archive. External street requests are blocked;
  // this screenshot proves prepared-map rendering, not live-provider availability.
  await context.route('https://tiles.openfreemap.org/**', route => route.abort());
  await page.addInitScript("Object.defineProperty(navigator, 'serviceWorker', {value: undefined});");
  await context.route(ORIGIN + '/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown) => route.fulfill({contentType:'application/json', body:JSON.stringify(body)});
    if (url.pathname === '/v1/responder/session') return json({responder:{responderId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',callsign:'SYNTHETIC QA',role:'DISPATCHER'}, expiresAt:new Date(received+3600000).toISOString()});
    if (url.pathname === '/v1/incidents/summary') return json({total:5,pending:1,acknowledged:1,enRoute:1,onScene:1,resolved:1,immediateDanger:0});
    if (url.pathname === '/v1/incidents') return json(incidents.filter(item => !url.searchParams.get('status') || (item.latestAck?.status ?? 'PENDING') === url.searchParams.get('status')));
    const incident = incidents.find(item => url.pathname === '/v1/incidents/' + item.reportId);
    if (incident) return json(incident);
    if (url.pathname.startsWith('/v1/')) return route.fulfill({status:405,body:'Synthetic visual fixture does not accept actions'});
    const response = await previewResponse(new Request(request.url(), {method:request.method()}));
    return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers.entries()),body:Buffer.from(await response.arrayBuffer())});
  });
  await page.setViewportSize({width:1440,height:960});
  await page.goto(ORIGIN + '/responder');
  await expect(page.locator('#incidentList .incident-card')).toHaveCount(5);
  await page.getByRole('button',{name:'Prepare Tagum offline map',exact:true}).click();
  await expect(page.locator('#incidentMapCanvas')).toHaveAttribute('data-map-source','offline');
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await expect(page.locator('.map-marker')).toHaveCount(4);
  await expect(page.locator('#sortOrder')).toHaveValue('newest_received');
  for (let index=0;index<4;index++) {
    await expect(page.locator('.map-marker[data-report-id="' + incidents[index]!.reportId + '"]')).toHaveAttribute('data-status',stages[index]!);
  }
  await expect(page.locator('.map-marker[data-report-id="' + incidents[4]!.reportId + '"]')).toHaveCount(0);
  // Natural operator controls keep endpoint pins clear of the dashboard overlays.
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.locator('#serverError')).toBeHidden();
  await page.getByRole('button',{name:'Zoom out',exact:true}).click();
  await expect.poll(async () => {
    const boxes = await page.locator('.map-marker').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return {x:rect.x,y:rect.y};
    }));
    return boxes.every(box => box.x > 470 && box.x < 980 && box.y > 300 && box.y < 800);
  }).toBe(true);
  await page.screenshot({path:'artifacts/response-phase1/real-tagum-status-pins-desktop.png',fullPage:true});
  await page.locator('#incidentList [data-report-id="' + incidents[0]!.reportId + '"]').click();
  await page.locator('#responseTab').click();
  await page.locator('#ackStatus').selectOption('RESOLVED');
  await page.locator('#ackButton').click();
  await expect(page.locator('#resolveDialog')).toBeVisible();
  await expect(page.locator('#resolveIdentity')).toContainText(incidents[0]!.reportId);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'artifacts/response-phase1/real-tagum-resolve-confirm-mobile.png',fullPage:true});
  await page.locator('#cancelResolveButton').click();
  await expect(page.locator('.map-marker')).toHaveCount(4);
  await page.getByRole('button',{name:'Zoom out',exact:true}).click({timeout:5000});
  const assertControlsAreReachable = async (layout: string) => {
    const legend = await page.locator('.map-legend').boundingBox();
    expect(legend).not.toBeNull();
    for (const button of await page.locator('.maplibregl-ctrl-group button').all()) {
      await button.scrollIntoViewIfNeeded();
      const control = await button.boundingBox();
      expect(control).not.toBeNull();
      if (!legend || !control) throw new Error('Map geometry unavailable');
      const overlaps = control.x < legend.x + legend.width && control.x + control.width > legend.x
        && control.y < legend.y + legend.height && control.y + control.height > legend.y;
      expect(overlaps).toBe(false);
      console.log('Pointer control QA:',layout,await button.getAttribute('aria-label'));
      await button.click({timeout:5000});
    }
  };
  for (const width of [1440,1280,1051,390]) {
    await page.setViewportSize({width,height:width === 390 ? 844 : 960});
    await assertControlsAreReachable(String(width));
  }
  await page.setViewportSize({width:1280,height:960});
  await page.locator('#overviewTab').click();
  await page.getByRole('button',{name:'Show on map',exact:true}).click();
  await expect(page.locator('#consolePanel')).toHaveClass(/map-focus-mode/);
  await assertControlsAreReachable('map-focus1280');
});
