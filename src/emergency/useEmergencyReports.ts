import {useCallback, useEffect, useState} from 'react';
import {AppState} from 'react-native';

import {SurvivalCore} from './SurvivalCore';
import type {
  CreateEmergencyReportInput,
  EmergencyReportSummary,
} from './types';

const STATUS_SYNC_INTERVAL_MS = 10_000;

export function reportNeedsStatusSync(report: EmergencyReportSummary): boolean {
  if (
    report.deliveryState === 'DELIVERY_PENDING' ||
    report.deliveryState === 'RELAYED_TO_PEER' ||
    report.deliveryState === 'SERVER_ACCEPTED'
  ) {
    return true;
  }

  return (
    report.deliveryState === 'RESPONDER_ACKNOWLEDGED' &&
    report.responderAck?.status !== 'RESOLVED'
  );
}

export function useEmergencyReports() {
  const [reports, setReports] = useState<EmergencyReportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const restore = useCallback(async () => {
    try {
      setReports(await SurvivalCore.listEmergencyReports());
    } catch {
      setMessage('Saved SOS reports could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    restore();
  }, [restore]);

  const hasStatusSyncWork = reports.some(reportNeedsStatusSync);

  const syncFromNative = useCallback(async () => {
    try {
      await SurvivalCore.triggerDelivery();
    } catch {
      // Native/background delivery remains best-effort; SQLite is still authoritative.
    }
    await restore();
  }, [restore]);

  useEffect(() => {
    if (!hasStatusSyncWork) return;
    const timer = setInterval(() => {
      void syncFromNative();
    }, STATUS_SYNC_INTERVAL_MS);
    if (typeof (timer as unknown as {unref?: () => void}).unref === 'function') {
      (timer as unknown as {unref: () => void}).unref();
    }
    return () => clearInterval(timer);
  }, [hasStatusSyncWork, syncFromNative]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        void syncFromNative();
      }
    });
    return () => subscription.remove();
  }, [syncFromNative]);

  const create = useCallback(async (input: CreateEmergencyReportInput) => {
    setSaving(true);
    setMessage(null);
    let savedReport: EmergencyReportSummary | null = null;
    try {
      savedReport = await SurvivalCore.createEmergencyReport(input);
      setReports(current => [savedReport!, ...current.filter(item => item.reportId !== savedReport!.reportId)]);
      setMessage('SOS saved on this device. You do not need internet.');
    } catch {
      setMessage('SOS was not saved. Please try again.');
      return null;
    } finally {
      setSaving(false);
    }

    // Best-effort delivery plus immediate reconciliation from authoritative SQLite.
    void syncFromNative();
    return savedReport;
  }, [syncFromNative]);

  return {reports, loading, saving, message, create};
}
