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

export type LifecycleState = 'LOCALLY_COMMITTED';

export const DELIVERY_STATES = [
  'DELIVERY_PENDING',
  'SERVER_ACCEPTED',
  'PERMANENT_FAILURE',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

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
}
