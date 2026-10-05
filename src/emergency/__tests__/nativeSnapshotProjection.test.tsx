import React from 'react';
import {NativeModules} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
// Node helpers are test-only; keep Node globals out of the mobile tsconfig.
const {createHash} = jest.requireActual('crypto');
const {readFileSync} = jest.requireActual('fs');
import projection from '../../../fixtures/offline-root-v1/native-projection.json';
import {SurvivalCore} from '../SurvivalCore';
import {SosHistory} from '../SosHistory';
import {reportIsResolved} from '../useEmergencyReports';

jest.mock('react-native', () => {
  const native = jest.requireActual('react-native');
  native.NativeModules.SagipSurvivalCore = {listEmergencyReports: jest.fn()};
  return native;
});

test('exact reopened three-node native projection crosses the real bridge and renders historical status', async () => {
  expect(createHash('sha256').update(readFileSync('fixtures/offline-root-v1/three-node.json')).digest('hex'))
    .toBe(projection.provenance.fixtureSha256);
  expect(projection.provenance).toMatchObject({
    storageBackend: 'PG_MEM_TEST', timeSource: 'SIMULATED_TEST_CLOCK',
    threeIndependentSqlCipherStores: true, originReopened: true,
    activityRendered: false, physicalRadioQualified: false, syntheticOnly: true,
  });
  // The export contains the actual durable status projection. These unrelated
  // display fields are a synthetic shell, not claimed native export fields.
  NativeModules.SagipSurvivalCore.listEmergencyReports.mockResolvedValue([{
    ...projection.summary, revision: projection.summary.latestRevision,
    createdAt: projection.summary.verifiedReceipt.issuedAt,
    emergencyType: 'UNSPECIFIED', urgency: 'UNSPECIFIED',
    lifecycleState: 'LOCALLY_COMMITTED', deliveryState: 'SERVER_ACCEPTED',
    location: null,
  }]);
  const [report] = await SurvivalCore.listEmergencyReports();
  expect(report.verifiedReceipt).toEqual(projection.summary.verifiedReceipt);
  expect(report.offlineSnapshotClosureHold).toBe(true);
  expect(reportIsResolved(report)).toBe(false);
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  try {
    await act(async () => {renderer = ReactTestRenderer.create(<SosHistory reports={[report]} />);});
    await act(async () => renderer.root.findByProps({
      accessibilityLabel: 'SOS history for ' + report.reportId,
    }).props.onPress());
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).toContain('SYNTHETIC TEAM');
    expect(rendered).toContain('Responder says they are on the way');
    expect(rendered).toContain('Saved signed responder update.');
    expect(rendered).toContain('Current responder approval cannot be confirmed offline.');
    expect(rendered).toContain('Issued:');
    expect(rendered).toContain('Checked:');
    expect(rendered).toContain('Valid until:');
    expect(rendered).toContain('SOS stays active.');
  } finally {
    if (renderer) act(() => renderer.unmount());
  }
});
