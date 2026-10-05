import {GatewayCore} from '../GatewayCore';

jest.mock('react-native', () => ({NativeModules: {}}));

test('missing native gateway rejects lock asynchronously so close and unmount stay safe', async () => {
  let result!: Promise<void>;
  expect(() => {result = GatewayCore.lock();}).not.toThrow();
  await expect(result).rejects.toThrow('Responder workspace requires Android');
});
