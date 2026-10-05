import {NativeModules} from 'react-native';

import {
  BLE_RELAY_AVAILABILITIES,
  DELIVERY_STATES,
  EMERGENCY_TYPES,
  REQUESTER_DELIVERY_STATES,
  URGENCIES,
  VERIFIED_RECEIPT_KINDS,
  VERIFIED_RESPONDER_STATUSES,
  type AppendEmergencyDetailsInput,
  type BleRelayStatus,
  type CreateEmergencyReportInput,
  type EmergencyReportSummary,
  type EmergencyHistoryEvent,
  type StatusSyncInfo,
  type ServerStatusInfo,
  type LocationSnapshot,
  type VerifiedReceiptInfo,
} from './types';

interface NativeSurvivalCore {
  newEmergencyDetailsOperationId(): Promise<string>;
  createEmergencyReport(
    input: CreateEmergencyReportInput,
  ): Promise<unknown>;
  appendEmergencyReportDetails(reportId: string, input: AppendEmergencyDetailsInput): Promise<unknown>;
  listEmergencyReports(): Promise<unknown>;
  claimVerifiedReceiptNotification(reportId: string, eventId: string): Promise<unknown>;
  primeLocation(): Promise<unknown>;
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

function invalidEmergencyReport(): never {
  throw new Error('Invalid emergency report response from native core');
}

function parseVerifiedReceipt(value: unknown): VerifiedReceiptInfo | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return invalidEmergencyReport();
  }

  const {
    eventId,
    revision,
    verificationKind,
    authorityCheckedAt,
    status,
    callsign,
    note,
    requesterDeliveryState,
  } = value;

  if (
    typeof eventId !== 'string' ||
    eventId.length === 0 ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision <= 0 ||
    !VERIFIED_RECEIPT_KINDS.includes(verificationKind as never) ||
    (authorityCheckedAt !== null &&
      (typeof authorityCheckedAt !== 'number' ||
        !Number.isSafeInteger(authorityCheckedAt) ||
        authorityCheckedAt < 0)) ||
    !VERIFIED_RESPONDER_STATUSES.includes(status as never) ||
    typeof callsign !== 'string' ||
    callsign.length === 0 ||
    typeof note !== 'string' ||
    !REQUESTER_DELIVERY_STATES.includes(requesterDeliveryState as never)
  ) {
    return invalidEmergencyReport();
  }

  return {
    eventId,
    revision,
    verificationKind: verificationKind as VerifiedReceiptInfo['verificationKind'],
    authorityCheckedAt,
    status: status as VerifiedReceiptInfo['status'],
    callsign,
    note,
    requesterDeliveryState:
      requesterDeliveryState as VerifiedReceiptInfo['requesterDeliveryState'],
  };
}

function parseRevisionDelivery(value: unknown): EmergencyReportSummary['latestDelivery'] {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.revision !== 'number' ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      typeof value.messageId !== 'string' || !value.messageId ||
      !DELIVERY_STATES.includes(value.deliveryState as never)) {
    return invalidEmergencyReport();
  }
  return {revision: value.revision, messageId: value.messageId,
    deliveryState: value.deliveryState as EmergencyReportSummary['deliveryState']};
}

function parseHistory(value: unknown): EmergencyHistoryEvent[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return invalidEmergencyReport();
  const ids = new Set<string>();
  return value.map(event => {
    if (!isRecord(event) || typeof event.id !== 'string' || !event.id || ids.has(event.id) ||
        !['LOCAL_COMMIT', 'DETAILS_SAVED', 'RELAYED_TO_PEER', 'SERVER_ACCEPTED', 'DELIVERY_FAILED', 'RESPONDER_UPDATE'].includes(event.kind as string) ||
        !Number.isSafeInteger(event.occurredAt) || (event.occurredAt as number) < 0 ||
        (event.revision !== null && (!Number.isSafeInteger(event.revision) || (event.revision as number) < 1)) ||
        (event.status !== null && !VERIFIED_RESPONDER_STATUSES.includes(event.status as never)) ||
        !['LOCAL', 'SERVER_AUTHENTICATED', 'UNVERIFIED', 'VERIFIED_CURRENT', 'VERIFIED_OFFLINE_AUTHORITY'].includes(event.provenance as string) ||
        (event.callsign !== null && typeof event.callsign !== 'string') ||
        (event.note !== null && typeof event.note !== 'string')) return invalidEmergencyReport();
    ids.add(event.id);
    return event as unknown as EmergencyHistoryEvent;
  });
}

function parseStatusSync(value: unknown): StatusSyncInfo | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.historyPending !== 'boolean' || !['NEVER', 'SUCCESS', 'FAILED'].includes(value.state as string) ||
      [value.lastAttemptAt, value.lastSuccessAt].some(time => time !== null && (!Number.isSafeInteger(time) || (time as number) < 0))) {
    return invalidEmergencyReport();
  }
  return value as unknown as StatusSyncInfo;
}

function parseServerStatus(value: unknown): ServerStatusInfo | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) ||
      !VERIFIED_RESPONDER_STATUSES.includes(value.status as never) ||
      value.revision !== null || value.statusScope !== 'REPORT' ||
      !Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < 0 ||
      (value.callsign !== null && typeof value.callsign !== 'string') ||
      (value.note !== null && typeof value.note !== 'string')) {
    return invalidEmergencyReport();
  }
  return {
    status: value.status as ServerStatusInfo['status'],
    revision: null,
    statusScope: 'REPORT',
    updatedAt: value.updatedAt as number,
    callsign: value.callsign as string | null,
    note: value.note as string | null,
  };
}

function parseSummary(value: unknown): EmergencyReportSummary {
  if (!isRecord(value)) {
    throw new Error('Invalid emergency report response from native core');
  }

  const {
    reportId,
    createdAt,
    revision,
    emergencyType,
    urgency,
    lifecycleState,
    deliveryState,
    location,
    responderAck,
    verifiedReceipt,
  } = value;

  if (
    typeof reportId !== 'string' ||
    reportId.length === 0 ||
    (value.providerConflict !== undefined && typeof value.providerConflict !== 'boolean') ||
    (value.receiptReturnState !== undefined && !['DISABLED', 'WAITING_FOR_QUALIFICATION', 'READY'].includes(value.receiptReturnState as string)) ||
    typeof createdAt !== 'number' ||
    (revision !== undefined && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1)) ||
    (emergencyType !== 'UNSPECIFIED' && !EMERGENCY_TYPES.includes(emergencyType as never)) ||
    (urgency !== 'UNSPECIFIED' && !URGENCIES.includes(urgency as never)) ||
    !VALID_LIFECYCLES.includes(lifecycleState as string) ||
    !DELIVERY_STATES.includes(deliveryState as never)
  ) {
    throw new Error('Invalid emergency report response from native core');
  }

  const ack = parseResponderAck(responderAck);
  const verified = parseVerifiedReceipt(verifiedReceipt);
  return {
    reportId,
    createdAt,
    ...(revision !== undefined ? {revision: revision as number} : {}),
    ...(value.originalDelivery !== undefined ? {originalDelivery: parseRevisionDelivery(value.originalDelivery)} : {}),
    ...(value.latestDelivery !== undefined ? {latestDelivery: parseRevisionDelivery(value.latestDelivery)} : {}),
    emergencyType: emergencyType as EmergencyReportSummary['emergencyType'],
    urgency: urgency as EmergencyReportSummary['urgency'],
    lifecycleState: lifecycleState as EmergencyReportSummary['lifecycleState'],
    deliveryState: deliveryState as EmergencyReportSummary['deliveryState'],
    location: parseLocation(location),
    ...(ack ? {responderAck: ack} : {}),
    ...(verified ? {verifiedReceipt: verified} : {}),
    ...(value.providerConflict !== undefined ? {providerConflict: value.providerConflict as boolean} : {}),
    ...(value.receiptReturnState !== undefined ? {receiptReturnState: value.receiptReturnState as EmergencyReportSummary['receiptReturnState']} : {}),
    ...(value.history !== undefined ? {history: parseHistory(value.history)} : {}),
    ...(value.statusSync !== undefined ? {statusSync: parseStatusSync(value.statusSync)} : {}),
    ...(value.serverStatus !== undefined ? {serverStatus: parseServerStatus(value.serverStatus)} : {}),
  };
}

function parseRelayStatus(value: unknown): BleRelayStatus {
  if (!isRecord(value)) {
    return {
      availability: 'UNKNOWN',
      isSupported: false,
      permissionGranted: false,
      bluetoothEnabled: false,
      isScanning: false,
      isAdvertising: false,
      isDutyCyclePaused: false,
      peerCount: 0,
      heldRelayCount: 0,
      pendingForwardCount: 0,
    };
  }

  const availability = BLE_RELAY_AVAILABILITIES.includes(
    value.availability as never,
  )
    ? (value.availability as BleRelayStatus['availability'])
    : 'UNKNOWN';

  return {
    availability,
    isSupported:
      typeof value.isSupported === 'boolean' ? value.isSupported : false,
    permissionGranted:
      typeof value.permissionGranted === 'boolean'
        ? value.permissionGranted
        : false,
    bluetoothEnabled:
      typeof value.bluetoothEnabled === 'boolean'
        ? value.bluetoothEnabled
        : false,
    isScanning: typeof value.isScanning === 'boolean' ? value.isScanning : false,
    isAdvertising:
      typeof value.isAdvertising === 'boolean' ? value.isAdvertising : false,
    isDutyCyclePaused:
      typeof value.isDutyCyclePaused === 'boolean'
        ? value.isDutyCyclePaused
        : false,
    peerCount:
      typeof value.peerCount === 'number' && value.peerCount >= 0
        ? Math.floor(value.peerCount)
        : 0,
    heldRelayCount:
      typeof value.heldRelayCount === 'number' && value.heldRelayCount >= 0
        ? Math.floor(value.heldRelayCount)
        : 0,
    pendingForwardCount:
      typeof value.pendingForwardCount === 'number' && value.pendingForwardCount >= 0
        ? Math.floor(value.pendingForwardCount)
        : 0,
  };
}

function requireNativeCore(): NativeSurvivalCore {
  if (!nativeCore) {
    throw new Error('Sagip Survival Core native module is unavailable');
  }
  return nativeCore;
}

export const SurvivalCore = {
  async newEmergencyDetailsOperationId(): Promise<string> {
    const id = await requireNativeCore().newEmergencyDetailsOperationId();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      throw new Error('Native detail operation ID is invalid');
    }
    return id;
  },
  async createEmergencyReport(
    input: CreateEmergencyReportInput,
  ): Promise<EmergencyReportSummary> {
    return parseSummary(await requireNativeCore().createEmergencyReport(input));
  },

  async appendEmergencyReportDetails(
    reportId: string,
    input: AppendEmergencyDetailsInput,
  ): Promise<EmergencyReportSummary> {
    const summary = parseSummary(await requireNativeCore().appendEmergencyReportDetails(reportId, input));
    if (summary.reportId !== reportId) throw new Error('Native detail update returned another report');
    return summary;
  },

  async listEmergencyReports(): Promise<EmergencyReportSummary[]> {
    const value = await requireNativeCore().listEmergencyReports();
    if (!Array.isArray(value)) {
      throw new Error('Invalid emergency report response from native core');
    }
    return value.map(parseSummary);
  },

  async claimVerifiedReceiptNotification(
    reportId: string,
    eventId: string,
  ): Promise<boolean> {
    const value = await requireNativeCore().claimVerifiedReceiptNotification(
      reportId,
      eventId,
    );
    return value === true;
  },

  async primeLocation(): Promise<boolean> {
    const value = await requireNativeCore().primeLocation();
    return value === true;
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
