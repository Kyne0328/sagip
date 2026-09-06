import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import App from '../App';
import {SurvivalCore} from '../src/emergency/SurvivalCore';

jest.mock('../src/emergency/SurvivalCore', () => ({
  SurvivalCore: {
    createEmergencyReport: jest.fn(),
    listEmergencyReports: jest.fn(),
    triggerDelivery: jest.fn().mockResolvedValue(0),
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
});

test('shows an offline-safe SOS entry point', async () => {
  const renderer = await renderApp();
  expect(renderer.root.findByProps({accessibilityLabel: 'Create SOS'})).toBeTruthy();
  expect(renderer.root.findAllByType('Text' as never).length).toBeGreaterThan(0);
});

test('creates a local SOS and tells the user it is pending delivery', async () => {
  core.createEmergencyReport.mockResolvedValue(report);
  const renderer = await renderApp();

  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Create SOS'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Medical'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Immediate danger'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Save SOS on this device'}).props.onPress());

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

  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Create SOS'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Medical'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Immediate danger'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Save SOS on this device'}).props.onPress());

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
