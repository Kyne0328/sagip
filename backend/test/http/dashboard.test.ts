import assert from 'node:assert/strict';
import test from 'node:test';

import {handleSagipRequest} from '../../src/http/handleRequest.js';

const deps = {
  ingestEnvelope: async () => {
    throw new Error('not used');
  },
};

test('responder dashboard assets are served with strict browser security headers', async () => {
  const html = await handleSagipRequest(new Request('http://localhost/responder'), deps);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type') ?? '', /^text\/html/u);
  assert.equal(html.headers.get('cache-control'), 'no-store');
  assert.match(html.headers.get('content-security-policy') ?? '', /default-src 'self'/u);
  assert.equal(html.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(html.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(html.headers.get('permissions-policy') ?? '', /geolocation=\(\)/u);
  assert.equal(html.headers.get('x-frame-options'), 'DENY');

  const body = await html.text();
  assert.match(body, /SAGIP/u);
  assert.match(body, /Responder Console/u);
  assert.match(body, /locator pin with medical plus/u);
  assert.match(body, /Report revision history/u);
  assert.match(body, /Start a responder shift/u);
  assert.match(body, /secure 12-hour browser session/u);
  assert.match(body, /Open incidents/u);
  assert.match(body, /Tagum emergency operations/u);
  assert.match(body, /class="operations-stage"/u);
  assert.match(body, /Prepare Tagum offline map/u);
  assert.match(body, /<button id="mapLink" type="button" class="map-link">Show on offline map<\/button>/u);
  assert.match(body, /id="exitMapFocusButton"[^>]*>Back to incident details<\/button>/u);
  assert.match(body, /id="incidentMapPanel"[^>]*tabindex="-1"/u);
  assert.doesNotMatch(body, /sagip-dev-token/u);

  const css = await handleSagipRequest(
    new Request('http://localhost/responder/styles.css'),
    deps,
  );
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') ?? '', /^text\/css/u);

  const js = await handleSagipRequest(
    new Request('http://localhost/responder/app.js'),
    deps,
  );
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') ?? '', /^text\/javascript/u);
  const javascript = await js.text();
  assert.match(javascript, /\/v1\/responder\/session/u);
  assert.match(javascript, /It may have been saved/u);
  assert.match(javascript, /sagip:focus-map/u);
  assert.match(javascript, /cancelable: true/u);
  assert.match(javascript, /map-focus-mode/u);
  assert.match(javascript, /scrollIntoView/u);
  assert.doesNotMatch(javascript, /sessionStorage/u);
  assert.doesNotMatch(javascript, /authorization.*Bearer/iu);
});

test('backend root leads responders to the console and health endpoint stays lightweight', async () => {
  const root = await handleSagipRequest(new Request('http://localhost/'), deps);
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/responder');

  const health = await handleSagipRequest(new Request('http://localhost/healthz'), deps);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {status: 'ok'});
});

test('dashboard routes reject mutation methods', async () => {
  const response = await handleSagipRequest(
    new Request('http://localhost/responder', {method: 'POST'}),
    deps,
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
});
