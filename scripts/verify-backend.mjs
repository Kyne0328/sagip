#!/usr/bin/env node

const args = process.argv.slice(2);
const healthOnly = args.includes('--health-only');
const full = args.includes('--full');
const baseUrlArg = args.find(arg => !arg.startsWith('--'));

if (!baseUrlArg) {
  console.error('Usage: node scripts/verify-backend.mjs <https-base-url> [--health-only|--full]');
  process.exit(2);
}

if (healthOnly && full) {
  console.error('Choose either --health-only or --full, not both.');
  process.exit(2);
}

let baseUrl;
try {
  const parsed = new URL(baseUrlArg);
  if (parsed.protocol !== 'https:') {
    throw new Error('backend verification requires HTTPS');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('backend base URL must not contain credentials, query, or fragment');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  baseUrl = parsed.toString().replace(/\/$/, '');
} catch (error) {
  console.error(`Invalid SAGIP backend URL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

async function request(path, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== expectedStatus) {
    throw new Error(`${path} returned HTTP ${response.status}; expected ${expectedStatus}`);
  }
  return response;
}

try {
  const health = await request('/healthz', 200);
  const healthText = (await health.text()).trim();
  let healthOk = healthText.toLowerCase() === 'ok';
  if (!healthOk) {
    try {
      healthOk = JSON.parse(healthText)?.status === 'ok';
    } catch {
      healthOk = false;
    }
  }
  if (!healthOk) {
    throw new Error('/healthz returned 200 but did not report an ok status');
  }
  console.log(`OK ${baseUrl}/healthz`);

  if (!healthOnly) {
    const responder = await request('/responder', 200);
    const contentType = responder.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('text/html')) {
      throw new Error('/responder did not return HTML');
    }
    console.log(`OK ${baseUrl}/responder`);

    await request('/v1/incidents?limit=1&offset=0', 401);
    console.log('OK unauthenticated responder API access is rejected with 401');
  }
} catch (error) {
  console.error(`SAGIP backend verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
