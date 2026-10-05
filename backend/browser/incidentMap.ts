import type {IncidentSnapshotEntry} from './consoleTypes.js';
import {readArchiveRange, type OfflineManifest} from './offlinePackage.js';

interface MapLike {
  fitBounds(bounds: [[number, number], [number, number]], options: {padding: number; duration: number}): void;
  resize(): void;
  getBounds(): {getWest(): number; getSouth(): number; getEast(): number; getNorth(): number};
  setStyle(style: string | Record<string, unknown>, options: {diff: boolean}): void;
  on(event: 'idle' | 'error', listener: () => void): void;
  panTo(center: [number, number], options: {duration: number}): void;
  addControl(control: unknown, position: string): void;
  remove(): void;
}
interface MarkerLike {
  setLngLat(value: [number, number]): MarkerLike;
  addTo(map: MapLike): MarkerLike;
  remove(): void;
}
interface MapLibreLike {
  Map: new (options: Record<string, unknown>) => MapLike;
  NavigationControl: new (options: {showCompass: boolean}) => unknown;
  ScaleControl: new (options: {maxWidth: number; unit: string}) => unknown;
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
  status?: 'PENDING' | 'ACKNOWLEDGED' | 'EN_ROUTE' | 'ON_SCENE' | 'RESOLVED';
  resolutionPending?: boolean;
  location: IncidentSnapshotEntry['location'];
}

let registeredProtocol: PmtilesProtocol | null = null;
let registeredMapLibre: MapLibreLike | null = null;
let pmtilesLoadPromise: Promise<PmtilesModule> | null = null;

const ONLINE_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const TAGUM_EXTENT: [number, number, number, number] = [125.6886, 7.2015, 125.9326, 7.5555];
type BasemapMode = 'loading' | 'online' | 'offline' | 'unavailable';

export class IncidentMapView {
  private map: MapLike | null = null;
  private maplibre: MapLibreLike | null = null;
  private readonly markers = new Map<string, {marker: MarkerLike; element: HTMLButtonElement}>();
  private readonly locationsByReportId = new Map<string, {latitude: number; longitude: number}>();
  private readonly lifecycle = new AbortController();
  private manifest: OfflineManifest | null = null;
  private items: readonly IncidentMapItem[] = [];
  private selectedReportId: string | null = null;
  private mode: BasemapMode = 'unavailable';
  private requestedSource: 'online' | 'offline' = 'online';
  private preferredSource: 'online' | 'offline' = 'online';
  private generation = 0;
  private installedGeneration = -1;
  private destroyed = false;
  private readonly readyWaiters = new Set<(ready: boolean) => void>();
  private needsInitialFit = false;
  private hasFittedIncidentBounds = false;
  private sourceTimeout: ReturnType<typeof setTimeout> | null = null;
  private sourcePreparationSettler: (() => void) | null = null;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly sourceStatus: HTMLElement | null;
  private readonly onlineButton: HTMLButtonElement | null;
  private readonly offlineButton: HTMLButtonElement | null;

  constructor(
    private readonly container: HTMLElement,
    private readonly placeholder: HTMLElement,
    private readonly coverage: HTMLElement,
    private readonly announce: HTMLElement,
    private readonly onSelect: (reportId: string) => void,
  ) {
    const stage = container.parentElement;
    this.sourceStatus = stage?.querySelector('[data-map-source-status]') ?? null;
    this.onlineButton = stage?.querySelector('[data-map-source="online"]') ?? null;
    this.offlineButton = stage?.querySelector('[data-map-source="offline"]') ?? null;
    this.onlineButton?.addEventListener('click', () => { void this.setBasemap('online'); }, {signal: this.lifecycle.signal});
    this.offlineButton?.addEventListener('click', () => { void this.setBasemap('offline'); }, {signal: this.lifecycle.signal});
    window.addEventListener('offline', () => {
      if (this.requestedSource === 'online') void this.switchSource('offline', 'Connection lost. ');
    }, {signal: this.lifecycle.signal});
    window.addEventListener('online', () => {
      if (this.preferredSource === 'online') void this.switchSource('online');
    }, {signal: this.lifecycle.signal});
    this.resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => this.refreshMapLayout())
      : null;
    this.resizeObserver?.observe(this.container);
  }

  async setManifest(manifest: OfflineManifest | null): Promise<void> {
    if (this.destroyed) return;
    const changed = this.manifest?.packageId !== manifest?.packageId;
    this.manifest = manifest ? structuredClone(manifest) : null;
    this.coverage.textContent = manifest
      ? `Prepared package ${manifest.version} · zoom ${manifest.minZoom}–${manifest.maxZoom} · ${manifest.attribution}`
      : 'No prepared local map package';
    if (this.offlineButton) this.offlineButton.disabled = !manifest;
    if (!this.map || (changed && this.requestedSource === 'offline')) {
      await this.switchSource(this.requestedSource === 'offline' || this.preferredSource === 'offline' || !navigator.onLine ? 'offline' : 'online');
    }
  }

  async prepareOfflineRuntime(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([loadMapLibre(), loadPmtiles()]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('OFFLINE_RUNTIME_TIMEOUT')), 12000);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  async setBasemap(source: 'online' | 'offline'): Promise<void> {
    this.preferredSource = source;
    await this.switchSource(source);
  }

  isReady(): boolean {
    return !!this.map && (this.mode === 'online' || this.mode === 'offline');
  }

  async waitUntilReady(): Promise<boolean> {
    if (this.mode !== 'loading') return this.isReady();
    return new Promise(resolve => {
      const finish = (ready: boolean): void => {
        clearTimeout(timer);
        this.readyWaiters.delete(finish);
        resolve(ready);
      };
      const timer = setTimeout(() => finish(this.isReady()), 25000);
      this.readyWaiters.add(finish);
    });
  }

  async render(items: readonly IncidentMapItem[], selectedReportId: string | null): Promise<void> {
    if (this.destroyed) return;
    this.items = items.filter(item => item.status !== 'RESOLVED');
    this.locationsByReportId.clear();
    for (const item of this.items) {
      if (validLocation(item.location)) this.locationsByReportId.set(item.reportId, item.location!);
    }
    this.select(selectedReportId);
    this.updateMarkers();
  }

  select(reportId: string | null): void {
    if (reportId !== this.selectedReportId) {
      const location = reportId ? this.locationsByReportId.get(reportId) : null;
      if (location && this.map && this.canFocus(location)) {
        this.map.panTo([location.longitude, location.latitude], {duration: 0});
      }
      this.selectedReportId = reportId;
    }
    for (const [id, {element}] of this.markers) {
      const selected = id === reportId;
      element.dataset.selected = String(selected);
      element.setAttribute('aria-pressed', String(selected));
    }
  }

  focusReport(reportId: string): 'FOCUSED' | 'MAP_NOT_READY' | 'LOCATION_NOT_MAPPED' | 'OUTSIDE_EXTENT' {
    if (!this.isReady() || !this.map) {
      this.announce.textContent = 'Map is not ready. The incident queue and coordinates remain available.';
      return 'MAP_NOT_READY';
    }
    const location = this.locationsByReportId.get(reportId);
    if (!location) {
      this.announce.textContent = 'The selected incident does not have mapped location evidence.';
      return 'LOCATION_NOT_MAPPED';
    }
    if (!this.canFocus(location)) {
      this.announce.textContent = 'The selected incident is outside the prepared Tagum map extent.';
      return 'OUTSIDE_EXTENT';
    }
    this.select(reportId);
    this.map.resize();
    this.map.fitBounds([
      [location.longitude - 0.003, location.latitude - 0.003],
      [location.longitude + 0.003, location.latitude + 0.003],
    ], {padding: this.focusPadding(), duration: 0});
    this.hasFittedIncidentBounds = true;
    this.announce.textContent = 'Map centered on the selected incident location.';
    return 'FOCUSED';
  }

  refreshLayout(): void { this.refreshMapLayout(); }

  destroy(): void {
    this.destroyed = true;
    this.generation += 1;
    this.clearSourceTimeout();
    this.lifecycle.abort();
    for (const finish of this.readyWaiters) finish(false);
    this.resizeObserver?.disconnect();
    for (const {marker} of this.markers.values()) marker.remove();
    this.markers.clear();
    this.map?.remove();
    this.map = null;
    this.locationsByReportId.clear();
  }

  private async switchSource(source: 'online' | 'offline', reason = ''): Promise<void> {
    if (this.destroyed) return;
    const generation = ++this.generation;
    this.installedGeneration = -1;
    this.clearSourceTimeout();
    this.requestedSource = source;
    this.setMode('loading', source === 'online' ? 'Loading OpenFreeMap streets…' : 'Opening prepared Tagum map…');
    // Cancellation also settles callers; a hung optional map must not block console setup.
    const deadline = new Promise<void>(resolve => { this.sourcePreparationSettler = resolve; });
    // Cover runtime loading and archive reads as well as style/tile loading.
    this.sourceTimeout = setTimeout(() => {
      if (!this.isCurrent(generation) || this.mode !== 'loading') return;
      if (source === 'online') void this.switchSource('offline', 'Street map timed out. ');
      else {
        this.generation += 1;
        this.installedGeneration = -1;
        this.setMode('unavailable', 'Prepared map timed out. Use the incident queue and coordinates.');
      }
    }, 12000);
    const prepare = async (): Promise<void> => {
      try {
        const maplibre = await loadMapLibre();
        if (!this.isCurrent(generation)) return;
        this.maplibre = maplibre;
        let style: string | Record<string, unknown> = ONLINE_STYLE;
        if (source === 'offline') {
          const manifest = this.manifest;
          if (!manifest) {
            this.map?.setStyle(emptyStyle(), {diff: false});
            this.setMode('unavailable', reason + 'No offline map prepared. Use incident coordinates or retry streets.');
            return;
          }
          const pmtiles = await loadPmtiles();
          if (!this.isCurrent(generation)) return;
          const archiveSource = new IndexedDbPmtilesSource(manifest.packageId);
          const archive = new pmtiles.PMTiles(archiveSource);
          ensureProtocol(maplibre, pmtiles).add(archive);
          const [header, metadata] = await Promise.all([archive.getHeader(), archive.getMetadata()]);
          if (!this.isCurrent(generation)) return;
          if (header.minZoom > manifest.maxZoom || header.maxZoom < manifest.minZoom) throw new Error('MAP_ZOOM_MISMATCH');
          style = buildOfflineStyle(archiveSource.getKey(), header.tileType, metadata, manifest.attribution, pmtiles.TileType);
        }
        if (!this.isCurrent(generation)) return;
        if (!this.map) {
          this.map = new maplibre.Map({
            container: this.container,
            style: emptyStyle(),
            center: [125.8078, 7.4477],
            zoom: 12,
            attributionControl: false,
            interactive: true,
            fadeDuration: 0,
            // Only basemap assets leave the browser. Never attach incident payloads,
            // auth headers or session identifiers to provider resource requests.
            transformRequest: (url: string) => ({url, credentials: 'omit', referrerPolicy: 'no-referrer'}),
          });
          this.map.addControl(new maplibre.NavigationControl({showCompass: true}), 'bottom-right');
          this.map.addControl(new maplibre.ScaleControl({maxWidth: 120, unit: 'metric'}), 'bottom-left');
          this.map.on('idle', () => {
            if (this.destroyed || this.installedGeneration !== this.generation || this.mode !== 'loading') return;
            this.clearSourceTimeout();
            this.setMode(this.requestedSource, this.requestedSource === 'online'
              ? 'OpenFreeMap · street map online'
              : 'Prepared Tagum map · offline coverage');
          });
          this.map.on('error', () => {
            if (this.destroyed || this.installedGeneration !== this.generation || this.mode === 'unavailable') return;
            if (this.requestedSource === 'online') {
              void this.switchSource('offline', 'Street map unavailable. ');
            } else {
              this.clearSourceTimeout();
              this.setMode('unavailable', 'Prepared map could not render. Use the incident queue and coordinates.');
            }
          });
          this.needsInitialFit = true;
        }
        this.map.setStyle(style, {diff: false});
        this.installedGeneration = generation;
        if (source === 'offline' && this.manifest && !this.needsInitialFit) {
          const bounds = this.map.getBounds();
          const [west, south, east, north] = this.manifest.extent;
          if (bounds.getEast() < west || bounds.getWest() > east || bounds.getNorth() < south || bounds.getSouth() > north) {
            this.map.fitBounds([[west, south], [east, north]], {padding: 24, duration: 0});
          }
        }
        this.refreshMapLayout();
        this.updateMarkers();
        // No unbounded automatic retries. The responder can retry streets explicitly.
        // Preserve fallback reason while waiting; idle confirms rendered readiness.
        if (reason) this.setStatus(reason + 'Opening prepared Tagum map…');
      } catch {
        if (!this.isCurrent(generation)) return;
        if (source === 'online') await this.switchSource('offline', 'Street map unavailable. ');
        else this.setMode('unavailable', 'Prepared map could not render. Use the incident queue and coordinates.');
      }
    };
    await Promise.race([prepare(), deadline]);
  }

  private isCurrent(generation: number): boolean { return !this.destroyed && generation === this.generation; }

  private clearSourceTimeout(): void {
    if (this.sourceTimeout !== null) clearTimeout(this.sourceTimeout);
    this.sourceTimeout = null;
    this.sourcePreparationSettler?.();
    this.sourcePreparationSettler = null;
  }

  private setStatus(message: string): void {
    if (this.sourceStatus) this.sourceStatus.textContent = message;
    this.container.dataset.mapSource = this.mode;
  }

  private setMode(mode: BasemapMode, message: string): void {
    this.mode = mode;
    if (mode !== 'loading') this.clearSourceTimeout();
    this.setStatus(message);
    if (mode !== 'loading') for (const finish of this.readyWaiters) finish(this.isReady());
    this.onlineButton?.setAttribute('aria-pressed', String(mode === 'online'));
    this.offlineButton?.setAttribute('aria-pressed', String(mode === 'offline'));
    if (this.onlineButton) this.onlineButton.textContent = mode === 'offline' || mode === 'unavailable' ? 'Retry streets' : 'Streets';
    this.placeholder.hidden = mode !== 'unavailable';
    if (mode === 'unavailable') this.placeholder.textContent = message;
    this.updateMarkers();
  }

  private canFocus(location: {latitude: number; longitude: number}): boolean {
    return this.requestedSource === 'online' || !!this.manifest && insideExtent(location, this.manifest.extent);
  }

  private focusPadding(): number { return Math.max(32, Math.min(96, this.container.clientWidth / 5)); }

  private updateMarkers(): void {
    if (!this.map || !this.maplibre) return;
    const valid = this.items.filter(item => validLocation(item.location));
    const ids = new Set(valid.map(item => item.reportId));
    for (const [id, entry] of this.markers) {
      if (!ids.has(id)) { entry.marker.remove(); this.markers.delete(id); }
    }
    for (const item of valid) {
      let entry = this.markers.get(item.reportId);
      if (!entry) {
        const element = document.createElement('button');
        element.type = 'button';
        element.className = 'map-marker';
        element.dataset.reportId = item.reportId;
        element.addEventListener('click', () => this.onSelect(item.reportId));
        const marker = new this.maplibre.Marker({element, anchor: 'center'})
          .setLngLat([item.location!.longitude, item.location!.latitude]).addTo(this.map);
        entry = {marker, element};
        this.markers.set(item.reportId, entry);
      }
      const {marker, element} = entry;
      marker.setLngLat([item.location!.longitude, item.location!.latitude]);
      const category = item.emergencyType === 'UNSPECIFIED' ? 'SOS · category not specified' : item.emergencyType.toLowerCase().replaceAll('_', ' ');
      const urgency = item.urgency === 'IMMEDIATE_DANGER' ? 'immediate danger' : item.urgency === 'UNSPECIFIED' ? 'urgency not specified' : 'reported incident';
      const status = item.status ?? 'PENDING';
      const label = status.toLowerCase().replaceAll('_', ' ');
      const pending = item.resolutionPending ? ' · resolution pending server confirmation' : '';
      element.setAttribute('aria-label', `${category} incident location · ${label} · ${urgency} · report ${item.reportId}${pending}`);
      element.title = `${label}${pending}`;
      element.dataset.status = status;
      element.dataset.resolutionPending = String(!!item.resolutionPending);
      element.dataset.urgency = item.urgency;
      element.dataset.selected = String(item.reportId === this.selectedReportId);
      element.setAttribute('aria-pressed', String(item.reportId === this.selectedReportId));
      element.textContent = status === 'ACKNOWLEDGED' ? '✓' : status === 'EN_ROUTE' ? '→' : status === 'ON_SCENE' ? '◆' : '!';
    }
    const mappable = valid.filter(item => this.canFocus(item.location!));
    if (!this.hasFittedIncidentBounds && mappable.length > 0 && this.container.clientWidth > 0) {
      const longitudes = mappable.map(item => item.location!.longitude);
      const latitudes = mappable.map(item => item.location!.latitude);
      let west = Math.min(...longitudes), east = Math.max(...longitudes);
      let south = Math.min(...latitudes), north = Math.max(...latitudes);
      if (west === east) { west -= 0.006; east += 0.006; }
      if (south === north) { south -= 0.006; north += 0.006; }
      this.map.fitBounds([[west, south], [east, north]], {padding: this.focusPadding(), duration: 0});
      this.needsInitialFit = false;
      this.hasFittedIncidentBounds = true;
    }
    const outside = this.manifest ? valid.filter(item => !insideExtent(item.location!, this.manifest!.extent)).length : 0;
    this.announce.textContent = `${this.items.length} incidents loaded; ${valid.length} mapped; ${this.items.length - valid.length} without usable location.` +
      (this.manifest ? ` ${outside} outside the prepared map extent.` : ' Offline map package is not prepared.');
  }

  private refreshMapLayout(): void {
    if (!this.map || this.container.clientWidth <= 0 || this.container.clientHeight <= 0) return;
    this.map.resize();
    if (this.needsInitialFit) {
      const [west, south, east, north] = this.manifest?.extent ?? TAGUM_EXTENT;
      this.map.fitBounds([[west, south], [east, north]], {padding: 24, duration: 0});
      this.needsInitialFit = false;
    }
    this.updateMarkers();
  }
}

function emptyStyle(): Record<string, unknown> {
  return {version: 8, sources: {}, layers: [{id: 'background', type: 'background', paint: {'background-color': '#e8eee9'}}]};
}

function validLocation(location: IncidentMapItem['location']): boolean {
  return !!location && Number.isFinite(location.latitude) && Number.isFinite(location.longitude) &&
    Math.abs(location.latitude) <= 90 && Math.abs(location.longitude) <= 180;
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
    paint: {'background-color': '#e9f0f3'},
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
  const has = (id: string): boolean => layerIds.includes(id);
  const addFill = (id: string, color: string, opacity = 1, outline = color): void => {
    if (!has(id)) return;
    layers.push({
      id: `sagip-${id}-fill`,
      type: 'fill',
      source: 'basemap',
      'source-layer': id,
      paint: {
        'fill-color': color,
        'fill-opacity': opacity,
        'fill-outline-color': outline,
      },
    });
  };
  const addLine = (id: string, color: string, width: number): void => {
    if (!has(id)) return;
    layers.push({
      id: `sagip-${id}-line`,
      type: 'line',
      source: 'basemap',
      'source-layer': id,
      paint: {
        'line-color': color,
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          8, Math.max(0.5, width * 0.45),
          12, width,
          15, width * 2.2,
        ],
        'line-opacity': 0.92,
      },
    });
  };

  addFill('earth', '#e8ede4');
  addFill('landcover', '#dfe9d8', 0.72);
  addFill('landuse', '#e2eadc', 0.6);
  addFill('water', '#9fc8dc', 0.96, '#8db9cf');
  addFill('buildings', '#d7cec3', 0.95, '#c4b8ab');
  addLine('boundaries', '#96a5ad', 0.8);
  addLine('transit', '#9aa8b0', 0.9);

  if (has('roads')) {
    layers.push(
      {
        id: 'sagip-roads-casing',
        type: 'line',
        source: 'basemap',
        'source-layer': 'roads',
        paint: {
          'line-color': '#9ba9b0',
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8, 1.2,
            12, 3.6,
            15, 7.5,
          ],
          'line-opacity': 0.75,
        },
      },
      {
        id: 'sagip-roads-surface',
        type: 'line',
        source: 'basemap',
        'source-layer': 'roads',
        paint: {
          'line-color': '#fffdf8',
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            8, 0.7,
            12, 2.4,
            15, 5.4,
          ],
          'line-opacity': 0.98,
        },
      },
    );
  }

  if (has('places')) {
    layers.push({
      id: 'sagip-places',
      type: 'circle',
      source: 'basemap',
      'source-layer': 'places',
      paint: {
        'circle-color': '#375d74',
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 15, 3.5],
        'circle-opacity': 0.8,
      },
    });
  }

  for (const [index, sourceLayer] of layerIds.entries()) {
    if (['earth', 'landcover', 'landuse', 'water', 'buildings', 'boundaries', 'transit', 'roads', 'places'].includes(sourceLayer)) {
      continue;
    }
    layers.push(
      {
        id: `sagip-fallback-${index}-fill`,
        type: 'fill',
        source: 'basemap',
        'source-layer': sourceLayer,
        filter: ['==', '$type', 'Polygon'],
        paint: {'fill-color': '#dde5e0', 'fill-opacity': 0.32},
      },
      {
        id: `sagip-fallback-${index}-line`,
        type: 'line',
        source: 'basemap',
        'source-layer': sourceLayer,
        filter: ['==', '$type', 'LineString'],
        paint: {'line-color': '#889ba6', 'line-width': 0.8, 'line-opacity': 0.7},
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
  location: {latitude: number; longitude: number},
  extent: readonly [number, number, number, number],
): boolean {
  const [west, south, east, north] = extent;
  return location.longitude >= west && location.longitude <= east &&
    location.latitude >= south && location.latitude <= north;
}
