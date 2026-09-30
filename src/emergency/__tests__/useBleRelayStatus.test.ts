import {PermissionsAndroid} from 'react-native';

import {
  relayNeedsAutomaticStart,
  relayPermissionsForApi,
} from '../useBleRelayStatus';

describe('relayPermissionsForApi', () => {
  it('uses fine location for BLE scanning through Android 11', () => {
    expect(relayPermissionsForApi(30)).toEqual([
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ]);
  });

  it('uses Nearby devices permissions on Android 12 and later', () => {
    expect(relayPermissionsForApi(31)).toEqual([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
  });
});

describe('relayNeedsAutomaticStart', () => {
  const ready = {
    availability: 'READY' as const,
    isSupported: true,
    permissionGranted: true,
    bluetoothEnabled: true,
    isScanning: false,
    isAdvertising: false,
    isDutyCyclePaused: false,
    peerCount: 0,
    heldRelayCount: 0,
    pendingForwardCount: 0,
  };

  it('starts a fully ready but inactive relay', () => {
    expect(relayNeedsAutomaticStart(ready)).toBe(true);
  });

  it('does not restart an active or duty-cycle-paused relay', () => {
    expect(relayNeedsAutomaticStart({...ready, isScanning: true})).toBe(false);
    expect(relayNeedsAutomaticStart({...ready, isAdvertising: true})).toBe(false);
    expect(relayNeedsAutomaticStart({...ready, isDutyCyclePaused: true})).toBe(false);
  });

  it('does not start without permission or Bluetooth', () => {
    expect(relayNeedsAutomaticStart({...ready, permissionGranted: false})).toBe(false);
    expect(relayNeedsAutomaticStart({...ready, bluetoothEnabled: false})).toBe(false);
  });
});
