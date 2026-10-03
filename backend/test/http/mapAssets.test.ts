import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';

import {handleSagipRequest} from '../../src/http/handleRequest.js';
import {
  RESPONDER_MAP_ASSET_PATHS,
  RESPONDER_MAP_DEPENDENCY_VERSIONS,
  RESPONDER_TAGUM_MAP_PATHS,
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

test('real Tagum map package is same-origin, hash-pinned, and attributed', async () => {
  const manifestResponse = await handleSagipRequest(
    new Request('https://sagip.example' + RESPONDER_TAGUM_MAP_PATHS.manifest),
    deps,
  );
  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers.get('content-type') ?? '', /^application\/json/u);
  assert.equal(manifestResponse.headers.get('cache-control'), 'no-cache');
  const manifest = await manifestResponse.json() as {
    packageId: string;
    sourceDate: string;
    attribution: string;
    extent: [number, number, number, number];
    maxZoom: number;
    totalBytes: number;
    resources: Array<{path: string; bytes: number; sha256: string; kind: string}>;
  };
  assert.equal(manifest.packageId, 'tagum-protomaps-20261002-z15');
  assert.equal(manifest.sourceDate, '2026-10-02T04:00:00Z');
  assert.deepEqual(manifest.extent, [125.6886, 7.2015, 125.9326, 7.5555]);
  assert.equal(manifest.maxZoom, 15);
  assert.match(manifest.attribution, /OpenStreetMap contributors/u);
  assert.equal(manifest.resources.length, 1);
  assert.equal(manifest.resources[0]?.path, RESPONDER_TAGUM_MAP_PATHS.archive);
  assert.equal(manifest.resources[0]?.kind, 'archive');

  const archiveResponse = await handleSagipRequest(
    new Request('https://sagip.example' + RESPONDER_TAGUM_MAP_PATHS.archive),
    deps,
  );
  assert.equal(archiveResponse.status, 200);
  assert.match(archiveResponse.headers.get('content-type') ?? '', /^application\/octet-stream/u);
  assert.match(archiveResponse.headers.get('cache-control') ?? '', /immutable/u);
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  assert.equal(archive.byteLength, manifest.totalBytes);
  assert.equal(archive.byteLength, manifest.resources[0]?.bytes);
  assert.equal(createHash('sha256').update(archive).digest('hex'), manifest.resources[0]?.sha256);
  assert.equal(archive.subarray(0, 7).toString('ascii'), 'PMTiles');
  assert.equal(archive[7], 3);

  const noticeResponse = await handleSagipRequest(
    new Request('https://sagip.example' + RESPONDER_TAGUM_MAP_PATHS.notice),
    deps,
  );
  assert.equal(noticeResponse.status, 200);
  const notice = await noticeResponse.text();
  assert.match(notice, /OpenStreetMap/u);
  assert.match(notice, /ODbL/u);
  assert.match(notice, /443884615d37bb15e789dd7b665b1016084cd3b9582db00ae2492f593b5daf70/u);

  for (const pathname of [RESPONDER_TAGUM_MAP_PATHS.manifest, RESPONDER_TAGUM_MAP_PATHS.archive]) {
    const mutation = await handleSagipRequest(
      new Request('https://sagip.example' + pathname, {method: 'POST'}),
      deps,
    );
    assert.equal(mutation.status, 405, pathname);
  }
});

test('unknown responder asset paths stay unavailable', async () => {
  const response = await handleSagipRequest(
    new Request('https://sagip.example/responder/assets/not-a-real-asset.js'),
    deps,
  );

  assert.equal(response.status, 404);
});
