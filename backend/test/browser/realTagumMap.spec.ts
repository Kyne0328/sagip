import {expect, test} from '@playwright/test';

import {handleSagipRequest} from '../../src/http/handleRequest.js';
import {
  RESPONDER_BROWSER_ASSET_PATHS,
  RESPONDER_MAP_ASSET_PATHS,
  RESPONDER_TAGUM_MAP_PATHS,
} from '../../src/responder/consoleAssets.js';

const ORIGIN = 'https://sagip.test';
const deps = {
  ingestEnvelope: async () => {
    throw new Error('not used');
  },
};

test('real Tagum package prepares once and reopens from IndexedDB with network offline', async ({
  page,
  context,
}) => {
  await context.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/responder/real-map-test') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><title>SAGIP real Tagum map test</title>',
      });
      return;
    }

    const response = await handleSagipRequest(
      new Request(request.url(), {method: request.method()}),
      deps,
    );
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });

  await page.goto(`${ORIGIN}/responder/real-map-test`);

  const prepared = await page.evaluate(
    async ({offlineModulePath, incidentMapModulePath, pmtilesModulePath, manifestPath}) => {
      const storage = (navigator as unknown as {storage: Record<string, unknown>}).storage;
      Object.defineProperty(storage, 'persist', {
        configurable: true,
        value: async () => false,
      });

      const offline = await import(offlineModulePath);
      const browserDocument = (globalThis as unknown as {
        document: {
          createElement(tag: 'script'): {
            src: string;
            addEventListener(type: 'load' | 'error', listener: () => void, options: {once: boolean}): void;
          };
          head: {append(node: unknown): void};
        };
      }).document;
      await new Promise<void>((resolve, reject) => {
        const script = browserDocument.createElement('script');
        script.src = pmtilesModulePath;
        script.addEventListener('load', () => resolve(), {once: true});
        script.addEventListener('error', () => reject(new Error('PMTILES_SCRIPT_UNAVAILABLE')), {once: true});
        browserDocument.head.append(script);
      });
      const pmtiles = (globalThis as unknown as {
        pmtiles?: {PMTiles?: new (...args: never[]) => unknown};
      }).pmtiles;
      if (typeof pmtiles?.PMTiles !== 'function') throw new Error('PMTILES_RUNTIME_INVALID');

      const manifestResponse = await fetch(manifestPath, {cache: 'no-store'});
      if (!manifestResponse.ok) throw new Error('manifest unavailable');
      const manifest = await manifestResponse.json() as {
        packageId: string;
        totalBytes: number;
        extent: [number, number, number, number];
      };
      const result = await offline.preparePackage(manifest);
      const readiness = await offline.inspectReadiness();
      const incidentMap = await import(incidentMapModulePath);
      const dom = (globalThis as unknown as {
        document: {
          createElement(tag: string): {
            id: string;
            style: {width: string; height: string};
            hidden: boolean;
            textContent: string | null;
            querySelector(selector: string): unknown;
            querySelectorAll(selector: string): {length: number};
          };
          body: {append(...nodes: unknown[]): void};
        };
      }).document;
      const mapContainer = dom.createElement('div');
      mapContainer.id = 'real-tagum-map-canvas';
      mapContainer.style.width = '800px';
      mapContainer.style.height = '600px';
      mapContainer.hidden = true;
      const placeholder = dom.createElement('div');
      const coverage = dom.createElement('div');
      const announcement = dom.createElement('div');
      dom.body.append(mapContainer, placeholder, coverage, announcement);
      const MapView = incidentMap.IncidentMapView as unknown as new (
        container: unknown,
        placeholderElement: unknown,
        coverageElement: unknown,
        announcementElement: unknown,
        onSelect: (reportId: string) => void,
      ) => {
        setManifest(value: unknown): Promise<void>;
        setBasemap(value: 'offline'): Promise<void>;
        waitUntilReady(): Promise<boolean>;
        render(items: readonly unknown[], selectedReportId: string | null): Promise<void>;
        focusReport(reportId: string): 'FOCUSED' | 'MAP_NOT_READY' | 'LOCATION_NOT_MAPPED' | 'OUTSIDE_EXTENT';
      };
      const view = new MapView(
        mapContainer,
        placeholder,
        coverage,
        announcement,
        () => undefined,
      );
      if (readiness.kind !== 'READY') throw new Error('real package was not activated');
      await view.setBasemap('offline');
      await view.setManifest(readiness.manifest);
      mapContainer.hidden = false;
      const requestFrame = (globalThis as unknown as {
        requestAnimationFrame(callback: () => void): number;
      }).requestAnimationFrame;
      await new Promise<void>(resolve => requestFrame(() => requestFrame(() => resolve())));
      await view.render([
        {
          reportId: '11111111-1111-4111-8111-111111111111',
          emergencyType: 'TRAPPED',
          urgency: 'IMMEDIATE_DANGER',
          location: {
            latitude: 7.4477,
            longitude: 125.8078,
            accuracyMeters: 9,
            capturedAtMs: 1_000n,
            source: 1,
            freshness: 1,
          },
        },
      ], '11111111-1111-4111-8111-111111111111');
      await view.waitUntilReady();
      const focusResult = view.focusReport('11111111-1111-4111-8111-111111111111');
      const canvas = mapContainer.querySelector('.maplibregl-canvas') as {
        getBoundingClientRect(): {width: number; height: number};
      } | null;
      const canvasRect = canvas?.getBoundingClientRect();

      (globalThis as unknown as {
        __sagipRealMap?: {
          offline: typeof offline;
          PMTiles: typeof pmtiles.PMTiles;
          packageId: string;
        };
      }).__sagipRealMap = {
        offline,
        PMTiles: pmtiles.PMTiles,
        packageId: manifest.packageId,
      };

      return {
        result,
        readinessKind: readiness.kind,
        packageId: readiness.kind === 'READY' ? readiness.packageId : null,
        totalBytes: readiness.kind === 'READY' ? readiness.manifest.totalBytes : null,
        extent: readiness.kind === 'READY' ? readiness.manifest.extent : null,
        renderedCanvas: canvas !== null,
        canvasWidth: canvasRect?.width ?? 0,
        canvasHeight: canvasRect?.height ?? 0,
        coverageText: coverage.textContent,
        placeholderHidden: placeholder.hidden,
        placeholderText: placeholder.textContent,
        markerCount: mapContainer.querySelectorAll('.map-marker').length,
        focusResult,
        announcementText: announcement.textContent,
      };
    },
    {
      offlineModulePath: RESPONDER_BROWSER_ASSET_PATHS.browserOfflinePackageModule,
      incidentMapModulePath: RESPONDER_BROWSER_ASSET_PATHS.incidentMapModule,
      pmtilesModulePath: RESPONDER_MAP_ASSET_PATHS.pmtilesScript,
      manifestPath: RESPONDER_TAGUM_MAP_PATHS.manifest,
    },
  );

  expect(prepared.result.kind).toBe('READY');
  expect(prepared.result.persistentStorage).toBe(false);
  expect(prepared.readinessKind).toBe('READY');
  expect(prepared.packageId).toBe('tagum-protomaps-20261002-z15');
  expect(prepared.totalBytes).toBe(5_630_162);
  expect(prepared.extent).toEqual([125.6886, 7.2015, 125.9326, 7.5555]);
  expect(prepared.renderedCanvas).toBe(true);
  expect(prepared.canvasWidth).toBe(800);
  expect(prepared.canvasHeight).toBe(600);
  expect(prepared.coverageText).toContain('OpenStreetMap contributors');
  expect(prepared.placeholderHidden).toBe(true);
  expect(prepared.markerCount).toBe(1);
  expect(prepared.focusResult).toBe('FOCUSED');
  expect(prepared.announcementText).toContain('centered on the selected incident');

  await context.unroute(`${ORIGIN}/**`);
  await context.setOffline(true);

  const offlineResult = await page.evaluate(async () => {
    const state = (globalThis as unknown as {
      __sagipRealMap: {
        offline: {
          inspectReadiness(): Promise<{
            kind: string;
            packageId?: string;
            manifest?: {attribution: string};
          }>;
          readArchiveRange(packageId: string, offset: number, length: number): Promise<ArrayBuffer>;
        };
        PMTiles: new (source: {
          getKey(): string;
          getBytes(
            offset: number,
            length: number,
            signal?: AbortSignal,
            etag?: string,
          ): Promise<{data: ArrayBuffer}>;
        }) => {
          getHeader(): Promise<{minZoom: number; maxZoom: number; tileType: number}>;
          getMetadata(): Promise<{name?: string; vector_layers?: Array<{id?: string}>}>;
        };
        packageId: string;
      };
    }).__sagipRealMap;

    const readiness = await state.offline.inspectReadiness();
    const firstBytes = Array.from(
      new Uint8Array(await state.offline.readArchiveRange(state.packageId, 0, 8)),
    );
    const source = {
      getKey: () => `sagip-${state.packageId}`,
      getBytes: async (
        offset: number,
        length: number,
        signal?: AbortSignal,
      ) => {
        signal?.throwIfAborted();
        const data = await state.offline.readArchiveRange(state.packageId, offset, length);
        signal?.throwIfAborted();
        return {data};
      },
    };
    const archive = new state.PMTiles(source);
    const [header, metadata] = await Promise.all([
      archive.getHeader(),
      archive.getMetadata(),
    ]);
    return {
      readinessKind: readiness.kind,
      packageId: readiness.packageId,
      attribution: readiness.manifest?.attribution,
      firstBytes,
      header,
      metadataName: metadata.name,
      layerIds: (metadata.vector_layers ?? []).map(layer => layer.id),
    };
  });

  expect(offlineResult.readinessKind).toBe('READY');
  expect(offlineResult.packageId).toBe('tagum-protomaps-20261002-z15');
  expect(offlineResult.attribution).toContain('OpenStreetMap contributors');
  expect(String.fromCharCode(...offlineResult.firstBytes.slice(0, 7))).toBe('PMTiles');
  expect(offlineResult.firstBytes[7]).toBe(3);
  expect(offlineResult.header.minZoom).toBe(0);
  expect(offlineResult.header.maxZoom).toBe(15);
  expect(offlineResult.metadataName).toBe('Protomaps Basemap');
  expect(offlineResult.layerIds).toEqual(
    expect.arrayContaining(['roads', 'water', 'places', 'buildings']),
  );
});
