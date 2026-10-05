import {expect, test} from '@playwright/test';
import {previewResponse} from './fixtures/consolePreview.js';

const ORIGIN = 'https://sagip.test';

test('reference shell keeps queue, tabs, map focus and offline controls functional', async ({page, context}) => {
  await context.route('https://tiles.openfreemap.org/**', route => route.abort());
  await context.route(ORIGIN + '/**', async route => {
    const request = route.request();
    const response = await previewResponse(new Request(request.url(), {method: request.method()}));
    await route.fulfill({status:response.status, headers:Object.fromEntries(response.headers.entries()), body:Buffer.from(await response.arrayBuffer())});
  });
  const pageErrors: string[] = [];
  page.on('pageerror',error => pageErrors.push(error.message));
  await page.setViewportSize({width:1672,height:941});
  await page.goto(ORIGIN + '/responder');
  await page.getByRole('button',{name:'Prepare Tagum offline map',exact:true}).click();
  await expect(page.locator('#mapReadinessStatus')).toContainText('Ready');
  await page.locator('.maplibregl-canvas').waitFor();
  await page.getByRole('button',{name:/^Trapped incident, Immediate danger, Pending, report /u}).click();
  await expect(page.getByRole('button',{name:'Update responder status'})).toBeVisible();
  await expect(page.locator('.incident-card[aria-current="true"]')).toHaveCount(1);
  await page.getByRole('button',{name:'Update responder status'}).click();
  await expect(page.getByRole('button',{name:'Save responder update'})).toBeVisible();
  await expect(page.locator('#ackStatus')).toBeFocused();
  await page.getByRole('button',{name:'Save responder update',exact:true}).click();
  await expect(page.locator('#ackResult')).toContainText('Could not confirm the update');
  await expect(page.locator('#detailStatus')).toHaveText('Pending');
  await page.getByRole('tab',{name:'History',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Report revision history'})).toBeVisible();
  await page.getByRole('tab',{name:'Overview',exact:true}).click();
  await page.getByRole('tab',{name:'Overview',exact:true}).press('ArrowRight');
  await expect(page.getByRole('tab',{name:'Response',exact:true})).toBeFocused();
  await page.getByRole('tab',{name:'Overview',exact:true}).click();
  await page.getByRole('button',{name:'Offline',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Offline response workspace'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'Offline',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Incidents',exact:true}).click();
  await expect(page.locator('#consolePanel')).toHaveClass(/queue-expanded/);
  await page.getByRole('combobox',{name:'Incident status',exact:true}).selectOption('EN_ROUTE');
  await expect(page.locator('.incident-card')).toHaveCount(1);
  await page.getByRole('combobox',{name:'Incident status',exact:true}).selectOption('');
  await expect(page.locator('.incident-card')).toHaveCount(5);
  await page.getByRole('button',{name:/^Trapped incident, Immediate danger, Pending, report /u}).click();
  await page.getByRole('button',{name:'Map',exact:true}).click();
  await page.getByRole('button',{name:'Show on map',exact:true}).click();
  await expect(page.locator('#consolePanel')).toHaveClass(/map-focus-mode/);
  await page.getByRole('button',{name:'Incidents',exact:true}).click();
  await expect(page.locator('#consolePanel')).not.toHaveClass(/map-focus-mode/);
  await expect(page.getByRole('heading',{name:'Incident queue',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Show on map',exact:true}).click();
  await page.getByRole('button',{name:'Offline',exact:true}).click();
  await expect(page.locator('#consolePanel')).not.toHaveClass(/map-focus-mode/);
  await expect(page.getByRole('heading',{name:'Offline response workspace'})).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Map',exact:true}).click();
  for (const [name,width,height] of [['desktop',1672,941],['laptop',1280,800],['tablet',820,1180],['mobile',390,844]] as const) {
    await page.setViewportSize({width,height});
    await page.evaluate(async () => {const view = globalThis as unknown as {document:{fonts:{ready:Promise<void>}}; scrollTo(x:number,y:number):void}; await view.document.fonts.ready; view.scrollTo(0,0);});
    await page.waitForTimeout(1200);
    const geometry = await page.evaluate(() => {const view = globalThis as unknown as {document:{documentElement:{scrollWidth:number}};innerWidth:number}; return {scroll:view.document.documentElement.scrollWidth,width:view.innerWidth};});
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
    const queueBox = await page.locator('.incident-column').boundingBox();
    const selectBox = await page.locator('#statusFilter').boundingBox();
    expect(queueBox).not.toBeNull(); expect(selectBox).not.toBeNull();
    expect(selectBox!.x + selectBox!.width).toBeLessThanOrEqual(queueBox!.x + queueBox!.width - 4);
    await page.screenshot({path:'artifacts/console-design/final-' + name + '.png',fullPage:name === 'mobile' || name === 'tablet'});
    if (name === 'mobile') {
      await page.getByRole('button',{name:'Incidents',exact:true}).click();
      await expect(page.locator('.incident-column')).toBeFocused();
      await expect(page.locator('.incident-type').first()).toBeVisible();
      await page.screenshot({path:'artifacts/console-design/final-mobile-queue.png'});
      await page.getByRole('button',{name:/^Trapped incident, Immediate danger, Pending, report /u}).click();
      await expect(page.locator('#detailPanel')).toBeFocused();
      await expect(page.getByRole('button',{name:'Update responder status'})).toBeVisible();
      await page.screenshot({path:'artifacts/console-design/final-mobile-detail.png'});
      await page.getByRole('button',{name:'Update status ↗',exact:true}).click();
      await expect(page.locator('#ackStatus')).toBeFocused();
      await page.screenshot({path:'artifacts/console-design/final-mobile-response.png'});
      await page.getByRole('button',{name:'Offline',exact:true}).click();
      await expect(page.locator('#offlineReadiness')).toBeFocused();
      await expect(page.getByRole('heading',{name:'Offline response workspace'})).toBeInViewport();
      await page.screenshot({path:'artifacts/console-design/final-mobile-offline.png'});
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button',{name:'Offline',exact:true})).toBeFocused();
    }
  }
  expect(pageErrors).toEqual([]);
});

test('bounded 100-incident queue renders and scrolls without missing rows', async ({page,context}) => {
  const listResponse = await previewResponse(new Request(ORIGIN + '/v1/incidents'));
  const seed = await listResponse.json() as Array<Record<string,unknown>>;
  const incidents = Array.from({length:100},(_,index) => ({...seed[0],reportId:'33333333-3333-4333-8333-' + String(index).padStart(12,'0'),emergencyType:'OTHER',urgency:'NEEDS_ASSISTANCE'}));
  await context.route('https://tiles.openfreemap.org/**', route => route.abort());
  await context.route(ORIGIN + '/**', async route => {
    if (new URL(route.request().url()).pathname === '/v1/incidents') {
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(incidents)});
      return;
    }
    const response = await previewResponse(new Request(route.request().url()));
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers.entries()),body:Buffer.from(await response.arrayBuffer())});
  });
  await page.setViewportSize({width:1280,height:800});
  const start = Date.now();
  await page.goto(ORIGIN + '/responder');
  await expect(page.locator('.incident-card')).toHaveCount(100);
  await page.getByRole('button',{name:'Incidents',exact:true}).click();
  await page.locator('.incident-card').last().scrollIntoViewIfNeeded();
  await expect(page.locator('.incident-card').last()).toBeVisible();
  await expect(page.locator('.incident-type').last()).toHaveText('Other');
  await page.locator('.incident-card').first().scrollIntoViewIfNeeded();
  await expect(page.locator('.incident-card').first()).toBeVisible();
  console.log('100-row queue render and two-way scroll: ' + (Date.now()-start) + 'ms');
});

test('authentication shell remains usable at mobile size', async ({page,context}) => {
  await context.route('https://tiles.openfreemap.org/**', route => route.abort());
  await context.route(ORIGIN + '/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/v1/responder/session') {
      await route.fulfill({status:401,contentType:'application/json',body:'{"error":"UNAUTHORIZED"}'});
      return;
    }
    const response = await previewResponse(new Request(route.request().url()));
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers.entries()),body:Buffer.from(await response.arrayBuffer())});
  });
  await page.setViewportSize({width:390,height:844});
  await page.goto(ORIGIN + '/responder');
  await expect(page.getByLabel('Provisioned responder token',{exact:true})).toHaveAttribute('type','password');
  await expect(page.locator('#consolePanel')).toBeHidden();
  await expect(page.getByRole('button',{name:'Start responder session'})).toBeVisible();
});

test('narrow and 200-percent-equivalent layouts retain keyboard navigation with reduced motion', async ({page,context}) => {
  await context.route('https://tiles.openfreemap.org/**', route => route.abort());
  await context.route(ORIGIN + '/**', async route => {
    const response = await previewResponse(new Request(route.request().url()));
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers.entries()),body:Buffer.from(await response.arrayBuffer())});
  });
  await page.emulateMedia({reducedMotion:'reduce'});
  for (const width of [320,640]) {
    await page.setViewportSize({width,height:640});
    await page.goto(ORIGIN + '/responder');
    const geometry = await page.evaluate(() => {const view = globalThis as unknown as {document:{documentElement:{scrollWidth:number}};innerWidth:number};return {scroll:view.document.documentElement.scrollWidth,width:view.innerWidth};});
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
    await page.getByRole('button',{name:'Incidents',exact:true}).click();
    await expect(page.locator('.incident-column')).toBeFocused();
    await page.getByRole('button',{name:'Map',exact:true}).click();
    await expect(page.locator('#incidentMapPanel')).toBeFocused();
    await page.getByRole('button',{name:'Offline',exact:true}).click();
    await expect(page.getByRole('button',{name:'Offline',exact:true})).toHaveAttribute('aria-expanded','true');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button',{name:'Offline',exact:true})).toBeFocused();
  }
});

test('late detail response cannot steal focus from another incident response draft', async ({page,context}) => {
  let releaseFirst: () => void = () => undefined;
  const firstGate = new Promise<void>(resolve => {releaseFirst = resolve;});
  const firstPath = '/v1/incidents/11111111-1111-4111-8111-000000000001';
  await context.route('https://tiles.openfreemap.org/**', route => route.abort());
  await context.route(ORIGIN + '/**', async route => {
    if (new URL(route.request().url()).pathname === firstPath) await firstGate;
    const response = await previewResponse(new Request(route.request().url()));
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers.entries()),body:Buffer.from(await response.arrayBuffer())});
  });
  await page.setViewportSize({width:390,height:844});
  await page.goto(ORIGIN + '/responder');
  await page.getByRole('button',{name:/^Trapped incident, Immediate danger, Pending, report /u}).click();
  const cancelledFirst = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === firstPath);
  await page.getByRole('button',{name:/^Fire incident, Immediate danger, Pending, report /u}).click();
  await expect(page.locator('#detailTitle')).toHaveText('Fire emergency');
  await expect(page.locator('#detailPanel')).toBeFocused();
  await page.getByRole('button',{name:'Update status ↗',exact:true}).click();
  await page.locator('#ackNote').fill('Keep this response draft focused');
  // Selecting the second report aborts this request. Its delayed handler may
  // finish, but it must never regain focus or replace the newer detail.
  releaseFirst();
  await cancelledFirst;
  await expect(page.locator('#ackNote')).toBeFocused();
  await expect(page.locator('#ackNote')).toHaveValue('Keep this response draft focused');
  await expect(page.locator('#detailTitle')).toHaveText('Fire emergency');
});
