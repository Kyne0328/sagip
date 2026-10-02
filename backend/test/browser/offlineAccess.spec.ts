import {readFileSync} from 'node:fs';

import {expect, test} from '@playwright/test';

const ORIGIN = 'https://sagip.test';
const modules = new Map(
  ['consoleStore.js', 'consoleTypes.js', 'offlineAccess.js', 'receiptVerifier.js'].map(name => [
    `/${name}`,
    readFileSync(new URL(`../../.generated/responder-browser/${name}`, import.meta.url), 'utf8'),
  ]),
);
const golden = JSON.parse(
  readFileSync(new URL('../../../sagip-docs/fixtures/receipts-v2/golden.json', import.meta.url), 'utf8'),
);

test.beforeEach(async ({page}) => {
  await page.route(`${ORIGIN}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/fixture') {
      await route.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html><title>C02 fixture</title>'});
      return;
    }
    const body = modules.get(pathname);
    await route.fulfill(body === undefined
      ? {status: 404, body: 'not found'}
      : {status: 200, contentType: 'text/javascript; charset=utf-8', body});
  });
  await page.goto(`${ORIGIN}/fixture`);
});

test('browser time verification matches R01 golden bounds and rejects rollback', async ({page}) => {
  const result = await page.evaluate(async fixture => {
    const hex = (value: string) => {
      const out = new Uint8Array(value.length / 2);
      for (let index = 0; index < out.length; index += 1) {
        out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
      }
      return out;
    };
    const vector = fixture.vectors.find((item: {name: string}) => item.name === 'valid_gateway_time');
    const verifierPath = '/receiptVerifier.js';
    const verifier = await import(verifierPath);
    const context = {
      roots: new Map([[fixture.trustedContext.rootKeyId, hex(fixture.trustedContext.rootPublicKeyDerHex)]]),
      revokedGrants: new Set<string>(),
      allowedScopes: new Set(fixture.trustedContext.allowedScopes),
      pairedTimeProviderId: fixture.trustedContext.gatewayProviderId,
    };
    const base = {
      challengeId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      verifierId: hex(fixture.trustedContext.challenge.verifierId),
      verifierBootSessionId: fixture.trustedContext.challenge.verifierBootSessionId,
      nonce: hex(fixture.trustedContext.challenge.nonce),
      sentElapsedMs: 100,
      currentElapsedMs: 110,
      highWaterEarliestMs: null,
    };
    const accepted = await verifier.verifyTimeProof(hex(vector.hex), base, context);
    const rollback = await verifier.verifyTimeProof(hex(vector.hex), {
      ...base,
      highWaterEarliestMs: fixture.trustedContext.authorityCheckedAtMs + 9890,
    }, context);
    const wrongBoot = await verifier.verifyTimeProof(hex(vector.hex), {
      ...base,
      verifierBootSessionId: '88888888-8888-4888-8888-888888888888',
    }, context);
    return {accepted, rollback, wrongBoot};
  }, golden);

  expect(result.accepted.kind).toBe('ACCEPTED');
  expect(result.accepted.checkpoint.earliestMs).toBe(golden.trustedContext.authorityCheckedAtMs + 9889);
  expect(result.rollback).toEqual({kind: 'REJECTED', reason: 'TIME_ROLLBACK'});
  expect(result.wrongBoot.kind).toBe('REJECTED');
});

test('protected store starts locked, preserves high-water, reserves intent capacity, and refuses missing UV', async ({page}) => {
  const result = await page.evaluate(async fixture => {
    const hex = (value: string) => {
      const out = new Uint8Array(value.length / 2);
      for (let index = 0; index < out.length; index += 1) {
        out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
      }
      return out;
    };
    const browserIndexedDb = (globalThis as unknown as {indexedDB: {deleteDatabase(name: string): {onsuccess: (() => void) | null; onerror: (() => void) | null; onblocked: (() => void) | null}}}).indexedDB;
    const removeDb = () => new Promise<void>(resolve => {
      const request = browserIndexedDb.deleteDatabase('sagip-responder-console-v1');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
    await removeDb();

    const consoleStorePath = '/consoleStore.js';
    const offlineAccessPath = '/offlineAccess.js';
    const {ConsoleStore} = await import(consoleStorePath);
    const {unlockOffline} = await import(offlineAccessPath);
    const responderId = '33333333-3333-4333-8333-333333333333';
    const providerKey = fixture.trustedContext.gatewayProviderId;
    const providerId = hex(providerKey);
    const store = await ConsoleStore.open({totalProtectedBytes: 16 * 1024, intentReservedBytes: 4 * 1024});

    let lockedRead = false;
    try { await store.readSnapshot(); } catch { lockedRead = true; }

    const highWaterFirst = await store.commitTimeHighWater(200);
    const highWaterRollback = await store.commitTimeHighWater(199);
    store.unlock({
      responderId,
      providerKey,
      earliestMs: 1_790_812_810_000,
      latestMs: 1_790_812_810_100,
      validUntilMs: 1_791_417_600_000,
      bootId: '66666666-6666-4666-8666-666666666666',
      receivedElapsedMs: performance.now(),
    });

    const makeIntent = (id: string, fill: number) => ({
      actionId: id,
      providerKind: 2,
      issuerProviderId: providerId,
      reportId: '22222222-2222-4222-8222-222222222222',
      reportProtocolVersion: 1,
      revision: 1,
      payloadDigest: hex(fixture.trustedContext.payloadDigest),
      originKeyId: hex(fixture.trustedContext.originKeyId),
      responderId,
      observedIncidentVersion: '1',
      status: 1,
      note: String(fill).repeat(700),
      actionDigest: new Uint8Array(32).fill(fill),
    });

    const firstId = '10000000-0000-4000-8000-000000000001';
    const first = await store.saveIntent(makeIntent(firstId, 1), providerKey);
    let full = false;
    for (let index = 2; index < 20; index += 1) {
      const id = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const saved = await store.saveIntent(makeIntent(id, index), providerKey);
      if (saved.kind === 'FULL') { full = true; break; }
    }
    const firstStillThere = (await store.getIntent(firstId))?.actionId === firstId;

    let timeFetches = 0;
    const denied = await unlockOffline({
      store,
      provider: {
        providerKind: 2,
        providerId,
        responderId,
        async createSnapshot() { throw new Error('unused'); },
        async readSnapshotPage() { throw new Error('unused'); },
        async commitAction() { throw new Error('unused'); },
        async getAction() { return null; },
        async getActionReceipt() { return null; },
        async fetchTimeProof() { timeFetches += 1; throw new Error('must not fetch'); },
      },
      verificationContext: {
        roots: new Map(),
        revokedGrants: new Set(),
        allowedScopes: new Set(),
        pairedTimeProviderId: providerKey,
      },
      verifierId: new Uint8Array(32),
      verifierBootSessionId: '77777777-7777-4777-8777-777777777777',
      verifyLocalUser: async () => false,
    });

    store.lock();
    let lockedAgain = false;
    try { await store.listIntents(); } catch { lockedAgain = true; }
    store.close();

    const reopened = await ConsoleStore.open();
    let reloadLocked = false;
    try { await reopened.listIntents(); } catch { reloadLocked = true; }
    const highWaterAfterReload = await reopened.readTimeHighWater();
    reopened.close();
    await removeDb();

    return {
      lockedRead, highWaterFirst, highWaterRollback, first, full, firstStillThere,
      denied, timeFetches, lockedAgain, reloadLocked, highWaterAfterReload,
    };
  }, golden);

  expect(result.lockedRead).toBe(true);
  expect(result.highWaterFirst).toBe(true);
  expect(result.highWaterRollback).toBe(false);
  expect(result.first.kind).toBe('SAVED');
  expect(result.full).toBe(true);
  expect(result.firstStillThere).toBe(true);
  expect(result.denied).toEqual({kind: 'LOCKED', reason: 'USER_VERIFICATION_REQUIRED'});
  expect(result.timeFetches).toBe(0);
  expect(result.lockedAgain).toBe(true);
  expect(result.reloadLocked).toBe(true);
  expect(result.highWaterAfterReload).toBe(200);
});
