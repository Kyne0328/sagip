import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {SosHistory, StatusFreshness} from '../SosHistory';
import {reportIsResolved, reportNeedsStatusSync} from '../useEmergencyReports';
import type {EmergencyReportSummary, ServerStatusInfo} from '../types';

const base: EmergencyReportSummary = {reportId: 'saved-1', revision: 2, createdAt: 1000,
  emergencyType: 'MEDICAL', urgency: 'NEED_ASSISTANCE', lifecycleState: 'RESPONDER_ACKNOWLEDGED',
  deliveryState: 'RESPONDER_ACKNOWLEDGED', location: null};
const serverStatus: ServerStatusInfo = {status: 'EN_ROUTE', revision: null, statusScope: 'REPORT',
  updatedAt: 2000, callsign: 'TEST-UNIT', note: 'On the way'};
let renderer: ReactTestRenderer.ReactTestRenderer;
afterEach(() => {act(() => renderer?.unmount());});

test('history pages every saved report and expands all persisted events without a server read', async () => {
  const reports: EmergencyReportSummary[] = Array.from({length: 23}, (_, i) => ({...base,
    reportId: `saved-${i}`, createdAt: 1000 + i,
    history: [
      {id: 'local', kind: 'LOCAL_COMMIT', occurredAt: 1000, revision: 1, status: null, provenance: 'LOCAL', callsign: null, note: null},
      {id: 'details', kind: 'DETAILS_SAVED', occurredAt: 1500, revision: 2, status: null, provenance: 'LOCAL', callsign: null, note: null},
      {id: 'ack', kind: 'RESPONDER_UPDATE', occurredAt: 2000, revision: null, status: 'EN_ROUTE', provenance: 'SERVER_AUTHENTICATED', callsign: 'TEST-UNIT', note: 'On the way'},
    ]}));
  await act(async () => {renderer = ReactTestRenderer.create(<SosHistory reports={reports} />);});
  const reportButtons = () => [...new Set(renderer.root.findAll(node =>
    typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.startsWith('SOS history for '))
    .map(node => node.props.accessibilityLabel as string))];
  expect(reportButtons()).toHaveLength(10);
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Show more SOS reports'}).props.onPress());
  expect(reportButtons()).toHaveLength(20);
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Show more SOS reports'}).props.onPress());
  expect(reportButtons()).toHaveLength(23);
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'SOS history for saved-0'}).props.onPress());
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain('SOS saved on this device');
  expect(text).toContain('Optional details saved');
  expect(text).toContain('Responder reports they are on the way');
  expect(text).toContain('Authenticated server record');
  expect(text).toContain('Report-wide');
  expect(text).toContain('Reading this history does not contact the server.');
  expect(reports[0].reportId).toBe('saved-0');
});

test('failed check keeps last successful check and warns cached status can be stale', async () => {
  await act(async () => {renderer = ReactTestRenderer.create(<StatusFreshness report={{...base,
    statusSync: {historyPending: false, state: 'FAILED', lastSuccessAt: 2000, lastAttemptAt: 3000}}} />);});
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain('Last successful server check:');
  expect(text).toContain('Last server check failed at');
  expect(text).toContain('Showing saved status; it may be out of date.');
  expect(text).toContain('Saved status remains available offline.');
  expect(text).toContain('Verified responder updates over nearby relay are not enabled in this build.');
  expect(text).toContain('Connect to the internet to check for new responder updates.');
});

test('qualified relay capability names the contact requirement without promising cloud-root return', async () => {
  await act(async () => {renderer = ReactTestRenderer.create(<StatusFreshness report={{...base, receiptReturnState: 'READY'}} />);});
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain('Signed updates from approved offline responders can arrive through a compatible nearby relay.');
  expect(text).toContain('no new update can arrive without a connection path.');
  expect(text).toContain('Connect to the internet to check cloud responder status.');
  expect(text).not.toContain('not enabled in this build');
});

test('unqualified relay state keeps saved history visible and makes new verification pending', async () => {
  await act(async () => {renderer = ReactTestRenderer.create(<StatusFreshness report={{...base, receiptReturnState: 'WAITING_FOR_QUALIFICATION'}} />);});
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain('Saved status remains available offline.');
  expect(text).toContain('New relay updates cannot be verified yet.');
  expect(text).not.toContain('can arrive through a compatible nearby relay');
});

test('an absent server check is never inferred from a local history read', async () => {
  await act(async () => {renderer = ReactTestRenderer.create(<StatusFreshness report={base} syncing />);});
  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain('No successful server status check recorded.');
  expect(text).toContain('Checking delivery and saved status');
  expect(text).not.toContain('Last successful server check:');
});

test('only authenticated report-wide or matching-version verified closure ends active polling', () => {
  const legacy = {...base, responderAck: {ackId: 'legacy', responderId: 'unknown', status: 'RESOLVED',
    callsign: null, note: null, acknowledgedAt: 2000}};
  expect(reportIsResolved(legacy)).toBe(false);
  expect(reportNeedsStatusSync(legacy)).toBe(true);
  const resolved = {...base, serverStatus: {...serverStatus, status: 'RESOLVED' as const}};
  expect(reportIsResolved(resolved)).toBe(true);
  expect(reportNeedsStatusSync(resolved)).toBe(false);
  const receipt = {eventId: 'receipt', revision: 1, verificationKind: 'VERIFIED_CURRENT' as const,
    authorityCheckedAt: 2000, status: 'RESOLVED' as const, callsign: 'UNIT-1', note: '',
    requesterDeliveryState: 'UNKNOWN' as const};
  expect(reportIsResolved({...base, verifiedReceipt: receipt})).toBe(false);
  expect(reportIsResolved({...base, verifiedReceipt: {...receipt, revision: 2}})).toBe(true);
});

test('resolved reports keep syncing incomplete history and outstanding details delivery', () => {
  const resolved: EmergencyReportSummary = {...base, serverStatus: {...serverStatus, status: 'RESOLVED'},
    statusSync: {state: 'SUCCESS', lastAttemptAt: 3000, lastSuccessAt: 3000, historyPending: true}};
  expect(reportIsResolved(resolved)).toBe(true);
  expect(reportNeedsStatusSync(resolved)).toBe(true);
  const complete = {...resolved, statusSync: {...resolved.statusSync!, historyPending: false}};
  expect(reportNeedsStatusSync(complete)).toBe(false);
  for (const state of ['DELIVERY_PENDING', 'RELAYED_TO_PEER'] as const) {
    expect(reportNeedsStatusSync({...complete, latestDelivery: {revision: 2, messageId: 'details', deliveryState: state}})).toBe(true);
    expect(reportNeedsStatusSync({...complete, originalDelivery: {revision: 1, messageId: 'original', deliveryState: state}})).toBe(true);
  }
  expect(reportNeedsStatusSync({...complete, latestDelivery: {revision: 2, messageId: 'details', deliveryState: 'SERVER_ACCEPTED'}})).toBe(false);
});

test('incomplete history is clearly distinguished from the saved timeline', async () => {
  await act(async () => {renderer = ReactTestRenderer.create(<StatusFreshness report={{...base,
    statusSync: {state: 'SUCCESS', lastAttemptAt: 3000, lastSuccessAt: 3000, historyPending: true}}} />);});
  expect(JSON.stringify(renderer.toJSON())).toContain('More server history is waiting to sync.');
});

test('large timelines render bounded pages while every saved event remains reachable', async () => {
  const report: EmergencyReportSummary = {...base, history: Array.from({length: 130}, (_, i) => ({
    id: `event-${i}`, kind: 'RESPONDER_UPDATE', occurredAt: 1000 + i, revision: null,
    status: 'ACKNOWLEDGED', provenance: 'SERVER_AUTHENTICATED', callsign: null, note: `history-note-${i}-END`,
  }))};
  await act(async () => {renderer = ReactTestRenderer.create(<SosHistory reports={[report]} />);});
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'SOS history for saved-1'}).props.onPress());
  expect(JSON.stringify(renderer.toJSON())).toContain('history-note-129-END');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('history-note-79-END');
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Show more history events for saved-1'}).props.onPress());
  expect(JSON.stringify(renderer.toJSON())).toContain('history-note-79-END');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('history-note-0-END');
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'Show more history events for saved-1'}).props.onPress());
  expect(JSON.stringify(renderer.toJSON())).toContain('history-note-0-END');
  expect(renderer.root.findAllByProps({accessibilityLabel: 'Show more history events for saved-1'})).toHaveLength(0);
  expect(report.history).toHaveLength(130);
});

test('conflicting current providers preserve the active SOS and show uncertainty offline', async () => {
  const conflict: EmergencyReportSummary = {...base, providerConflict: true,
    serverStatus: {...serverStatus, status: 'RESOLVED'},
    verifiedReceipt: {eventId: 'receipt', revision: 2, verificationKind: 'VERIFIED_OFFLINE_AUTHORITY',
      authorityCheckedAt: 2000, status: 'RESOLVED', callsign: 'UNIT-1', note: '',
      requesterDeliveryState: 'UNKNOWN'}};
  expect(reportIsResolved(conflict)).toBe(false);
  expect(reportNeedsStatusSync(conflict)).toBe(true);
  expect(reportIsResolved({...conflict, providerConflict: false})).toBe(true);
  await act(async () => {renderer = ReactTestRenderer.create(<SosHistory reports={[conflict]} />);});
  await act(async () => renderer.root.findByProps({accessibilityLabel: 'SOS history for saved-1'}).props.onPress());
  expect(JSON.stringify(renderer.toJSON())).toContain('Responder updates disagree about whether this SOS is resolved.');
  expect(JSON.stringify(renderer.toJSON())).toContain('Your SOS stays active while the conflict is unresolved.');
});

test('empty history has an offline-readable explanation', async () => {
  await act(async () => {renderer = ReactTestRenderer.create(<SosHistory reports={[]} />);});
  expect(JSON.stringify(renderer.toJSON())).toContain('No saved SOS reports yet.');
});
