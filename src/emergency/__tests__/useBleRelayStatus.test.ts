import {PermissionsAndroid} from 'react-native';

import {relayPermissionsForApi} from '../useBleRelayStatus';

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
