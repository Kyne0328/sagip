export const EMERGENCY_TYPES = [
  'MEDICAL',
  'FLOOD',
  'FIRE',
  'TRAPPED',
  'VIOLENCE',
  'OTHER',
] as const;

export type EmergencyType = (typeof EMERGENCY_TYPES)[number] | 'UNSPECIFIED';

export const URGENCIES = ['IMMEDIATE_DANGER', 'NEED_ASSISTANCE'] as const;
export type Urgency = (typeof URGENCIES)[number] | 'UNSPECIFIED';

export type LifecycleState = 'LOCALLY_COMMITTED' | 'RELAYED' | 'RESPONDER_ACKNOWLEDGED';

export const DELIVERY_STATES = [
  'DELIVERY_PENDING',
  'RELAYED_TO_PEER',
  'SERVER_ACCEPTED',
  'RESPONDER_ACKNOWLEDGED',
  'PERMANENT_FAILURE',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const BLE_RELAY_AVAILABILITIES = [
  'READY',
  'PERMISSION_REQUIRED',
  'BLUETOOTH_OFF',
  'NOT_SUPPORTED',
  'UNKNOWN',
] as const;

export type BleRelayAvailability = (typeof BLE_RELAY_AVAILABILITIES)[number];

export interface BleRelayStatus {
  availability: BleRelayAvailability;
  isSupported: boolean;
  permissionGranted: boolean;
  bluetoothEnabled: boolean;
  isScanning: boolean;
  isAdvertising: boolean;
  isDutyCyclePaused: boolean;
  peerCount: number;
  heldRelayCount: number;
  pendingForwardCount: number;
}

export interface ResponderAckInfo {
  ackId: string;
  responderId: string;
  callsign: string | null;
  status: string;
  note: string | null;
  acknowledgedAt: number;
}

export const VERIFIED_RECEIPT_KINDS = [
  'VERIFIED_CURRENT',
  'VERIFIED_OFFLINE_AUTHORITY',
] as const;
export type VerifiedReceiptKind = (typeof VERIFIED_RECEIPT_KINDS)[number];

export const VERIFIED_RESPONDER_STATUSES = [
  'ACKNOWLEDGED',
  'EN_ROUTE',
  'ON_SCENE',
  'RESOLVED',
] as const;
export type VerifiedResponderStatus =
  (typeof VERIFIED_RESPONDER_STATUSES)[number];

export const REQUESTER_DELIVERY_STATES = ['UNKNOWN', 'RECEIVED'] as const;
export type RequesterDeliveryState =
  (typeof REQUESTER_DELIVERY_STATES)[number];

export interface VerifiedReceiptInfo {
  eventId: string;
  revision: number;
  verificationKind: VerifiedReceiptKind;
  authorityCheckedAt: number | null;
  status: VerifiedResponderStatus;
  callsign: string;
  note: string;
  requesterDeliveryState: RequesterDeliveryState;
}

export interface LocationSnapshot {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  capturedAt: number;
  source: 'GPS' | 'NETWORK';
  freshness: 'FRESH' | 'STALE';
}

export interface CreateEmergencyReportInput {
  emergencyType?: EmergencyType;
  urgency?: Urgency;
}

export interface AppendEmergencyDetailsInput extends CreateEmergencyReportInput {
  expectedRevision: number;
  operationId: string;
}

export interface RevisionDelivery {
  revision: number;
  messageId: string;
  deliveryState: DeliveryState;
}

export interface EmergencyHistoryEvent {
  id: string;
  kind: 'LOCAL_COMMIT' | 'DETAILS_SAVED' | 'RELAYED_TO_PEER' | 'SERVER_ACCEPTED' | 'DELIVERY_FAILED' | 'RESPONDER_UPDATE';
  occurredAt: number;
  revision: number | null;
  status: string | null;
  provenance: 'LOCAL' | 'SERVER_AUTHENTICATED' | 'UNVERIFIED' | 'VERIFIED_CURRENT' | 'VERIFIED_OFFLINE_AUTHORITY';
  callsign: string | null;
  note: string | null;
}

export interface StatusSyncInfo {
  historyPending: boolean;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  state: 'NEVER' | 'SUCCESS' | 'FAILED';
}

/** Report-wide status authenticated by the native HTTPS client; not a portable signed receipt. */
export interface ServerStatusInfo {
  status: VerifiedResponderStatus;
  revision: null;
  statusScope: 'REPORT';
  updatedAt: number;
  callsign: string | null;
  note: string | null;
}

export interface EmergencyReportSummary {
  serverStatus?: ServerStatusInfo;
  history?: EmergencyHistoryEvent[];
  statusSync?: StatusSyncInfo;
  reportId: string;
  revision?: number;
  originalDelivery?: RevisionDelivery;
  latestDelivery?: RevisionDelivery;
  createdAt: number;
  emergencyType: EmergencyType;
  urgency: Urgency;
  lifecycleState: LifecycleState;
  deliveryState: DeliveryState;
  location: LocationSnapshot | null;
  responderAck?: ResponderAckInfo | null;
  verifiedReceipt?: VerifiedReceiptInfo;
}
