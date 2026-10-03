import {Buffer} from 'node:buffer';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {BUNDLED_RESPONDER_ASSETS} from './embeddedAssets.js';

export const RESPONDER_MAP_DEPENDENCY_VERSIONS = {
  maplibre: '6.11.2',
  pmtiles: '4.5.0',
} as const;

const MAPLIBRE_VERSION = RESPONDER_MAP_DEPENDENCY_VERSIONS.maplibre;
const PMTILES_VERSION = RESPONDER_MAP_DEPENDENCY_VERSIONS.pmtiles;
const MAPLIBRE_ASSET_ROOT = `/responder/assets/maplibre-gl-${MAPLIBRE_VERSION}`;
const PMTILES_ASSET_ROOT = `/responder/assets/pmtiles-${PMTILES_VERSION}`;
const BROWSER_ASSET_ROOT = '/responder/assets/browser';
const BACKEND_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const GENERATED_ASSET_ROOT = join(BACKEND_ROOT, '.generated', 'responder-assets');
const GENERATED_BROWSER_ROOT = join(BACKEND_ROOT, '.generated', 'responder-browser');
const MAP_DATA_ROOT = join(BACKEND_ROOT, 'map-data');

export const RESPONDER_MAP_ASSET_PATHS = {
  maplibreModule: `${MAPLIBRE_ASSET_ROOT}/maplibre-gl.mjs`,
  maplibreShared: `${MAPLIBRE_ASSET_ROOT}/maplibre-gl-shared.mjs`,
  maplibreWorker: `${MAPLIBRE_ASSET_ROOT}/maplibre-gl-worker.mjs`,
  maplibreCss: `${MAPLIBRE_ASSET_ROOT}/maplibre-gl.css`,
  pmtilesScript: `${PMTILES_ASSET_ROOT}/pmtiles.js`,
} as const;

export const RESPONDER_TAGUM_MAP_PATHS = {
  manifest: '/responder/map/tagum/manifest.json',
  archive: '/responder/map/tagum/tagum-protomaps-20261002.pmtiles',
  notice: '/responder/map/tagum/NOTICE.txt',
} as const;

export const RESPONDER_BROWSER_ASSET_PATHS = {
  assetManifest: '/responder/assets/asset-manifest.json',
  offlinePackageModule: '/responder/assets/offline-package.js',
  browserOfflinePackageModule: `${BROWSER_ASSET_ROOT}/offlinePackage.js`,
  consoleStoreModule: `${BROWSER_ASSET_ROOT}/consoleStore.js`,
  consoleTypesModule: `${BROWSER_ASSET_ROOT}/consoleTypes.js`,
  offlineAccessModule: `${BROWSER_ASSET_ROOT}/offlineAccess.js`,
  receiptVerifierModule: `${BROWSER_ASSET_ROOT}/receiptVerifier.js`,
  gatewayClientModule: `${BROWSER_ASSET_ROOT}/gatewayClient.js`,
  incidentSnapshotModule: `${BROWSER_ASSET_ROOT}/incidentSnapshot.js`,
  actionCodecModule: `${BROWSER_ASSET_ROOT}/actionCodec.js`,
  actionOutboxModule: `${BROWSER_ASSET_ROOT}/actionOutbox.js`,
  incidentMapModule: `${BROWSER_ASSET_ROOT}/incidentMap.js`,
  consoleControllerModule: `${BROWSER_ASSET_ROOT}/consoleController.js`,
  serviceWorker: '/responder/service-worker.js',
} as const;

interface AssetDescriptor {
  readonly contentType: string;
  readonly resolveFile: () => string;
  readonly cacheControl?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

const assets = new Map<string, AssetDescriptor>([
  [
    RESPONDER_MAP_ASSET_PATHS.maplibreModule,
    {contentType: 'text/javascript; charset=utf-8', resolveFile: () => join(resolveMapLibreDist(), 'maplibre-gl.mjs')},
  ],
  [
    RESPONDER_MAP_ASSET_PATHS.maplibreShared,
    {contentType: 'text/javascript; charset=utf-8', resolveFile: () => join(resolveMapLibreDist(), 'maplibre-gl-shared.mjs')},
  ],
  [
    RESPONDER_MAP_ASSET_PATHS.maplibreWorker,
    {contentType: 'text/javascript; charset=utf-8', resolveFile: () => join(resolveMapLibreDist(), 'maplibre-gl-worker.mjs')},
  ],
  [
    RESPONDER_MAP_ASSET_PATHS.maplibreCss,
    {contentType: 'text/css; charset=utf-8', resolveFile: () => join(resolveMapLibreDist(), 'maplibre-gl.css')},
  ],
  [
    RESPONDER_MAP_ASSET_PATHS.pmtilesScript,
    {contentType: 'text/javascript; charset=utf-8', resolveFile: () => join(resolvePmtilesDist(), 'pmtiles.js')},
  ],
  [
    RESPONDER_TAGUM_MAP_PATHS.manifest,
    {
      contentType: 'application/json; charset=utf-8',
      resolveFile: () => join(MAP_DATA_ROOT, 'tagum-manifest.json'),
      cacheControl: 'no-cache',
    },
  ],
  [
    RESPONDER_TAGUM_MAP_PATHS.archive,
    {
      contentType: 'application/octet-stream',
      resolveFile: () => join(MAP_DATA_ROOT, 'tagum-protomaps-20261002.pmtiles'),
    },
  ],
  [
    RESPONDER_TAGUM_MAP_PATHS.notice,
    {
      contentType: 'text/plain; charset=utf-8',
      resolveFile: () => join(MAP_DATA_ROOT, 'NOTICE.md'),
      cacheControl: 'no-cache',
    },
  ],
  [
    RESPONDER_BROWSER_ASSET_PATHS.assetManifest,
    {
      contentType: 'application/json; charset=utf-8',
      resolveFile: () => join(GENERATED_ASSET_ROOT, 'asset-manifest.json'),
      cacheControl: 'no-cache',
    },
  ],
  [
    RESPONDER_BROWSER_ASSET_PATHS.offlinePackageModule,
    browserModule('offlinePackage.js'),
  ],
  [
    RESPONDER_BROWSER_ASSET_PATHS.browserOfflinePackageModule,
    browserModule('offlinePackage.js'),
  ],
  [
    RESPONDER_BROWSER_ASSET_PATHS.consoleStoreModule,
    browserModule('consoleStore.js'),
  ],
  [
    RESPONDER_BROWSER_ASSET_PATHS.consoleTypesModule,
    browserModule('consoleTypes.js'),
  ],
  [
    RESPONDER_BROWSER_ASSET_PATHS.offlineAccessModule,
    browserModule('offlineAccess.js'),
  ],
  [
    RESPONDER_BROWSER_ASSET_PATHS.receiptVerifierModule,
    browserModule('receiptVerifier.js'),
  ],
  [
    RESPONDER_BROWSER_ASSET_PATHS.gatewayClientModule,
    browserModule('gatewayClient.js'),
  ],
  [
    RESPONDER_BROWSER_ASSET_PATHS.incidentSnapshotModule,
    browserModule('incidentSnapshot.js'),
  ],
  [
    RESPONDER_BROWSER_ASSET_PATHS.actionCodecModule,
    browserModule('actionCodec.js'),
  ],
  [
    RESPONDER_BROWSER_ASSET_PATHS.actionOutboxModule,
    browserModule('actionOutbox.js'),
  ],
  [
    RESPONDER_BROWSER_ASSET_PATHS.incidentMapModule,
    browserModule('incidentMap.js'),
  ],
  [
    RESPONDER_BROWSER_ASSET_PATHS.consoleControllerModule,
    browserModule('consoleController.js'),
  ],
  [
    RESPONDER_BROWSER_ASSET_PATHS.serviceWorker,
    {
      contentType: 'text/javascript; charset=utf-8',
      resolveFile: () => join(GENERATED_BROWSER_ROOT, 'serviceWorker.js'),
      cacheControl: 'no-cache',
      headers: {'service-worker-allowed': '/responder/'},
    },
  ],
]);

const cachedBytes = new Map<string, Uint8Array>();

export function consoleAssetResponse(pathname: string, method: string): Response | null {
  const asset = assets.get(pathname);
  if (!asset) return null;
  if (method !== 'GET') {
    return new Response(JSON.stringify({error: 'METHOD_NOT_ALLOWED'}), {
      status: 405,
      headers: {
        allow: 'GET',
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'cross-origin-resource-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  try {
    let bytes = cachedBytes.get(pathname);
    if (!bytes) {
      const embedded = BUNDLED_RESPONDER_ASSETS[pathname];
      bytes =
        embedded === undefined
          ? new Uint8Array(readFileSync(asset.resolveFile()))
          : new Uint8Array(Buffer.from(embedded, 'base64'));
      cachedBytes.set(pathname, bytes);
    }
    return new Response(bytes, {
      status: 200,
      headers: {
        'cache-control': asset.cacheControl ?? 'public, max-age=31536000, immutable',
        'content-type': asset.contentType,
        'cross-origin-resource-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
        ...asset.headers,
      },
    });
  } catch {
    return new Response(JSON.stringify({error: 'RESPONDER_ASSET_UNAVAILABLE'}), {
      status: 503,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'cross-origin-resource-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
      },
    });
  }
}

function browserModule(fileName: string): AssetDescriptor {
  return {
    contentType: 'text/javascript; charset=utf-8',
    resolveFile: () => join(GENERATED_BROWSER_ROOT, fileName),
    cacheControl: 'no-cache',
  };
}

function resolveMapLibreDist(): string {
  return dirname(fileURLToPath(import.meta.resolve('maplibre-gl')));
}

function resolvePmtilesDist(): string {
  const esmEntry = fileURLToPath(import.meta.resolve('pmtiles'));
  return dirname(dirname(esmEntry));
}
