import {PermissionsAndroid, Platform} from 'react-native';

import {SurvivalCore} from './SurvivalCore';

export type SosLocationPreparation =
  | 'STARTED'
  | 'DENIED'
  | 'UNAVAILABLE';

async function hasAndroidLocationPermission(): Promise<boolean> {
  const [fine, coarse] = await Promise.all([
    PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ),
    PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
    ),
  ]);
  return fine || coarse;
}

async function requestAndroidLocationPermission(): Promise<boolean> {
  const results = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  ]);
  return (
    results[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] ===
      PermissionsAndroid.RESULTS.GRANTED ||
    results[PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION] ===
      PermissionsAndroid.RESULTS.GRANTED
  );
}

export async function prepareSosLocation(
  requestPermission: boolean,
): Promise<SosLocationPreparation> {
  if (Platform.OS !== 'android') {
    return 'UNAVAILABLE';
  }

  try {
    let granted = await hasAndroidLocationPermission();
    if (!granted && requestPermission) {
      granted = await requestAndroidLocationPermission();
    }
    if (!granted) {
      return 'DENIED';
    }

    return (await SurvivalCore.primeLocation()) ? 'STARTED' : 'UNAVAILABLE';
  } catch {
    return 'UNAVAILABLE';
  }
}
