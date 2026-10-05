import {ActionOutbox} from './actionOutbox.js';
import {ConsoleStore} from './consoleStore.js';
import type {ActionDraft} from './actionCodec.js';
import type {ConsoleProvider, IncidentSnapshot, IncidentSnapshotEntry, ResponderStatusName} from './consoleTypes.js';
import {GatewayClient} from './gatewayClient.js';
import {IncidentMapView, type IncidentMapItem} from './incidentMap.js';
import {syncSnapshot} from './incidentSnapshot.js';
import {createWebAuthnUserVerifier, unlockOffline} from './offlineAccess.js';
import {inspectReadiness, preparePackage, type OfflineManifest, type ReadinessResult} from './offlinePackage.js';
import type {BrowserVerificationContext} from './receiptVerifier.js';

interface DashboardState {
  incidents: IncidentMapItem[];
  selectedReportId: string | null;
}
interface DashboardBridge {
  getState(): DashboardState;
  selectReport(reportId: string): void;
  useOfflineSnapshot(snapshot: IncidentSnapshot): void;
  showOperationalMessage(message: string): void;
}
interface OfflineBootstrap {
  provider?: ConsoleProvider;
  providerKind?: 1 | 2;
  providerId?: Uint8Array;
  responderId?: string;
  baseUrl?: string;
  authorizeNativeRequest?: (context: {method: string; path: string; body: Uint8Array}) => Promise<Record<string, string>>;
  verificationContext: BrowserVerificationContext;
  verifierId: Uint8Array;
  verifierBootSessionId: string;
  credentialIds: readonly Uint8Array[];
}
declare global {
  interface Window {
    SagipResponderBridge?: DashboardBridge;
    SAGIP_OFFLINE_BOOTSTRAP?: OfflineBootstrap;
    SagipOfflineConsole?: {
      queueStatus(reportId: string, status: ResponderStatusName, note: string): Promise<unknown>;
      safeLogout(): Promise<unknown>;
      discardAndLogout(reason: string): Promise<unknown>;
      refreshSnapshot(): Promise<unknown>;
      prepareMap(): Promise<unknown>;
    };
  }
}

const mapStatus = required('mapReadinessStatus');
const accessStatus = required('accessReadinessStatus');
const snapshotStatus = required('snapshotReadinessStatus');
const outboxStatus = required('outboxReadinessStatus');
const mapCanvas = required('incidentMapCanvas');
const mapPlaceholder = required('incidentMapPlaceholder');
const mapCoverage = required('mapCoverage');
const mapAnnouncement = required('mapAnnouncement');
const discardButton = requiredButton('offlineDiscardButton');
const prepareMapButton = requiredButton('prepareMapButton');
const mapLink = requiredButton('mapLink');
const exitMapFocusButton = requiredButton('exitMapFocusButton');
const mapPanel = required('incidentMapPanel');
const mapFocusStatus = required('mapFocusStatus');
const mapFocusTitle = required('mapFocusTitle');
const mapFocusLocation = required('mapFocusLocation');
const consolePanel = required('consolePanel');
const mapFocusInertTargets = Array.from(document.querySelectorAll<HTMLElement>(
  '.stats-grid, .offline-heading, .readiness-grid, .incident-column, .detail-panel',
));
const TAGUM_MANIFEST_PATH = '/responder/map/tagum/manifest.json';

let store: ConsoleStore | null = null;
let outbox: ActionOutbox | null = null;
let provider: ConsoleProvider | null = null;
let activeSnapshot: IncidentSnapshot | null = null;
let mapReadiness: ReadinessResult = {kind: 'INCOMPLETE', reason: 'NOT_CHECKED'};
const mapView = new IncidentMapView(
  mapCanvas,
  mapPlaceholder,
  mapCoverage,
  mapAnnouncement,
  reportId => window.SagipResponderBridge?.selectReport(reportId),
);

void initialize();

window.addEventListener('sagip:incidents', event => {
  const detail = (event as CustomEvent<DashboardState>).detail;
  void mapView.render(detail.incidents, detail.selectedReportId);
  mapView.select(detail.selectedReportId);
  if (consolePanel.classList.contains('map-focus-mode')) {
    const selected = detail.incidents.find(item => item.reportId === detail.selectedReportId);
    if (selected?.location) updateMapFocusStatus(selected);
    else exitMapFocus(false);
  }
});

prepareMapButton.addEventListener('click', () => {
  void prepareTagumMap();
});

mapLink.addEventListener('click', () => {
  void showSelectedIncidentOnMap();
});

exitMapFocusButton.addEventListener('click', () => exitMapFocus(true));

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && consolePanel.classList.contains('map-focus-mode')) {
    exitMapFocus(true);
  }
});

discardButton.addEventListener('click', async () => {
  if (!outbox || !store) return;
  const pending = await store.pendingIntentCount();
  if (pending === 0) return;
  const accepted = window.confirm(
    `Discard ${pending} pending offline responder update${pending === 1 ? '' : 's'} from this browser? This cannot be undone.`,
  );
  if (!accepted) return;
  const result = await outbox.safeLogout({
    kind: 'DISCARD',
    confirmed: true,
    reason: 'Responder explicitly confirmed browser discard',
  });
  if (result.kind === 'COMPLETE') {
    discardButton.hidden = true;
    setText(accessStatus, 'Locked');
    setText(snapshotStatus, 'Protected data cleared');
    setText(outboxStatus, 'No pending offline updates');
    window.SagipResponderBridge?.showOperationalMessage('Offline protected data cleared after explicit confirmation.');
  }
});

async function initialize(): Promise<void> {
  mapReadiness = await inspectReadiness().catch(() => ({kind: 'INCOMPLETE', reason: 'READINESS_UNAVAILABLE'}));
  if (mapReadiness.kind === 'READY') {
    setText(mapStatus, mapReadiness.persistentStorage ? 'Ready · storage persisted' : 'Ready · storage may be evicted');
    prepareMapButton.hidden = true;
    await mapView.setManifest(mapReadiness.manifest);
  } else {
    prepareMapButton.hidden = false;
    setText(mapStatus, 'Not prepared');
    await mapView.setManifest(null);
  }

  store = await ConsoleStore.open();
  setText(accessStatus, 'Locked');
  setText(snapshotStatus, 'No unlocked snapshot');
  setText(outboxStatus, 'No pending offline updates');

  const bootstrap = window.SAGIP_OFFLINE_BOOTSTRAP;
  if (!bootstrap) {
    setText(accessStatus, 'Locked · gateway access not provisioned');
    publishCurrentMapState();
    return;
  }

  provider = bootstrap.provider ?? buildProvider(bootstrap);
  const access = await unlockOffline({
    store,
    provider,
    verificationContext: bootstrap.verificationContext,
    verifierId: bootstrap.verifierId,
    verifierBootSessionId: bootstrap.verifierBootSessionId,
    verifyLocalUser: createWebAuthnUserVerifier(bootstrap.credentialIds),
  });
  if (access.kind !== 'UNLOCKED') {
    setText(accessStatus, `Locked · ${humanize(access.reason)}`);
    publishCurrentMapState();
    return;
  }

  setText(accessStatus, 'Unlocked with local user verification');
  outbox = new ActionOutbox(store, provider);
  activeSnapshot = await store.readSnapshot();
  if (activeSnapshot) {
    window.SagipResponderBridge?.useOfflineSnapshot(activeSnapshot);
    setText(snapshotStatus, `${activeSnapshot.entries.length} incidents saved offline`);
  }
  await updateOutboxReadiness();
  window.SagipOfflineConsole = {
    queueStatus,
    safeLogout: () => outbox!.safeLogout({kind: 'EXPORT_TO_GATEWAY'}),
    discardAndLogout: reason => outbox!.safeLogout({kind: 'DISCARD', confirmed: true, reason}),
    refreshSnapshot,
    prepareMap: prepareTagumMap,
  };

  if (navigator.onLine || provider.providerKind === 2) {
    await refreshSnapshot();
    await outbox.drain();
    await updateOutboxReadiness();
  }
  publishCurrentMapState();
}

async function prepareTagumMap(): Promise<unknown> {
  if (prepareMapButton.disabled) return {kind: 'IN_PROGRESS'};
  prepareMapButton.disabled = true;
  const previousText = prepareMapButton.textContent;
  prepareMapButton.textContent = 'Preparing Tagum map…';
  setText(mapStatus, 'Preparing · downloading and verifying map package');
  try {
    const response = await fetch(TAGUM_MANIFEST_PATH, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('MAP_MANIFEST_UNAVAILABLE');
    const manifest = await response.json() as OfflineManifest;
    const result = await preparePackage(manifest);
    if (result.kind === 'READY') {
      mapReadiness = await inspectReadiness();
      if (mapReadiness.kind !== 'READY') throw new Error('MAP_READINESS_FAILED');
      prepareMapButton.hidden = true;
      setText(
        mapStatus,
        mapReadiness.persistentStorage
          ? 'Ready · Tagum map stored persistently'
          : 'Ready · Tagum map stored; browser may evict it',
      );
      await mapView.setManifest(mapReadiness.manifest);
      publishCurrentMapState();
      window.SagipResponderBridge?.showOperationalMessage(
        'Tagum offline map prepared and verified. Keep this browser profile on the responder device for outage use.',
      );
      return result;
    }
    if (result.kind === 'INSUFFICIENT_STORAGE') {
      setText(mapStatus, `Not prepared · needs ${formatBytes(result.requiredBytes)} free`);
      window.SagipResponderBridge?.showOperationalMessage(
        `Tagum map was not changed. Free at least ${formatBytes(result.requiredBytes)} in this browser profile and try again.`,
      );
      return result;
    }
    setText(mapStatus, `Not prepared · ${humanize(result.reason)}`);
    window.SagipResponderBridge?.showOperationalMessage(
      'Tagum map preparation did not complete. Any previously prepared complete map remains active.',
    );
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'MAP_PREPARATION_FAILED';
    setText(mapStatus, `Not prepared · ${humanize(reason)}`);
    window.SagipResponderBridge?.showOperationalMessage(
      'Tagum map preparation failed. Connect to the SAGIP responder service and try again before the outage.',
    );
    return {kind: 'INCOMPLETE', reason};
  } finally {
    prepareMapButton.disabled = false;
    prepareMapButton.textContent = previousText;
  }
}

async function refreshSnapshot(): Promise<unknown> {
  if (!store || !provider) return {kind: 'LOCKED'};
  const result = await syncSnapshot(
    provider,
    store,
    mapReadiness.kind === 'READY' ? mapReadiness.packageId : null,
  );
  if (result.kind === 'COMPLETE') {
    activeSnapshot = await store.readSnapshot();
    if (activeSnapshot) window.SagipResponderBridge?.useOfflineSnapshot(activeSnapshot);
    setText(snapshotStatus, `${result.count} incidents saved offline`);
  } else {
    setText(snapshotStatus, activeSnapshot
      ? `${activeSnapshot.entries.length} incidents kept · refresh incomplete`
      : 'Snapshot unavailable');
  }
  return result;
}

async function queueStatus(
  reportId: string,
  status: ResponderStatusName,
  note: string,
): Promise<unknown> {
  if (!outbox || !provider || !activeSnapshot) return {kind: 'LOCKED'};
  const incident = activeSnapshot.entries.find(entry => entry.reportId === reportId);
  if (!incident) return {kind: 'REJECTED', reason: 'REPORT_NOT_IN_ACTIVE_SNAPSHOT'};
  const statusCode = statusToCode(status);
  const draft: ActionDraft = {
    providerKind: provider.providerKind,
    issuerProviderId: provider.providerId,
    reportId: incident.reportId,
    reportProtocolVersion: incident.reportProtocolVersion,
    revision: incident.revision,
    payloadDigest: incident.payloadDigest,
    originKeyId: incident.originKeyId,
    responderId: provider.responderId,
    observedIncidentVersion: incident.observedIncidentVersion,
    status: statusCode,
    note,
  };
  const queued = await outbox.queue(draft);
  if (queued.kind === 'SAVED_LOCAL') {
    const drain = await outbox.drain();
    await updateOutboxReadiness();
    return {queued, drain};
  }
  await updateOutboxReadiness();
  return queued;
}

async function updateOutboxReadiness(): Promise<void> {
  if (!store || !store.isUnlocked()) {
    setText(outboxStatus, 'Locked');
    discardButton.hidden = true;
    return;
  }
  const pending = await store.pendingIntentCount();
  setText(outboxStatus, pending === 0
    ? 'No pending offline updates'
    : `${pending} pending offline update${pending === 1 ? '' : 's'}`);
  discardButton.hidden = pending === 0;
}

function buildProvider(bootstrap: OfflineBootstrap): ConsoleProvider {
  if (
    bootstrap.providerKind === undefined ||
    bootstrap.providerId === undefined ||
    bootstrap.responderId === undefined
  ) {
    throw new Error('Offline provider bootstrap is incomplete');
  }
  return new GatewayClient({
    providerKind: bootstrap.providerKind,
    providerId: bootstrap.providerId,
    responderId: bootstrap.responderId,
    baseUrl: bootstrap.baseUrl,
    authorizeNativeRequest: bootstrap.authorizeNativeRequest,
  });
}

async function renderCurrentMapState(): Promise<DashboardState | null> {
  const state = window.SagipResponderBridge?.getState() ?? null;
  if (!state) return null;
  await mapView.render(state.incidents, state.selectedReportId);
  return state;
}

function publishCurrentMapState(): void {
  void renderCurrentMapState();
}

async function showSelectedIncidentOnMap(): Promise<void> {
  const state = window.SagipResponderBridge?.getState();
  const reportId = state?.selectedReportId ?? null;
  const incident = reportId
    ? state?.incidents.find(item => item.reportId === reportId) ?? null
    : null;

  if (!reportId || !incident) {
    window.SagipResponderBridge?.showOperationalMessage(
      'Select an incident before opening the map.',
    );
    return;
  }
  if (!incident.location) {
    window.SagipResponderBridge?.showOperationalMessage(
      'The selected incident does not have usable location evidence to show on the map.',
    );
    return;
  }

  const previousText = mapLink.textContent;
  mapLink.disabled = true;
  try {
    await mapView.waitUntilReady();
    if (!mapIsReady()) {
      mapLink.textContent = 'Preparing map…';
      await prepareTagumMap();
      await mapView.waitUntilReady();
      if (!mapIsReady()) {
        mapPanel.scrollIntoView({block: 'start', inline: 'nearest'});
        mapPanel.focus({preventScroll: true});
        return;
      }
    }

    mapLink.textContent = 'Opening map…';
    const currentState = await renderCurrentMapState();
    if (!currentState || currentState.selectedReportId !== reportId) return;

    const focusResult = mapView.focusReport(reportId);
    if (focusResult !== 'FOCUSED') {
      reportMapFocusFailure(focusResult);
      return;
    }

    enterMapFocus(incident);
    await nextAnimationFrame();
    mapView.refreshLayout();
    mapView.focusReport(reportId);
    mapPanel.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start',
      inline: 'nearest',
    });
    mapPanel.focus({preventScroll: true});
  } finally {
    mapLink.disabled = false;
    mapLink.textContent = previousText;
  }
}

function enterMapFocus(incident: IncidentMapItem): void {
  consolePanel.classList.add('map-focus-mode');
  for (const target of mapFocusInertTargets) target.inert = true;
  exitMapFocusButton.hidden = false;
  mapFocusStatus.hidden = false;
  updateMapFocusStatus(incident);
}

function exitMapFocus(restoreTriggerFocus: boolean): void {
  consolePanel.classList.remove('map-focus-mode');
  for (const target of mapFocusInertTargets) target.inert = false;
  exitMapFocusButton.hidden = true;
  mapFocusStatus.hidden = true;
  void nextAnimationFrame().then(() => mapView.refreshLayout());
  if (restoreTriggerFocus && !mapLink.hidden) mapLink.focus({preventScroll: true});
}

function updateMapFocusStatus(incident: IncidentMapItem): void {
  mapFocusTitle.textContent = `${formatEmergencyLabel(incident.emergencyType)} incident`;
  const location = incident.location;
  mapFocusLocation.textContent = location
    ? `${Number(location.latitude).toFixed(5)}, ${Number(location.longitude).toFixed(5)}`
    : 'Location unavailable';
}

function reportMapFocusFailure(
  result: ReturnType<IncidentMapView['focusReport']>,
): void {
  if (result === 'MAP_NOT_READY') {
    window.SagipResponderBridge?.showOperationalMessage(
      'The map is not ready. Retry streets or prepare the Tagum offline map package.',
    );
  } else if (result === 'LOCATION_NOT_MAPPED') {
    window.SagipResponderBridge?.showOperationalMessage(
      'The selected incident does not have usable location evidence to show on the map.',
    );
  } else if (result === 'OUTSIDE_EXTENT') {
    window.SagipResponderBridge?.showOperationalMessage(
      'The selected incident location is outside the prepared Tagum offline map coverage.',
    );
  }
}

function mapIsReady(): boolean {
  return mapView.isReady();
}

function formatEmergencyLabel(value: string): string {
  if (!value || value === 'UNSPECIFIED') return 'SOS · category not specified';
  const normalized = humanize(value).trim();
  return normalized.length === 0
    ? 'Emergency'
    : normalized[0]!.toUpperCase() + normalized.slice(1);
}

function nextAnimationFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function statusToCode(status: ResponderStatusName): 1 | 2 | 3 | 4 {
  return status === 'ACKNOWLEDGED' ? 1 : status === 'EN_ROUTE' ? 2 : status === 'ON_SCENE' ? 3 : 4;
}

function humanize(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function setText(element: HTMLElement, value: string): void {
  element.textContent = value;
}

function required(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing responder console element: ${id}`);
  return element;
}

function requiredButton(id: string): HTMLButtonElement {
  const element = required(id);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Expected button: ${id}`);
  return element;
}
