import {readFileSync} from 'node:fs';

import {expect, test} from '@playwright/test';

const ORIGIN = 'https://sagip.test';
const moduleNames = [
  'consoleStore.js',
  'consoleTypes.js',
  'incidentSnapshot.js',
  'actionCodec.js',
  'actionOutbox.js',
];
const modules = new Map(moduleNames.map(name => [
  `/${name}`,
  readFileSync(new URL(`../../.generated/responder-browser/${name}`, import.meta.url), 'utf8'),
]));

test('C06 software outage/restart/reconnect keeps snapshot and exact pending action until provider evidence', async ({page}) => {
  await page.route(`${ORIGIN}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/fixture') {
      await route.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html><title>C06 fixture</title>'});
      return;
    }
    const body = modules.get(pathname);
    await route.fulfill(body === undefined ? {status: 404, body: 'not found'} : {
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      body,
    });
  });
  await page.goto(`${ORIGIN}/fixture`);

  const result = await page.evaluate(async () => {
    const consoleStorePath = '/consoleStore.js';
    const incidentSnapshotPath = '/incidentSnapshot.js';
    const actionOutboxPath = '/actionOutbox.js';
    const {ConsoleStore} = await import(consoleStorePath);
    const {syncSnapshot} = await import(incidentSnapshotPath);
    const {ActionOutbox} = await import(actionOutboxPath);

    const browserIndexedDb = (globalThis as unknown as {
      indexedDB: {deleteDatabase(name: string): {
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onblocked: (() => void) | null;
      }};
    }).indexedDB;
    const dbName = 'sagip-responder-console-v1';
    const removeDb = () => new Promise<void>(resolve => {
      const request = browserIndexedDb.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
    await removeDb();

    const responderId = '33333333-3333-4333-8333-333333333333';
    const providerId = new Uint8Array(32).fill(7);
    const providerKey = [...providerId].map(value => value.toString(16).padStart(2, '0')).join('');
    const unlock = (store: InstanceType<typeof ConsoleStore>) => store.unlock({
      responderId,
      providerKey,
      earliestMs: 1_000,
      latestMs: 1_001,
      validUntilMs: 9_999_999_999_999,
      bootId: '66666666-6666-4666-8666-666666666666',
      receivedElapsedMs: performance.now(),
    });

    const entry = (index: number, location: {latitude:number;longitude:number}|null) => ({
      reportId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      reportProtocolVersion: 1 as const,
      revision: 1,
      payloadDigest: new Uint8Array(32).fill(index + 1),
      originKeyId: new Uint8Array(32).fill(20 + index),
      observedIncidentVersion: '1',
      emergencyType: index === 0 ? 'FLOOD' : 'MEDICAL',
      urgency: index === 0 ? 'IMMEDIATE_DANGER' : 'NEED_ASSISTANCE',
      location: location ? {...location, accuracyMeters:null, capturedAtMs:1_790_000_000_000, source:'GPS', freshness:'FRESH'} : null,
      reportCreatedAtMs: 1_790_000_000_000 + index,
      receivedAtMs: 1_790_000_001_000 + index,
      syncedAtMs: 1_790_000_002_000,
      receiptEvidence: [],
      pendingActions: [],
      latestAck: null,
      revisions: [],
      acknowledgements: [],
    });
    const entries = [
      entry(0, {latitude:7.447, longitude:125.807}),
      entry(1, null),
      entry(2, {latitude:7.43, longitude:125.82}),
    ];
    const descriptor = {
      snapshotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAtMs: 1_790_000_002_000,
      expiresAtMs: 1_790_000_902_000,
      total: entries.length,
      summary: {total:3,pending:3,immediateDanger:1,missingLocation:1},
      nextCursor: 'page-a',
    };

    let providerCommitted: {
      actionId:string;
      issuerProviderId:Uint8Array;
      actionDigest:Uint8Array;
      state:'SIGNED';
      eventDigest:string;
      reason:null;
    } | null = null;
    let commitCalls = 0;
    const provider = {
      providerKind: 2 as const,
      providerId,
      responderId,
      async createSnapshot() { return descriptor; },
      async readSnapshotPage() { return {...descriptor, entries, nextCursor:null}; },
      async commitAction(intent: {actionId:string;issuerProviderId:Uint8Array;actionDigest:Uint8Array}) {
        commitCalls += 1;
        providerCommitted = {
          actionId:intent.actionId,
          issuerProviderId:intent.issuerProviderId.slice(),
          actionDigest:intent.actionDigest.slice(),
          state:'SIGNED',
          eventDigest:'cd'.repeat(32),
          reason:null,
        };
        if (commitCalls === 1) throw new Error('simulated lost response');
        return providerCommitted;
      },
      async getAction() { return providerCommitted; },
      async getActionReceipt() { return null; },
      async fetchTimeProof() { throw new Error('unused'); },
      async logout() { return new Response(null,{status:204}); },
    };

    const firstStore = await ConsoleStore.open();
    unlock(firstStore);
    const snapshotSync = await syncSnapshot(provider, firstStore, 'tagum-software-fixture');
    const firstSnapshot = await firstStore.readSnapshot();
    const outbox = new ActionOutbox(firstStore, provider);
    const target = firstSnapshot!.entries[0]!;
    const queued = await outbox.queue({
      providerKind: 2,
      issuerProviderId: providerId,
      reportId: target.reportId,
      reportProtocolVersion: target.reportProtocolVersion,
      revision: target.revision,
      payloadDigest: target.payloadDigest,
      originKeyId: target.originKeyId,
      responderId,
      observedIncidentVersion: target.observedIncidentVersion,
      status: 2,
      note: 'Team dispatched during outage',
    });
    const lost = await outbox.drain();
    const pendingBeforeRestart = await firstStore.pendingIntentCount();
    firstStore.close();

    const restartedStore = await ConsoleStore.open();
    unlock(restartedStore);
    const reopenedSnapshot = await restartedStore.readSnapshot();
    const restartedOutbox = new ActionOutbox(restartedStore, provider);
    const reconciled = await restartedOutbox.drain();
    const pendingAfterReconnect = await restartedStore.pendingIntentCount();
    const intents = await restartedStore.listIntents();
    restartedStore.close();
    await removeDb();

    return {
      snapshotSync,
      firstCount:firstSnapshot?.entries.length,
      missingLocation:firstSnapshot?.entries.filter((item:{location:unknown}) => item.location === null).length,
      queuedKind:queued.kind,
      queuedActionId:queued.kind === 'SAVED_LOCAL' ? queued.actionId : null,
      lost,
      pendingBeforeRestart,
      reopenedSnapshotId:reopenedSnapshot?.snapshotId,
      reopenedCount:reopenedSnapshot?.entries.length,
      reconciled,
      pendingAfterReconnect,
      finalIntentState:intents[0]?.state,
      finalActionId:intents[0]?.actionId,
      commitCalls,
    };
  });

  expect(result.snapshotSync.kind).toBe('COMPLETE');
  expect(result.firstCount).toBe(3);
  expect(result.missingLocation).toBe(1);
  expect(result.queuedKind).toBe('SAVED_LOCAL');
  expect(result.lost.remaining).toBe(1);
  expect(result.pendingBeforeRestart).toBe(1);
  expect(result.reopenedSnapshotId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  expect(result.reopenedCount).toBe(3);
  expect(result.reconciled.committed).toBe(1);
  expect(result.pendingAfterReconnect).toBe(0);
  expect(result.finalIntentState).toBe('PROVIDER_COMMITTED');
  expect(result.finalActionId).toBe(result.queuedActionId);
  expect(result.commitCalls).toBe(1);
});
