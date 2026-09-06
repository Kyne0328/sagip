import {NativeModules} from 'react-native';

import {SurvivalCore} from '../SurvivalCore';

jest.mock('react-native', () => ({
  NativeModules: {
    SagipSurvivalCore: {
      createEmergencyReport: jest.fn(),
      listEmergencyReports: jest.fn(),
      triggerDelivery: jest.fn(),
    },
  },
}));

const nativeCore = NativeModules.SagipSurvivalCore as {
  createEmergencyReport: jest.Mock;
  listEmergencyReports: jest.Mock;
  triggerDelivery: jest.Mock;
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

  it('triggers delivery and returns processed envelope count', async () => {
    nativeCore.triggerDelivery.mockResolvedValue(3);

    await expect(SurvivalCore.triggerDelivery()).resolves.toBe(3);
    expect(nativeCore.triggerDelivery).toHaveBeenCalled();
  });

  it('falls back to 0 when triggerDelivery returns non-number', async () => {
    nativeCore.triggerDelivery.mockResolvedValue(null);

    await expect(SurvivalCore.triggerDelivery()).resolves.toBe(0);
  });
});
