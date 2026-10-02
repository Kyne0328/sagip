import {ActionOutbox} from './actionOutbox.js';
import {ConsoleStore} from './consoleStore.js';
import type {ActionDraft} from './actionCodec.js';
import type {ConsoleProvider, IncidentSnapshot, IncidentSnapshotEntry, ResponderStatusName} from './consoleTypes.js';
import {GatewayClient} from './gatewayClient.js';
import {IncidentMapView, type IncidentMapItem} from './incidentMap.js';
import {syncSnapshot} from './incidentSnapshot.js';
import {createWebAuthnUserVerifier, unlockOffline} from './offlineAccess.js';
import {inspectReadiness, type ReadinessResult} from './offlinePackage.js';
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
    await mapView.setManifest(mapReadiness.manifest);
  } else {
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
  };

  if (navigator.onLine || provider.providerKind === 2) {
    await refreshSnapshot();
    await outbox.drain();
    await updateOutboxReadiness();
  }
  publishCurrentMapState();
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

function publishCurrentMapState(): void {
  const state = window.SagipResponderBridge?.getState();
  if (state) void mapView.render(state.incidents, state.selectedReportId);
}

function statusToCode(status: ResponderStatusName): 1 | 2 | 3 | 4 {
  return status === 'ACKNOWLEDGED' ? 1 : status === 'EN_ROUTE' ? 2 : status === 'ON_SCENE' ? 3 : 4;
}

function humanize(value: string): string {
  return value.toLowerCase().replaceAll('_', ' ');
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
