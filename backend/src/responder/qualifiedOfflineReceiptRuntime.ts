import type {Pool} from 'pg';
import {configuredOfflineReceiptAdapter} from './configuredReceiptSigner.js';
import {createOfflineReceiptRuntime, offlineReceiptRuntimeMode,
  type OfflineReceiptRuntime, type OfflineReceiptRuntimeAdapter} from './offlineReceiptRuntime.js';
import type {RoughtimeClock} from './roughtimeClock.js';

export type ConfiguredOfflineReceiptTrust = Omit<OfflineReceiptRuntimeAdapter,
  'signer' | 'offlineRoot' | 'qualifiedTime' | 'isQualified'> & {
    offlineRoot: Omit<NonNullable<OfflineReceiptRuntimeAdapter['offlineRoot']>, 'checkpointSigner'>;
  };
/** Only explicitly configured bootstrap calls this; no key creation or automatic registry enrollment. */
export async function createQualifiedOfflineReceiptRuntime(
  pool: Pick<Pool, 'connect'>, env: Readonly<Record<string, string | undefined>>,
  trusted: ConfiguredOfflineReceiptTrust,
  clock: Pick<RoughtimeClock, 'refresh' | 'isQualified' | 'time'>,
): Promise<OfflineReceiptRuntime> {
  if (offlineReceiptRuntimeMode(env) === 'DISABLED') return {};
  const adapter = configuredOfflineReceiptAdapter(env, {...trusted,
    isQualified: () => clock.isQualified(), qualifiedTime: () => clock.time()});
  // Construction never contacts the clock provider or blocks unrelated SOS ingestion.
  const runtime = createOfflineReceiptRuntime(pool, env, adapter, true);
  return {...runtime, refreshAuthorityTime: async () => {
    if (!clock.isQualified()) await clock.refresh();
    if (!clock.isQualified()) throw new Error('TIME_UNAVAILABLE');
  }};
}
