import type {ConsoleStore} from './consoleStore.js';

// Local custody is not canonical resolution. Include durable committed intents
// until the independently accepted incident status becomes RESOLVED in the UI.
export async function pendingResolutionReportIds(store: Pick<ConsoleStore, 'listIntents'>): Promise<string[]> {
  const intents = await store.listIntents();
  return [...new Set(intents.filter(item => item.intent.status === 4).map(item => item.intent.reportId))];
}
