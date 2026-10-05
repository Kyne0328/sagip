import {NativeModules} from 'react-native';

import {SurvivalCore} from '../SurvivalCore';

jest.mock('react-native', () => ({
  NativeModules: {
    SagipSurvivalCore: {
      createEmergencyReport: jest.fn(),
      appendEmergencyReportDetails: jest.fn(),
      newEmergencyDetailsOperationId: jest.fn(),
      listEmergencyReports: jest.fn(),
      primeLocation: jest.fn(),
      triggerDelivery: jest.fn(),
      getRelayStatus: jest.fn(),
      startBleRelay: jest.fn(),
      stopBleRelay: jest.fn(),
    },
  },
}));

const nativeCore = NativeModules.SagipSurvivalCore as {
  createEmergencyReport: jest.Mock;
  appendEmergencyReportDetails: jest.Mock;
  newEmergencyDetailsOperationId: jest.Mock;
  listEmergencyReports: jest.Mock;
  primeLocation: jest.Mock;
  triggerDelivery: jest.Mock;
  getRelayStatus: jest.Mock;
  startBleRelay: jest.Mock;
  stopBleRelay: jest.Mock;
};

const nativeSummary = {
  reportId: 'report-1',
  createdAt: 1788565000000,
  emergencyType: 'MEDICAL',
  urgency: 'IMMEDIATE_DANGER',
  lifecycleState: 'LOCALLY_COMMITTED',
  deliveryState: 'DELIVERY_PENDING',
  location: null,
};

describe('SurvivalCore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps create input to the native module and validates the response', async () => {
    nativeCore.createEmergencyReport.mockResolvedValue(nativeSummary);

    await expect(
      SurvivalCore.createEmergencyReport({
        emergencyType: 'MEDICAL',
        urgency: 'IMMEDIATE_DANGER',
      }),
    ).resolves.toEqual(nativeSummary);

    expect(nativeCore.createEmergencyReport).toHaveBeenCalledWith({
      emergencyType: 'MEDICAL',
      urgency: 'IMMEDIATE_DANGER',
    });
  });

  it('restores reports from native storage', async () => {
    nativeCore.listEmergencyReports.mockResolvedValue([nativeSummary]);

    await expect(SurvivalCore.listEmergencyReports()).resolves.toEqual([
      nativeSummary,
    ]);
  });

  it('accepts server accepted delivery state from native storage', async () => {
    const acceptedSummary = {
      ...nativeSummary,
      deliveryState: 'SERVER_ACCEPTED' as const,
    };
    nativeCore.listEmergencyReports.mockResolvedValue([acceptedSummary]);

    await expect(SurvivalCore.listEmergencyReports()).resolves.toEqual([
      acceptedSummary,
    ]);
  });

  it('rejects malformed native responses', async () => {
    nativeCore.createEmergencyReport.mockResolvedValue({
      ...nativeSummary,
      deliveryState: 'SENT',
    });

    await expect(
      SurvivalCore.createEmergencyReport({
        emergencyType: 'MEDICAL',
        urgency: 'IMMEDIATE_DANGER',
      }),
    ).rejects.toThrow('Invalid emergency report response from native core');
  });

  it('accepts relayed to peer delivery state from native storage', async () => {
    const relayedSummary = {
      ...nativeSummary,
      deliveryState: 'RELAYED_TO_PEER' as const,
    };
    nativeCore.listEmergencyReports.mockResolvedValue([relayedSummary]);

    await expect(SurvivalCore.listEmergencyReports()).resolves.toEqual([
      relayedSummary,
    ]);
  });

  it('accepts responder acknowledged delivery state and parses responderAck from native storage', async () => {
    const ackSummary = {
      ...nativeSummary,
      deliveryState: 'RESPONDER_ACKNOWLEDGED' as const,
      lifecycleState: 'RESPONDER_ACKNOWLEDGED' as const,
      responderAck: {
        ackId: 'ack-1',
        responderId: 'resp-1',
        callsign: 'RESCUE-1',
        status: 'ACKNOWLEDGED',
        note: 'En route',
        acknowledgedAt: 1788565100000,
      },
    };
    nativeCore.listEmergencyReports.mockResolvedValue([ackSummary]);

    await expect(SurvivalCore.listEmergencyReports()).resolves.toEqual([
      ackSummary,
    ]);
  });

  it('primes device location without changing SOS persistence semantics', async () => {
    nativeCore.primeLocation.mockResolvedValue(true);

    await expect(SurvivalCore.primeLocation()).resolves.toBe(true);
    expect(nativeCore.primeLocation).toHaveBeenCalledTimes(1);
  });

  it('triggers delivery and returns processed envelope count', async () => {
    nativeCore.triggerDelivery.mockResolvedValue(3);

    await expect(SurvivalCore.triggerDelivery()).resolves.toBe(3);
    expect(nativeCore.triggerDelivery).toHaveBeenCalled();
  });

  it('falls back to 0 when triggerDelivery returns non-number', async () => {
    nativeCore.triggerDelivery.mockResolvedValue(null);

    await expect(SurvivalCore.triggerDelivery()).resolves.toBe(0);
  });

  it('queries BLE relay status and parses response', async () => {
    nativeCore.getRelayStatus.mockResolvedValue({
      availability: 'READY',
      isSupported: true,
      permissionGranted: true,
      bluetoothEnabled: true,
      isScanning: true,
      isAdvertising: true,
      isDutyCyclePaused: false,
      peerCount: 2,
      heldRelayCount: 3,
      pendingForwardCount: 1,
    });

    await expect(SurvivalCore.getRelayStatus()).resolves.toEqual({
      availability: 'READY',
      isSupported: true,
      permissionGranted: true,
      bluetoothEnabled: true,
      isScanning: true,
      isAdvertising: true,
      isDutyCyclePaused: false,
      peerCount: 2,
      heldRelayCount: 3,
      pendingForwardCount: 1,
    });
  });

  it('starts and stops BLE relay successfully', async () => {
    nativeCore.startBleRelay.mockResolvedValue(true);
    nativeCore.stopBleRelay.mockResolvedValue(true);

    await expect(SurvivalCore.startBleRelay()).resolves.toBe(true);
    await expect(SurvivalCore.stopBleRelay()).resolves.toBe(true);
  });
});

test('native-generated operation identities satisfy canonical UUID validation', async () => {
  nativeCore.newEmergencyDetailsOperationId.mockResolvedValue('00000000-0000-4000-8000-000000000001');
  await expect(SurvivalCore.newEmergencyDetailsOperationId()).resolves.toBe('00000000-0000-4000-8000-000000000001');
  nativeCore.newEmergencyDetailsOperationId.mockResolvedValue('details-123');
  await expect(SurvivalCore.newEmergencyDetailsOperationId()).rejects.toThrow('operation ID is invalid');
});

test('allows a no-detail SOS and explicit unspecified metadata without inventing choices', async () => {
  const result = {...nativeSummary, revision: 1, emergencyType: 'UNSPECIFIED', urgency: 'UNSPECIFIED'};
  nativeCore.createEmergencyReport.mockResolvedValue(result);
  await expect(SurvivalCore.createEmergencyReport({})).resolves.toEqual(result);
  expect(nativeCore.createEmergencyReport).toHaveBeenCalledWith({});
});

test('appends details with report identity and idempotent revision contract', async () => {
  const result = {...nativeSummary, revision: 2};
  nativeCore.appendEmergencyReportDetails.mockResolvedValue(result);
  const input = {expectedRevision: 1, operationId: 'synthetic-edit-1', urgency: 'IMMEDIATE_DANGER' as const};
  await expect(SurvivalCore.appendEmergencyReportDetails('report-1', input)).resolves.toEqual(result);
  expect(nativeCore.appendEmergencyReportDetails).toHaveBeenCalledWith('report-1', input);
  nativeCore.appendEmergencyReportDetails.mockResolvedValue({...result, reportId: 'another-report'});
  await expect(SurvivalCore.appendEmergencyReportDetails('report-1', input)).rejects.toThrow('another report');
});
