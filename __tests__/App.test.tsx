import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import App from '../App';
import {SurvivalCore} from '../src/emergency/SurvivalCore';

jest.mock('../src/emergency/SurvivalCore', () => ({
  SurvivalCore: {
    createEmergencyReport: jest.fn(),
    listEmergencyReports: jest.fn(),
    triggerDelivery: jest.fn().mockResolvedValue(0),
    getRelayStatus: jest.fn(),
    startBleRelay: jest.fn().mockResolvedValue(true),
    stopBleRelay: jest.fn().mockResolvedValue(true),
  },
}));

const core = SurvivalCore as jest.Mocked<typeof SurvivalCore>;
const report = {
  reportId: 'report-1',
  createdAt: 1234,
  emergencyType: 'MEDICAL' as const,
  urgency: 'IMMEDIATE_DANGER' as const,
  lifecycleState: 'LOCALLY_COMMITTED' as const,
  deliveryState: 'DELIVERY_PENDING' as const,
  location: null,
};

async function renderApp() {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(<App />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return renderer;
}

beforeEach(() => {
  jest.clearAllMocks();
  core.listEmergencyReports.mockResolvedValue([]);
  core.getRelayStatus.mockResolvedValue({
    availability: 'READY',
    isSupported: true,
    permissionGranted: true,
    bluetoothEnabled: true,
    isScanning: true,
    isAdvertising: true,
    isDutyCyclePaused: false,
    peerCount: 0,
  });
  core.startBleRelay.mockResolvedValue(true);
});

test('shows an offline-safe SOS entry point with accessibility attributes', async () => {
  const renderer = await renderApp();
  const sosBtn = renderer.root.findByProps({accessibilityLabel: 'Create emergency SOS report'});
  expect(sosBtn).toBeTruthy();
  expect(sosBtn.props.accessibilityRole).toBe('button');
  expect(sosBtn.props.accessibilityHint).toContain('save SOS locally');
  expect(
    renderer.root.findAllByProps({accessibilityLiveRegion: 'polite'}).length,
  ).toBeGreaterThan(0);
});

test('creates a local SOS and tells the user it is pending delivery', async () => {
  core.createEmergencyReport.mockResolvedValue(report);
  const renderer = await renderApp();

  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Create emergency SOS report'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Medical'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Immediate danger'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Save SOS now on this device'}).props.onPress());

  expect(core.createEmergencyReport).toHaveBeenCalledWith({
    emergencyType: 'MEDICAL',
    urgency: 'IMMEDIATE_DANGER',
  });
  expect(JSON.stringify(renderer.toJSON())).toContain('SOS saved on this device. You do not need internet.');
  expect(JSON.stringify(renderer.toJSON())).toContain('Pending delivery');
});

test('does not claim success when persistence fails', async () => {
  core.createEmergencyReport.mockRejectedValue(new Error('disk full'));
  const renderer = await renderApp();

  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Create emergency SOS report'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Medical'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Immediate danger'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Save SOS now on this device'}).props.onPress());

  expect(JSON.stringify(renderer.toJSON())).toContain('SOS was not saved. Please try again.');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('SOS saved on this device. You do not need internet.');
});


test('restores a pending local report on launch', async () => {
  core.listEmergencyReports.mockResolvedValue([report]);
  const renderer = await renderApp();

  expect(JSON.stringify(renderer.toJSON())).toContain('Saved on this device');
  expect(JSON.stringify(renderer.toJSON())).toContain('Pending delivery');
});

test('renders server accepted delivery state when report is accepted', async () => {
  core.listEmergencyReports.mockResolvedValue([{
    ...report,
    deliveryState: 'SERVER_ACCEPTED' as const,
  }]);
  const renderer = await renderApp();

  expect(JSON.stringify(renderer.toJSON())).toContain('Saved on this device');
  expect(JSON.stringify(renderer.toJSON())).toContain('Server accepted');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Pending delivery');
});

test('renders relayed to nearby SAGIP device when report is relayed to peer', async () => {
  core.listEmergencyReports.mockResolvedValue([{
    ...report,
    deliveryState: 'RELAYED_TO_PEER' as const,
  }]);
  const renderer = await renderApp();

  expect(JSON.stringify(renderer.toJSON())).toContain('Saved on this device');
  expect(JSON.stringify(renderer.toJSON())).toContain('Relayed to nearby SAGIP device');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Pending delivery');
});

test('shows relay permission as separate from local SOS persistence', async () => {
  core.getRelayStatus.mockResolvedValue({
    availability: 'PERMISSION_REQUIRED',
    isSupported: true,
    permissionGranted: false,
    bluetoothEnabled: false,
    isScanning: false,
    isAdvertising: false,
    isDutyCyclePaused: false,
    peerCount: 0,
  });
  const renderer = await renderApp();

  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).toContain('Nearby relay needs permission');
  expect(rendered).toContain('SOS saving still works without it');
  expect(
    renderer.root.findByProps({accessibilityLabel: 'Allow nearby relay'}),
  ).toBeTruthy();
});

test('shows active relay and nearby peer count', async () => {
  core.getRelayStatus.mockResolvedValue({
    availability: 'READY',
    isSupported: true,
    permissionGranted: true,
    bluetoothEnabled: true,
    isScanning: true,
    isAdvertising: true,
    isDutyCyclePaused: false,
    peerCount: 2,
  });
  const renderer = await renderApp();

  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).toContain('Nearby relay active');
  expect(rendered).toContain('2 nearby SAGIP devices detected.');
});

test('shows battery-saving relay pause as active rather than failed', async () => {
  core.getRelayStatus.mockResolvedValue({
    availability: 'READY',
    isSupported: true,
    permissionGranted: true,
    bluetoothEnabled: true,
    isScanning: false,
    isAdvertising: false,
    isDutyCyclePaused: true,
    peerCount: 0,
  });
  const renderer = await renderApp();

  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).toContain('Nearby relay active');
  expect(rendered).toContain('conserving battery');
  expect(rendered).not.toContain('Nearby relay not active');
});

test('renders responder acknowledged delivery state with callsign and note', async () => {
  core.listEmergencyReports.mockResolvedValue([{
    ...report,
    deliveryState: 'RESPONDER_ACKNOWLEDGED' as const,
    lifecycleState: 'RESPONDER_ACKNOWLEDGED' as const,
    responderAck: {
      ackId: 'ack-123',
      responderId: 'resp-456',
      callsign: 'RESCUE-ALPHA-1',
      status: 'ACKNOWLEDGED',
      note: 'Boat team deployed',
      acknowledgedAt: 1758369600000,
    },
  }]);
  const renderer = await renderApp();

  expect(JSON.stringify(renderer.toJSON())).toContain('Saved on this device');
  expect(JSON.stringify(renderer.toJSON())).toContain('Responder acknowledged');
  expect(JSON.stringify(renderer.toJSON())).toContain('Help is on the way · RESCUE-ALPHA-1 (Boat team deployed)');
});
