import {reportIsResolved, reportNeedsStatusSync} from '../useEmergencyReports';
import {offlineSnapshotText} from '../SosHistory';
import type {EmergencyReportSummary, VerifiedReceiptInfo} from '../types';

const receipt: VerifiedReceiptInfo = {
  eventId: 'snapshot-event', revision: 1, verificationKind: 'VERIFIED_OFFLINE_ROOT_SNAPSHOT',
  authorityCheckedAt: 2000, issuedAt: 1000, authorityExpiresAt: 900000,
  offlineEvidenceState: 'VALID_AT_LAST_CHECK', status: 'RESOLVED', callsign: 'UNIT-1',
  note: '', requesterDeliveryState: 'UNKNOWN',
};
const report: EmergencyReportSummary = {
  reportId: 'report', revision: 1, createdAt: 1000, emergencyType: 'MEDICAL', urgency: 'IMMEDIATE_DANGER',
  lifecycleState: 'RESPONDER_ACKNOWLEDGED', deliveryState: 'SERVER_ACCEPTED', location: null,
  verifiedReceipt: receipt,
  serverStatus: {status: 'RESOLVED', revision: null, statusScope: 'REPORT', updatedAt: 2500, callsign: 'UNIT-1', note: null},
};

test.each(['VALID_AT_LAST_CHECK', 'EXPIRED', 'TIME_UNAVAILABLE', 'REVOKED', 'CONFLICT'] as const)(
  'snapshot %s never closes an SOS even with cached server resolution and keeps sync alive', state => {
    const saved = {...report, verifiedReceipt: {...receipt, offlineEvidenceState: state}};
    expect(reportIsResolved(saved)).toBe(false);
    expect(reportNeedsStatusSync(saved)).toBe(true);
    expect(offlineSnapshotText(saved.verifiedReceipt)).toContain('SOS stays active');
  },
);

test('report-wide snapshot hold defeats selected non-snapshot and cached server resolution', () => {
  const mixed: EmergencyReportSummary = {...report, offlineSnapshotClosureHold: true, providerConflict: false,
    verifiedReceipt: {...receipt, verificationKind: 'VERIFIED_CURRENT'}};
  expect(reportIsResolved(mixed)).toBe(false);
  expect(reportNeedsStatusSync(mixed)).toBe(true);
});

test('saved snapshot text separates report issuance, authority age and current revocation uncertainty', () => {
  const text = offlineSnapshotText(receipt);
  expect(text).toContain('Saved signed responder update');
  expect(text).toContain('Responder approval was valid at the last check');
  expect(text).toContain('Issued:');
  expect(text).toContain('Checked:');
  expect(text).toContain('Valid until:');
  expect(text).toContain('Current responder approval cannot be confirmed offline');
});

test.each([
  ['EXPIRED', 'Offline responder proof expired'], ['REVOKED', 'Responder approval was revoked'],
  ['TIME_UNAVAILABLE', 'Responder approval cannot be checked'], ['CONFLICT', 'Responder approval is uncertain'],
] as const)('snapshot %s wording does not claim current validity', (state, expected) => {
  const text = offlineSnapshotText({...receipt, offlineEvidenceState: state});
  expect(text).toContain(expected);
  expect(text).not.toContain('Responder approval was valid at the last check');
});
