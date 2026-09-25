import {useCallback, useEffect, useState} from 'react';
import {PermissionsAndroid, Platform} from 'react-native';

import {SurvivalCore} from './SurvivalCore';
import type {BleRelayStatus} from './types';

const RELAY_STATUS_REFRESH_MS = 10_000;

export function relayPermissionsForApi(apiLevel: number) {
  return apiLevel >= 31
    ? [
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]
    : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
}

async function requestBleRelayPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return false;
  }

  const apiLevel =
    typeof Platform.Version === 'number'
      ? Platform.Version
      : Number.parseInt(String(Platform.Version), 10);

  const requiredPermissions = relayPermissionsForApi(apiLevel);

  const results = await PermissionsAndroid.requestMultiple(requiredPermissions);
  return requiredPermissions.every(
    permission => results[permission] === PermissionsAndroid.RESULTS.GRANTED,
  );
}

export function useBleRelayStatus() {
  const [status, setStatus] = useState<BleRelayStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await SurvivalCore.getRelayStatus());
    } catch {
      setStatus({
        availability: 'UNKNOWN',
        isSupported: false,
        permissionGranted: false,
        bluetoothEnabled: false,
        isScanning: false,
        isAdvertising: false,
        isDutyCyclePaused: false,
        peerCount: 0,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, RELAY_STATUS_REFRESH_MS);
    if (typeof (timer as unknown as {unref?: () => void}).unref === 'function') {
      (timer as unknown as {unref: () => void}).unref();
    }
    return () => clearInterval(timer);
  }, [refresh]);

  const enable = useCallback(async () => {
    setRequesting(true);
    try {
      let permissionGranted = status?.permissionGranted === true;
      if (!permissionGranted) {
        permissionGranted = await requestBleRelayPermissions();
      }
      if (!permissionGranted) {
        await refresh();
        return false;
      }

      const started = await SurvivalCore.startBleRelay();
      await refresh();
      return started;
    } catch {
      await refresh();
      return false;
    } finally {
      setRequesting(false);
    }
  }, [refresh, status?.permissionGranted]);

  return {
    status,
    loading,
    requesting,
    enable,
    refresh,
  };
}
