const CACHE_PREFIX = 'sagip-responder-public-';
const CACHE_NAME = `${CACHE_PREFIX}c05-v1`;
const ASSET_MANIFEST_PATH = '/responder/assets/asset-manifest.json';
const PUBLIC_SHELL_PATHS = [
  '/responder/',
  '/responder/styles.css',
  '/responder/app.js',
  '/responder/assets/offline-package.js',
  '/responder/assets/browser/offlinePackage.js',
  '/responder/assets/browser/consoleStore.js',
  '/responder/assets/browser/consoleTypes.js',
  '/responder/assets/browser/offlineAccess.js',
  '/responder/assets/browser/receiptVerifier.js',
  '/responder/assets/browser/gatewayClient.js',
  '/responder/assets/browser/incidentSnapshot.js',
  '/responder/assets/browser/actionCodec.js',
  '/responder/assets/browser/actionOutbox.js',
  '/responder/assets/browser/incidentMap.js',
  '/responder/assets/browser/consoleController.js',
  ASSET_MANIFEST_PATH,
] as const;

interface AssetManifest {
  schemaVersion: number;
  assets: Array<{path: string}>;
}

const serviceWorker = globalThis as unknown as ServiceWorkerGlobalScope;

serviceWorker.addEventListener('install', event => {
  event.waitUntil(installPublicCache());
});

serviceWorker.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
          .map(name => caches.delete(name)),
      );
      await serviceWorker.clients.claim();
    })(),
  );
});

serviceWorker.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== serviceWorker.location.origin || !isPublicResponderAsset(url.pathname)) return;
  event.respondWith(cacheFirst(request));
});

async function installPublicCache(): Promise<void> {
  const manifestResponse = await fetch(ASSET_MANIFEST_PATH, {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!manifestResponse.ok) throw new Error('Responder map asset manifest is unavailable');

  const assetPaths = parseAssetManifest(await manifestResponse.json());
  const urls = [...new Set([...PUBLIC_SHELL_PATHS, ...assetPaths])];
  const cache = await caches.open(CACHE_NAME);
  for (const path of urls) {
    const response = await fetch(path, {cache: 'no-store', credentials: 'same-origin'});
    if (!response.ok) throw new Error(`Responder public asset is unavailable: ${path}`);
    await cache.put(path, response);
  }
}

async function cacheFirst(request: Request): Promise<Response> {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

function parseAssetManifest(value: unknown): string[] {
  if (!value || typeof value !== 'object') throw new Error('Responder map asset manifest is invalid');
  const manifest = value as Partial<AssetManifest>;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets)) {
    throw new Error('Responder map asset manifest is invalid');
  }
  return manifest.assets.map(asset => {
    const path = asset?.path;
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.startsWith('/') ||
      path.includes('..') ||
      path.includes('\\')
    ) throw new Error('Responder map asset manifest contains an invalid path');
    return `/responder/assets/${path}`;
  });
}

function isPublicResponderAsset(pathname: string): boolean {
  return (
    PUBLIC_SHELL_PATHS.includes(pathname as (typeof PUBLIC_SHELL_PATHS)[number]) ||
    pathname.startsWith('/responder/assets/maplibre-gl-') ||
    pathname.startsWith('/responder/assets/pmtiles-')
  );
}
