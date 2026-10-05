import React from 'react';
import {AppState, type AppStateStatus} from 'react-native';
import TestRenderer, {act} from 'react-test-renderer';
import {GatewayScreen} from '../GatewayScreen';
import {GatewayCore} from '../GatewayCore';

jest.mock('../GatewayCore', () => ({GatewayCore: {
  authenticate: jest.fn(), lock: jest.fn().mockResolvedValue(undefined), status: jest.fn(), newActionId: jest.fn(),
  listGatewayIncidents: jest.fn(), recordGatewayAction: jest.fn(), getGatewayAction: jest.fn(),
}}));
const core = GatewayCore as jest.Mocked<typeof GatewayCore>;
const incident = {reportId: '11111111-1111-4111-8111-111111111111', revision: 1,
  observedIncidentVersion: '1', emergencyType: 'MEDICAL', urgency: 'NEED_ASSISTANCE', location: null,
  timeline: []};

beforeEach(() => {
  jest.clearAllMocks();
  AppState.currentState = 'active';
  jest.spyOn(AppState, 'addEventListener').mockImplementation(() => ({remove: jest.fn()}));
  core.authenticate.mockResolvedValue(true);
  core.newActionId.mockResolvedValue('22222222-2222-4222-8222-222222222222');
  core.status.mockResolvedValue({authorityReady: false, callsign: null});
  core.listGatewayIncidents.mockResolvedValue([incident]);
  core.recordGatewayAction.mockResolvedValue({actionId: 'saved-action', state: 'PREPARING', reason: 'SIGNER_UNAVAILABLE'});
});
async function press(r: TestRenderer.ReactTestRenderer, label: string) {
  const matchesLabel = (actual: string | undefined) => label.startsWith('Select incident ')
    ? Boolean(actual?.startsWith('Select ') && actual.includes(label.slice('Select incident '.length, 'Select incident '.length + 8)))
    : actual === label;
  await act(async () => { await r.root.findAll(b => matchesLabel(b.props.accessibilityLabel) && typeof b.props.onPress === 'function')[0].props.onPress(); });
}
async function render() {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<GatewayScreen onClose={() => {}} />); });
  return r;
}
function content(r: TestRenderer.ReactTestRenderer) { return JSON.stringify(r.toJSON()); }

test('shows explicit selected incident and action indicators without recording an action', async () => {
  const r = await render();
  await press(r, 'Unlock responder workspace');
  await press(r, `Select incident ${incident.reportId}`);
  expect(content(r)).toContain('✓ ');
  const selectedIncident = r.root.findAll(b => b.props.accessibilityLabel?.includes(incident.reportId.slice(0, 8)) && typeof b.props.onPress === 'function')[0];
  expect(selectedIncident.props.accessibilityState.selected).toBe(true);
  await press(r, 'En route');
  const choice = r.root.findAll(b => b.props.accessibilityLabel === 'En route' && typeof b.props.onPress === 'function')[0];
  expect(choice.props.accessibilityState.checked).toBe(true);
  expect(core.recordGatewayAction).not.toHaveBeenCalled();
  expect(content(r)).toContain('Location unavailable');
  expect(content(r)).toContain('Verified issuance unavailable');
  await act(async () => r.unmount());
});

test('locks choices after saved pending work while keeping retry explicit', async () => {
  const r = await render();
  await press(r, 'Unlock responder workspace');
  await press(r, `Select incident ${incident.reportId}`);
  await press(r, 'Save acknowledgement');
  const choice = r.root.findAll(b => b.props.accessibilityLabel === 'En route' && typeof b.props.onPress === 'function')[0];
  expect(choice.props.accessibilityState.disabled).toBe(true);
  expect(choice.props.disabled).toBe(true);
  const note = r.root.findAll(b => b.props.accessibilityLabel === 'Responder action note')[0];
  expect(note.props.editable).toBe(false);
  expect(content(r)).toContain('Retry saved action');
  expect(core.recordGatewayAction).toHaveBeenCalledTimes(1);
  await act(async () => r.unmount());
});


test('gateway_ack_requires_human_intent and keeps preparing work explicit', async () => {
  const r = await render();
  expect(content(r)).not.toContain(incident.reportId);
  await press(r, 'Unlock responder workspace');
  expect(content(r)).toContain('Location unavailable');
  expect(content(r)).toContain('Verified issuance unavailable');
  expect(core.recordGatewayAction).not.toHaveBeenCalled();
  await press(r, `Select incident ${incident.reportId}`);
  expect(core.recordGatewayAction).not.toHaveBeenCalled();
  await press(r, 'Save acknowledgement');
  expect(content(r)).toContain('Work saved on this device');
  expect(content(r)).toContain('Awaiting verified issuance');
  expect(core.recordGatewayAction).toHaveBeenCalledTimes(1);
  const action = core.recordGatewayAction.mock.calls[0][0];
  expect(action.reportId).toBe(incident.reportId);
  expect(action.observedIncidentVersion).toBe('1');
  expect(action.status).toBe(1);
  await act(async () => r.unmount());
});

test('denied device verification keeps incidents locked', async () => {
  core.authenticate.mockResolvedValue(false);
  const r = await render();
  await press(r, 'Unlock responder workspace');
  expect(content(r)).toContain('Device verification required');
  expect(core.listGatewayIncidents).not.toHaveBeenCalled();
  expect(content(r)).not.toContain(incident.reportId);
  await act(async () => r.unmount());
});

test('lost action response retains the same action for retry', async () => {
  core.recordGatewayAction.mockRejectedValueOnce(new Error('lost response'));
  core.getGatewayAction.mockResolvedValue({actionId: 'existing', state: 'PREPARING'});
  const r = await render(); await press(r, 'Unlock responder workspace');
  await press(r, `Select incident ${incident.reportId}`); await press(r, 'Save acknowledgement');
  expect(content(r)).toContain('Outcome unknown');
  await press(r, 'Retry saved action');
  expect(core.recordGatewayAction.mock.calls[1][0]).toEqual(core.recordGatewayAction.mock.calls[0][0]);
  await act(async () => r.unmount());
});

test('backgrounding removes sensitive incident data and locks native access', async () => {
  let handler!: (state: AppStateStatus) => void;
  const listener = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
    handler = callback; return {remove: jest.fn()};
  });
  const r = await render(); await press(r, 'Unlock responder workspace');
  await act(async () => handler('background'));
  expect(content(r)).not.toContain(incident.reportId);
  expect(core.lock).toHaveBeenCalled();
  await act(async () => r.unmount()); listener.mockRestore();
});

test('reopening a pending native action restores its identity instead of allocating a replacement', async () => {
  const saved = {actionId: '33333333-3333-4333-8333-333333333333', reportId: incident.reportId,
    observedIncidentVersion: '1', status: 2, note: 'Saved before restart'};
  core.listGatewayIncidents.mockResolvedValue([{...incident, pendingActions: [saved]}]);
  const r = await render(); await press(r, 'Unlock responder workspace');
  await press(r, `Select incident ${incident.reportId}`); await press(r, 'Retry saved action');
  expect(core.recordGatewayAction.mock.calls[0][0]).toEqual(saved);
  expect(core.newActionId).not.toHaveBeenCalled();
  await act(async () => r.unmount());
});

test('credential activity handoff can return to an unlocked foreground workspace', async () => {
  let finish!: (accepted: boolean) => void;
  let handler!: (state: AppStateStatus) => void;
  core.authenticate.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {handler = callback; return {remove: jest.fn()};});
  const r = await render();
  await act(async () => {r.root.findByProps({accessibilityLabel: 'Unlock responder workspace'}).props.onPress();});
  await act(async () => handler('background'));
  await act(async () => finish(true));
  expect(content(r)).not.toContain(incident.reportId);
  await act(async () => handler('active'));
  expect(content(r)).toContain(incident.reportId);
  await act(async () => r.unmount());
});

test('definitive rejection allows note correction and a new explicitly saved action', async () => {
  core.recordGatewayAction.mockResolvedValueOnce({actionId: 'invalid', state: 'REJECTED', reason: 'INVALID_FIELDS'});
  const r = await render(); await press(r, 'Unlock responder workspace');
  await press(r, `Select incident ${incident.reportId}`);
  await act(async () => r.root.findByProps({accessibilityLabel: 'Responder action note'}).props.onChangeText('😀'.repeat(300)));
  await press(r, 'Save acknowledgement');
  expect(r.root.findByProps({accessibilityLabel: 'Responder action note'}).props.editable).toBe(true);
  await act(async () => r.root.findByProps({accessibilityLabel: 'Responder action note'}).props.onChangeText('Corrected note'));
  await press(r, 'Save acknowledgement');
  expect(core.recordGatewayAction.mock.calls[1][0].note).toBe('Corrected note');
  await act(async () => r.unmount());
});

test('stale saved work remains visible while a new revision can receive a fresh action', async () => {
  core.listGatewayIncidents.mockResolvedValue([{...incident, revision: 2, observedIncidentVersion: '2',
    pendingActions: [{actionId: 'old-action', reportId: incident.reportId, observedIncidentVersion: '1', status: 1, note: 'Historical work'}]}]);
  const r = await render(); await press(r, 'Unlock responder workspace');
  await press(r, `Select incident ${incident.reportId}`);
  expect(content(r)).toContain('Historical work');
  await press(r, 'Save acknowledgement');
  expect(core.recordGatewayAction.mock.calls[0][0].observedIncidentVersion).toBe('2');
  expect(core.recordGatewayAction.mock.calls[0][0].actionId).not.toBe('old-action');
  await act(async () => r.unmount());
});


test('incident accessibility names include meaningful emergency and location details', async () => {
  const r = await render();
  try {
    await press(r, 'Unlock responder workspace');
    const card = r.root.findAll(b => typeof b.props.onPress === 'function' && b.props.accessibilityLabel?.includes(incident.reportId.slice(0, 8)))[0];
    expect(card.props.accessibilityLabel).toContain('medical');
    expect(card.props.accessibilityLabel).toContain('revision 1');
    expect(card.props.accessibilityLabel).toContain('Need assistance');
    expect(card.props.accessibilityLabel).toContain('Location unavailable');
  } finally {await act(async () => r.unmount());}
});

test('save accessibility name follows the selected responder action', async () => {
  const r = await render();
  try {
    await press(r, 'Unlock responder workspace');
    await press(r, `Select incident ${incident.reportId}`);
    await press(r, 'Resolved');
    expect(r.root.findAll(b => b.props.accessibilityLabel === 'Save resolved action' && typeof b.props.onPress === 'function')).toHaveLength(1);
  } finally {await act(async () => r.unmount());}
});

test('selected gateway incident preserves civilian detail text verbatim', async () => {
  const message = '  Synthetic help 🆘\nUpper floor <script>literal</script>  ';
  core.listGatewayIncidents.mockResolvedValue([{...incident, message}]);
  const r = await render();
  try {
    await press(r, 'Unlock responder workspace');
    await press(r, `Select incident ${incident.reportId}`);
    expect(content(r)).toContain('Civilian message');
    expect(content(r)).toContain(JSON.stringify(message).slice(1, -1));
    expect(core.recordGatewayAction).not.toHaveBeenCalled();
  } finally {await act(async () => r.unmount());}
});

test('device verification exposes its busy state to assistive technology', async () => {
  let finish!: (value: boolean) => void;
  core.authenticate.mockReturnValue(new Promise(resolve => {finish = resolve;}));
  const r = await render();
  try {
    await act(async () => {r.root.findByProps({accessibilityLabel: 'Unlock responder workspace'}).props.onPress();});
    expect(r.root.findByProps({accessibilityLabel: 'Unlock responder workspace'}).props.accessibilityState.busy).toBe(true);
  } finally {
    await act(async () => {finish(false);});
    await act(async () => r.unmount());
  }
});
