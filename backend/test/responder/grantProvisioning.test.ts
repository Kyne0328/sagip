import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID, sign } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyMigrations } from '../../src/db/migrate.js';
import {
  decodeReceipt,
  verifyReceiptSignature,
  canonicalizeNewReceiptSignature,
  encodeReceipt,
  receiptSigningInput,
} from '../../src/protocol/receiptV2.js';
import { issuerProviderId } from '../../src/responder/receiptAuthority.js';
import {
  GrantProvisioningService,
  type GatewayGrantRequest,
} from '../../src/responder/grantProvisioning.js';
import { createTestIdentity } from '../support/envelopeFactory.js';
import { createIsolatedPostgres } from '../support/realPostgres.js';
import { provisionGatewayAuthority } from '../../src/provisionGatewayAuthority.js';

const N = BigInt(
  '0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
);
test('authority expiry uses the entire qualified time interval', async () => {
  const f = await setup();
  try {
    const bytes = await f.service.issueGatewayGrant(f.request, f.operator);
    const fields = decodeReceipt(bytes).fields;
    if (fields.purpose !== 3) throw new Error('Expected grant');
    f.setTime(fields.expiresAtMs - 100);
    assert.equal(
      (await f.service.authorityStatus(f.request.grantId, f.responder)).state,
      'EXPIRED',
    );
    assert.deepEqual(
      await f.service.issueGatewayGrant(f.request, f.operator),
      bytes,
    );
    f.advance();
    assert.deepEqual(
      await f.service.issueGatewayGrant(f.request, f.operator),
      bytes,
    );
  } finally {
    await f.close();
  }
});
test('invalid operator masks and unknown clock sources fail closed', async () => {
  const f = await setup();
  try {
    assert.throws(
      () =>
        new GrantProvisioningService(f.pool, f.signer, f.clock, {
          ...f.policy,
          statusMask: -1,
        }),
      /INVALID_AUTHORITY_POLICY/,
    );
    const badClock = new GrantProvisioningService(
      f.pool,
      f.signer,
      () => ({ timeMs: 1, uncertaintyMs: 100, validForMs: 604800000 }),
      f.policy,
    );
    await assert.rejects(
      badClock.issueGatewayGrant(f.request, f.operator),
      /TIME_UNAVAILABLE/,
    );
    assert.equal(
      (await f.pool.query('SELECT * FROM receipt_authority_grants')).rowCount,
      0,
    );
  } finally {
    await f.close();
  }
});
test('key rotation preserves prior grant bytes and time rollback/capacity cannot renew trust', async () => {
  const f = await setup();
  try {
    const grant = await f.service.issueGatewayGrant(f.request, f.operator);
    const rotated = createTestIdentity();
    const nextSigner = {
      publicKeyDer: rotated.publicKeyDer,
      sign: async (bytes: Uint8Array) =>
        canonicalizeNewReceiptSignature(
          sign('sha256', bytes, {
            key: rotated.privateKey,
            dsaEncoding: 'ieee-p1363',
          }),
        ),
    };
    const next = new GrantProvisioningService(
      f.pool,
      nextSigner,
      f.clock,
      f.policy,
    );
    assert.deepEqual(
      await next.issueGatewayGrant(f.request, f.operator),
      grant,
    );
    const challenge = {
      verifierId: Buffer.from(f.request.issuerKeyId),
      verifierBootSessionId: randomUUID(),
      nonce: randomBytes(32),
    };
    await assert.rejects(
      f.service.issueAuthorityTimeProof(
        { ...challenge, verifierId: randomBytes(32) },
        f.responder,
      ),
      /VERIFIER_NOT_APPROVED/,
    );
    const proof = await f.service.issueAuthorityTimeProof(
      challenge,
      f.responder,
    );
    assert.deepEqual(
      await next.issueAuthorityTimeProof(challenge, f.responder),
      proof,
    );
    const now = f.clock().timeMs;
    f.setTime(now - 1);
    await assert.rejects(
      next.issueAuthorityTimeProof(
        { ...challenge, nonce: randomBytes(32) },
        f.responder,
      ),
      /TIME_ROLLBACK/,
    );
    f.setTime(now);
    await Promise.all(
      Array.from({ length: 127 }, () =>
        next.issueAuthorityTimeProof(
          { ...challenge, nonce: randomBytes(32) },
          f.responder,
        ),
      ),
    );
    await assert.rejects(
      next.issueAuthorityTimeProof(
        { ...challenge, nonce: randomBytes(32) },
        f.responder,
      ),
      /CAPACITY_FULL/,
    );
    assert.equal(
      (await f.pool.query('SELECT * FROM receipt_authority_time_proofs'))
        .rowCount,
      128,
    );
  } finally {
    await f.close();
  }
});
test('operator CLI requires explicit authenticated custody and never prints credentials or replaces output', async () => {
  const f = await setup(),
    directory = await mkdtemp(path.join(tmpdir(), 'sagip-authority-cli-'));
  try {
    await assert.rejects(provisionGatewayAuthority({}), /CONFIG_REQUIRED/);
    const token = randomBytes(32).toString('hex');
    await f.pool.query(
      'UPDATE responder_identities SET api_key_hash=$2 WHERE responder_id=$1',
      [
        f.operator.responderId,
        createHash('sha256').update(token).digest('hex'),
      ],
    );
    const url = new URL(process.env.SAGIP_TEST_DATABASE_URL!);
    url.searchParams.set('options', f.pool.options.options!);
    const file = (name: string) => path.join(directory, name);
    await writeFile(file('operator-token'), token, { mode: 0o600 });
    await writeFile(
      file('root.pem'),
      f.root.privateKey.export({ format: 'pem', type: 'pkcs8' }),
      { mode: 0o600 },
    );
    const request = {
      ...f.request,
      issuerKeyId: Buffer.from(f.request.issuerKeyId).toString('hex'),
      issuerPublicKeyDer: Buffer.from(f.request.issuerPublicKeyDer).toString(
        'base64',
      ),
      issuerProviderId: Buffer.from(f.request.issuerProviderId).toString('hex'),
    };
    await writeFile(file('request.json'), JSON.stringify(request));
    await writeFile(
      file('policy.json'),
      JSON.stringify({
        approvedIssuerKeyIds: [...f.policy.approvedIssuerKeyIds],
        allowedScopes: [...f.policy.allowedScopes],
        allowedResponderRoles: [...f.policy.allowedResponderRoles],
        verifierOwners: Object.fromEntries(f.policy.verifierOwners),
        statusMask: 15,
        purposeMask: 9,
      }),
    );
    const env = {
      DATABASE_URL: url.toString(),
      SAGIP_AUTHORITY_OPERATOR_TOKEN_PATH: file('operator-token'),
      SAGIP_AUTHORITY_ROOT_KEY_PATH: file('root.pem'),
      SAGIP_AUTHORITY_REQUEST_PATH: file('request.json'),
      SAGIP_AUTHORITY_POLICY_PATH: file('policy.json'),
      SAGIP_AUTHORITY_OUTPUT_PATH: file('grant.sgg2'),
      SAGIP_AUTHORITY_CLOCK_MODE: 'QUALIFIED_SYSTEM_CLOCK',
      SAGIP_AUTHORITY_TIME_UNCERTAINTY_MS: '100',
      SAGIP_AUTHORITY_TIME_VALIDITY_MS: '604800000',
    };
    assert.deepEqual(await provisionGatewayAuthority(env), {
      grantId: f.request.grantId,
    });
    const bytes = await readFile(file('grant.sgg2'));
    assert.equal(
      verifyReceiptSignature(decodeReceipt(bytes), f.root.publicKeyDer),
      true,
    );
    assert.ok(
      !bytes.includes(Buffer.from('PRIVATE KEY')) &&
        !bytes.includes(Buffer.from(token)),
    );
    const child = spawnSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'src/provisionGatewayAuthority.ts'],
      { env: { ...process.env, ...env }, encoding: 'utf8' },
    );
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr.trim(), 'SAGIP authority provisioning failed');
    assert.deepEqual(await readFile(file('grant.sgg2')), bytes);
    await writeFile(
      file('request.json'),
      '{"requestId":"duplicate",' + JSON.stringify(request).slice(1),
    );
    await assert.rejects(
      provisionGatewayAuthority({
        ...env,
        SAGIP_AUTHORITY_OUTPUT_PATH: file('other.sgg2'),
      }),
      /INVALID_OPERATOR_JSON/,
    );
    await writeFile(file('request.json'), 'x'.repeat(4097));
    await assert.rejects(
      provisionGatewayAuthority({
        ...env,
        SAGIP_AUTHORITY_OUTPUT_PATH: file('other.sgg2'),
      }),
      /INPUT_TOO_LARGE/,
    );
  } finally {
    await f.close();
    assert.ok(
      directory.startsWith(path.join(tmpdir(), 'sagip-authority-cli-')),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
async function setup() {
  const database = await createIsolatedPostgres(),
    { pool } = database;
  try {
    await applyMigrations(
      pool,
      fileURLToPath(new URL('../../migrations/', import.meta.url)),
    );
    const root = createTestIdentity(),
      gateway = createTestIdentity();
    const keyId = createHash('sha256').update(gateway.publicKeyDer).digest();
    const grantId = randomUUID(),
      request: GatewayGrantRequest = {
        requestId: randomUUID(),
        issuerKeyId: keyId,
        issuerPublicKeyDer: gateway.publicKeyDer,
        issuerProviderId: issuerProviderId(2, keyId, grantId),
        grantId,
        responderId: randomUUID(),
        callsign: 'TEST-GATEWAY',
        statusMask: 15,
        purposeMask: 9,
        scope: 'TAGUM_PILOT',
      };
    const operator = {
      responderId: randomUUID(),
      callsign: 'TEST-ADMIN',
      role: 'AUTHORITY_ADMIN',
      registeredAt: new Date().toISOString(),
    };
    const responder = {
      responderId: request.responderId,
      callsign: request.callsign,
      role: 'RESPONDER',
      registeredAt: new Date().toISOString(),
    };
    for (const [index, person] of [operator, responder].entries())
      await pool.query(
        'INSERT INTO responder_identities VALUES ($1,$2,$3,$4,$5)',
        [
          person.responderId,
          person.callsign,
          person.role,
          String(index + 1).repeat(64),
          person.registeredAt,
        ],
      );
    let time = 1790812800000,
      unavailable = false;
    const signer = {
      publicKeyDer: root.publicKeyDer,
      sign: async (input: Uint8Array) => {
        if (unavailable) throw new Error('unavailable');
        const bytes = sign('sha256', input, {
          key: root.privateKey,
          dsaEncoding: 'ieee-p1363',
        });
        const s = BigInt('0x' + bytes.subarray(32).toString('hex'));
        if (s > N / 2n)
          Buffer.from((N - s).toString(16).padStart(64, '0'), 'hex').copy(
            bytes,
            32,
          );
        return bytes;
      },
    };
    const clock = () => ({
      timeMs: time,
      uncertaintyMs: 100,
      validForMs: 604800000,
    });
    const policy = {
      approvedIssuerKeyIds: new Set([keyId.toString('hex')]),
      allowedScopes: new Set(['TAGUM_PILOT']),
      allowedResponderRoles: new Set(['RESPONDER']),
      verifierOwners: new Map([[keyId.toString('hex'), responder.responderId]]),
      statusMask: 15,
      purposeMask: 9,
    };
    const service = new GrantProvisioningService(pool, signer, clock, policy);
    return {
      pool,
      service,
      request,
      operator,
      responder,
      root,
      signer,
      clock,
      policy,
      setTime: (value: number) => {
        time = value;
      },
      advance: () => {
        time += 604800001;
      },
      unavailable: () => {
        unavailable = true;
      },
      close: database.close,
    };
  } catch (e) {
    await database.close();
    throw e;
  }
}
test('grant_provisioning_never_invents_authority; duplicate request is immutable and revocation is permanent', async () => {
  const f = await setup();
  try {
    await assert.rejects(
      f.service.issueGatewayGrant(f.request, f.responder),
      /ROLE_REQUIRED/,
    );
    await assert.rejects(
      f.service.issueGatewayGrant({ ...f.request, scope: 'OTHER' }, f.operator),
      /SCOPE_DENIED/,
    );
    await assert.rejects(
      f.service.issueGatewayGrant(
        { ...f.request, issuerKeyId: Buffer.alloc(32) },
        f.operator,
      ),
      /KEY_BINDING/,
    );
    assert.equal(
      (await f.pool.query('SELECT * FROM receipt_authority_grants')).rowCount,
      0,
    );
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        f.service.issueGatewayGrant(f.request, f.operator),
      ),
    );
    assert.ok(
      results.every(b => Buffer.from(b).equals(Buffer.from(results[0]!))),
    );
    const decoded = decodeReceipt(results[0]!);
    assert.equal(decoded.fields.purpose, 3);
    if (decoded.fields.purpose !== 3) throw new Error('grant expected');
    assert.equal(
      decoded.fields.expiresAtMs - decoded.fields.notBeforeMs,
      604800000,
    );
    assert.equal(verifyReceiptSignature(decoded, f.root.publicKeyDer), true);
    await assert.rejects(
      f.service.issueGatewayGrant(
        { ...f.request, callsign: 'OTHER' },
        f.operator,
      ),
      /REQUEST_CONFLICT/,
    );
    f.unavailable();
    assert.deepEqual(
      await f.service.issueGatewayGrant(f.request, f.operator),
      results[0],
    );
    assert.equal(
      (await f.service.authorityStatus(f.request.grantId, f.responder)).state,
      'ACTIVE',
    );
    const revoked = await f.service.revokeGrant(
      f.request.grantId,
      f.operator,
      'device key compromised',
    );
    f.advance();
    assert.deepEqual(
      await f.service.revokeGrant(
        f.request.grantId,
        f.operator,
        'retry must preserve original reason',
      ),
      revoked,
    );
    assert.equal(
      (await f.service.authorityStatus(f.request.grantId, f.responder)).state,
      'REVOKED',
    );
    await assert.rejects(
      f.service.issueGatewayGrant(f.request, f.operator),
      /GRANT_REVOKED/,
    );
    const audit = await f.pool.query(
      'SELECT event_type,operator_id,operator_callsign,operator_role,reason FROM receipt_authority_audit ORDER BY occurred_at_ms,audit_id',
    );
    assert.equal(audit.rowCount, 2);
    const issued = audit.rows.find(r => r.event_type === 'ISSUED'),
      revocation = audit.rows.find(r => r.event_type === 'REVOKED');
    assert.equal(issued.operator_id, f.operator.responderId);
    assert.equal(issued.operator_callsign, f.operator.callsign);
    assert.equal(revocation.operator_id, f.operator.responderId);
    assert.equal(revocation.operator_role, 'AUTHORITY_ADMIN');
    assert.equal(revocation.reason, 'device key compromised');
  } finally {
    await f.close();
  }
});
test('durable total time-proof budget remains full beyond the sliding minute', async () => {
  const f = await setup();
  try {
    const challenge = {
      verifierId: Buffer.from(f.request.issuerKeyId),
      verifierBootSessionId: randomUUID(),
      nonce: randomBytes(32),
    };
    const original = await f.service.issueAuthorityTimeProof(
      challenge,
      f.responder,
    );
    const template = decodeReceipt(original).fields;
    if (template.purpose !== 4) throw new Error('time expected');
    // Fill the protected ledger with valid synthetic signed history in batches,
    // so this test measures total admission rather than the one-minute limiter.
    for (let start = 1; start < 10000; start += 250) {
      const values: unknown[] = [],
        rows: string[] = [];
      for (let i = start; i < Math.min(start + 250, 10000); i++) {
        const nonce = createHash('sha256')
          .update('synthetic proof ' + i)
          .digest();
        const fields = { ...template, nonce, proofId: randomUUID() };
        const signature = canonicalizeNewReceiptSignature(
          sign('sha256', receiptSigningInput(fields, Buffer.alloc(0)), {
            key: f.root.privateKey,
            dsaEncoding: 'ieee-p1363',
          }),
        );
        const bytes = encodeReceipt(fields, signature, Buffer.alloc(0));
        const offset = values.length;
        values.push(
          fields.verifierId,
          nonce,
          fields.verifierBootSessionId,
          f.responder.responderId,
          fields.signedTimeMs,
          fields.validUntilMs,
          bytes,
        );
        rows.push(
          '(' +
            Array.from({ length: 7 }, (_, j) => '$' + (offset + j + 1)).join(
              ',',
            ) +
            ')',
        );
      }
      await f.pool.query(
        'INSERT INTO receipt_authority_time_proofs VALUES ' + rows.join(','),
        values,
      );
    }
    f.setTime(f.clock().timeMs + 60001);
    await assert.rejects(
      f.service.issueAuthorityTimeProof(
        { ...challenge, nonce: randomBytes(32) },
        f.responder,
      ),
      /CAPACITY_FULL/,
    );
    assert.equal(
      (await f.pool.query('SELECT * FROM receipt_authority_time_proofs'))
        .rowCount,
      10000,
    );
    assert.deepEqual(
      await f.service.issueAuthorityTimeProof(challenge, f.responder),
      original,
    );
  } finally {
    await f.close();
  }
});
test('audit failure rolls back issuance and revocation; reasons have UTF-8 bounds', async () => {
  const f = await setup();
  try {
    await f.pool.query(
      'ALTER TABLE receipt_authority_audit RENAME TO unavailable_audit',
    );
    await assert.rejects(
      f.service.issueGatewayGrant(f.request, f.operator),
      /receipt_authority_audit/,
    );
    assert.equal(
      (await f.pool.query('SELECT * FROM receipt_authority_grants')).rowCount,
      0,
    );
    await f.pool.query(
      'ALTER TABLE unavailable_audit RENAME TO receipt_authority_audit',
    );
    await f.service.issueGatewayGrant(f.request, f.operator);
    for (const reason of ['', 'é'.repeat(513), 'a\0b', '\ud800'])
      await assert.rejects(
        f.service.revokeGrant(f.request.grantId, f.operator, reason),
        /INVALID_REVOCATION_REASON/,
      );
    assert.equal(
      (await f.pool.query('SELECT * FROM receipt_authority_audit')).rowCount,
      1,
    );
    await f.pool.query(
      'ALTER TABLE receipt_authority_audit RENAME TO unavailable_audit',
    );
    await assert.rejects(
      f.service.revokeGrant(f.request.grantId, f.operator, 'storage test'),
      /receipt_authority_audit/,
    );
    assert.equal(
      (await f.pool.query('SELECT revoked_at_ms FROM receipt_authority_grants'))
        .rows[0].revoked_at_ms,
      null,
    );
    await f.pool.query(
      'ALTER TABLE unavailable_audit RENAME TO receipt_authority_audit',
    );
    await f.service.revokeGrant(f.request.grantId, f.operator, 'é'.repeat(512));
    assert.equal(
      (
        await f.pool.query(
          "SELECT reason FROM receipt_authority_audit WHERE event_type='REVOKED'",
        )
      ).rows[0].reason,
      'é'.repeat(512),
    );
  } finally {
    await f.close();
  }
});
test('time nonce is bound and retries cannot renew an old proof', async () => {
  const f = await setup();
  try {
    const challenge = {
      verifierId: Buffer.from(f.request.issuerKeyId),
      verifierBootSessionId: randomUUID(),
      nonce: randomBytes(32),
    };
    const first = await f.service.issueAuthorityTimeProof(
      challenge,
      f.responder,
    );
    const decoded = decodeReceipt(first);
    assert.equal(decoded.fields.purpose, 4);
    if (decoded.fields.purpose !== 4) throw new Error('time expected');
    assert.deepEqual(decoded.fields.nonce, challenge.nonce);
    assert.deepEqual(decoded.fields.verifierId, challenge.verifierId);
    assert.equal(
      decoded.fields.verifierBootSessionId,
      challenge.verifierBootSessionId,
    );
    assert.equal(verifyReceiptSignature(decoded, f.root.publicKeyDer), true);
    assert.deepEqual(
      await f.service.issueAuthorityTimeProof(challenge, f.responder),
      first,
    );
    await assert.rejects(
      f.service.issueAuthorityTimeProof(
        { ...challenge, verifierBootSessionId: randomUUID() },
        f.responder,
      ),
      /TIME_CHALLENGE_REUSED/,
    );
    f.advance();
    await assert.rejects(
      f.service.issueAuthorityTimeProof(challenge, f.responder),
      /TIME_CHALLENGE_REUSED/,
    );
  } finally {
    await f.close();
  }
});
test('unavailable signer never silently becomes renewed authority', async () => {
  const f = await setup();
  try {
    f.unavailable();
    await assert.rejects(
      f.service.issueGatewayGrant(f.request, f.operator),
      /SIGNER_UNAVAILABLE/,
    );
    assert.equal(
      (await f.pool.query('SELECT * FROM receipt_authority_grants')).rowCount,
      0,
    );
    await assert.rejects(
      f.service.issueAuthorityTimeProof(
        {
          verifierId: Buffer.from(f.request.issuerKeyId),
          verifierBootSessionId: randomUUID(),
          nonce: randomBytes(32),
        },
        f.responder,
      ),
      /SIGNER_UNAVAILABLE/,
    );
    assert.equal(
      (await f.pool.query('SELECT * FROM receipt_authority_time_proofs'))
        .rowCount,
      0,
    );
  } finally {
    await f.close();
  }
});
