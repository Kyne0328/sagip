import {expect, test, type BrowserContext} from '@playwright/test';
import {handleSagipRequest} from '../../src/http/handleRequest.js';

const ORIGIN = 'https://sagip.test';
const runtime = `
globalThis.__mapRuntimeLoaded = true;
export class Map {
  constructor() { this.events = {}; this.fitCalls = 0; this.panCalls = 0; this.removed = false; }
  on(name, callback) { this.events[name] = callback; }
  setStyle(style) { this.style = style; queueMicrotask(() => this.events.idle?.()); }
  fitBounds() { this.fitCalls++; }
  panTo() { this.panCalls++; }
  resize() {}
  getBounds() { return {getWest:()=>125.7,getEast:()=>125.9,getSouth:()=>7.3,getNorth:()=>7.5}; }
  addControl() {}
  remove() { this.removed = true; }
}
export class Marker { constructor({element}){this.element=element;} setLngLat(){return this;} addTo(){return this;} remove(){} }
export class NavigationControl {}
export class ScaleControl {}
export function addProtocol() {}
`;
async function fixture(context: BrowserContext): Promise<void> {
  await context.route(ORIGIN + '/**', async route => {
    if (new URL(route.request().url()).pathname === '/map-lifecycle') {
      await route.fulfill({contentType:'text/html',body:'<!doctype html><div id="map" style="width:800px;height:600px"></div><p id="placeholder"></p><p id="coverage"></p><p id="announce"></p>'});
      return;
    }
    const response = await handleSagipRequest(new Request(route.request().url()), {ingestEnvelope: async () => {throw new Error('not used');}});
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers.entries()),body:Buffer.from(await response.arrayBuffer())});
  });
}
const createView = `(async () => {
  const {IncidentMapView} = await import('/responder/assets/browser/incidentMap.js');
  window.view = new IncidentMapView(document.getElementById('map'),document.getElementById('placeholder'),document.getElementById('coverage'),document.getElementById('announce'),()=>{});
})()`;

test('refresh and source changes preserve manual camera and marker identity; only changed selection pans', async ({page, context}) => {
  await fixture(context);
  await context.route(ORIGIN + '/responder/assets/maplibre-gl-6.11.2/maplibre-gl.mjs', route => route.fulfill({contentType:'text/javascript',body:runtime}));
  await page.goto(ORIGIN + '/map-lifecycle');
  await page.evaluate(createView);
  const result = await page.evaluate(`(async () => {
    const v=window.view;
    await v.setManifest(null);
    const items=[{reportId:'test-only',emergencyType:'TRAPPED',urgency:'IMMEDIATE_DANGER',location:{latitude:7.4477,longitude:125.8078}}];
    await v.render(items,null);
    const map=v.map, marker=v.markers.get('test-only').marker;
    const fit=map.fitCalls;
    await v.render(items,null);
    await v.setBasemap('online');
    const unchanged=map.fitCalls===fit && v.markers.get('test-only').marker===marker && v.map===map;
    v.select('test-only');
    const pan=map.panCalls;
    await v.render(items,'test-only'); v.select('test-only');
    return {unchanged,pan,panAfter:map.panCalls};
  })()`);
  expect(result).toEqual({unchanged:true,pan:1,panAfter:1});
});

test('destroy during pending runtime import prevents late map creation', async ({page, context}) => {
  await fixture(context);
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {release=resolve;});
  await context.route(ORIGIN + '/responder/assets/maplibre-gl-6.11.2/maplibre-gl.mjs', async route => {
    await gate; await route.fulfill({contentType:'text/javascript',body:runtime});
  });
  await page.goto(ORIGIN + '/map-lifecycle');
  await page.evaluate(createView);
  await page.evaluate('window.pending = window.view.setManifest(null); window.view.destroy();');
  release();
  await expect.poll(() => page.evaluate('!!window.__mapRuntimeLoaded')).toBe(true);
  expect(await page.evaluate('(async () => {await window.pending; return window.view.map === null;})()')).toBe(true);
});

test('stalled offline runtime settles unavailable and late script cannot resurrect map', async ({page, context}) => {
  await fixture(context);
  await page.clock.install();
  await context.route(ORIGIN + '/responder/assets/maplibre-gl-6.11.2/maplibre-gl.mjs', route => route.fulfill({contentType:'text/javascript',body:runtime}));
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {release=resolve;});
  await context.route(ORIGIN + '/responder/assets/pmtiles-4.5.0/pmtiles.js', async route => {
    await gate;
    await route.fulfill({contentType:'text/javascript',body:'window.pmtiles={PMTiles:class {async getHeader(){return {tileType:1,minZoom:0,maxZoom:15}} async getMetadata(){return {vector_layers:[{id:"roads"}]}}},Protocol:class {add(){}},TileType:{Mvt:1}};'});
  });
  await page.goto(ORIGIN + '/map-lifecycle');
  await page.evaluate(createView);
  await page.evaluate(`(async () => {
    await window.view.setBasemap('offline');
    window.settled=false;
    window.pending=window.view.setManifest({packageId:'test-only',version:'test',extent:[125.7,7.2,125.9,7.6],minZoom:0,maxZoom:15,attribution:'test'}).finally(()=>{window.settled=true;});
  })()`);
  await page.clock.runFor(12001);
  await expect(page.locator('#map')).toHaveAttribute('data-map-source','unavailable');
  await expect(page.locator('#placeholder')).toContainText('timed out');
  expect(await page.evaluate('window.settled')).toBe(true);
  release();
  await expect.poll(() => page.evaluate('!!window.pmtiles')).toBe(true);
  expect(await page.evaluate('(async () => {await window.pending; return window.view.map === null;})()')).toBe(true);
});
