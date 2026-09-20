import {NativeModules} from 'react-native';

import {
  DELIVERY_STATES,
  EMERGENCY_TYPES,
  URGENCIES,
  type BleRelayStatus,
  type CreateEmergencyReportInput,
  type EmergencyReportSummary,
  type LocationSnapshot,
} from './types';

interface NativeSurvivalCore {
  createEmergencyReport(
    input: CreateEmergencyReportInput,
  ): Promise<unknown>;
  listEmergencyReports(): Promise<unknown>;
  triggerDelivery(): Promise<unknown>;
  getRelayStatus(): Promise<unknown>;
  startBleRelay(): Promise<unknown>;
  stopBleRelay(): Promise<unknown>;
}

const nativeCore = NativeModules.SagipSurvivalCore as NativeSurvivalCore | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLocation(value: unknown): LocationSnapshot | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error('Invalid emergency report response from native core');
  }

  const {latitude, longitude, accuracyMeters, capturedAt, source, freshness} =
    value;
  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    (accuracyMeters !== null && typeof accuracyMeters !== 'number') ||
    typeof capturedAt !== 'number' ||
    (source !== 'GPS' && source !== 'NETWORK') ||
    (freshness !== 'FRESH' && freshness !== 'STALE')
  ) {
    throw new Error('Invalid emergency report response from native core');
  }

  return {
    latitude,
    longitude,
    accuracyMeters,
    capturedAt,
    source,
    freshness,
  };
}

const VALID_LIFECYCLES = ['LOCALLY_COMMITTED', 'RELAYED', 'RESPONDER_ACKNOWLEDGED'];

function parseResponderAck(value: unknown): EmergencyReportSummary['responderAck'] {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const {ackId, responderId, callsign, status, note, acknowledgedAt} = value;
  if (
    typeof ackId !== 'string' ||
    typeof responderId !== 'string' ||
    typeof status !== 'string' ||
    typeof acknowledgedAt !== 'number'
  ) {
    return null;
  }
  return {
    ackId,
    responderId,
    callsign: typeof callsign === 'string' ? callsign : null,
    status,
    note: typeof note === 'string' ? note : null,
    acknowledgedAt,
  };
}

function parseSummary(value: unknown): EmergencyReportSummary {
  if (!isRecord(value)) {
    throw new Error('Invalid emergency report response from native core');
  }

  const {
    reportId,
    createdAt,
    emergencyType,
    urgency,
    lifecycleState,
    deliveryState,
    location,
    responderAck,
  } = value;

  if (
    typeof reportId !== 'string' ||
    reportId.length === 0 ||
    typeof createdAt !== 'number' ||
    !EMERGENCY_TYPES.includes(emergencyType as never) ||
    !URGENCIES.includes(urgency as never) ||
    !VALID_LIFECYCLES.includes(lifecycleState as string) ||
    !DELIVERY_STATES.includes(deliveryState as never)
  ) {
    throw new Error('Invalid emergency report response from native core');
  }

  const ack = parseResponderAck(responderAck);
  return {
    reportId,
    createdAt,
    emergencyType: emergencyType as EmergencyReportSummary['emergencyType'],
    urgency: urgency as EmergencyReportSummary['urgency'],
    lifecycleState: lifecycleState as EmergencyReportSummary['lifecycleState'],
    deliveryState: deliveryState as EmergencyReportSummary['deliveryState'],
    location: parseLocation(location),
    ...(ack ? {responderAck: ack} : {}),
  };
}

function parseRelayStatus(value: unknown): BleRelayStatus {
  if (!isRecord(value)) {
    return {isScanning: false, isAdvertising: false, peerCount: 0};
  }
  return {
    isScanning: typeof value.isScanning === 'boolean' ? value.isScanning : false,
    isAdvertising:
      typeof value.isAdvertising === 'boolean' ? value.isAdvertising : false,
    peerCount: typeof value.peerCount === 'number' ? value.peerCount : 0,
  };
}

function requireNativeCore(): NativeSurvivalCore {
  if (!nativeCore) {
    throw new Error('Sagip Survival Core native module is unavailable');
  }
  return nativeCore;
}

export const SurvivalCore = {
  async createEmergencyReport(
    input: CreateEmergencyReportInput,
  ): Promise<EmergencyReportSummary> {
    return parseSummary(await requireNativeCore().createEmergencyReport(input));
  },

  async listEmergencyReports(): Promise<EmergencyReportSummary[]> {
    const value = await requireNativeCore().listEmergencyReports();
    if (!Array.isArray(value)) {
      throw new Error('Invalid emergency report response from native core');
    }
    return value.map(parseSummary);
  },

  async triggerDelivery(): Promise<number> {
    const value = await requireNativeCore().triggerDelivery();
    if (typeof value !== 'number') {
      return 0;
    }
    return value;
  },

  async getRelayStatus(): Promise<BleRelayStatus> {
    return parseRelayStatus(await requireNativeCore().getRelayStatus());
  },

  async startBleRelay(): Promise<boolean> {
    const value = await requireNativeCore().startBleRelay();
    return typeof value === 'boolean' ? value : false;
  },

  async stopBleRelay(): Promise<boolean> {
    const value = await requireNativeCore().stopBleRelay();
    return typeof value === 'boolean' ? value : false;
  },
};
