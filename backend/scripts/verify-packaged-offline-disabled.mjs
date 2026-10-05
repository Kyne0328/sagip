import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// This gate may only use the disposable database created by start-test-postgres.sh.
// Never inherit production connection strings, authority settings or signing keys.
const backendRoot = fileURLToPath(new URL('../', import.meta.url));
const self = fileURLToPath(import.meta.url);
function testDatabase(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Isolated test database is required'); }
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55432');
  assert.equal(url.username, 'sagip_test');
  assert.equal(url.pathname, '/sagip_test');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  assert.ok(url.password.length > 0);
  return value;
}
function isolatedEnvironment(database) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.DATABASE_URL = database;
  return env;
}
function run(args, env) {
  const result = spawnSync(process.execPath, args, {
    cwd: backendRoot, env, encoding: 'utf8', timeout: 120000,
  });
  // Do not include process errors or inherited configuration in failure output.
  assert.equal(result.status, 0, 'Packaged default-off validation failed');
  if (result.stdout) process.stdout.write(result.stdout);
}

const selectedCase = process.argv[2];
if (selectedCase === undefined) {
  const database = testDatabase(process.env.SAGIP_TEST_DATABASE_URL);
  const env = isolatedEnvironment(database);
  run(['--import', 'tsx', 'src/migrate.ts'], env);
  run([self, 'default-disabled'], env);
  run([self, 'missing-adapter-config'], {...env, SAGIP_OFFLINE_RECEIPTS_MODE: 'ADAPTER'});
  console.log('PASS packaged default-off gate against isolated PostgreSQL');
} else {
  assert.ok(['default-disabled', 'missing-adapter-config'].includes(selectedCase));
  testDatabase(process.env.DATABASE_URL);
  assert.equal(process.env.SAGIP_OFFLINE_RECEIPTS_CONFIG_JSON, undefined);
  const api = (await import('../.generated/neon-api/index.mjs')).default;
  const health = await api(new Request('http://package.local/healthz'));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {status: 'ok'});
  const id = '11111111-1111-4111-8111-111111111111';
  const checks = [
    ['POST', '/v2/authority/grants'],
    ['POST', `/v2/authority/grants/${id}/revoke`],
    ['GET', '/v2/authority/status'],
    ['POST', '/v2/authority/time'],
    ['POST', `/v2/reports/${id}/authority/time`],
    ['GET', `/v2/responder/reports/${id}/receipts`],
    ['POST', `/v2/reports/${id}/receipt-access/challenges`],
    ['POST', `/v2/reports/${id}/receipt-access`],
    ['GET', `/v2/reports/${id}/receipts`],
    ['POST', '/v2/responder/actions'],
    ['POST', '/v2/responder/receipts/import'],
  ];
  for (const [method, path] of checks) {
    const response = await api(new Request('http://package.local' + path, {method}));
    assert.equal(response.status, 501, `${selectedCase}: ${path}`);
    assert.deepEqual(await response.json(), {error: 'NOT_IMPLEMENTED'});
  }
  console.log(`PASS ${selectedCase}: health200 and ${checks.length} inactive routes501`);
}
