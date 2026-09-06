import {useCallback, useEffect, useState} from 'react';

import {SurvivalCore} from './SurvivalCore';
import type {
  CreateEmergencyReportInput,
  EmergencyReportSummary,
} from './types';

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

  const hasPending = reports.some(item => item.deliveryState === 'DELIVERY_PENDING');

  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => {
      SurvivalCore.triggerDelivery()
        .then(count => {
          if (count > 0) {
            restore();
          }
        })
        .catch(() => {});
    }, 10_000);
    if (typeof (timer as unknown as {unref?: () => void}).unref === 'function') {
      (timer as unknown as {unref: () => void}).unref();
    }
    return () => clearInterval(timer);
  }, [hasPending, restore]);

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

    // Best-effort background delivery trigger after durable local save
    try {
      SurvivalCore.triggerDelivery()
        .then(count => {
          if (count > 0) {
            restore();
          }
        })
        .catch(() => {});
    } catch {
      // Best-effort; background sync will retry when connected
    }
    return savedReport;
  }, [restore]);

  return {reports, loading, saving, message, create};
}
