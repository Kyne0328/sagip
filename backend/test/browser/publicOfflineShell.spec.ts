import {expect, test} from '@playwright/test';

import {handleSagipRequest} from '../../src/http/handleRequest.js';
import {
  RESPONDER_BROWSER_ASSET_PATHS,
  RESPONDER_MAP_ASSET_PATHS,
} from '../../src/responder/consoleAssets.js';

const ORIGIN = 'https://sagip.test';
const deps = {
  ingestEnvelope: async () => {
    throw new Error('not used');
  },
};

test('public responder shell and map runtime remain available offline without caching protected routes', async ({
  page,
  context,
}) => {
  await context.route(`${ORIGIN}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/responder/offline-test') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><title>SAGIP offline shell fixture</title>',
      });
      return;
    }

    const response = await handleSagipRequest(
      new Request(request.url(), {method: request.method()}),
      deps,
    );
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });

  await page.goto(`${ORIGIN}/responder/offline-test`);

  const registrationScope = await page.evaluate(async serviceWorkerPath => {
    const serviceWorker = (navigator as unknown as {
      serviceWorker: {
        register(path: string, options: {scope: string}): Promise<{scope: string}>;
        ready: Promise<unknown>;
        controller: unknown;
        addEventListener(
          type: string,
          listener: () => void,
          options: {once: boolean},
        ): void;
      };
    }).serviceWorker;
    const registration = await serviceWorker.register(serviceWorkerPath, {
      scope: '/responder/',
    });
    await serviceWorker.ready;

    if (!serviceWorker.controller) {
      await new Promise<void>(resolve => {
        serviceWorker.addEventListener('controllerchange', () => resolve(), {
          once: true,
        });
      });
    }

    return registration.scope;
  }, RESPONDER_BROWSER_ASSET_PATHS.serviceWorker);

  expect(registrationScope).toBe(`${ORIGIN}/responder/`);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (navigator as unknown as {serviceWorker: {controller: unknown}}).serviceWorker
            .controller !== null,
      ),
    )
    .toBe(true);

  await context.unroute(`${ORIGIN}/**`);
  await context.setOffline(true);

  const result = await page.evaluate(async mapModulePath => {
    const mapModule = await fetch(mapModulePath);
    const mapBytes = (await mapModule.arrayBuffer()).byteLength;
    const appScript = await fetch('/responder/app.js');

    let uncachedProtectedRoute = 'unexpected-response';
    try {
      await fetch('/v1/responder/incidents');
    } catch {
      uncachedProtectedRoute = 'network-failed';
    }

    return {
      mapStatus: mapModule.status,
      mapBytes,
      appStatus: appScript.status,
      uncachedProtectedRoute,
    };
  }, RESPONDER_MAP_ASSET_PATHS.maplibreModule);

  expect(result.mapStatus).toBe(200);
  expect(result.mapBytes).toBeGreaterThan(0);
  expect(result.appStatus).toBe(200);
  expect(result.uncachedProtectedRoute).toBe('network-failed');
});
