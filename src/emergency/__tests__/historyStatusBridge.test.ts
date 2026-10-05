import {NativeModules} from 'react-native';
import {SurvivalCore} from '../SurvivalCore';

jest.mock('react-native', () => ({NativeModules: {SagipSurvivalCore: {
  listEmergencyReports: jest.fn(), appendEmergencyReportDetails: jest.fn(),
}}}));
const core = NativeModules.SagipSurvivalCore as {listEmergencyReports: jest.Mock; appendEmergencyReportDetails: jest.Mock};
const base = {reportId: 'history-report', revision: 2, createdAt: 1000,
  emergencyType: 'MEDICAL', urgency: 'IMMEDIATE_DANGER', lifecycleState: 'RESPONDER_ACKNOWLEDGED',
  deliveryState: 'RESPONDER_ACKNOWLEDGED', location: null};
const event = {id: 'event-1', kind: 'RESPONDER_UPDATE', occurredAt: 2000, revision: null,
  status: 'EN_ROUTE', provenance: 'SERVER_AUTHENTICATED', callsign: 'UNIT-1', note: 'On the way'};
const serverStatus = {status: 'EN_ROUTE', revision: null, statusScope: 'REPORT', updatedAt: 2000, callsign: 'UNIT-1', note: 'On the way'};
const statusSync = {historyPending: false, state: 'SUCCESS', lastAttemptAt: 2500, lastSuccessAt: 2500};

beforeEach(() => jest.clearAllMocks());

test('restores authenticated report status, complete durable history and server freshness separately', async () => {
  const report = {...base, history: [event], serverStatus, statusSync};
  core.listEmergencyReports.mockResolvedValue([report]);
  const [restored] = await SurvivalCore.listEmergencyReports();
  expect(restored).toEqual(report);
  expect(restored.verifiedReceipt).toBeUndefined();
});

test.each([
  {status: 'DISPATCHED'}, {revision: 2}, {revision: undefined}, {statusScope: 'REVISION'},
  {updatedAt: -1}, {updatedAt: NaN}, {updatedAt: Infinity}, {updatedAt: '2000'},
  {callsign: 7}, {note: {}}, {note: undefined},
])('rejects malformed authenticated server status %p', async patch => {
  core.listEmergencyReports.mockResolvedValue([{...base, serverStatus: {...serverStatus, ...patch}}]);
  await expect(SurvivalCore.listEmergencyReports()).rejects.toThrow('Invalid emergency report');
});

test.each([
  {id: ''}, {kind: 'UNKNOWN'}, {occurredAt: -1}, {occurredAt: Infinity}, {revision: 0},
  {revision: undefined}, {status: 'UNKNOWN'}, {provenance: 'TRUST_ME'}, {callsign: {}}, {note: undefined},
])('rejects malformed durable history %p', async patch => {
  core.listEmergencyReports.mockResolvedValue([{...base, history: [{...event, ...patch}]}]);
  await expect(SurvivalCore.listEmergencyReports()).rejects.toThrow('Invalid emergency report');
});

test('restores all retained native history beyond ten thousand events without hiding other reports', async () => {
  const history = Array.from({length: 10001}, (_, i) => ({...event, id: `saved-${i}`, occurredAt: i}));
  core.listEmergencyReports.mockResolvedValue([{...base, history}, {...base, reportId: 'new-sos', history: []}]);
  const restored = await SurvivalCore.listEmergencyReports();
  expect(restored).toHaveLength(2);
  expect(restored[0].history).toHaveLength(10001);
  expect(restored[1].reportId).toBe('new-sos');
});

test('rejects duplicate durable event identities', async () => {
  core.listEmergencyReports.mockResolvedValue([{...base, history: [event, event]}]);
  await expect(SurvivalCore.listEmergencyReports()).rejects.toThrow('Invalid emergency report');
});

test.each([
  {state: 'ONLINE'}, {historyPending: undefined}, {historyPending: 'true'}, {lastAttemptAt: undefined}, {lastAttemptAt: -1}, {lastSuccessAt: Infinity},
])('rejects malformed server freshness %p', async patch => {
  core.listEmergencyReports.mockResolvedValue([{...base, statusSync: {...statusSync, ...patch}}]);
  await expect(SurvivalCore.listEmergencyReports()).rejects.toThrow('Invalid emergency report');
});

test('keeps stale success timestamp after failed check without deriving trust from legacy acknowledgement', async () => {
  const report = {...base, statusSync: {...statusSync, state: 'FAILED', lastAttemptAt: 3000},
    responderAck: {ackId: 'legacy', responderId: 'server', status: 'RESOLVED', acknowledgedAt: 2000}};
  core.listEmergencyReports.mockResolvedValue([report]);
  const [restored] = await SurvivalCore.listEmergencyReports();
  expect(restored.statusSync?.lastSuccessAt).toBe(2500);
  expect(restored.serverStatus).toBeUndefined();
  expect(restored.verifiedReceipt).toBeUndefined();
});

test('authenticated status remains bound to its containing report during a details update', async () => {
  core.appendEmergencyReportDetails.mockResolvedValue({...base, reportId: 'other-report', serverStatus});
  await expect(SurvivalCore.appendEmergencyReportDetails(base.reportId,
    {expectedRevision: 1, operationId: 'synthetic-history-edit', emergencyType: 'MEDICAL'}))
    .rejects.toThrow('another report');
});
