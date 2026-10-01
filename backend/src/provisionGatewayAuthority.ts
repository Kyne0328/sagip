import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createPool } from './db/pool.js';
import {
  canonicalizeNewReceiptSignature,
  validateReceiptPublicKey,
} from './protocol/receiptV2.js';
import {
  GrantProvisioningService,
  type AuthorityPolicy,
  type GatewayGrantRequest,
} from './responder/grantProvisioning.js';
import { ResponderService } from './responder/service.js';

const hex = /^[0-9a-f]{64}$/u;
function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error('CONFIG_REQUIRED');
  return value;
}
async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(limit + 1);
    let read = 0;
    while (read < bytes.length) {
      const result = await file.read(bytes, read, bytes.length - read, null);
      if (result.bytesRead === 0) break;
      read += result.bytesRead;
    }
    if (read > limit) throw new Error('INPUT_TOO_LARGE');
    return bytes.subarray(0, read);
  } finally {
    await file.close();
  }
}
async function jsonFile(path: string): Promise<Record<string, unknown>> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(
    await boundedFile(path, 4096),
  );
  const value: unknown = JSON.parse(text);
  // Operator files use compact canonical JSON; round-trip equality rejects
  // duplicate keys and noncanonical escapes without a permissive second parser.
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(value) !== text.trim()
  )
    throw new Error('INVALID_OPERATOR_JSON');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some(k => !keys.includes(k))
  )
    throw new Error('INVALID_OPERATOR_JSON');
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string'))
    throw new Error('INVALID_OPERATOR_JSON');
  return value;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('INVALID_OPERATOR_JSON');
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error('INVALID_OPERATOR_JSON');
  return value;
}
function digest(value: unknown): Buffer {
  const s = string(value);
  if (!hex.test(s)) throw new Error('INVALID_OPERATOR_JSON');
  return Buffer.from(s, 'hex');
}
function request(value: Record<string, unknown>): GatewayGrantRequest {
  exactKeys(value, [
    'requestId',
    'issuerKeyId',
    'issuerPublicKeyDer',
    'issuerProviderId',
    'grantId',
    'responderId',
    'callsign',
    'statusMask',
    'purposeMask',
    'scope',
  ]);
  const encoded = string(value.issuerPublicKeyDer),
    der = Buffer.from(encoded, 'base64');
  if (der.toString('base64') !== encoded)
    throw new Error('INVALID_OPERATOR_JSON');
  return {
    requestId: string(value.requestId),
    issuerKeyId: digest(value.issuerKeyId),
    issuerPublicKeyDer: der,
    issuerProviderId: digest(value.issuerProviderId),
    grantId: string(value.grantId),
    responderId: string(value.responderId),
    callsign: string(value.callsign),
    statusMask: integer(value.statusMask),
    purposeMask: integer(value.purposeMask),
    scope: string(value.scope),
  };
}
function policy(value: Record<string, unknown>): AuthorityPolicy {
  exactKeys(value, [
    'approvedIssuerKeyIds',
    'allowedScopes',
    'allowedResponderRoles',
    'verifierOwners',
    'statusMask',
    'purposeMask',
  ]);
  const keys = strings(value.approvedIssuerKeyIds);
  keys.forEach(k => digest(k));
  const owners = value.verifierOwners;
  if (!owners || typeof owners !== 'object' || Array.isArray(owners))
    throw new Error('INVALID_OPERATOR_JSON');
  const entries = Object.entries(owners).map(([k, v]) => {
    digest(k);
    return [k, string(v)] as [string, string];
  });
  return {
    approvedIssuerKeyIds: new Set(keys),
    allowedScopes: new Set(strings(value.allowedScopes)),
    allowedResponderRoles: new Set(strings(value.allowedResponderRoles)),
    verifierOwners: new Map(entries),
    statusMask: integer(value.statusMask),
    purposeMask: integer(value.purposeMask),
  };
}
export async function provisionGatewayAuthority(
  env: NodeJS.ProcessEnv,
): Promise<{ grantId: string }> {
  // All inputs are explicit. No token/key, approved scope, clock error bound
  // or operator identity is installed automatically by this command.
  const databaseUrl = required(env, 'DATABASE_URL');
  const tokenPath = required(env, 'SAGIP_AUTHORITY_OPERATOR_TOKEN_PATH');
  const rootPath = required(env, 'SAGIP_AUTHORITY_ROOT_KEY_PATH');
  const requestPath = required(env, 'SAGIP_AUTHORITY_REQUEST_PATH');
  const policyPath = required(env, 'SAGIP_AUTHORITY_POLICY_PATH');
  const outputPath = required(env, 'SAGIP_AUTHORITY_OUTPUT_PATH');
  if (required(env, 'SAGIP_AUTHORITY_CLOCK_MODE') !== 'QUALIFIED_SYSTEM_CLOCK')
    throw new Error('TIME_UNAVAILABLE');
  const uncertaintyMs = Number(
    required(env, 'SAGIP_AUTHORITY_TIME_UNCERTAINTY_MS'),
  );
  const validForMs = Number(required(env, 'SAGIP_AUTHORITY_TIME_VALIDITY_MS'));
  const pool = createPool(databaseUrl);
  try {
    const token = (await boundedFile(tokenPath, 512)).toString('utf8').trim();
    const operator = await new ResponderService(pool).authenticate(token);
    if (!operator || operator.role !== 'AUTHORITY_ADMIN')
      throw new Error('ROLE_REQUIRED');
    const input = request(await jsonFile(requestPath)),
      approved = policy(await jsonFile(policyPath));
    const privateBytes = await boundedFile(rootPath, 4096);
    const key = (() => {
      try {
        return createPrivateKey({
          key: privateBytes,
          format: 'pem',
          type: 'pkcs8',
        });
      } finally {
        privateBytes.fill(0);
      }
    })();
    const publicKeyDer = createPublicKey(key).export({
      format: 'der',
      type: 'spki',
    });
    validateReceiptPublicKey(publicKeyDer);
    const signer = {
      publicKeyDer,
      sign: async (bytes: Uint8Array) => {
        const signature = sign('sha256', bytes, {
          key,
          dsaEncoding: 'ieee-p1363',
        });
        return canonicalizeNewReceiptSignature(signature);
      },
    };
    const service = new GrantProvisioningService(
      pool,
      signer,
      () => ({ timeMs: Date.now(), uncertaintyMs, validForMs }),
      approved,
    );
    const bytes = await service.issueGatewayGrant(input, operator);
    await writeFile(outputPath, bytes, { flag: 'wx' });
    return { grantId: input.grantId };
  } finally {
    await pool.end();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void provisionGatewayAuthority(process.env)
    .then(result => console.log('Gateway grant written: ' + result.grantId))
    .catch(() => {
      // Never print private material, raw input, URLs or provider stack traces.
      console.error('SAGIP authority provisioning failed');
      process.exitCode = 1;
    });
}
