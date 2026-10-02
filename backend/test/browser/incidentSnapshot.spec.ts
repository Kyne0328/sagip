import {readFileSync} from 'node:fs';

import {expect, test} from '@playwright/test';

const ORIGIN = 'https://sagip.test';
const moduleNames = ['consoleStore.js', 'consoleTypes.js', 'incidentSnapshot.js'];
const modules = new Map(moduleNames.map(name => [
  `/${name}`,
  readFileSync(new URL(`../../.generated/responder-browser/${name}`, import.meta.url), 'utf8'),
]));

test('complete 205-incident snapshot activates atomically and failed replacement preserves it', async ({page}) => {
  await page.route(`${ORIGIN}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/fixture') {
      await route.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html><title>C03 fixture</title>'});
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
    const snapshotPath = '/incidentSnapshot.js';
    const {ConsoleStore} = await import(consoleStorePath);
    const {syncSnapshot} = await import(snapshotPath);
    const providerId = new Uint8Array(32).fill(4);
    const responderId = '33333333-3333-4333-8333-333333333333';
    const providerKey = [...providerId].map(value => value.toString(16).padStart(2, '0')).join('');
    const store = await ConsoleStore.open();
    store.unlock({
      responderId, providerKey, earliestMs: 1_000, latestMs: 1_001, validUntilMs: 9_999_999_999_999,
      bootId: '66666666-6666-4666-8666-666666666666', receivedElapsedMs: performance.now(),
    });

    const entry = (index: number) => ({
      reportId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      reportProtocolVersion: 1,
      revision: 1,
      payloadDigest: new Uint8Array(32).fill(1),
      originKeyId: new Uint8Array(32).fill(2),
      observedIncidentVersion: '1',
      emergencyType: index % 2 === 0 ? 'MEDICAL' : 'FIRE',
      urgency: index % 3 === 0 ? 'IMMEDIATE_DANGER' : 'NEED_ASSISTANCE',
      location: index % 17 === 0 ? null : {
        latitude: 7.44 + index / 10000, longitude: 125.80 + index / 10000,
        accuracyMeters: index % 5 === 0 ? null : 5, capturedAtMs: 1_790_000_000_000,
        source: 'GPS', freshness: 'FRESH',
      },
      reportCreatedAtMs: 1_790_000_000_000 + index,
      receivedAtMs: 1_790_000_001_000 + index,
      syncedAtMs: 1_790_000_002_000,
      receiptEvidence: [],
      pendingActions: [],
      latestAck: null,
      revisions: [],
      acknowledgements: [],
    });
    const all = Array.from({length: 205}, (_, index) => entry(index));
    const summary = {total: 205, pending: 205, immediateDanger: 69, missingLocation: 13};
    const descriptor = {
      snapshotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAtMs: 1_790_000_002_000,
      expiresAtMs: 1_790_000_902_000,
      total: 205, summary, nextCursor: 'page-0',
    };
    const pages = new Map([
      ['page-0', {...descriptor, entries: all.slice(0, 100), nextCursor: 'page-1'}],
      ['page-1', {...descriptor, entries: all.slice(100, 200), nextCursor: 'page-2'}],
      ['page-2', {...descriptor, entries: all.slice(200), nextCursor: null}],
    ]);
    const provider = {
      providerKind: 2, providerId, responderId,
      async createSnapshot() { return descriptor; },
      async readSnapshotPage(_id: string, cursor: string) { return pages.get(cursor); },
      async commitAction() { throw new Error('unused'); },
      async getAction() { return null; },
      async getActionReceipt() { return null; },
      async fetchTimeProof() { throw new Error('unused'); },
    };
    const first = await syncSnapshot(provider, store, 'tagum-fixture');

    const brokenDescriptor = {...descriptor, snapshotId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', nextCursor: 'broken-0'};
    const brokenProvider = {
      ...provider,
      async createSnapshot() { return brokenDescriptor; },
      async readSnapshotPage() { return {...brokenDescriptor, entries: all.slice(0, 100), nextCursor: null}; },
    };
    const replacement = await syncSnapshot(brokenProvider, store, 'tagum-fixture-2');
    const active = await store.readSnapshot();
    store.close();
    return {
      first,
      replacement,
      activeId: active?.snapshotId,
      activeCount: active?.entries.length,
      missingLocation: active?.entries.filter((item: {location: unknown}) => item.location === null).length,
    };
  });

  expect(result.first).toEqual({
    kind: 'COMPLETE',
    snapshotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    count: 205,
    total: 205,
  });
  expect(result.replacement).toEqual({kind: 'INCOMPLETE', reason: 'COUNT_MISMATCH'});
  expect(result.activeId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  expect(result.activeCount).toBe(205);
  expect(result.missingLocation).toBe(13);
});
