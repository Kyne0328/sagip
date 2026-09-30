import type {EmergencyReportSummary} from '../types';
import {reportNeedsStatusSync} from '../useEmergencyReports';

const base: EmergencyReportSummary = {
  reportId: 'report-1',
  createdAt: 1,
  emergencyType: 'MEDICAL',
  urgency: 'IMMEDIATE_DANGER',
  lifecycleState: 'LOCALLY_COMMITTED',
  deliveryState: 'DELIVERY_PENDING',
  location: null,
};

test('keeps syncing reports until responder resolution is persisted', () => {
  expect(reportNeedsStatusSync(base)).toBe(true);
  expect(reportNeedsStatusSync({...base, deliveryState: 'RELAYED_TO_PEER'})).toBe(true);
  expect(reportNeedsStatusSync({...base, deliveryState: 'SERVER_ACCEPTED'})).toBe(true);
  expect(
    reportNeedsStatusSync({
      ...base,
      lifecycleState: 'RESPONDER_ACKNOWLEDGED',
      deliveryState: 'RESPONDER_ACKNOWLEDGED',
      responderAck: {
        ackId: 'ack-1',
        responderId: 'SERVER',
        callsign: 'RESCUE-1',
        status: 'ON_SCENE',
        note: null,
        acknowledgedAt: 2,
      },
    }),
  ).toBe(true);
  expect(
    reportNeedsStatusSync({
      ...base,
      lifecycleState: 'RESPONDER_ACKNOWLEDGED',
      deliveryState: 'RESPONDER_ACKNOWLEDGED',
      responderAck: {
        ackId: 'ack-2',
        responderId: 'SERVER',
        callsign: 'RESCUE-1',
        status: 'RESOLVED',
        note: null,
        acknowledgedAt: 3,
      },
    }),
  ).toBe(false);
  expect(reportNeedsStatusSync({...base, deliveryState: 'PERMANENT_FAILURE'})).toBe(false);
});
