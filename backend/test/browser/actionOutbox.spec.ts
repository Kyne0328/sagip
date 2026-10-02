import {readFileSync} from 'node:fs';

import {expect, test} from '@playwright/test';

const ORIGIN = 'https://sagip.test';
const moduleNames = [
  'consoleStore.js',
  'consoleTypes.js',
  'actionCodec.js',
  'actionOutbox.js',
];
const modules = new Map(moduleNames.map(name => [
  `/${name}`,
  readFileSync(new URL(`../../.generated/responder-browser/${name}`, import.meta.url), 'utf8'),
]));

test('lost response keeps exact fixed-provider intent and reconciles it after restart', async ({page}) => {
  await page.route(`${ORIGIN}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/fixture') {
      await route.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html><title>C04 fixture</title>'});
      return;
    }
    const body = modules.get(pathname);
    await route.fulfill(body === undefined ? {status: 404, body: 'not found'} : {
      status: 200, contentType: 'text/javascript; charset=utf-8', body,
    });
  });
  await page.goto(`${ORIGIN}/fixture`);

  const result = await page.evaluate(async () => {
    const consoleStorePath = '/consoleStore.js';
    const actionOutboxPath = '/actionOutbox.js';
    const {ConsoleStore} = await import(consoleStorePath);
    const {ActionOutbox} = await import(actionOutboxPath);
    const browserIndexedDb = (globalThis as unknown as {
      indexedDB: {deleteDatabase(name: string): {
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onblocked: (() => void) | null;
      }};
    }).indexedDB;
    const removeDb = () => new Promise<void>(resolve => {
      const request = browserIndexedDb.deleteDatabase('sagip-responder-console-v1');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
    await removeDb();

    const responderId = '33333333-3333-4333-8333-333333333333';
    const reportId = '22222222-2222-4222-8222-222222222222';
    const providerId = new Uint8Array(32).fill(9);
    const providerKey = [...providerId].map(value => value.toString(16).padStart(2, '0')).join('');
    let remoteResult: {
      actionId: string;
      issuerProviderId: Uint8Array;
      actionDigest: Uint8Array;
      state: 'SIGNED';
      eventDigest: string;
      reason: null;
    } | null = null;
    let commitAttempts = 0;
    let queryAttempts = 0;
    let logoutCalls = 0;
    let forceUnknownOutcome = false;

    const provider = {
      providerKind: 2 as const,
      providerId,
      responderId,
      async createSnapshot() { throw new Error('unused'); },
      async readSnapshotPage() { throw new Error('unused'); },
      async commitAction(intent: {
        actionId: string;
        issuerProviderId: Uint8Array;
        actionDigest: Uint8Array;
      }) {
        commitAttempts += 1;
        if (forceUnknownOutcome) throw new Error('provider unavailable');
        remoteResult = {
          actionId: intent.actionId,
          issuerProviderId: intent.issuerProviderId.slice(),
          actionDigest: intent.actionDigest.slice(),
          state: 'SIGNED' as const,
          eventDigest: 'ab'.repeat(32),
          reason: null,
        };
        if (commitAttempts === 1) throw new Error('response lost');
        return remoteResult;
      },
      async getAction() {
        queryAttempts += 1;
        return remoteResult;
      },
      async getActionReceipt() { return null; },
      async fetchTimeProof() { throw new Error('unused'); },
      async logout() {
        logoutCalls += 1;
        return new Response(null, {status: 204});
      },
    };

    const unlock = (store: {
      unlock(grant: {
        responderId: string;
        providerKey: string;
        earliestMs: number;
        latestMs: number;
        validUntilMs: number;
        bootId: string;
        receivedElapsedMs: number;
      }): void;
    }) => store.unlock({
      responderId,
      providerKey,
      earliestMs: 1_000,
      latestMs: 1_001,
      validUntilMs: 9_999_999_999_999,
      bootId: '66666666-6666-4666-8666-666666666666',
      receivedElapsedMs: performance.now(),
    });

    const firstStore = await ConsoleStore.open();
    unlock(firstStore);
    const firstOutbox = new ActionOutbox(firstStore, provider);
    const queued = await firstOutbox.queue({
      providerKind: 2,
      issuerProviderId: providerId,
      reportId,
      reportProtocolVersion: 1,
      revision: 1,
      payloadDigest: new Uint8Array(32).fill(1),
      originKeyId: new Uint8Array(32).fill(2),
      responderId,
      observedIncidentVersion: '7',
      status: 2,
      note: 'Boat team dispatched',
    });
    const before = await firstStore.listIntents();
    const firstDrain = await firstOutbox.drain();
    const afterLost = await firstStore.listIntents();
    firstStore.close();

    const secondStore = await ConsoleStore.open();
    unlock(secondStore);
    const secondOutbox = new ActionOutbox(secondStore, provider);
    const secondDrain = await secondOutbox.drain();
    const reconciled = await secondStore.listIntents();

    remoteResult = null;
    forceUnknownOutcome = true;
    const secondQueued = await secondOutbox.queue({
      providerKind: 2,
      issuerProviderId: providerId,
      reportId,
      reportProtocolVersion: 1,
      revision: 1,
      payloadDigest: new Uint8Array(32).fill(1),
      originKeyId: new Uint8Array(32).fill(2),
      responderId,
      observedIncidentVersion: '7',
      status: 3,
      note: 'Arrived at staging point',
    });
    const blockedLogout = await secondOutbox.safeLogout({kind: 'EXPORT_TO_GATEWAY'});
    const pendingBeforeDiscard = await secondStore.pendingIntentCount();
    const discardLogout = await secondOutbox.safeLogout({
      kind: 'DISCARD',
      confirmed: true,
      reason: 'Field test operator confirmed local discard',
    });

    const digestHex = (bytes: Uint8Array) =>
      [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    const snapshot = {
      queued,
      beforeId: before[0]?.actionId,
      beforeDigest: before[0] ? digestHex(before[0].intent.actionDigest) : null,
      beforeProvider: before[0]?.providerKey,
      firstDrain,
      afterLostState: afterLost[0]?.state,
      afterLostId: afterLost[0]?.actionId,
      afterLostDigest: afterLost[0] ? digestHex(afterLost[0].intent.actionDigest) : null,
      secondDrain,
      reconciledState: reconciled[0]?.state,
      reconciledId: reconciled[0]?.actionId,
      reconciledDigest: reconciled[0] ? digestHex(reconciled[0].intent.actionDigest) : null,
      secondQueued,
      blockedLogout,
      pendingBeforeDiscard,
      discardLogout,
      commitAttempts,
      queryAttempts,
      logoutCalls,
    };
    secondStore.close();
    await removeDb();
    return snapshot;
  });

  expect(result.queued.kind).toBe('SAVED_LOCAL');
  expect(result.beforeId).toBe(result.queued.actionId);
  expect(result.afterLostState).toBe('PENDING');
  expect(result.afterLostId).toBe(result.beforeId);
  expect(result.afterLostDigest).toBe(result.beforeDigest);
  expect(result.firstDrain.remaining).toBe(1);
  expect(result.secondDrain.committed).toBe(1);
  expect(result.reconciledState).toBe('PROVIDER_COMMITTED');
  expect(result.reconciledId).toBe(result.beforeId);
  expect(result.reconciledDigest).toBe(result.beforeDigest);
  expect(result.secondQueued.kind).toBe('SAVED_LOCAL');
  expect(result.blockedLogout.kind).toBe('BLOCKED_PENDING_ACTIONS');
  expect(result.pendingBeforeDiscard).toBe(1);
  expect(result.discardLogout).toEqual({kind: 'COMPLETE'});
  expect(result.commitAttempts).toBeGreaterThanOrEqual(3);
  expect(result.logoutCalls).toBe(1);
  expect(result.queryAttempts).toBeGreaterThanOrEqual(3);
});
