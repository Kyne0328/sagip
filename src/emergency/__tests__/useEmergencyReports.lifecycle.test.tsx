import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {AppState} from 'react-native';
import {SurvivalCore} from '../SurvivalCore';
import {useEmergencyReports} from '../useEmergencyReports';
import type {EmergencyReportSummary} from '../types';

jest.mock('react-native', () => ({AppState: {addEventListener: jest.fn(() => ({remove: jest.fn()}))}}));
jest.mock('../SurvivalCore', () => ({SurvivalCore: {
  appendEmergencyReportDetails: jest.fn(), createEmergencyReport: jest.fn(), listEmergencyReports: jest.fn(), triggerDelivery: jest.fn(),
}}));
const core = SurvivalCore as jest.Mocked<typeof SurvivalCore>;
const report: EmergencyReportSummary = {reportId: 'report-1', createdAt: 1234,
  emergencyType: 'MEDICAL', urgency: 'IMMEDIATE_DANGER', lifecycleState: 'LOCALLY_COMMITTED',
  deliveryState: 'DELIVERY_PENDING', location: null};
const input = {emergencyType: 'MEDICAL' as const, urgency: 'IMMEDIATE_DANGER' as const};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}
let current!: ReturnType<typeof useEmergencyReports>;
let renderer: ReactTestRenderer.ReactTestRenderer;
function Harness() {current = useEmergencyReports(); return null;}
async function mount() {await act(async () => {renderer = ReactTestRenderer.create(<Harness />);});}
beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks();
  core.listEmergencyReports.mockResolvedValue([]);
  core.createEmergencyReport.mockResolvedValue(report);
  core.triggerDelivery.mockResolvedValue(0);
});
afterEach(() => {act(() => renderer?.unmount()); jest.useRealTimers();});

test('a double tap issues only one native SOS save request', async () => {
  const save = deferred<EmergencyReportSummary>();
  core.createEmergencyReport.mockReturnValue(save.promise);
  await mount();
  await act(async () => {
    const first = current.create(input);
    const second = current.create(input);
    save.resolve(report);
    await Promise.all([first, second]);
  });
  expect(core.createEmergencyReport).toHaveBeenCalledTimes(1);
});

test('awaited calls through the same callback reuse the committed identity before render and reconciliation', async () => {
  const delivery = deferred<number>();
  core.triggerDelivery.mockReturnValue(delivery.promise);
  await mount();
  const create = current.create;
  await act(async () => {
    expect((await create(input))?.reportId).toBe(report.reportId);
    expect((await create(input))?.reportId).toBe(report.reportId);
    expect((await create(input))?.reportId).toBe(report.reportId);
  });
  expect(core.createEmergencyReport).toHaveBeenCalledTimes(1);
  expect(core.triggerDelivery).toHaveBeenCalledTimes(1);
  expect(current.reports).toEqual([report]);
});

test('a restored active identity prevents a new native save after remount', async () => {
  core.listEmergencyReports.mockResolvedValue([report]);
  await mount();
  await act(async () => {await current.create(input);});
  act(() => renderer.unmount());
  await mount();
  await act(async () => {await current.create(input);});
  expect(core.createEmergencyReport).not.toHaveBeenCalled();
  expect(current.reports[0].reportId).toBe(report.reportId);
});

test('an active report behind newer closed history remains canonical', async () => {
  const closed: EmergencyReportSummary = {...report, reportId: 'closed', createdAt: 5000,
    serverStatus: {status: 'RESOLVED', revision: null, statusScope: 'REPORT', updatedAt: 6000, callsign: null, note: null}};
  core.listEmergencyReports.mockResolvedValue([closed, report]);
  await mount();
  let reused: EmergencyReportSummary | null = null;
  await act(async () => {reused = await current.create(input);});
  expect(reused).toEqual(report);
  expect(core.createEmergencyReport).not.toHaveBeenCalled();
});

test('a failed reconciliation cannot forget the committed identity', async () => {
  core.listEmergencyReports.mockResolvedValueOnce([]).mockRejectedValue(new Error('read failed'));
  await mount();
  const create = current.create;
  await act(async () => {await create(input);});
  await act(async () => {await create(input);});
  expect(core.createEmergencyReport).toHaveBeenCalledTimes(1);
  expect(current.reports[0].reportId).toBe(report.reportId);
});

test('an older startup read cannot erase a newly committed SOS', async () => {
  const read = deferred<EmergencyReportSummary[]>();
  const delivery = deferred<number>();
  core.listEmergencyReports.mockReturnValueOnce(read.promise);
  core.triggerDelivery.mockReturnValue(delivery.promise);
  await mount();
  await act(async () => {await current.create(input);});
  expect(current.reports).toEqual([report]);
  await act(async () => {read.resolve([]);});
  expect(current.reports).toEqual([report]);
});

test('successful foreground restoration clears an obsolete load error', async () => {
  core.listEmergencyReports.mockRejectedValueOnce(new Error('Temporary database failure'));
  await mount();
  expect(current.message).toBe('Saved SOS reports could not be loaded.');
  const listener = (AppState.addEventListener as jest.Mock).mock.calls[0][1];
  await act(async () => {listener('active');});
  expect(current.message).toBeNull();
});

test('a failed startup restore retries while the app remains open', async () => {
  core.listEmergencyReports.mockRejectedValueOnce(new Error('Temporary database failure'));
  await mount();
  await act(async () => {jest.advanceTimersByTime(10_000);});
  expect(core.listEmergencyReports).toHaveBeenCalledTimes(2);
  expect(current.message).toBeNull();
});

test('slow native delivery cannot accumulate overlapping status polls', async () => {
  const delivery = deferred<number>();
  core.listEmergencyReports.mockResolvedValue([report]);
  core.triggerDelivery.mockReturnValue(delivery.promise);
  await mount();
  await act(async () => {jest.advanceTimersByTime(30_000);});
  expect(core.triggerDelivery).toHaveBeenCalledTimes(1);
});

test('failed status delivery keeps cached history and successful reconnect updates status', async () => {
  const cached: EmergencyReportSummary = {...report, history: [{id: 'local', kind: 'LOCAL_COMMIT',
    occurredAt: 1234, revision: 1, status: null, provenance: 'LOCAL', callsign: null, note: null}],
    statusSync: {historyPending: false, state: 'FAILED', lastAttemptAt: 3000, lastSuccessAt: 2000}};
  core.listEmergencyReports.mockResolvedValue([cached]);
  await mount();
  core.triggerDelivery.mockRejectedValueOnce(new Error('offline'));
  await act(async () => {await current.refresh();});
  expect(current.reports[0].history).toEqual(cached.history);
  expect(current.reports[0].statusSync?.lastSuccessAt).toBe(2000);
  const connected: EmergencyReportSummary = {...cached,
    serverStatus: {status: 'EN_ROUTE', revision: null, statusScope: 'REPORT', updatedAt: 4000, callsign: 'TEST-UNIT', note: null},
    statusSync: {historyPending: false, state: 'SUCCESS', lastAttemptAt: 4000, lastSuccessAt: 4000}};
  core.listEmergencyReports.mockResolvedValue([connected]);
  const listener = (AppState.addEventListener as jest.Mock).mock.calls[0][1];
  await act(async () => {listener('active');});
  expect(current.reports[0].serverStatus?.status).toBe('EN_ROUTE');
  expect(current.reports[0].statusSync?.lastSuccessAt).toBe(4000);
  expect(current.syncing).toBe(false);
});

test('server-confirmed closure stops polling while legacy closure continues', async () => {
  core.listEmergencyReports.mockResolvedValue([{...report, deliveryState: 'RESPONDER_ACKNOWLEDGED',
    responderAck: {ackId: 'legacy', responderId: 'unknown', status: 'RESOLVED', callsign: null, note: null, acknowledgedAt: 2000}}]);
  await mount();
  await act(async () => {jest.advanceTimersByTime(10_000);});
  expect(core.triggerDelivery).toHaveBeenCalledTimes(1);
  core.listEmergencyReports.mockResolvedValue([{...report, deliveryState: 'RESPONDER_ACKNOWLEDGED',
    serverStatus: {status: 'RESOLVED', revision: null, statusScope: 'REPORT', updatedAt: 3000, callsign: null, note: null}}]);
  await act(async () => {await current.refresh();});
  const count = core.triggerDelivery.mock.calls.length;
  await act(async () => {jest.advanceTimersByTime(30_000);});
  expect(core.triggerDelivery).toHaveBeenCalledTimes(count);
});

test('resolved history continues paging until native marks the saved history complete', async () => {
  const resolved: EmergencyReportSummary = {...report, deliveryState: 'SERVER_ACCEPTED',
    serverStatus: {status: 'RESOLVED', revision: null, statusScope: 'REPORT', updatedAt: 3000, callsign: null, note: null},
    statusSync: {state: 'SUCCESS', lastAttemptAt: 3000, lastSuccessAt: 3000, historyPending: true}};
  core.listEmergencyReports.mockResolvedValue([resolved]);
  await mount();
  await act(async () => {jest.advanceTimersByTime(10_000);});
  expect(core.triggerDelivery).toHaveBeenCalledTimes(1);
  core.listEmergencyReports.mockResolvedValue([{...resolved,
    statusSync: {...resolved.statusSync!, historyPending: false}}]);
  await act(async () => {jest.advanceTimersByTime(10_000);});
  expect(core.triggerDelivery).toHaveBeenCalledTimes(2);
  await act(async () => {jest.advanceTimersByTime(30_000);});
  expect(core.triggerDelivery).toHaveBeenCalledTimes(2);
  expect(current.reports[0].serverStatus?.status).toBe('RESOLVED');
});

test('original pending SOS continues polling when optional details permanently fail', async () => {
  core.listEmergencyReports.mockResolvedValue([{...report, revision: 2, deliveryState: 'PERMANENT_FAILURE',
    originalDelivery: {revision: 1, messageId: 'm1', deliveryState: 'DELIVERY_PENDING'},
    latestDelivery: {revision: 2, messageId: 'm2', deliveryState: 'PERMANENT_FAILURE'},
  }]);
  await mount();
  await act(async () => {jest.advanceTimersByTime(10_000);});
  expect(core.triggerDelivery).toHaveBeenCalledTimes(1);
});
