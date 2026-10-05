import {expect, test} from '@playwright/test';
import {previewResponse} from './fixtures/consolePreview.js';
const ORIGIN = 'https://sagip-login.test';
test('focused login responsive visual and keyboard contract', async ({page,context}) => {
  const errors: string[] = [];
  page.on('pageerror',error => errors.push(error.message));
  await context.route(ORIGIN+'/**',async route => {
    if(new URL(route.request().url()).pathname === '/v1/responder/session') {
      await route.fulfill({status:401,contentType:'application/json',body:'{"error":"UNAUTHORIZED"}'}); return;
    }
    const response=await previewResponse(new Request(route.request().url()));
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers.entries()),body:Buffer.from(await response.arrayBuffer())});
  });
  await page.emulateMedia({reducedMotion:'reduce'});
  for(const [name,width,height] of [['desktop',1672,941],['laptop',1280,800],['tablet',820,1180],['mobile',390,844],['narrow',320,640],['zoom200',640,400]] as const) {
    await page.setViewportSize({width,height});
    await page.goto(ORIGIN+'/responder');
    await expect(page.locator('#consolePanel')).toBeHidden();
    await expect(page.locator('#authTitle')).toBeVisible();
    expect(await page.evaluate(() => {const view=globalThis as unknown as {document:{documentElement:{scrollWidth:number}};innerWidth:number};return view.document.documentElement.scrollWidth<=view.innerWidth;})).toBe(true);
    await page.screenshot({path:'artifacts/login-design/final-'+name+'.png',fullPage:true});
  }
  await page.setViewportSize({width:390,height:844});
  await page.goto(ORIGIN+'/responder');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link',{name:'Skip to emergency operations'})).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#tokenInput')).toBeFocused();
  await page.screenshot({path:'artifacts/login-design/final-focus.png',fullPage:true});
  await page.locator('#tokenInput').press('Enter');
  await expect(page.locator('#authError')).toContainText('Paste your provisioned responder token.');
  await expect(page.locator('#tokenInput')).toBeFocused();
  await expect(page.locator('#tokenInput')).toHaveAttribute('aria-invalid','true');
  await page.screenshot({path:'artifacts/login-design/final-error.png',fullPage:true});
  await page.locator('#tokenInput').fill('synthetic-not-a-real-token');
  await expect(page.locator('#authError')).toBeEmpty();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button',{name:'Show responder token'})).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#tokenInput')).toHaveAttribute('type','text');
  await expect(page.getByRole('button',{name:'Hide responder token'})).toHaveAttribute('aria-pressed','true');
  await page.keyboard.press('Enter');
  await expect(page.locator('#tokenInput')).toHaveAttribute('type','password');
  expect(errors).toEqual([]);
});
for(const status of [401,429,500]) {
  test('synthetic session failure '+status+' preserves token clearing and retry',async({page,context})=>{
    let postCount=0;
    let release:()=>void=()=>undefined;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    await context.route(ORIGIN+'/**',async route=>{
      const req=route.request();
      if(new URL(req.url()).pathname==='/v1/responder/session'){
        if(req.method()==='POST'){
          postCount++;
          expect(req.postDataJSON()).toEqual({token:'synthetic-not-a-real-token'});
          await gate;
          await route.fulfill({status,contentType:'application/json',body:'{"error":"synthetic"}'});return;
        }
        await route.fulfill({status:401,contentType:'application/json',body:'{"error":"UNAUTHORIZED"}'});return;
      }
      const response=await previewResponse(new Request(req.url()));
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers.entries()),body:Buffer.from(await response.arrayBuffer())});
    });
    await page.setViewportSize({width:390,height:844});
    await page.goto(ORIGIN+'/responder');
    await page.locator('#tokenInput').fill('synthetic-not-a-real-token');
    await page.getByRole('button',{name:'Show responder token'}).click();
    await page.locator('#tokenInput').press('Enter');
    await expect(page.locator('#connectButton')).toBeDisabled();
    await expect(page.locator('#connectButton')).toHaveText('Connecting…');
    await expect(page.locator('#authForm')).toHaveAttribute('aria-busy','true');
    await expect(page.locator('#authPending')).toContainText('Connecting');
    await expect(page.locator('#tokenVisibility')).toBeDisabled();
    await expect(page.locator('#tokenInput')).toHaveValue('');
    await expect(page.locator('#tokenInput')).toHaveAttribute('type','password');
    await page.locator('#authForm').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(postCount).toBe(1);
    if(status===401)await page.screenshot({path:'artifacts/login-design/final-loading.png',fullPage:true});
    release();
    await expect(page.locator('#connectButton')).toBeEnabled();
    await expect(page.locator('#authForm')).toHaveAttribute('aria-busy','false');
    await expect(page.locator('#authPending')).toBeEmpty();
    await expect(page.locator('#tokenVisibility')).toBeEnabled();
    if(status===401)await expect(page.locator('#tokenInput')).toHaveAttribute('aria-invalid','true');
    await expect(page.locator('#tokenInput')).toBeFocused();
    await expect(page.locator('#authError')).toContainText(status===401?'not accepted':status===429?'Too many':'Could not start');
    expect(await page.evaluate(()=>({local:localStorage.length,session:sessionStorage.length}))).toEqual({local:0,session:0});
    expect(await context.cookies()).toEqual([]);
    await page.screenshot({path:'artifacts/login-design/final-failure-'+status+'.png',fullPage:true});
  });
}

test('synthetic accepted session and disconnect restore the masked access gate',async({page,context})=>{
  let active=false;
  await context.route(ORIGIN+'/**',async route=>{
    const req=route.request();
    if(new URL(req.url()).pathname==='/v1/responder/session'){
      if(req.method()==='POST')active=true;
      if(req.method()==='DELETE'){active=false;await route.fulfill({status:204});return;}
      if(!active){await route.fulfill({status:401,contentType:'application/json',body:'{}'});return;}
    }
    const response=await previewResponse(new Request(req.url(),{method:req.method()}));
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers.entries()),body:Buffer.from(await response.arrayBuffer())});
  });
  await page.goto(ORIGIN+'/responder');
  await expect(page.locator('#tokenInput')).toHaveAttribute('autocomplete','off');
  await expect(page.locator('#tokenInput')).toHaveAttribute('spellcheck','false');
  await page.locator('#tokenInput').fill('synthetic-not-a-real-token');
  await page.getByRole('button',{name:'Show responder token'}).click();
  await page.locator('#tokenInput').press('Enter');
  await expect(page.locator('#consolePanel')).toBeVisible();
  await expect(page.locator('#authPanel')).toBeHidden();
  await expect(page.locator('#tokenInput')).toHaveValue('');
  await expect(page.locator('#tokenInput')).toHaveAttribute('type','password');
  await page.locator('#logoutButton').click();
  await expect(page.locator('#authPanel')).toBeVisible();
  await expect(page.locator('#tokenInput')).toHaveValue('');
  await expect(page.locator('#tokenInput')).toHaveAttribute('type','password');
  await expect(page.getByRole('button',{name:'Show responder token'})).toHaveAttribute('aria-pressed','false');
});
