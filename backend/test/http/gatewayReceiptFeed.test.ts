import assert from 'node:assert/strict';
import test from 'node:test';
import {handleSagipRequest, type SagipServerDependencies} from '../../src/http/handleRequest.js';
import type {ResponderService} from '../../src/responder/service.js';
import type {GatewayReceiptFeed} from '../../src/responder/gatewayReceiptFeed.js';
import type {ReceiptService} from '../../src/responder/receiptService.js';
const rid = '22222222-2222-4222-8222-222222222222';
const actor = {responderId: '33333333-3333-4333-8333-333333333333', callsign: 'TEST', role: 'RESPONDER', registeredAt: ''};
function deps(): SagipServerDependencies & {calls: number} {
  const result = {
    calls: 0, ingestEnvelope: async () => {throw new Error('unused');},
    responderService: {authenticate: async (token: string) => token === 'test' ? actor : null} as unknown as ResponderService,
    gatewayReceiptFeed: {list: async (report: string, cursor: string | null, who: typeof actor) => {
      result.calls++;
      assert.equal(report, rid); assert.equal(who, actor);
      return {entries: [], nextCursor: cursor};
    }} as unknown as GatewayReceiptFeed,
  };
  return result;
}
const request = (suffix = '', authenticated = true, method = 'GET') => new Request(
  'https://sagip.example/v2/responder/reports/' + rid + '/receipts' + suffix,
  {method, headers: authenticated ? {authorization: 'Bearer test'} : {}},
);
test('gateway feed route stays disabled without adapter and requires authentication', async () => {
  const d = deps();
  const disabled = {...d};
  delete disabled.gatewayReceiptFeed;
  assert.equal((await handleSagipRequest(request(), disabled)).status, 501);
  assert.equal((await handleSagipRequest(request('', false), d)).status, 401);
  assert.equal(d.calls, 0);
  assert.equal((await handleSagipRequest(request('', true, 'POST'), d)).status, 405);
});
test('gateway route validates query bounds and returns no-store original feed shape', async () => {
  const d = deps();
  for (const suffix of ['?cursor=', '?cursor=x', '?cursor=' + 'f'.repeat(65), '?other=x',
    '?cursor=' + 'f'.repeat(64) + '&cursor=' + 'f'.repeat(64)]) {
    assert.equal((await handleSagipRequest(request(suffix), d)).status, 400);
  }
  assert.equal(d.calls, 0);
  const response = await handleSagipRequest(request('?cursor=' + 'a'.repeat(64)), d);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {entries: [], nextCursor: 'a'.repeat(64)});
});
test('scope denial is explicit and responder bearer cannot read origin receipt route', async () => {
  const d = deps();
  d.gatewayReceiptFeed = {list: async () => {throw new Error('SCOPE_DENIED');}} as unknown as GatewayReceiptFeed;
  const response = await handleSagipRequest(request(), d);
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), {error: 'SCOPE_DENIED'});
  d.receiptService = {listReportReceipts: async () => {throw new Error('MUST_NOT_BYPASS_OWNER');}} as unknown as ReceiptService;
  const origin = await handleSagipRequest(new Request(
    'https://sagip.example/v2/reports/' + rid + '/receipts',
    {headers: {authorization: 'Bearer test'}},
  ), d);
  assert.equal(origin.status, 401);
  assert.deepEqual(await origin.json(), {error: 'SESSION_REQUIRED'});
});
