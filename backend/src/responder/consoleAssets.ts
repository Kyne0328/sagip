import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const RESPONDER_MAP_DEPENDENCY_VERSIONS = {
  maplibre: '6.11.2',
  pmtiles: '4.5.0',
} as const;

const MAPLIBRE_VERSION = RESPONDER_MAP_DEPENDENCY_VERSIONS.maplibre;
const PMTILES_VERSION = RESPONDER_MAP_DEPENDENCY_VERSIONS.pmtiles;

const MAPLIBRE_ASSET_ROOT = `/responder/assets/maplibre-gl-${MAPLIBRE_VERSION}`;
const PMTILES_ASSET_ROOT = `/responder/assets/pmtiles-${PMTILES_VERSION}`;
const BACKEND_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const GENERATED_ASSET_ROOT = join(BACKEND_ROOT, '.generated', 'responder-assets');
const GENERATED_BROWSER_ROOT = join(BACKEND_ROOT, '.generated', 'responder-browser');

export const RESPONDER_MAP_ASSET_PATHS = {
  maplibreModule: `${MAPLIBRE_ASSET_ROOT}/maplibre-gl.mjs`,
  maplibreShared: `${MAPLIBRE_ASSET_ROOT}/maplibre-gl-shared.mjs`,
  maplibreWorker: `${MAPLIBRE_ASSET_ROOT}/maplibre-gl-worker.mjs`,
  maplibreCss: `${MAPLIBRE_ASSET_ROOT}/maplibre-gl.css`,
  pmtilesScript: `${PMTILES_ASSET_ROOT}/pmtiles.js`,
} as const;

export const RESPONDER_BROWSER_ASSET_PATHS = {
  assetManifest: '/responder/assets/asset-manifest.json',
  offlinePackageModule: '/responder/assets/offline-package.js',
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
    {
      contentType: 'text/javascript; charset=utf-8',
      resolveFile: () => join(resolveMapLibreDist(), 'maplibre-gl.mjs'),
    },
  ],
  [
    RESPONDER_MAP_ASSET_PATHS.maplibreShared,
    {
      contentType: 'text/javascript; charset=utf-8',
      resolveFile: () => join(resolveMapLibreDist(), 'maplibre-gl-shared.mjs'),
    },
  ],
  [
    RESPONDER_MAP_ASSET_PATHS.maplibreWorker,
    {
      contentType: 'text/javascript; charset=utf-8',
      resolveFile: () => join(resolveMapLibreDist(), 'maplibre-gl-worker.mjs'),
    },
  ],
  [
    RESPONDER_MAP_ASSET_PATHS.maplibreCss,
    {
      contentType: 'text/css; charset=utf-8',
      resolveFile: () => join(resolveMapLibreDist(), 'maplibre-gl.css'),
    },
  ],
  [
    RESPONDER_MAP_ASSET_PATHS.pmtilesScript,
    {
      contentType: 'text/javascript; charset=utf-8',
      resolveFile: () => join(resolvePmtilesDist(), 'pmtiles.js'),
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
    {
      contentType: 'text/javascript; charset=utf-8',
      resolveFile: () => join(GENERATED_BROWSER_ROOT, 'offlinePackage.js'),
      cacheControl: 'no-cache',
    },
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
      bytes = new Uint8Array(readFileSync(asset.resolveFile()));
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

function resolveMapLibreDist(): string {
  return dirname(fileURLToPath(import.meta.resolve('maplibre-gl')));
}

function resolvePmtilesDist(): string {
  const esmEntry = fileURLToPath(import.meta.resolve('pmtiles'));
  return dirname(dirname(esmEntry));
}
