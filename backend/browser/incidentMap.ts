import type {IncidentSnapshotEntry} from './consoleTypes.js';
import {readArchiveRange, type OfflineManifest} from './offlinePackage.js';

interface MapLike {
  fitBounds(bounds: [[number, number], [number, number]], options: {padding: number; duration: number}): void;
  remove(): void;
}
interface MarkerLike {
  setLngLat(value: [number, number]): MarkerLike;
  addTo(map: MapLike): MarkerLike;
  remove(): void;
}
interface MapLibreLike {
  Map: new (options: Record<string, unknown>) => MapLike;
  Marker: new (options: {element: HTMLElement; anchor: string}) => MarkerLike;
  addProtocol(name: string, protocol: unknown): void;
}
interface PmtilesSource {
  getKey(): string;
  getBytes(offset: number, length: number, signal?: AbortSignal): Promise<{data: ArrayBuffer}>;
}
interface PmtilesArchive {
  getHeader(): Promise<{tileType: number; minZoom: number; maxZoom: number}>;
  getMetadata(): Promise<unknown>;
}
interface PmtilesProtocol {
  add(archive: PmtilesArchive): void;
  tile: unknown;
}
interface PmtilesModule {
  PMTiles: new (source: PmtilesSource) => PmtilesArchive;
  Protocol: new (options?: {metadata?: boolean}) => PmtilesProtocol;
  TileType: {Mvt: number; Png: number; Jpeg: number; Webp: number; Avif: number};
}

export interface IncidentMapItem {
  reportId: string;
  emergencyType: string;
  urgency: string;
  location: IncidentSnapshotEntry['location'];
}

let registeredProtocol: PmtilesProtocol | null = null;
let registeredMapLibre: MapLibreLike | null = null;
let pmtilesLoadPromise: Promise<PmtilesModule> | null = null;

export class IncidentMapView {
  private map: MapLike | null = null;
  private markers: MarkerLike[] = [];
  private markerListeners = new AbortController();
  private manifest: OfflineManifest | null = null;
  private activePackageId: string | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly placeholder: HTMLElement,
    private readonly coverage: HTMLElement,
    private readonly announce: HTMLElement,
    private readonly onSelect: (reportId: string) => void,
  ) {}

  async setManifest(manifest: OfflineManifest | null): Promise<void> {
    const nextId = manifest?.packageId ?? null;
    const changed = this.activePackageId !== nextId;
    this.manifest = manifest ? structuredClone(manifest) : null;
    this.activePackageId = nextId;
    if (!manifest) {
      this.coverage.textContent = 'No prepared local map package';
      this.placeholder.hidden = false;
      this.placeholder.textContent =
        'The incident queue remains available. Prepare an approved Tagum map package before relying on the map during an outage.';
      this.destroyMap();
      return;
    }

    this.coverage.textContent =
      `Prepared package ${manifest.version} · zoom ${manifest.minZoom}–${manifest.maxZoom} · ${manifest.attribution}`;
    if (changed) this.destroyMap();
    if (!this.map) await this.createMap(manifest);
  }

  async render(items: readonly IncidentMapItem[], selectedReportId: string | null): Promise<void> {
    this.clearMarkers();
    if (!this.manifest) {
      const located = items.filter(item => item.location !== null).length;
      this.announce.textContent =
        `${items.length} incidents loaded; ${located} have location evidence. Offline map package is not prepared.`;
      return;
    }
    if (!this.map) await this.createMap(this.manifest);
    if (!this.map) return;

    const located = items.filter(item => item.location !== null);
    const outOfExtent = located.filter(item => !insideExtent(item.location!, this.manifest!.extent));
    const maplibre = await loadMapLibre();
    for (const item of located) {
      const location = item.location!;
      const markerElement = document.createElement('div');
      markerElement.className = 'map-marker';
      markerElement.dataset.reportId = item.reportId;
      markerElement.dataset.selected = item.reportId === selectedReportId ? 'true' : 'false';
      markerElement.dataset.urgency = item.urgency;
      markerElement.textContent = item.urgency === 'IMMEDIATE_DANGER' ? '!' : '•';
      markerElement.addEventListener('click', () => this.onSelect(item.reportId), {
        signal: this.markerListeners.signal,
      });
      const marker = new maplibre.Marker({element: markerElement, anchor: 'center'})
        .setLngLat([location.longitude, location.latitude])
        .addTo(this.map);
      this.markers.push(marker);
    }
    const missing = items.length - located.length;
    this.announce.textContent =
      `${items.length} incidents loaded; ${located.length} mapped; ${missing} without location; ${outOfExtent.length} outside the prepared map extent.`;
  }

  select(reportId: string | null): void {
    for (const element of this.container.querySelectorAll<HTMLElement>('.map-marker')) {
      element.dataset.selected = element.dataset.reportId === reportId ? 'true' : 'false';
    }
  }

  destroy(): void {
    this.clearMarkers();
    this.destroyMap();
  }

  private async createMap(manifest: OfflineManifest): Promise<void> {
    try {
      const [maplibre, pmtiles] = await Promise.all([loadMapLibre(), loadPmtiles()]);
      const source = new IndexedDbPmtilesSource(manifest.packageId);
      const archive = new pmtiles.PMTiles(source);
      const protocol = ensureProtocol(maplibre, pmtiles);
      protocol.add(archive);
      const [header, metadata] = await Promise.all([
        archive.getHeader(),
        archive.getMetadata().catch(() => ({})),
      ]);
      if (header.minZoom > manifest.maxZoom || header.maxZoom < manifest.minZoom) {
        throw new Error('MAP_ZOOM_MISMATCH');
      }
      const style = buildOfflineStyle(
        source.getKey(),
        header.tileType,
        metadata,
        manifest.attribution,
        pmtiles.TileType,
      );
      const [west, south, east, north] = manifest.extent;
      this.map = new maplibre.Map({
        container: this.container,
        style,
        attributionControl: false,
        interactive: true,
        fadeDuration: 0,
      });
      this.placeholder.hidden = true;
      this.map.fitBounds([[west, south], [east, north]], {padding: 24, duration: 0});
    } catch {
      this.map = null;
      this.placeholder.hidden = false;
      this.placeholder.textContent =
        'The prepared local basemap could not be rendered. Use the complete incident queue and location coordinates.';
      this.announce.textContent = 'Prepared local basemap unavailable; incident queue remains available.';
    }
  }

  private clearMarkers(): void {
    this.markerListeners.abort();
    this.markerListeners = new AbortController();
    for (const marker of this.markers) marker.remove();
    this.markers = [];
  }

  private destroyMap(): void {
    this.clearMarkers();
    this.map?.remove();
    this.map = null;
    this.container.replaceChildren();
  }
}

class IndexedDbPmtilesSource implements PmtilesSource {
  constructor(private readonly packageId: string) {}

  getKey(): string {
    return `sagip-${this.packageId}`;
  }

  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<{data: ArrayBuffer}> {
    signal?.throwIfAborted();
    const data = await readArchiveRange(this.packageId, offset, length);
    signal?.throwIfAborted();
    return {data};
  }
}

function ensureProtocol(maplibre: MapLibreLike, pmtiles: PmtilesModule): PmtilesProtocol {
  if (!registeredProtocol || registeredMapLibre !== maplibre) {
    registeredProtocol = new pmtiles.Protocol({metadata: true});
    registeredMapLibre = maplibre;
    maplibre.addProtocol('pmtiles', registeredProtocol.tile);
  }
  return registeredProtocol;
}

function buildOfflineStyle(
  sourceKey: string,
  tileType: number,
  metadata: unknown,
  attribution: string,
  tileTypes: PmtilesModule['TileType'],
): Record<string, unknown> {
  const sourceUrl = `pmtiles://${sourceKey}`;
  const background = {
    id: 'sagip-background',
    type: 'background',
    paint: {'background-color': '#eef2f5'},
  };
  if ([tileTypes.Png, tileTypes.Jpeg, tileTypes.Webp, tileTypes.Avif].includes(tileType)) {
    return {
      version: 8,
      sources: {
        basemap: {type: 'raster', url: sourceUrl, tileSize: 256, attribution},
      },
      layers: [
        background,
        {id: 'sagip-raster-basemap', type: 'raster', source: 'basemap'},
      ],
    };
  }
  if (tileType !== tileTypes.Mvt) throw new Error('UNSUPPORTED_MAP_TILE_TYPE');

  const layerIds = vectorLayerIds(metadata);
  if (layerIds.length === 0) throw new Error('MAP_VECTOR_LAYERS_MISSING');
  const layers: Array<Record<string, unknown>> = [background];
  for (const [index, sourceLayer] of layerIds.entries()) {
    const prefix = `sagip-base-${index}`;
    layers.push(
      {
        id: `${prefix}-fill`,
        type: 'fill',
        source: 'basemap',
        'source-layer': sourceLayer,
        filter: ['==', '$type', 'Polygon'],
        paint: {'fill-color': '#dfe7dc', 'fill-opacity': 0.48},
      },
      {
        id: `${prefix}-line`,
        type: 'line',
        source: 'basemap',
        'source-layer': sourceLayer,
        filter: ['==', '$type', 'LineString'],
        paint: {'line-color': '#8798a5', 'line-width': 1},
      },
      {
        id: `${prefix}-point`,
        type: 'circle',
        source: 'basemap',
        'source-layer': sourceLayer,
        filter: ['==', '$type', 'Point'],
        paint: {'circle-color': '#526776', 'circle-radius': 1.5},
      },
    );
  }
  return {
    version: 8,
    sources: {
      basemap: {type: 'vector', url: sourceUrl, attribution},
    },
    layers,
  };
}

function vectorLayerIds(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as {vector_layers?: unknown}).vector_layers;
  if (!Array.isArray(raw)) return [];
  const unique = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const id = (entry as {id?: unknown}).id;
    if (typeof id === 'string' && id.length > 0 && id.length <= 256) unique.add(id);
  }
  return [...unique].slice(0, 256);
}

async function loadMapLibre(): Promise<MapLibreLike> {
  const path = '/responder/assets/maplibre-gl-6.11.2/maplibre-gl.mjs';
  return await import(path) as unknown as MapLibreLike;
}

async function loadPmtiles(): Promise<PmtilesModule> {
  const existing = (globalThis as unknown as {pmtiles?: PmtilesModule}).pmtiles;
  if (existing?.PMTiles && existing.Protocol && existing.TileType) return existing;
  if (pmtilesLoadPromise) return await pmtilesLoadPromise;

  pmtilesLoadPromise = new Promise<PmtilesModule>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/responder/assets/pmtiles-4.5.0/pmtiles.js';
    script.async = true;
    script.addEventListener('load', () => {
      const loaded = (globalThis as unknown as {pmtiles?: PmtilesModule}).pmtiles;
      if (!loaded?.PMTiles || !loaded.Protocol || !loaded.TileType) {
        pmtilesLoadPromise = null;
        reject(new Error('PMTILES_RUNTIME_INVALID'));
        return;
      }
      resolve(loaded);
    }, {once: true});
    script.addEventListener('error', () => {
      pmtilesLoadPromise = null;
      reject(new Error('PMTILES_RUNTIME_UNAVAILABLE'));
    }, {once: true});
    document.head.append(script);
  });
  return await pmtilesLoadPromise;
}

function insideExtent(
  location: NonNullable<IncidentSnapshotEntry['location']>,
  extent: readonly [number, number, number, number],
): boolean {
  const [west, south, east, north] = extent;
  return location.longitude >= west && location.longitude <= east &&
    location.latitude >= south && location.latitude <= north;
}
