import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import {handleSagipRequest} from '../../src/http/handleRequest.js';
import {
  RESPONDER_MAP_ASSET_PATHS,
  RESPONDER_MAP_DEPENDENCY_VERSIONS,
} from '../../src/responder/consoleAssets.js';

const deps = {
  ingestEnvelope: async () => {
    throw new Error('not used');
  },
};

test('responder map asset URLs match pinned dependency versions', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as {dependencies: Record<string, string>};

  assert.equal(packageJson.dependencies['maplibre-gl'], RESPONDER_MAP_DEPENDENCY_VERSIONS.maplibre);
  assert.equal(packageJson.dependencies.pmtiles, RESPONDER_MAP_DEPENDENCY_VERSIONS.pmtiles);
});

test('responder map assets are same-origin, versioned, immutable, and mutation-safe', async () => {
  const assetPaths = [
    [RESPONDER_MAP_ASSET_PATHS.maplibreModule, 'text/javascript'],
    [RESPONDER_MAP_ASSET_PATHS.maplibreShared, 'text/javascript'],
    [RESPONDER_MAP_ASSET_PATHS.maplibreWorker, 'text/javascript'],
    [RESPONDER_MAP_ASSET_PATHS.maplibreCss, 'text/css'],
    [RESPONDER_MAP_ASSET_PATHS.pmtilesScript, 'text/javascript'],
  ] as const;

  for (const [pathname, contentType] of assetPaths) {
    assert.match(pathname, /\d+\.\d+\.\d+/u);

    const response = await handleSagipRequest(
      new Request('https://sagip.example' + pathname),
      deps,
    );

    assert.equal(response.status, 200, pathname);
    assert.match(response.headers.get('content-type') ?? '', new RegExp('^' + contentType));
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('cache-control') ?? '', /immutable/u);
    assert.ok((await response.arrayBuffer()).byteLength > 0, pathname);

    const mutation = await handleSagipRequest(
      new Request('https://sagip.example' + pathname, {method: 'POST'}),
      deps,
    );
    assert.equal(mutation.status, 405, pathname);
    assert.equal(mutation.headers.get('allow'), 'GET');
  }
});

test('unknown responder asset paths stay unavailable', async () => {
  const response = await handleSagipRequest(
    new Request('https://sagip.example/responder/assets/not-a-real-asset.js'),
    deps,
  );

  assert.equal(response.status, 404);
});
