import {createHash, randomBytes, randomUUID} from 'node:crypto';

import {createPool} from './db/pool.js';

const CALLSIGN_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,63}$/u;
const ROLE_PATTERN = /^[A-Z][A-Z0-9_-]{0,31}$/u;

async function main(): Promise<void> {
  const databaseUrl = requireEnv('DATABASE_URL');
  const callsign = (process.env.RESPONDER_CALLSIGN ?? 'FIELD-RESCUE-1').trim();
  const role = (process.env.RESPONDER_ROLE ?? 'DISPATCHER').trim();
  const suppliedToken = process.env.RESPONDER_TOKEN?.trim();
  const token =
    suppliedToken && suppliedToken.length > 0
      ? suppliedToken
      : `sagip-ft-${randomBytes(32).toString('base64url')}`;

  if (!CALLSIGN_PATTERN.test(callsign)) {
    throw new Error('RESPONDER_CALLSIGN must be 1-64 uppercase letters, digits, underscore, or hyphen');
  }
  if (!ROLE_PATTERN.test(role)) {
    throw new Error('RESPONDER_ROLE must be 1-32 uppercase letters, digits, underscore, or hyphen');
  }

  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
  const pool = createPool(databaseUrl);

  try {
    const provisioned = await pool.query<{responder_id: string}>(
      `INSERT INTO responder_identities(
         responder_id, callsign, role, api_key_hash, registered_at
       ) VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (callsign) DO UPDATE SET
         role = EXCLUDED.role,
         api_key_hash = EXCLUDED.api_key_hash,
         registered_at = EXCLUDED.registered_at
       RETURNING responder_id`,
      [randomUUID(), callsign, role, tokenHash],
    );

    const responderId = provisioned.rows[0]?.responder_id;
    if (!responderId) {
      throw new Error('Responder provisioning did not return an identity');
    }

    // Rotating a responder token must also invalidate browser sessions issued under the old token.
    await pool.query('DELETE FROM responder_sessions WHERE responder_id = $1', [responderId]);
  } finally {
    await pool.end();
  }

  console.log(`Responder provisioned: ${callsign} (${role})`);
  console.log(`Bearer token (shown once): ${token}`);
  console.log('Store the token in the approved private team secret store; only its SHA-256 hash is in PostgreSQL.');
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

void main().catch(error => {
  const message = error instanceof Error ? error.message : 'unknown error';
  console.error(`Responder provisioning failed: ${message}`);
  process.exitCode = 1;
});
