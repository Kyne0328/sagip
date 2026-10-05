import assert from 'node:assert/strict';
import test from 'node:test';
import {statusProofHeaders, statusTestIdentity} from '../support/statusProof.js';
import {handleSagipRequest} from '../../src/http/handleRequest.js';
import type {ResponderService} from '../../src/responder/service.js';
import type {ActionIntent, ReceiptService} from '../../src/responder/receiptService.js';
import type {GatewayGrantRequest, GrantProvisioningService, TimeChallenge} from '../../src/responder/grantProvisioning.js';

const responder = {
  responderId: '33333333-3333-4333-8333-333333333333',
  callsign: 'TAGUM-1',
  role: 'RESPONDER',
  registeredAt: new Date(0).toISOString(),
};
const admin = {
  responderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  callsign: 'TAGUM-ADMIN',
  role: 'AUTHORITY_ADMIN',
  registeredAt: new Date(0).toISOString(),
};

function responderService(): ResponderService {
  return {
    authenticate: async (token: string) => token === 'valid-token' ? responder : token === 'valid-admin-token' ? admin : null,
  } as unknown as ResponderService;
}

test('authority JSON routes reject malformed JSON and UTF-8 before service calls', async () => {
  let calls = 0;
  const mustNotRun = async () => { calls += 1; throw new Error('must not run'); };
  const deps = {
    ingestEnvelope: mustNotRun,
    responderService: responderService(),
    authorityService: {
      issueGatewayGrantResult: mustNotRun,
      revokeGrant: mustNotRun,
      issueAuthorityTimeProof: mustNotRun,
    } as unknown as GrantProvisioningService,
    rateLimiter: {isAllowed: () => true},
  };
  for (const path of [
    '/v2/authority/grants',
    '/v2/authority/grants/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/revoke',
    '/v2/authority/time',
  ]) {
    for (const body of [Buffer.from('{'), Buffer.from([0xff])]) {
      const response = await handleSagipRequest(new Request('https://sagip.example' + path, {
        method: 'POST',
        headers: {authorization: 'Bearer valid-admin-token', 'content-type': 'application/json'},
        body,
      }), deps);
      assert.equal(response.status, 400, path);
      assert.deepEqual(await response.json(), {error: 'INVALID_JSON'});
    }
  }
  assert.equal(calls, 0);
});

test('v2 receipt import requires responder authentication and forwards exact signed bytes', async () => {
  const seen: Buffer[] = [];
  const receiptService = {
    importGatewayReceipt: async (bytes: Uint8Array, identity: typeof responder) => {
      seen.push(Buffer.from(bytes));
      assert.equal(identity.responderId, responder.responderId);
      return {
        eventId: '44444444-4444-4444-8444-444444444444',
        issuerProviderId: Buffer.alloc(32, 1),
        eventDigest: 'aa'.repeat(32),
        state: 'IMPORTED' as const,
        projection: 'APPLIED' as const,
        reason: null,
      };
    },
  } as unknown as ReceiptService;
  const deps = {
    ingestEnvelope: async () => {
      throw new Error('unused');
    },
    responderService: responderService(),
    receiptService,
  };
  const bytes = Buffer.from([0x53, 0x47, 0x41, 0x32, 1, 2, 3]);

  const unauthorized = await handleSagipRequest(
    new Request('https://sagip.example/v2/responder/receipts/import', {
      method: 'POST',
      headers: {'content-type': 'application/octet-stream'},
      body: bytes,
    }),
    deps,
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(seen.length, 0);

  const response = await handleSagipRequest(
    new Request('https://sagip.example/v2/responder/receipts/import', {
      method: 'POST',
      headers: {
        authorization: 'Bearer valid-token',
        'content-type': 'application/octet-stream',
      },
      body: bytes,
    }),
    deps,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [bytes]);
  assert.deepEqual(await response.json(), {
    eventId: '44444444-4444-4444-8444-444444444444',
    issuerProviderId: Buffer.alloc(32, 1).toString('base64'),
    eventDigest: 'aa'.repeat(32),
    state: 'IMPORTED',
    projection: 'APPLIED',
    reason: null,
  });
});

test('v2 receipt import enforces signed-object media type and 8192-byte bound', async () => {
  const deps = {
    ingestEnvelope: async () => {
      throw new Error('unused');
    },
    responderService: responderService(),
    receiptService: {importGatewayReceipt: async () => { throw new Error('must not run'); }} as unknown as ReceiptService,
  };
  const wrongType = await handleSagipRequest(
    new Request('https://sagip.example/v2/responder/receipts/import', {
      method: 'POST',
      headers: {authorization: 'Bearer valid-token', 'content-type': 'application/json'},
      body: '{}',
    }),
    deps,
  );
  assert.equal(wrongType.status, 415);

  const oversized = await handleSagipRequest(
    new Request('https://sagip.example/v2/responder/receipts/import', {
      method: 'POST',
      headers: {authorization: 'Bearer valid-token', 'content-type': 'application/octet-stream'},
      body: Buffer.alloc(8193),
    }),
    deps,
  );
  assert.equal(oversized.status, 413);
});


const actionId = '55555555-5555-4555-8555-555555555555';
const reportId = '22222222-2222-4222-8222-222222222222';
const provider = Buffer.alloc(32, 2);
const actionDigest = Buffer.alloc(32, 3);
const actionBody = {
  actionId, providerKind: 1, issuerProviderId: provider.toString('base64'),
  reportId, reportProtocolVersion: 1, revision: 1,
  payloadDigest: Buffer.alloc(32, 4).toString('base64'),
  originKeyId: Buffer.alloc(32, 5).toString('base64'),
  responderId: responder.responderId, observedIncidentVersion: '0',
  status: 1, note: '', actionDigest: actionDigest.toString('base64'),
};
const actionResult = {
  actionId, issuerProviderId: provider, actionDigest, state: 'SIGNED' as const,
  eventDigest: 'bb'.repeat(32), reason: null,
};

test('v2 action routes enforce owner auth and preserve first-allocation versus retry status', async () => {
  let existing: typeof actionResult | null = null;
  let savedNote: string | undefined;
  let allocations = 0;
  const receiptService = {
    getActionResult: async (_id: string, identity: typeof responder) => {
      assert.equal(identity.responderId, responder.responderId);
      return existing;
    },
    allocateActionResult: async (intent: ActionIntent, identity: typeof responder) => {
      allocations += 1;
      assert.equal(identity.responderId, responder.responderId);
      assert.deepEqual(intent.issuerProviderId, provider);
      assert.equal(intent.observedIncidentVersion, 0n);
      if (savedNote !== undefined && intent.note !== savedNote)
        throw new Error('DIGEST_CONFLICT');
      const created = savedNote === undefined;
      savedNote = intent.note;
      return {action: {}, created};
    },
    prepareReceipt: async () => { existing = actionResult; return actionResult; },
    getReceipt: async () => Buffer.from([0x53, 0x47, 0x41, 0x32]),
  } as unknown as ReceiptService;
  const deps = {
    ingestEnvelope: async () => { throw new Error('unused'); },
    responderService: responderService(), receiptService,
  };
  const makePost = () => new Request('https://sagip.example/v2/responder/actions', {
    method: 'POST', headers: {authorization: 'Bearer valid-token', 'content-type': 'application/json'},
    body: JSON.stringify(actionBody),
  });
  const created = await handleSagipRequest(makePost(), deps);
  assert.equal(created.status, 201);
  assert.equal(allocations, 1);
  assert.deepEqual(await created.json(), {
    actionId, issuerProviderId: provider.toString('base64'), actionDigest: actionDigest.toString('base64'),
    state: 'SIGNED', eventDigest: 'bb'.repeat(32), reason: null,
  });
  const retry = await handleSagipRequest(makePost(), deps);
  assert.equal(retry.status, 200);
  assert.equal(allocations, 2);

  const changed = await handleSagipRequest(new Request('https://sagip.example/v2/responder/actions', {
    method: 'POST',
    headers: {authorization: 'Bearer valid-token', 'content-type': 'application/json'},
    body: JSON.stringify({...actionBody, note: 'changed'}),
  }), deps);
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), {error: 'ACTION_CONFLICT'});
  assert.equal(allocations, 3);

  const invalidBodies = [
    {...actionBody, providerKind: 3},
    {...actionBody, reportProtocolVersion: 3},
    {...actionBody, revision: 0},
    {...actionBody, status: 5},
    {...actionBody, actionId: '00000000-0000-0000-0000-000000000000'},
    {...actionBody, observedIncidentVersion: '18446744073709551616'},
    {...actionBody, note: null},
    {...actionBody, note: 'x'.repeat(1025)},
  ];
  for (const body of invalidBodies) {
    const invalid = await handleSagipRequest(new Request('https://sagip.example/v2/responder/actions', {
      method: 'POST',
      headers: {authorization: 'Bearer valid-token', 'content-type': 'application/json'},
      body: JSON.stringify(body),
    }), deps);
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), {error: 'INVALID_FIELDS'});
  }
  assert.equal(allocations, 3);

  const status = await handleSagipRequest(new Request(
    'https://sagip.example/v2/responder/actions/' + actionId,
    {headers: {authorization: 'Bearer valid-token'}},
  ), deps);
  assert.equal(status.status, 200);
  const statusBody = (await status.json()) as {state: string};
  assert.equal(statusBody.state, 'SIGNED');

  const receipt = await handleSagipRequest(new Request(
    'https://sagip.example/v2/responder/actions/' + actionId + '/receipt',
    {headers: {authorization: 'Bearer valid-token'}},
  ), deps);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual(Buffer.from(await receipt.arrayBuffer()), Buffer.from([0x53,0x47,0x41,0x32]));
});


test('origin receipt access routes bind challenge, secure session and report polling', async () => {
  const rid = '77777777-7777-4777-8777-777777777777';
  const challengeId = '99999999-9999-4999-8999-999999999999';
  const nonce = Buffer.alloc(32, 7);
  const originKeyId = Buffer.alloc(32, 8);
  let listedToken: string | null = null;
  let listedCursor: string | null = null;
  const receiptService = {
    createReceiptAccessChallenge: async (reportId: string) => {
      assert.equal(reportId, rid);
      return {challengeId, reportId, originKeyId, nonce, expiresAtMs: 1790812870000};
    },
    authorizeReceiptAccess: async (reportId: string, id: string, signature: Uint8Array) => {
      assert.equal(reportId, rid);
      assert.equal(id, challengeId);
      assert.deepEqual(Buffer.from(signature), Buffer.alloc(64, 9));
      return {sessionToken: 'receipt-session-token', expiresAtMs: 1790813710000};
    },
    listReportReceipts: async (reportId: string, token: string, cursor: string | null) => {
      assert.equal(reportId, rid);
      listedToken = token; listedCursor = cursor;
      return {entries: [{eventId: actionId,eventDigest: 'cc'.repeat(32),bytesBase64: Buffer.from('SGA2').toString('base64'),kind: 'SGA2',revision: 1,verification: 'VERIFIED_CURRENT'}], nextCursor: null};
    },
  } as unknown as ReceiptService;
  const origin = statusTestIdentity();
  const deps = {
    ingestEnvelope: async () => { throw new Error('unused'); }, receiptService,
    responderService: {authenticateReportStatusAccess: async () => true} as unknown as ResponderService,
  };

  const challenge = await handleSagipRequest(new Request(
    'https://sagip.example/v2/reports/' + rid + '/receipt-access/challenges',
    {method: 'POST', headers: statusProofHeaders(rid, origin.privateKey)},
  ), deps);
  assert.equal(challenge.status, 201);
  assert.deepEqual(await challenge.json(), {challengeId, reportId: rid, originKeyId: originKeyId.toString('base64'), nonce: nonce.toString('base64'), expiresAtMs: 1790812870000});

  const access = await handleSagipRequest(new Request(
    'https://sagip.example/v2/reports/' + rid + '/receipt-access',
    {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({challengeId, signatureBase64: Buffer.alloc(64,9).toString('base64')})},
  ), deps);
  assert.equal(access.status, 200);
  const cookie = access.headers.get('set-cookie');
  assert.ok(cookie?.includes('__Host-sagip-receipt-read=receipt-session-token'));
  assert.ok(cookie?.includes('HttpOnly'));
  assert.ok(cookie?.includes('Secure'));
  assert.ok(cookie?.includes('SameSite=Strict'));

  const page = await handleSagipRequest(new Request(
    'https://sagip.example/v2/reports/' + rid + '/receipts?cursor=abc',
    {headers: {cookie: '__Host-sagip-receipt-read=receipt-session-token'}},
  ), deps);
  assert.equal(page.status, 200);
  assert.equal(listedToken, 'receipt-session-token');
  assert.equal(listedCursor, 'abc');
  assert.equal(((await page.json()) as {entries: unknown[]}).entries.length, 1);

  const unauthorized = await handleSagipRequest(new Request(
    'https://sagip.example/v2/reports/' + rid + '/receipts',
  ), deps);
  assert.equal(unauthorized.status, 401);
});


test('v2 authority routes authenticate roles and preserve signed bytes', async () => {
  const grantBytes = Buffer.from([0x53,0x47,0x47,0x32,1]);
  const timeBytes = Buffer.from([0x53,0x47,0x54,0x32,1]);
  const request = {
    requestId: '10101010-1010-4010-8010-101010101010',
    issuerKeyId: Buffer.alloc(32,1).toString('base64'),
    issuerPublicKeyDer: Buffer.alloc(91,2).toString('base64'),
    issuerProviderId: Buffer.alloc(32,3).toString('base64'),
    grantId: '20202020-2020-4020-8020-202020202020',
    responderId: responder.responderId, callsign: responder.callsign,
    statusMask: 15, purposeMask: 9, scope: 'TAGUM_PILOT',
  };
  let grantCalls = 0;
  const authority = {
    issueGatewayGrantResult: async (input: GatewayGrantRequest, actor: typeof admin) => {
      grantCalls += 1;
      assert.equal(actor.role, 'AUTHORITY_ADMIN');
      assert.deepEqual(input.issuerKeyId, Buffer.alloc(32,1));
      return {bytes: grantBytes, created: grantCalls === 1};
    },
    revokeGrant: async (grantId: string, actor: typeof admin, reason: string) => {
      assert.equal(actor.role, 'AUTHORITY_ADMIN');
      assert.equal(reason, 'lost device');
      return {grantId, revokedAtMs: 1790812800000};
    },
    authorityStatus: async (grantId: string, actor: typeof responder) => {
      assert.equal(actor.responderId, responder.responderId);
      return {grantId, state: 'ACTIVE' as const, authorityCheckedAtMs: 1790812800000};
    },
    issueAuthorityTimeProof: async (input: TimeChallenge, actor: typeof responder) => {
      assert.equal(actor.responderId, responder.responderId);
      assert.deepEqual(input.verifierId, Buffer.alloc(32,4));
      return timeBytes;
    },
  } as unknown as GrantProvisioningService;
  const deps = {
    ingestEnvelope: async () => { throw new Error('unused'); },
    responderService: responderService(), authorityService: authority,
  };

  const denied = await handleSagipRequest(new Request('https://sagip.example/v2/authority/grants', {
    method: 'POST', headers: {authorization: 'Bearer valid-token','content-type':'application/json'}, body: JSON.stringify(request),
  }), deps);
  assert.equal(denied.status, 403);
  assert.equal(grantCalls, 0);

  const issue = () => handleSagipRequest(new Request('https://sagip.example/v2/authority/grants', {
    method: 'POST', headers: {authorization: 'Bearer valid-admin-token','content-type':'application/json'}, body: JSON.stringify(request),
  }), deps);
  const created = await issue();
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual(Buffer.from(await created.arrayBuffer()), grantBytes);
  const retry = await issue();
  assert.equal(retry.status, 200);
  assert.deepEqual(Buffer.from(await retry.arrayBuffer()), grantBytes);

  const revoke = await handleSagipRequest(new Request('https://sagip.example/v2/authority/grants/' + request.grantId + '/revoke', {
    method: 'POST', headers: {authorization: 'Bearer valid-admin-token','content-type':'application/json'}, body: JSON.stringify({reason:'lost device'}),
  }), deps);
  assert.equal(revoke.status, 200);
  assert.deepEqual(await revoke.json(), {grantId: request.grantId, revokedAtMs: 1790812800000});

  const status = await handleSagipRequest(new Request('https://sagip.example/v2/authority/status?grantId=' + request.grantId, {headers:{authorization:'Bearer valid-token'}}), deps);
  assert.equal(status.status, 200);
  assert.equal(((await status.json()) as {state:string}).state, 'ACTIVE');

  const time = await handleSagipRequest(new Request('https://sagip.example/v2/authority/time', {
    method:'POST', headers:{authorization:'Bearer valid-token','content-type':'application/json'},
    body: JSON.stringify({verifierId:Buffer.alloc(32,4).toString('base64'),verifierBootSessionId:'30303030-3030-4030-8030-303030303030',nonce:Buffer.alloc(32,5).toString('base64')}),
  }), deps);
  assert.equal(time.status, 200);
  assert.deepEqual(Buffer.from(await time.arrayBuffer()), timeBytes);
});

test('v2 authority domain errors map to explicit R01 responses', async () => {
  const authority = {
    authorityStatus: async () => { throw new Error('ROLE_REQUIRED'); },
  } as unknown as GrantProvisioningService;
  const deps = {
    ingestEnvelope: async () => { throw new Error('unused'); },
    responderService: responderService(), authorityService: authority,
  };
  const response = await handleSagipRequest(new Request(
    'https://sagip.example/v2/authority/status?grantId=20202020-2020-4020-8020-202020202020',
    {headers:{authorization:'Bearer valid-token'}},
  ), deps);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {error:'ROLE_REQUIRED'});
});
