import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {ScrollView} from 'react-native';

import App from '../App';
import {SurvivalCore} from '../src/emergency/SurvivalCore';

jest.mock('../src/emergency/SurvivalCore', () => ({
  SurvivalCore: {
    createEmergencyReport: jest.fn(),
    appendEmergencyReportDetails: jest.fn(),
    newEmergencyDetailsOperationId: jest.fn(),
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
  revision: 1,
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
  core.createEmergencyReport.mockResolvedValue(report);
  core.appendEmergencyReportDetails.mockResolvedValue({...report, revision: 2});
  core.getRelayStatus.mockResolvedValue({
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
  });
  core.startBleRelay.mockResolvedValue(true);
  core.newEmergencyDetailsOperationId.mockResolvedValue('00000000-0000-4000-8000-000000000001');
});

test('shows SAGIP branding and an offline-safe SOS entry point with accessibility attributes', async () => {
  const renderer = await renderApp();
  expect(
    renderer.root.findByProps({
      accessibilityLabel: 'SAGIP locator pin with medical plus logo',
    }),
  ).toBeTruthy();
  expect(JSON.stringify(renderer.toJSON())).toContain('Save an SOS even without internet.');
  expect(JSON.stringify(renderer.toJSON())).not.toContain(
    'If internet works, SAGIP sends directly to the server.',
  );
  const sosBtn = renderer.root.findByProps({accessibilityLabel: 'Create emergency SOS report'});
  expect(sosBtn).toBeTruthy();
  expect(sosBtn.props.accessibilityRole).toBe('button');
  expect(sosBtn.props.accessibilityHint).toContain('save SOS locally');
  expect(
    renderer.root.findAllByProps({accessibilityLiveRegion: 'polite'}).length,
  ).toBeGreaterThan(0);
});

test('keeps delivery and location explanations available behind Help', async () => {
  const renderer = await renderApp();
  const help = renderer.root.findByProps({accessibilityLabel: 'How SOS works'});
  expect(help.props.accessibilityState.expanded).toBe(false);
  await act(async () => help.props.onPress());
  expect(JSON.stringify(renderer.toJSON())).toContain(
    'If internet works, SAGIP sends directly to the server.',
  );
  expect(JSON.stringify(renderer.toJSON())).toContain(
    'Your SOS still saves if location permission or GPS is unavailable.',
  );
  expect(help.props.accessibilityState.expanded).toBe(true);
  await act(async () => help.props.onPress());
  expect(JSON.stringify(renderer.toJSON())).not.toContain(
    'If internet works, SAGIP sends directly to the server.',
  );
});

test('optional details accept either choice and keep Save outside the scrolling form', async () => {
  core.listEmergencyReports.mockResolvedValue([report]);
  const renderer = await renderApp();
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Add optional SOS details'}).props.onPress());
  const saveButton = renderer.root.findByProps({accessibilityLabel: 'Save optional SOS details'});
  expect(saveButton.props.accessibilityState.disabled).toBe(true);
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Flood'}).props.onPress());
  expect(saveButton.props.accessibilityState.disabled).toBe(false);
  expect(core.createEmergencyReport).not.toHaveBeenCalled();
  let ancestor = saveButton.parent;
  while (ancestor) {
    expect(ancestor.type).not.toBe('RCTScrollView');
    expect(ancestor.type).not.toBe(ScrollView);
    ancestor = ancestor.parent;
  }
  await act(async () => saveButton.props.onPress());
  expect(core.appendEmergencyReportDetails).toHaveBeenCalledWith('report-1', {
    expectedRevision: 1, operationId: expect.any(String), emergencyType: 'FLOOD',
  });
});

test('creates a local SOS and tells the user it is pending delivery', async () => {
  core.createEmergencyReport.mockResolvedValue(report);
  core.listEmergencyReports.mockResolvedValueOnce([]).mockResolvedValue([report]);
  const renderer = await renderApp();

  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Create emergency SOS report'}).props.onPress());

  expect(core.createEmergencyReport).toHaveBeenCalledWith({});
  expect(JSON.stringify(renderer.toJSON())).toContain('SOS saved on this device. You do not need internet.');
  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).toContain('Pending delivery');
  expect(rendered).toContain('Saved on your phone; waiting to send.');
  expect(rendered.indexOf('SOS already active. Check delivery status')).toBeLessThan(
    rendered.indexOf('Saved on this device'),
  );
  expect(renderer.root.findAllByProps({accessibilityRole: 'alert'})).toHaveLength(0);
});

test('does not claim success when persistence fails', async () => {
  core.createEmergencyReport.mockRejectedValue(new Error('disk full'));
  const renderer = await renderApp();

  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Create emergency SOS report'}).props.onPress());

  expect(JSON.stringify(renderer.toJSON())).toContain('SOS was not saved. Please try again.');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('SOS saved on this device. You do not need internet.');
  const alert = renderer.root.findByProps({accessibilityRole: 'alert'});
  expect(alert.props.accessibilityLiveRegion).toBe('assertive');
});


test('restores a pending local report on launch', async () => {
  core.listEmergencyReports.mockResolvedValue([report]);
  const renderer = await renderApp();

  expect(JSON.stringify(renderer.toJSON())).toContain('Saved on this device');
  expect(JSON.stringify(renderer.toJSON())).toContain('Pending delivery');
  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered.indexOf('SOS already active. Check delivery status')).toBeLessThan(
    rendered.indexOf('Saved on this device'),
  );
});

test('renders server accepted delivery state when report is accepted', async () => {
  core.listEmergencyReports.mockResolvedValue([{
    ...report,
    deliveryState: 'SERVER_ACCEPTED' as const,
  }]);
  const renderer = await renderApp();

  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).toContain('Saved on this device');
  expect(rendered).toContain('Server accepted');
  expect(rendered).toContain('Server acceptance does not by itself prove responder acknowledgement');
  expect(rendered).not.toContain('Pending delivery');
});

test('reconciles a server-accepted report even when delivery processes no new envelope', async () => {
  jest.useFakeTimers();
  const acknowledged = {
    ...report,
    deliveryState: 'RESPONDER_ACKNOWLEDGED' as const,
    lifecycleState: 'RESPONDER_ACKNOWLEDGED' as const,
    responderAck: {
      ackId: 'ack-refresh',
      responderId: 'SERVER',
      callsign: 'RESCUE-REFRESH-1',
      status: 'EN_ROUTE',
      note: 'Unit dispatched',
      acknowledgedAt: 1758369900000,
    },
  };
  core.listEmergencyReports
    .mockResolvedValueOnce([{...report, deliveryState: 'SERVER_ACCEPTED' as const}])
    .mockResolvedValue([acknowledged]);
  core.triggerDelivery.mockResolvedValue(0);

  let renderer: ReactTestRenderer.ReactTestRenderer | null = null;
  try {
    renderer = await renderApp();
    expect(JSON.stringify(renderer.toJSON())).toContain('Server accepted');

    await act(async () => {
      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(core.triggerDelivery).toHaveBeenCalled();
    expect(core.listEmergencyReports).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(renderer.toJSON())).toContain('Responders report they are on the way');
  } finally {
    if (renderer) {
      act(() => renderer?.unmount());
    }
    jest.useRealTimers();
  }
});

test('renders relayed to nearby SAGIP device when report is relayed to peer', async () => {
  core.listEmergencyReports.mockResolvedValue([{
    ...report,
    deliveryState: 'RELAYED_TO_PEER' as const,
  }]);
  const renderer = await renderApp();

  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).toContain('Saved on this device');
  expect(rendered).toContain('Relayed to another SAGIP device');
  expect(rendered).toContain('does not yet mean the server or a responder received it');
  expect(rendered).not.toContain('Pending delivery');
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
    heldRelayCount: 0,
    pendingForwardCount: 0,
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
    heldRelayCount: 0,
    pendingForwardCount: 0,
  });
  const renderer = await renderApp();

  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).toContain('Nearby relay active');
  expect(rendered).toContain('2 nearby SAGIP devices detected.');
});

test('shows gateway custody without exposing another persons incident contents', async () => {
  core.getRelayStatus.mockResolvedValue({
    availability: 'READY',
    isSupported: true,
    permissionGranted: true,
    bluetoothEnabled: true,
    isScanning: true,
    isAdvertising: true,
    isDutyCyclePaused: false,
    peerCount: 1,
    heldRelayCount: 1,
    pendingForwardCount: 1,
  });
  const renderer = await renderApp();

  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).toContain('safely carrying 1 relayed SOS message');
  expect(rendered).toContain('waiting to forward it to the SAGIP server');
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
    heldRelayCount: 0,
    pendingForwardCount: 0,
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

  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).toContain('Saved on this device');
  expect(rendered).toContain('Unverified responder update');
  expect(rendered).toContain(
    'Responder has acknowledged your SOS · RESCUE-ALPHA-1 (Boat team deployed). This legacy acknowledgement is not cryptographically verified.',
  );
  expect(rendered).not.toContain('Responders report they are on the way');
});

test('uses persisted responder status before saying responders are on the way', async () => {
  core.listEmergencyReports.mockResolvedValue([{
    ...report,
    deliveryState: 'RESPONDER_ACKNOWLEDGED' as const,
    lifecycleState: 'RESPONDER_ACKNOWLEDGED' as const,
    responderAck: {
      ackId: 'ack-en-route',
      responderId: 'resp-456',
      callsign: 'RESCUE-ALPHA-1',
      status: 'EN_ROUTE',
      note: 'Boat team dispatched',
      acknowledgedAt: 1758369600000,
    },
  }]);
  const renderer = await renderApp();

  expect(JSON.stringify(renderer.toJSON())).toContain(
    'Responders report they are on the way · RESCUE-ALPHA-1 (Boat team dispatched). This legacy acknowledgement is not cryptographically verified.',
  );
});

test('keeps a permanent delivery failure distinct from local persistence', async () => {
  core.listEmergencyReports.mockResolvedValue([{
    ...report,
    deliveryState: 'PERMANENT_FAILURE' as const,
  }]);
  const renderer = await renderApp();

  const failureRendered = JSON.stringify(renderer.toJSON());
  expect(failureRendered).toContain('Saved on this device');
  expect(failureRendered).toContain('Delivery failed permanently');
  expect(failureRendered).toContain('automatic delivery cannot continue for this initial SOS version');
});

test('skipping optional details leaves the persisted SOS and delivery active', async () => {
  core.listEmergencyReports.mockResolvedValue([report]);
  const renderer = await renderApp();
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Add optional SOS details'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Medical'}).props.onPress());
  const skip = renderer.root.findByProps({accessibilityLabel: 'Skip optional SOS details'});
  expect(skip.props.accessibilityHint).toContain('Keeps your saved SOS');
  await act(async () => skip.props.onPress());
  expect(core.createEmergencyReport).not.toHaveBeenCalled();
  expect(core.appendEmergencyReportDetails).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer.toJSON())).toContain('Pending delivery');
});

test('one tap persists without category, urgency or a permission prompt and no mobile responder entry remains', async () => {
  const unspecified = {...report, emergencyType: 'UNSPECIFIED' as const, urgency: 'UNSPECIFIED' as const};
  core.createEmergencyReport.mockResolvedValue(unspecified);
  core.listEmergencyReports.mockResolvedValueOnce([]).mockResolvedValue([unspecified]);
  const renderer = await renderApp();
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Create emergency SOS report'}).props.onPress());
  expect(core.createEmergencyReport).toHaveBeenCalledTimes(1);
  expect(core.createEmergencyReport).toHaveBeenCalledWith({});
  expect(core.triggerDelivery).toHaveBeenCalled();
  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).toContain('Emergency type not specified');
  expect(rendered).toContain('Urgency not specified');
  expect(rendered).not.toContain('Responder workspace');
  expect(rendered).not.toContain('Open responder workspace');
  expect(renderer.root.findAllByProps({accessibilityLabel: 'Save SOS now on this device'})).toHaveLength(0);
});

test('rapid SOS taps issue only one request while storage is pending', async () => {
  let resolve!: (value: typeof report) => void;
  core.createEmergencyReport.mockReturnValue(new Promise(done => {resolve = done;}));
  core.listEmergencyReports.mockResolvedValueOnce([]).mockResolvedValue([report]);
  const renderer = await renderApp();
  const button = renderer.root.findByProps({accessibilityLabel: 'Create emergency SOS report'});
  await act(async () => {button.props.onPress(); button.props.onPress();});
  expect(core.createEmergencyReport).toHaveBeenCalledTimes(1);
  expect(button.props.accessibilityState.busy).toBe(true);
  await act(async () => {resolve(report);});
});

test('failed optional details preserve the SOS and reuse operation identity on an unchanged retry', async () => {
  core.listEmergencyReports.mockResolvedValue([report]);
  core.appendEmergencyReportDetails.mockRejectedValueOnce(new Error('temporary bridge failure'));
  const renderer = await renderApp();
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Add optional SOS details'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Need assistance'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Save optional SOS details'}).props.onPress());
  expect(JSON.stringify(renderer.toJSON())).toContain('Your original SOS remains saved');
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Save optional SOS details'}).props.onPress());
  expect(core.appendEmergencyReportDetails).toHaveBeenCalledTimes(2);
  expect(core.appendEmergencyReportDetails.mock.calls[1]).toEqual(core.appendEmergencyReportDetails.mock.calls[0]);
  expect(core.createEmergencyReport).not.toHaveBeenCalled();
});

test('older SOS acknowledgement does not claim appended details were delivered', async () => {
  core.listEmergencyReports.mockResolvedValue([{...report, revision: 2, deliveryState: 'DELIVERY_PENDING',
    originalDelivery: {revision: 1, messageId: 'm1', deliveryState: 'RESPONDER_ACKNOWLEDGED'},
    latestDelivery: {revision: 2, messageId: 'm2', deliveryState: 'DELIVERY_PENDING'},
    responderAck: {ackId: 'a1', responderId: 'r1', callsign: null, note: null, status: 'EN_ROUTE', acknowledgedAt: 1234},
  }]);
  const renderer = await renderApp();
  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).toContain('Responders report they are on the way');
  expect(rendered).toContain('Latest details saved here and waiting to send.');
});

test('details choices cannot change while operation identity or persistence is pending', async () => {
  let resolve!: (id: string) => void;
  core.newEmergencyDetailsOperationId.mockReturnValue(new Promise(done => {resolve = done;}));
  core.listEmergencyReports.mockResolvedValue([report]);
  const renderer = await renderApp();
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Add optional SOS details'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Medical'}).props.onPress());
  await act(async () => {
    renderer.root.findByProps({accessibilityLabel: 'Save optional SOS details'}).props.onPress();
  });
  expect(renderer.root.findByProps({accessibilityLabel: 'Flood'}).props.disabled).toBe(true);
  await act(async () => {resolve('00000000-0000-4000-8000-000000000001');});
});

test('conflicting edit keeps choices and requires explicit refresh before retrying a new revision', async () => {
  core.listEmergencyReports.mockResolvedValue([report]);
  core.appendEmergencyReportDetails.mockRejectedValueOnce(new Error('DETAILS_CONFLICT'));
  const renderer = await renderApp();
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Add optional SOS details'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Flood'}).props.onPress());
  core.listEmergencyReports.mockResolvedValue([{...report, revision: 2}]);
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Save optional SOS details'}).props.onPress());
  expect(renderer.root.findByProps({accessibilityLabel: 'Flood'}).props.accessibilityState.selected).toBe(true);
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Refresh SOS version and keep choices'}).props.onPress());
  expect(renderer.root.findByProps({accessibilityLabel: 'Flood'}).props.accessibilityState.selected).toBe(true);
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Save optional SOS details'}).props.onPress());
  expect(core.appendEmergencyReportDetails.mock.calls[1][1]).toMatchObject({expectedRevision: 2, emergencyType: 'FLOOD'});
});

test('active SOS action refreshes delivery instead of promising another send', async () => {
  core.listEmergencyReports.mockResolvedValue([report]);
  const renderer = await renderApp();
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'SOS already active. Check delivery status'}).props.onPress());
  expect(core.createEmergencyReport).not.toHaveBeenCalled();
  expect(core.triggerDelivery).toHaveBeenCalled();
});

test('authenticated report-wide status is qualified and resolved allows a new SOS', async () => {
  core.listEmergencyReports.mockResolvedValue([{...report, revision: 2,
    serverStatus: {status: 'RESOLVED', revision: null, statusScope: 'REPORT', updatedAt: 2000, callsign: 'TEST-UNIT', note: null}}]);
  const renderer = await renderApp();
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain('Server-confirmed responder update');
  expect(text).toContain('Report-wide status');
  expect(text).toContain('does not confirm acknowledgement of a particular details version');
  expect(renderer.root.findAllByProps({children: 'Verified responder update'})).toHaveLength(0);
  expect(text).toContain('Optional details are closed.');
  expect(renderer.root.findAllByProps({accessibilityLabel: 'Add optional SOS details'})).toHaveLength(0);
  expect(renderer.root.findByProps({accessibilityLabel: 'Create emergency SOS report'})).toBeTruthy();
});

test('legacy resolved acknowledgement does not unlock a new SOS', async () => {
  core.listEmergencyReports.mockResolvedValue([{...report, deliveryState: 'RESPONDER_ACKNOWLEDGED',
    responderAck: {ackId: 'unverified', responderId: 'unknown', status: 'RESOLVED', callsign: null, note: null, acknowledgedAt: 2000}}]);
  const renderer = await renderApp();
  expect(renderer.root.findByProps({accessibilityLabel: 'SOS already active. Check delivery status'})).toBeTruthy();
  expect(renderer.root.findAllByProps({accessibilityLabel: 'Create emergency SOS report'})).toHaveLength(0);
  expect(renderer.root.findByProps({accessibilityLabel: 'Add optional SOS details'})).toBeTruthy();
});

test.each(['DELIVERY_PENDING', 'RELAYED_TO_PEER', 'PERMANENT_FAILURE'] as const)(
  'authenticated status qualifies missing original transport evidence for %s without acknowledging details',
  async deliveryState => {
    core.listEmergencyReports.mockResolvedValue([{...report, revision: 2, deliveryState,
      originalDelivery: {revision: 1, messageId: 'original', deliveryState},
      latestDelivery: {revision: 2, messageId: 'details', deliveryState: 'DELIVERY_PENDING'},
      serverStatus: {status: 'EN_ROUTE', revision: null, statusScope: 'REPORT', updatedAt: 2000, callsign: 'TEST-UNIT', note: null}}]);
    const renderer = await renderApp();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('Responder reports they are on the way');
    expect(text).toContain(deliveryState === 'PERMANENT_FAILURE' ? 'Original transport confirmation unavailable' : 'Original transport confirmation pending');
    expect(text).toContain('The server has a record of this incident.');
    expect(text).toContain('does not have a delivery receipt for the original SOS message');
    expect(text).toContain('Latest details saved here and waiting to send.');
    expect(text).not.toContain('Saved on your phone; waiting to send.');
    expect(text).not.toContain('This does not yet mean the server or a responder received it.');
    expect(text).not.toContain('Delivery failed permanently');
    expect(core.createEmergencyReport).not.toHaveBeenCalled();
  },
);

test('trusted resolution arriving during an edit disables saving without discarding saved SOS', async () => {
  jest.useFakeTimers();
  core.listEmergencyReports.mockResolvedValue([report]);
  let renderer: ReactTestRenderer.ReactTestRenderer | null = null;
  try {
    renderer = await renderApp();
    const app = renderer;
    await act(async () => app.root.findByProps({accessibilityLabel: 'Add optional SOS details'}).props.onPress());
    await act(async () => app.root.findByProps({accessibilityLabel: 'Medical'}).props.onPress());
    core.listEmergencyReports.mockResolvedValue([{...report, deliveryState: 'RESPONDER_ACKNOWLEDGED',
      serverStatus: {status: 'RESOLVED', revision: null, statusScope: 'REPORT', updatedAt: 2000, callsign: null, note: null}}]);
    await act(async () => {jest.advanceTimersByTime(10_000);});
    const save = app.root.findByProps({accessibilityLabel: 'Save optional SOS details'});
    expect(save.props.disabled).toBe(true);
    await act(async () => save.props.onPress());
    expect(core.appendEmergencyReportDetails).not.toHaveBeenCalled();
    expect(JSON.stringify(app.toJSON())).toContain('This SOS was resolved while you were editing.');
  } finally {
    act(() => renderer?.unmount());
    jest.useRealTimers();
  }
});

test('expanding saved history never calls remote delivery', async () => {
  core.listEmergencyReports.mockResolvedValue([report]);
  const renderer = await renderApp();
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Your SOS history'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'SOS history for report-1'}).props.onPress());
  expect(JSON.stringify(renderer.toJSON())).toContain('Reading this history does not contact the server.');
  expect(core.triggerDelivery).not.toHaveBeenCalled();
});


test('optional details keep a compact SOS action without losing choices or creating another incident', async () => {
  core.listEmergencyReports.mockResolvedValue([report]);
  const renderer = await renderApp();
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Add optional SOS details'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Medical'}).props.onPress());
  const compact = renderer.root.findByProps({testID: 'compact-sos-button'});
  expect(compact.props.accessibilityLabel).toBe('Active SOS. Check saved delivery status');
  let ancestor = compact.parent;
  while (ancestor) {
    expect(ancestor.type).not.toBe('RCTScrollView');
    expect(ancestor.type).not.toBe(ScrollView);
    ancestor = ancestor.parent;
  }
  await act(async () => compact.props.onPress());
  expect(renderer.root.findByProps({accessibilityLabel: 'Medical'}).props.accessibilityState.selected).toBe(true);
  expect(core.createEmergencyReport).not.toHaveBeenCalled();
  expect(core.appendEmergencyReportDetails).not.toHaveBeenCalled();
  expect(core.triggerDelivery).toHaveBeenCalled();
});

test('a compact SOS action stays reachable when the large SOS scrolls out of view', async () => {
  core.listEmergencyReports.mockResolvedValue([report]);
  const renderer = await renderApp();
  const primary = renderer.root.findByProps({testID: 'primary-sos-button'});
  await act(async () => primary.props.onLayout({nativeEvent: {layout: {y: 100, height: 200}}}));
  const scroll = renderer.root.findByType(ScrollView);
  await act(async () => scroll.props.onScroll({nativeEvent: {contentOffset: {y: 301}}}));
  const compact = renderer.root.findByProps({testID: 'compact-sos-button'});
  await act(async () => compact.props.onPress());
  expect(core.createEmergencyReport).not.toHaveBeenCalled();
  expect(core.triggerDelivery).toHaveBeenCalled();
  await act(async () => scroll.props.onScroll({nativeEvent: {contentOffset: {y: 0}}}));
  expect(renderer.root.findAllByProps({testID: 'compact-sos-button'})).toHaveLength(0);
  expect(renderer.root.findByProps({testID: 'primary-sos-button'})).toBeTruthy();
});

test('large SOS stays above status and expanded saved history', async () => {
  core.listEmergencyReports.mockResolvedValue([report]);
  const renderer = await renderApp();
  const button = renderer.root.findByProps({testID: 'primary-sos-button'});
  const flattened = button.props.style({pressed: false}).filter(Boolean);
  expect(flattened[0].minHeight).toBeGreaterThanOrEqual(190);
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Your SOS history'}).props.onPress());
  const text = JSON.stringify(renderer.toJSON());
  expect(text.indexOf('primary-sos-button')).toBeLessThan(text.indexOf('Active SOS status'));
  expect(text.indexOf('primary-sos-button')).toBeLessThan(text.indexOf('Your saved SOS history'));
  expect(text).toContain('SOS already active');
  expect(text).not.toContain('Tap to send a new SOS');
});

test('newer resolved history does not hide an older active SOS or unlock another incident', async () => {
  core.listEmergencyReports.mockResolvedValue([
    {...report, reportId: 'newer-closed', createdAt: 5000, emergencyType: 'FIRE',
      serverStatus: {status: 'RESOLVED', revision: null, statusScope: 'REPORT', updatedAt: 6000, callsign: null, note: null}},
    report,
  ]);
  const renderer = await renderApp();
  expect(renderer.root.findByProps({accessibilityLabel: 'SOS already active. Check delivery status'})).toBeTruthy();
  expect(renderer.root.findAllByProps({accessibilityLabel: 'Create emergency SOS report'})).toHaveLength(0);
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Add optional SOS details'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Flood'}).props.onPress());
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Save optional SOS details'}).props.onPress());
  expect(core.appendEmergencyReportDetails.mock.calls[0][0]).toBe(report.reportId);
  expect(core.createEmergencyReport).not.toHaveBeenCalled();
});

test('a captured SOS handler cannot create again after an awaited save', async () => {
  core.listEmergencyReports.mockResolvedValueOnce([]).mockResolvedValue([report]);
  const renderer = await renderApp();
  const stalePress = renderer.root.findByProps({accessibilityLabel: 'Create emergency SOS report'}).props.onPress;
  await act(async () => {await stalePress();});
  await act(async () => {await stalePress(); await stalePress();});
  expect(core.createEmergencyReport).toHaveBeenCalledTimes(1);
  expect(core.triggerDelivery).toHaveBeenCalled();
});

test('confirmed resolution permits one new SOS and rapid repeats keep the new incident', async () => {
  const resolved = {...report, serverStatus: {status: 'RESOLVED' as const, revision: null,
    statusScope: 'REPORT' as const, updatedAt: 2000, callsign: null, note: null}};
  const next = {...report, reportId: 'new-incident', createdAt: 3000};
  core.listEmergencyReports.mockResolvedValueOnce([resolved]).mockResolvedValue([next, resolved]);
  core.createEmergencyReport.mockResolvedValue(next);
  const renderer = await renderApp();
  const press = renderer.root.findByProps({accessibilityLabel: 'Create emergency SOS report'}).props.onPress;
  await act(async () => {await press();});
  await act(async () => {await press();});
  expect(core.createEmergencyReport).toHaveBeenCalledTimes(1);
  expect(renderer.root.findByProps({accessibilityLabel: 'SOS already active. Check delivery status'})).toBeTruthy();
});
