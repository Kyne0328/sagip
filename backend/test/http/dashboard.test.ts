import assert from 'node:assert/strict';
import test from 'node:test';
import {runInNewContext} from 'node:vm';

import {handleSagipRequest} from '../../src/http/handleRequest.js';

const deps = {
  ingestEnvelope: async () => {
    throw new Error('not used');
  },
};

// Test doubles verify rendering logic; real DOM/parser verification belongs to P13.
class TextNodeDouble {
  className = '';
  textContent = '';
  children: TextNodeDouble[] = [];
  classList = {add: () => {}, remove: () => {}, toggle: () => {}};
  value = '';
  set innerHTML(_value: string) { throw new Error('HTML insertion forbidden'); }
  append(...nodes: TextNodeDouble[]) { this.children.push(...nodes); }
  appendChild(node: TextNodeDouble) { this.append(node); }
  replaceChildren() { this.children = []; }
}

async function renderingHarness() {
  const response = await handleSagipRequest(new Request('http://localhost/responder/app.js'), deps);
  const javascript = await response.text();
  const functions = ['createText', 'addFact', 'renderRevisionHistory', 'renderDetail'].map((name) => {
    const start = javascript.indexOf('  function ' + name + '(');
    assert.ok(start >= 0, name + ' exists');
    const end = javascript.indexOf('\n  }', start);
    return javascript.slice(start, end + 4);
  }).join('\n');
  const detailFacts = new TextNodeDouble();
  const revisionHistory = new TextNodeDouble();
  const context = {
    document: {createElement: () => new TextNodeDouble()}, detailFacts, revisionHistory,
    detailPlaceholder: new TextNodeDouble(), detailContent: new TextNodeDouble(),
    detailTitle: new TextNodeDouble(), detailSubtitle: new TextNodeDouble(),
    detailStatus: new TextNodeDouble(), urgencyBanner: new TextNodeDouble(),
    ackStatus: new TextNodeDouble(),
    formatEmergencyType: String, formatRelative: String, formatDate: String,
    formatStatus: String, statusLabel: () => 'PENDING', statusClass: String,
    renderLocation: () => {}, renderAckHistory: () => {},
  };
  const render = runInNewContext(functions + '\n({renderDetail, renderRevisionHistory})', context) as {
    renderDetail: (detail: Record<string, unknown>) => void;
    renderRevisionHistory: (revisions: Record<string, unknown>[]) => void;
  };
  return {...render, detailFacts, revisionHistory};
}

for (const message of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)> & <b>help</b>', 'Help 🆘', 'First line\nSecond line']) {
  test('isolated dashboard renderers preserve message text: ' + JSON.stringify(message), async () => {
    const harness = await renderingHarness();
    const revision = {revision: 2, emergencyType: 'OTHER', urgency: 'IMMEDIATE_DANGER', message};
    harness.renderDetail({reportId: 'selected-report', latestRevision: 2, message, revisions: [revision]});
    const fact = harness.detailFacts.children.find((node) => node.children[0]?.textContent === 'Civilian message');
    assert.equal(fact?.children[1]?.textContent, message);
    assert.equal(fact?.children[1]?.className, 'civilian-message');
    const history = harness.revisionHistory.children[0];
    assert.ok(history);
    assert.equal(history.children[0]?.textContent, 'Revision 2 · OTHER');
    assert.equal(history.children.find((node) => node.className === 'civilian-message')?.textContent, message);
    assert.ok(harness.detailFacts.children.some((node) => node.children[1]?.textContent === 'selected-report'));
  });
}

test('isolated dashboard renderers clear old message and omit null message panels', async () => {
  const harness = await renderingHarness();
  harness.renderDetail({message: 'Old message', revisions: [{revision: 1, message: 'Old message'}]});
  harness.renderDetail({message: null, revisions: [{revision: 1, message: 'Historical message'}, {revision: 2, message: null}]});
  assert.ok(!harness.detailFacts.children.some((node) => node.children[0]?.textContent === 'Civilian message'));
  assert.equal(harness.revisionHistory.children.length, 2);
  assert.equal(harness.revisionHistory.children[0]?.children.find((node) => node.className === 'civilian-message')?.textContent, 'Historical message');
  assert.ok(!harness.revisionHistory.children[1]?.children.some((node) => node.className === 'civilian-message'));
});

test('civilian message styling preserves line breaks and wraps long text', async () => {
  const response = await handleSagipRequest(new Request('http://localhost/responder/styles.css'), deps);
  assert.match(await response.text(), /\.civilian-message\s*\{[^}]*white-space: pre-wrap;[^}]*overflow-wrap: anywhere;/u);
});

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
