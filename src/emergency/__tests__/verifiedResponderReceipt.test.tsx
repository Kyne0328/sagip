import React from 'react';
import {AccessibilityInfo} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';

import App from '../../../App';
import {SurvivalCore} from '../SurvivalCore';
import type {EmergencyReportSummary} from '../types';
import {useBleRelayStatus} from '../useBleRelayStatus';
import {useEmergencyReports} from '../useEmergencyReports';

jest.mock('../SurvivalCore', () => ({
  SurvivalCore: {
    claimVerifiedReceiptNotification: jest.fn(),
  },
}));

jest.mock('../useEmergencyReports', () => ({
  ...jest.requireActual('../useEmergencyReports'),
  useEmergencyReports: jest.fn(),
}));

jest.mock('../useBleRelayStatus', () => ({
  useBleRelayStatus: jest.fn(),
}));

const core = SurvivalCore as jest.Mocked<typeof SurvivalCore>;
const mockedReports = useEmergencyReports as jest.MockedFunction<typeof useEmergencyReports>;
const mockedRelay = useBleRelayStatus as jest.MockedFunction<typeof useBleRelayStatus>;

const baseReport: EmergencyReportSummary = {
  reportId: '11111111-1111-4111-8111-111111111111',
  createdAt: 1788565000000,
  emergencyType: 'MEDICAL',
  urgency: 'IMMEDIATE_DANGER',
  lifecycleState: 'RESPONDER_ACKNOWLEDGED',
  deliveryState: 'RESPONDER_ACKNOWLEDGED',
  location: null,
};

function reportWithVerifiedReceipt(
  overrides: Partial<NonNullable<EmergencyReportSummary['verifiedReceipt']>> = {},
): EmergencyReportSummary {
  return {
    ...baseReport,
    verifiedReceipt: {
      eventId: '22222222-2222-4222-8222-222222222222',
      revision: 1,
      verificationKind: 'VERIFIED_CURRENT',
      authorityCheckedAt: 1788565100000,
      status: 'ACKNOWLEDGED',
      callsign: 'TAGUM-1',
      note: 'Acknowledged',
      requesterDeliveryState: 'UNKNOWN',
      ...overrides,
    },
  };
}

function setReports(reports: EmergencyReportSummary[]) {
  mockedReports.mockReturnValue({
    reports,
    loading: false,
    saving: false,
    syncing: false,
    lastLocalReadAt: null,
    message: null,
    create: jest.fn(),
    appendDetails: jest.fn(),
    refresh: jest.fn(),
  });
}

async function renderApp() {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(<App />);
    await Promise.resolve();
  });
  return renderer;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedRelay.mockReturnValue({
    status: {
      availability: 'READY',
      isSupported: true,
      permissionGranted: true,
      bluetoothEnabled: true,
      isScanning: true,
      isAdvertising: true,
      isDutyCyclePaused: false,
      peerCount: 0,
      heldRelayCount: 0,
      pendingForwardCount: 0,
    },
    loading: false,
    requesting: false,
    enable: jest.fn(),
    refresh: jest.fn(),
  });
  core.claimVerifiedReceiptNotification.mockResolvedValue(false);
  jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('requester assurance requires current verified receipt evidence', async () => {
  setReports([
    {
      ...baseReport,
      responderAck: {
        ackId: 'legacy-ack',
        responderId: 'legacy-responder',
        callsign: 'LEGACY-1',
        status: 'ACKNOWLEDGED',
        note: 'Legacy acknowledgement',
        acknowledgedAt: 1788565050000,
      },
    },
  ]);

  const legacy = await renderApp();
  const legacyText = JSON.stringify(legacy.toJSON());
  expect(legacyText).not.toContain('Responder acknowledged this SOS');
  expect(legacyText).toContain('Unverified responder update');
  act(() => legacy.unmount());

  setReports([reportWithVerifiedReceipt()]);
  const verified = await renderApp();
  const verifiedText = JSON.stringify(verified.toJSON());
  expect(verifiedText).toContain('Responder acknowledged this SOS');
  expect(verifiedText).toContain('TAGUM-1');
  expect(verifiedText).not.toContain('Requester return confirmation');
});

test('verified responder action text stays qualified and visible when return signing is unavailable', async () => {
  setReports([
    reportWithVerifiedReceipt({
      status: 'EN_ROUTE',
      note: 'Unit dispatched',
      requesterDeliveryState: 'UNKNOWN',
    }),
  ]);

  const renderer = await renderApp();
  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).toContain('Responder says they are on the way');
  expect(rendered).toContain('Unit dispatched');
  expect(rendered).not.toContain('Requester return confirmation');
  expect(rendered).not.toContain('Responder received your return confirmation');
});

test('historical receipt names its version and does not imply current authority checking', async () => {
  setReports([{...reportWithVerifiedReceipt(), revision: 2}]);
  const renderer = await renderApp();
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain('Responder acknowledged SOS version 1');
  expect(text).not.toContain('Responder acknowledged this SOS');
  expect(text).not.toContain('Current revocation status is unavailable');
  expect(text).not.toContain('Requester return confirmation');
});

test('offline authority evidence names unavailable live revocation knowledge', async () => {
  setReports([
    reportWithVerifiedReceipt({
      verificationKind: 'VERIFIED_OFFLINE_AUTHORITY',
      authorityCheckedAt: 1788564000000,
      status: 'ON_SCENE',
      note: 'Team reports arrival',
    }),
  ]);

  const renderer = await renderApp();
  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).toContain('Responder says they are on scene');
  expect(rendered).toContain('Responder approval was verified offline');
  expect(rendered).toContain('Current approval cannot be checked');
});

test('conflicting providers keep the SOS active and qualify accessibility announcements', async () => {
  setReports([{...reportWithVerifiedReceipt({status: 'RESOLVED'}), providerConflict: true}]);
  core.claimVerifiedReceiptNotification.mockResolvedValueOnce(true);
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const renderer = await renderApp();
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain('Active SOS');
  expect(text).toContain('Responder updates conflict. SOS stays active.');
  expect(text).not.toContain('Resolved. You can send a new SOS.');
  expect(announce).toHaveBeenCalledWith(
    'Responder updates conflict. SOS stays active.',
  );
  expect(announce).not.toHaveBeenCalledWith('Responder marked this resolved');
  act(() => renderer.unmount());
});

test('offline root snapshot resolution stays active and qualifies its accessibility announcement', async () => {
  setReports([reportWithVerifiedReceipt({verificationKind: 'VERIFIED_OFFLINE_ROOT_SNAPSHOT',
    status: 'RESOLVED', note: '', issuedAt: 1788565000000, authorityExpiresAt: 1788565900000,
    offlineEvidenceState: 'VALID_AT_LAST_CHECK'})]);
  core.claimVerifiedReceiptNotification.mockResolvedValueOnce(true);
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const renderer = await renderApp();
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain('Active SOS');
  expect(text).toContain('Saved responder update');
  expect(text).toContain('Current responder approval cannot be confirmed offline');
  expect(announce).toHaveBeenCalledWith('Saved responder update says resolved. SOS stays active until confirmed.');
  expect(text).not.toContain('Resolved. You can send a new SOS.');
  act(() => renderer.unmount());
});

test('durable notification claim prevents replay and restart announcements', async () => {
  const report = reportWithVerifiedReceipt();
  setReports([report]);
  core.claimVerifiedReceiptNotification
    .mockResolvedValueOnce(true)
    .mockResolvedValue(false);
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');

  const first = await renderApp();
  await act(async () => {
    await Promise.resolve();
  });
  expect(core.claimVerifiedReceiptNotification).toHaveBeenCalledWith(
    report.reportId,
    report.verifiedReceipt?.eventId,
  );
  expect(announce).toHaveBeenCalledTimes(1);
  expect(announce).toHaveBeenCalledWith('Responder acknowledged this SOS');
  act(() => first.unmount());

  const reopened = await renderApp();
  await act(async () => {
    await Promise.resolve();
  });
  expect(core.claimVerifiedReceiptNotification).toHaveBeenCalledTimes(2);
  expect(announce).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(reopened.toJSON())).toContain('Responder acknowledged this SOS');
});
