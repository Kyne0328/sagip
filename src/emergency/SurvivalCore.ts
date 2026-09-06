import {NativeModules} from 'react-native';

import {
  DELIVERY_STATES,
  EMERGENCY_TYPES,
  URGENCIES,
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
  } = value;

  if (
    typeof reportId !== 'string' ||
    reportId.length === 0 ||
    typeof createdAt !== 'number' ||
    !EMERGENCY_TYPES.includes(emergencyType as never) ||
    !URGENCIES.includes(urgency as never) ||
    lifecycleState !== 'LOCALLY_COMMITTED' ||
    !DELIVERY_STATES.includes(deliveryState as never)
  ) {
    throw new Error('Invalid emergency report response from native core');
  }

  return {
    reportId,
    createdAt,
    emergencyType: emergencyType as EmergencyReportSummary['emergencyType'],
    urgency: urgency as EmergencyReportSummary['urgency'],
    lifecycleState,
    deliveryState: deliveryState as EmergencyReportSummary['deliveryState'],
    location: parseLocation(location),
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
};
