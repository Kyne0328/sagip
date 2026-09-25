export const EMERGENCY_TYPES = [
  'MEDICAL',
  'FLOOD',
  'FIRE',
  'TRAPPED',
  'VIOLENCE',
  'OTHER',
] as const;

export type EmergencyType = (typeof EMERGENCY_TYPES)[number];

export const URGENCIES = ['IMMEDIATE_DANGER', 'NEED_ASSISTANCE'] as const;
export type Urgency = (typeof URGENCIES)[number];

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
}

export interface ResponderAckInfo {
  ackId: string;
  responderId: string;
  callsign: string | null;
  status: string;
  note: string | null;
  acknowledgedAt: number;
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
  emergencyType: EmergencyType;
  urgency: Urgency;
}

export interface EmergencyReportSummary {
  reportId: string;
  createdAt: number;
  emergencyType: EmergencyType;
  urgency: Urgency;
  lifecycleState: LifecycleState;
  deliveryState: DeliveryState;
  location: LocationSnapshot | null;
  responderAck?: ResponderAckInfo | null;
}
