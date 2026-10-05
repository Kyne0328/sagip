import {NativeModules} from 'react-native';

import {SurvivalCore} from '../SurvivalCore';

jest.mock('react-native', () => ({
  NativeModules: {
    SagipSurvivalCore: {
      createEmergencyReport: jest.fn(),
      listEmergencyReports: jest.fn(),
      triggerDelivery: jest.fn(),
      getRelayStatus: jest.fn(),
      startBleRelay: jest.fn(),
      stopBleRelay: jest.fn(),
    },
  },
}));

const nativeCore = NativeModules.SagipSurvivalCore as {
  createEmergencyReport: jest.Mock;
  listEmergencyReports: jest.Mock;
};

const baseSummary = {
  reportId: '11111111-1111-4111-8111-111111111111',
  createdAt: 1788565000000,
  emergencyType: 'MEDICAL',
  urgency: 'IMMEDIATE_DANGER',
  lifecycleState: 'LOCALLY_COMMITTED',
  deliveryState: 'SERVER_ACCEPTED',
  location: null,
};

describe('verified receipt bridge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('preserves committed verified receipt evidence from native storage', async () => {
    nativeCore.listEmergencyReports.mockResolvedValue([
      {
        ...baseSummary,
        verifiedReceipt: {
          eventId: '22222222-2222-4222-8222-222222222222',
          revision: 2,
          verificationKind: 'VERIFIED_CURRENT',
          authorityCheckedAt: 1788565100000,
          status: 'EN_ROUTE',
          callsign: 'TAGUM-1',
          note: 'En route',
          requesterDeliveryState: 'UNKNOWN',
        },
      },
    ]);

    const [result] = await SurvivalCore.listEmergencyReports();

    expect(result.verifiedReceipt?.revision).toBe(2);
    expect(result.verifiedReceipt).toEqual({
      eventId: '22222222-2222-4222-8222-222222222222',
      revision: 2,
      verificationKind: 'VERIFIED_CURRENT',
      authorityCheckedAt: 1788565100000,
      status: 'EN_ROUTE',
      callsign: 'TAGUM-1',
      note: 'En route',
      requesterDeliveryState: 'UNKNOWN',
    });
  });

  it('rejects malformed native verification metadata instead of treating it as verified', async () => {
    nativeCore.listEmergencyReports.mockResolvedValue([
      {
        ...baseSummary,
        verifiedReceipt: {
          eventId: '22222222-2222-4222-8222-222222222222',
          revision: 2,
          verificationKind: 'UNVERIFIED_AUTHORITY',
          authorityCheckedAt: null,
          status: 'ACKNOWLEDGED',
          callsign: 'TAGUM-1',
          note: '',
          requesterDeliveryState: 'UNKNOWN',
        },
      },
    ]);

    await expect(SurvivalCore.listEmergencyReports()).rejects.toThrow(
      'Invalid emergency report response from native core',
    );
  });

  it('preserves native provider conflict without inventing it for legacy summaries', async () => {
    nativeCore.listEmergencyReports.mockResolvedValue([{...baseSummary, providerConflict: true}]);
    const [result] = await SurvivalCore.listEmergencyReports();
    expect(result.providerConflict).toBe(true);
  });

  it.each(['false', 0, null, {}])('rejects malformed provider conflict %p', async providerConflict => {
    nativeCore.listEmergencyReports.mockResolvedValue([{...baseSummary, providerConflict}]);
    await expect(SurvivalCore.listEmergencyReports()).rejects.toThrow(
      'Invalid emergency report response from native core',
    );
  });

  it.each(['DISABLED', 'WAITING_FOR_QUALIFICATION', 'READY'])('preserves receipt return state %s', async receiptReturnState => {
    nativeCore.listEmergencyReports.mockResolvedValue([{...baseSummary, receiptReturnState}]);
    const [result] = await SurvivalCore.listEmergencyReports();
    expect(result.receiptReturnState).toBe(receiptReturnState);
  });

  it.each(['DELIVERED', true, null])('rejects unknown receipt return state %p', async receiptReturnState => {
    nativeCore.listEmergencyReports.mockResolvedValue([{...baseSummary, receiptReturnState}]);
    await expect(SurvivalCore.listEmergencyReports()).rejects.toThrow(
      'Invalid emergency report response from native core',
    );
  });

  it('keeps absent legacy verified evidence absent', async () => {
    nativeCore.createEmergencyReport.mockResolvedValue(baseSummary);

    const result = await SurvivalCore.createEmergencyReport({
      emergencyType: 'MEDICAL',
      urgency: 'IMMEDIATE_DANGER',
    });

    expect(result).toEqual(baseSummary);
    expect('verifiedReceipt' in result).toBe(false);
  });
});
