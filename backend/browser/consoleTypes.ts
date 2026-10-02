export type ResponderStatusCode = 1 | 2 | 3 | 4;
export type ResponderStatusName = 'ACKNOWLEDGED' | 'EN_ROUTE' | 'ON_SCENE' | 'RESOLVED';

export const RESPONDER_STATUS_NAMES: Readonly<Record<ResponderStatusCode, ResponderStatusName>> = {
  1: 'ACKNOWLEDGED',
  2: 'EN_ROUTE',
  3: 'ON_SCENE',
  4: 'RESOLVED',
};

export interface IncidentLocation {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  capturedAtMs: number | null;
  source: string | null;
  freshness: string | null;
}

export interface ReceiptEvidence {
  eventId: string;
  eventDigest: string;
  bytes: Uint8Array;
  kind: 'SGA2' | 'SGR2';
  revision: number;
  verification: string;
  issuerProviderId: string | null;
}

export interface PendingActionSummary {
  actionId: string;
  observedIncidentVersion: string;
  status: ResponderStatusName;
  note: string;
}

export interface IncidentSnapshotEntry {
  reportId: string;
  reportProtocolVersion: 1 | 2;
  revision: number;
  payloadDigest: Uint8Array;
  originKeyId: Uint8Array;
  observedIncidentVersion: string;
  emergencyType: string;
  urgency: string;
  location: IncidentLocation | null;
  reportCreatedAtMs: number;
  receivedAtMs: number;
  syncedAtMs: number | null;
  receiptEvidence: ReceiptEvidence[];
  pendingActions: PendingActionSummary[];
  latestAck?: {
    ackId: string;
    callsign: string;
    status: ResponderStatusName;
    note: string | null;
    acknowledgedAt: string;
  } | null;
  revisions?: unknown[];
  acknowledgements?: unknown[];
}

export interface IncidentSnapshotSummary {
  total: number;
  pending?: number;
  acknowledged?: number;
  enRoute?: number;
  onScene?: number;
  resolved?: number;
  immediateDanger?: number;
  missingLocation?: number;
}

export interface SnapshotDescriptor {
  snapshotId: string;
  createdAtMs: number;
  expiresAtMs: number;
  total: number;
  summary: IncidentSnapshotSummary;
  nextCursor: string | null;
}

export interface IncidentSnapshotPage extends SnapshotDescriptor {
  entries: IncidentSnapshotEntry[];
}

export interface IncidentSnapshot extends SnapshotDescriptor {
  packageId: string | null;
  loadedCount: number;
  entries: IncidentSnapshotEntry[];
}

export interface ActionIntent {
  actionId: string;
  providerKind: 1 | 2;
  issuerProviderId: Uint8Array;
  reportId: string;
  reportProtocolVersion: 1 | 2;
  revision: number;
  payloadDigest: Uint8Array;
  originKeyId: Uint8Array;
  responderId: string;
  observedIncidentVersion: string;
  status: ResponderStatusCode;
  note: string;
  actionDigest: Uint8Array;
}

export type ActionCommitState =
  | 'SAVED_LOCAL'
  | 'PREPARING'
  | 'SIGNED'
  | 'CONFLICT'
  | 'REJECTED';

export interface ActionCommitResult {
  actionId: string;
  issuerProviderId: Uint8Array;
  actionDigest: Uint8Array;
  state: ActionCommitState;
  eventDigest: string | null;
  reason: string | null;
}

export interface TimeChallengeRequest {
  challengeId: string;
  verifierId: Uint8Array;
  verifierBootSessionId: string;
  nonce: Uint8Array;
  sentElapsedMs: number;
}

export interface ConsoleProvider {
  readonly providerKind: 1 | 2;
  readonly providerId: Uint8Array;
  readonly responderId: string;
  createSnapshot(): Promise<SnapshotDescriptor>;
  readSnapshotPage(snapshotId: string, cursor: string): Promise<IncidentSnapshotPage>;
  commitAction(intent: ActionIntent): Promise<ActionCommitResult>;
  getAction(actionId: string): Promise<ActionCommitResult | null>;
  getActionReceipt(actionId: string): Promise<Uint8Array | null>;
  fetchTimeProof(challenge: TimeChallengeRequest): Promise<Uint8Array>;
  logout?(): Promise<Response>;
}
