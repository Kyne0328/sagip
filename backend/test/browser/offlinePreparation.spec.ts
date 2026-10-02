import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {expect, test} from '@playwright/test';

const ORIGIN = 'https://sagip.test';
const offlinePackageModule = readFileSync(
  fileURLToPath(
    new URL('../../.generated/responder-browser/offlinePackage.js', import.meta.url),
  ),
  'utf8',
);

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('offline map replacement activates only after every resource verifies', async ({page}) => {
  const archiveA = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
  const styleA = new TextEncoder().encode('{"version":8,"sources":{},"layers":[]}');
  const archiveB = new Uint8Array([90, 91, 92, 93, 94, 95]);
  const styleB = new TextEncoder().encode('{"version":8,"name":"replacement"}');

  const resources = new Map<string, Uint8Array>([
    ['/fixtures/a.pmtiles', archiveA],
    ['/fixtures/a-style.json', styleA],
    ['/fixtures/b.pmtiles', archiveB],
    ['/fixtures/b-style.json', styleB],
  ]);

  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/offlinePackage.js') {
      await route.fulfill({
        status: 200,
        contentType: 'text/javascript; charset=utf-8',
        body: offlinePackageModule,
      });
      return;
    }

    if (url.pathname === '/fixture') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><title>SAGIP offline package fixture</title>',
      });
      return;
    }

    const body = resources.get(url.pathname);
    if (!body) {
      await route.fulfill({status: 404, body: 'not found'});
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: url.pathname.endsWith('.pmtiles')
        ? 'application/octet-stream'
        : 'application/json',
      body: Buffer.from(body),
    });
  });

  await page.goto(`${ORIGIN}/fixture`);

  const manifestA = {
    packageId: 'tagum-fixture-a',
    version: 'fixture-a',
    sourceDate: '2026-10-02',
    rights: 'Synthetic test fixture only',
    attribution: 'SAGIP test fixture',
    appShellVersion: 'test-shell',
    extent: [125.7, 7.3, 125.9, 7.6],
    bufferMeters: 0,
    minZoom: 8,
    maxZoom: 14,
    totalBytes: archiveA.byteLength + styleA.byteLength,
    resources: [
      {
        path: '/fixtures/a.pmtiles',
        sha256: digest(archiveA),
        bytes: archiveA.byteLength,
        kind: 'archive',
      },
      {
        path: '/fixtures/a-style.json',
        sha256: digest(styleA),
        bytes: styleA.byteLength,
        kind: 'style',
      },
    ],
  };

  const manifestB = {
    ...manifestA,
    packageId: 'tagum-fixture-b',
    version: 'fixture-b',
    totalBytes: archiveB.byteLength + styleB.byteLength,
    resources: [
      {
        path: '/fixtures/b.pmtiles',
        sha256: digest(archiveB),
        bytes: archiveB.byteLength,
        kind: 'archive',
      },
      {
        path: '/fixtures/b-style.json',
        sha256: '0'.repeat(64),
        bytes: styleB.byteLength,
        kind: 'style',
      },
    ],
  };

  const result = await page.evaluate(
    async ({manifestA, manifestB}) => {
      const storage = (navigator as unknown as {storage: Record<string, unknown>}).storage;
      Object.defineProperty(storage, 'persist', {
        configurable: true,
        value: async () => false,
      });
      const modulePath = '/offlinePackage.js';
      const module = await import(modulePath);
      const first = await module.preparePackage(manifestA);
      const firstReadiness = await module.inspectReadiness();
      const range = Array.from(
        new Uint8Array(await module.readArchiveRange(manifestA.packageId, 2, 4)),
      );

      const replacement = await module.preparePackage(manifestB);
      const afterFailedReplacement = await module.inspectReadiness();

      let outOfRangeRejected = false;
      try {
        await module.readArchiveRange(manifestA.packageId, 7, 2);
      } catch {
        outOfRangeRejected = true;
      }

      return {
        first,
        firstReadiness,
        range,
        replacement,
        afterFailedReplacement,
        outOfRangeRejected,
      };
    },
    {manifestA, manifestB},
  );

  expect(result.first.kind).toBe('READY');
  expect(result.first.persistentStorage).toBe(false);
  expect(result.firstReadiness.kind).toBe('READY');
  expect(result.firstReadiness.packageId).toBe('tagum-fixture-a');
  expect(result.range).toEqual([30, 40, 50, 60]);

  expect(result.replacement).toEqual({
    kind: 'INCOMPLETE',
    reason: 'RESOURCE_DIGEST_MISMATCH:/fixtures/b-style.json',
  });
  expect(result.afterFailedReplacement.kind).toBe('READY');
  expect(result.afterFailedReplacement.packageId).toBe('tagum-fixture-a');
  expect(result.outOfRangeRejected).toBe(true);
});

test('offline map preparation reports insufficient storage before fetching package resources', async ({page}) => {
  await page.route(`${ORIGIN}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/offlinePackage.js') {
      await route.fulfill({
        status: 200,
        contentType: 'text/javascript; charset=utf-8',
        body: offlinePackageModule,
      });
      return;
    }
    if (url.pathname === '/fixture') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><title>SAGIP offline quota fixture</title>',
      });
      return;
    }
    await route.fulfill({status: 500, body: 'resource fetch should not occur'});
  });

  await page.goto(`${ORIGIN}/fixture`);

  const result = await page.evaluate(async () => {
    const storage = (navigator as unknown as {storage: Record<string, unknown>}).storage;
    Object.defineProperty(storage, 'estimate', {
      configurable: true,
      value: async () => ({quota: 100, usage: 95}),
    });
    Object.defineProperty(storage, 'persist', {
      configurable: true,
      value: async () => true,
    });

    const modulePath = '/offlinePackage.js';
    const module = await import(modulePath);
    return module.preparePackage({
      packageId: 'tagum-quota-fixture',
      version: 'fixture',
      sourceDate: '2026-10-02',
      rights: 'Synthetic test fixture only',
      attribution: 'SAGIP test fixture',
      appShellVersion: 'test-shell',
      extent: [125.7, 7.3, 125.9, 7.6],
      bufferMeters: 0,
      minZoom: 8,
      maxZoom: 14,
      totalBytes: 8,
      resources: [
        {
          path: '/fixtures/quota.pmtiles',
          sha256: '0'.repeat(64),
          bytes: 8,
          kind: 'archive',
        },
      ],
    });
  });

  expect(result).toEqual({
    kind: 'INSUFFICIENT_STORAGE',
    availableBytes: 5,
    requiredBytes: 8,
  });
});
