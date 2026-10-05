import {PermissionsAndroid} from 'react-native';

import {SurvivalCore} from '../SurvivalCore';
import {prepareSosLocation} from '../prepareSosLocation';

jest.mock('react-native', () => ({
  Platform: {OS: 'android'},
  PermissionsAndroid: {
    PERMISSIONS: {
      ACCESS_FINE_LOCATION: 'android.permission.ACCESS_FINE_LOCATION',
      ACCESS_COARSE_LOCATION: 'android.permission.ACCESS_COARSE_LOCATION',
    },
    RESULTS: {
      GRANTED: 'granted',
      DENIED: 'denied',
      NEVER_ASK_AGAIN: 'never_ask_again',
    },
    check: jest.fn(),
    requestMultiple: jest.fn(),
  },
}));

jest.mock('../SurvivalCore', () => ({
  SurvivalCore: {
    primeLocation: jest.fn(),
  },
}));

const check = PermissionsAndroid.check as jest.Mock;
const requestMultiple = PermissionsAndroid.requestMultiple as jest.Mock;
const primeLocation = SurvivalCore.primeLocation as jest.Mock;

describe('prepareSosLocation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    primeLocation.mockResolvedValue(true);
  });

  it('warms location immediately when permission already exists', async () => {
    check
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(prepareSosLocation(true)).resolves.toBe('STARTED');
    expect(requestMultiple).not.toHaveBeenCalled();
    expect(primeLocation).toHaveBeenCalledTimes(1);
  });

  it('accepts approximate location permission and warms the native provider', async () => {
    check.mockResolvedValue(false);
    requestMultiple.mockResolvedValue({
      [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]:
        PermissionsAndroid.RESULTS.DENIED,
      [PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION]:
        PermissionsAndroid.RESULTS.GRANTED,
    });

    await expect(prepareSosLocation(true)).resolves.toBe('STARTED');
    expect(primeLocation).toHaveBeenCalledTimes(1);
  });

  it('does not block SOS flow when location permission is denied', async () => {
    check.mockResolvedValue(false);
    requestMultiple.mockResolvedValue({
      [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]:
        PermissionsAndroid.RESULTS.DENIED,
      [PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION]:
        PermissionsAndroid.RESULTS.DENIED,
    });

    await expect(prepareSosLocation(true)).resolves.toBe('DENIED');
    expect(primeLocation).not.toHaveBeenCalled();
  });

  it('contains a permission check failure during best-effort startup', async () => {
    check.mockRejectedValue(new Error('Permission service unavailable'));
    await expect(prepareSosLocation(false)).resolves.toBe('UNAVAILABLE');
    expect(primeLocation).not.toHaveBeenCalled();
  });

  it('contains a permission prompt failure without interrupting SOS entry', async () => {
    check.mockResolvedValue(false);
    requestMultiple.mockRejectedValue(new Error('Activity unavailable'));
    await expect(prepareSosLocation(true)).resolves.toBe('UNAVAILABLE');
    expect(primeLocation).not.toHaveBeenCalled();
  });

  it('does not prompt during silent startup warm-up', async () => {
    check.mockResolvedValue(false);

    await expect(prepareSosLocation(false)).resolves.toBe('DENIED');
    expect(requestMultiple).not.toHaveBeenCalled();
    expect(primeLocation).not.toHaveBeenCalled();
  });
});
