import {useCallback, useEffect, useRef, useState} from 'react';
import {AppState} from 'react-native';

import {SurvivalCore} from './SurvivalCore';
import type {
  AppendEmergencyDetailsInput,
  CreateEmergencyReportInput,
  EmergencyReportSummary,
} from './types';

const STATUS_SYNC_INTERVAL_MS = 10_000;
const LOAD_ERROR = 'Saved SOS reports could not be loaded.';

export function reportIsResolved(report: EmergencyReportSummary): boolean {
  return report.serverStatus?.status === 'RESOLVED' ||
    (report.verifiedReceipt?.status === 'RESOLVED' && report.verifiedReceipt.revision === (report.revision ?? 1));
}

/** Match the native repository's canonical newest-active ordering, including legacy history. */
export function activeEmergencyReport(reports: EmergencyReportSummary[]): EmergencyReportSummary | undefined {
  return reports.filter(report => !reportIsResolved(report)).sort((a, b) =>
    b.createdAt - a.createdAt || (a.reportId < b.reportId ? 1 : a.reportId > b.reportId ? -1 : 0),
  )[0];
}

export function reportNeedsStatusSync(report: EmergencyReportSummary): boolean {
  const states = [report.deliveryState, report.originalDelivery?.deliveryState, report.latestDelivery?.deliveryState];
  // Incident closure does not finish history pagination or outstanding envelope delivery.
  if (report.statusSync?.historyPending || states.some(state => state === 'DELIVERY_PENDING' || state === 'RELAYED_TO_PEER')) return true;
  if (reportIsResolved(report)) return false;
  return states.some(state =>
    state === 'DELIVERY_PENDING' || state === 'RELAYED_TO_PEER' || state === 'SERVER_ACCEPTED' ||
    state === 'RESPONDER_ACKNOWLEDGED');
}

export function useEmergencyReports() {
  const [reports, setReports] = useState<EmergencyReportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastLocalReadAt, setLastLocalReadAt] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const restoreGeneration = useRef(0);
  // Keep committed identity current even before React renders an async save result.
  const reportsRef = useRef<EmergencyReportSummary[]>([]);
  const saveInFlight = useRef(false);
  const syncInFlight = useRef(false);

  const restore = useCallback(async () => {
    const generation = ++restoreGeneration.current;
    try {
      const restored = await SurvivalCore.listEmergencyReports();
      if (generation !== restoreGeneration.current) return;
      reportsRef.current = restored;
      setReports(restored);
      setLastLocalReadAt(Date.now());
      setRestoreFailed(false);
      setMessage(current => current === LOAD_ERROR ? null : current);
    } catch {
      if (generation !== restoreGeneration.current) return;
      setRestoreFailed(true);
      setMessage(LOAD_ERROR);
    } finally {
      if (generation === restoreGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    restore();
  }, [restore]);

  const hasStatusSyncWork = restoreFailed || reports.some(reportNeedsStatusSync);

  const syncFromNative = useCallback(async () => {
    if (syncInFlight.current) return;
    syncInFlight.current = true;
    setSyncing(true);
    try {
      try {
        await SurvivalCore.triggerDelivery();
      } catch {
        // Native/background delivery remains best-effort; SQLite is still authoritative.
      }
      await restore();
    } finally {
      syncInFlight.current = false;
      setSyncing(false);
    }
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
    // State updates alone cannot guard two presses in the same render frame.
    if (saveInFlight.current) return null;
    const active = activeEmergencyReport(reportsRef.current);
    if (active) {
      setMessage('SOS already active. Checking saved delivery status.');
      void syncFromNative();
      return active;
    }
    saveInFlight.current = true;
    setSaving(true);
    setMessage(null);
    let savedReport: EmergencyReportSummary | null = null;
    try {
      savedReport = await SurvivalCore.createEmergencyReport(input);
      // A read started before this commit must not erase the committed report.
      restoreGeneration.current += 1;
      setLoading(false);
      reportsRef.current = [savedReport, ...reportsRef.current.filter(item => item.reportId !== savedReport!.reportId)];
      setReports(reportsRef.current);
      setMessage('SOS saved on this device. You do not need internet.');
    } catch {
      setMessage('SOS was not saved. Please try again.');
      return null;
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }

    // Best-effort delivery plus immediate reconciliation from authoritative SQLite.
    void syncFromNative();
    return savedReport;
  }, [syncFromNative]);

  const appendDetails = useCallback(async (reportId: string, input: AppendEmergencyDetailsInput) => {
    if (saveInFlight.current) return null;
    saveInFlight.current = true;
    setSaving(true);
    setMessage(null);
    try {
      const updated = await SurvivalCore.appendEmergencyReportDetails(reportId, input);
      restoreGeneration.current += 1;
      reportsRef.current = reportsRef.current.map(item => item.reportId === reportId ? updated : item);
      setReports(reportsRef.current);
      setMessage('Details saved on this device. Delivery will keep trying.');
      void syncFromNative();
      return updated;
    } catch {
      setMessage('Details were not saved. Your original SOS remains saved. Try again; if its version changed, refresh the version below.');
      void syncFromNative();
      return null;
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }, [syncFromNative]);

  return {reports, loading, saving, syncing, lastLocalReadAt, message, create, appendDetails, refresh: syncFromNative};
}
