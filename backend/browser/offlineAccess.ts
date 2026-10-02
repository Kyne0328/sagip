import {ConsoleStore} from './consoleStore.js';
import type {ConsoleProvider, TimeChallengeRequest} from './consoleTypes.js';
import {
  verifyTimeProof,
  type BrowserVerificationContext,
} from './receiptVerifier.js';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export type AccessResult =
  | {
      kind: 'UNLOCKED';
      responderId: string;
      providerKey: string;
      earliestMs: number;
      latestMs: number;
      validUntilMs: number;
    }
  | {kind: 'LOCKED'; reason: string};

export interface OfflineAccessOptions {
  store: ConsoleStore;
  provider: ConsoleProvider;
  verificationContext: BrowserVerificationContext;
  verifierId: Uint8Array;
  verifierBootSessionId: string;
  verifyLocalUser: (challenge: Uint8Array) => Promise<boolean>;
}

export async function unlockOffline(options: OfflineAccessOptions): Promise<AccessResult> {
  if (options.verifierId.length !== 32) return {kind: 'LOCKED', reason: 'INVALID_VERIFIER'};
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const challengeId = crypto.randomUUID();
  const verified = await options.verifyLocalUser(nonce.slice());
  if (!verified) return {kind: 'LOCKED', reason: 'USER_VERIFICATION_REQUIRED'};

  const sentElapsedMs = performance.now();
  const challenge: TimeChallengeRequest = {
    challengeId,
    verifierId: options.verifierId.slice(),
    verifierBootSessionId: options.verifierBootSessionId,
    nonce,
    sentElapsedMs,
  };

  let proof: Uint8Array;
  try {
    proof = await options.provider.fetchTimeProof(challenge);
  } catch (error) {
    return {
      kind: 'LOCKED',
      reason: error instanceof Error ? error.message : 'TIME_PROOF_UNAVAILABLE',
    };
  }

  const highWater = await options.store.readTimeHighWater();
  const acceptance = await verifyTimeProof(
    proof,
    {
      ...challenge,
      currentElapsedMs: performance.now(),
      highWaterEarliestMs: highWater,
    },
    options.verificationContext,
  );
  if (acceptance.kind !== 'ACCEPTED') {
    return {kind: 'LOCKED', reason: acceptance.reason};
  }
  const checkpoint = acceptance.checkpoint;
  if (
    checkpoint.grantId === NIL_UUID ||
    checkpoint.signerProviderId !== bytesToHex(options.provider.providerId)
  ) {
    return {kind: 'LOCKED', reason: 'OFFLINE_AUTHORITY_REQUIRED'};
  }
  if (!(await options.store.commitTimeHighWater(checkpoint.earliestMs))) {
    return {kind: 'LOCKED', reason: 'TIME_ROLLBACK'};
  }

  options.store.unlock({
    responderId: options.provider.responderId,
    providerKey: checkpoint.signerProviderId,
    earliestMs: checkpoint.earliestMs,
    latestMs: checkpoint.latestMs,
    validUntilMs: checkpoint.validUntilMs,
    bootId: checkpoint.signerBootSessionId,
    receivedElapsedMs: performance.now(),
  });
  return {
    kind: 'UNLOCKED',
    responderId: options.provider.responderId,
    providerKey: checkpoint.signerProviderId,
    earliestMs: checkpoint.earliestMs,
    latestMs: checkpoint.latestMs,
    validUntilMs: checkpoint.validUntilMs,
  };
}

export function createWebAuthnUserVerifier(
  credentialIds: readonly Uint8Array[],
): (challenge: Uint8Array) => Promise<boolean> {
  return async challenge => {
    if (
      !('credentials' in navigator) ||
      typeof navigator.credentials?.get !== 'function' ||
      credentialIds.length === 0
    ) return false;
    try {
      const credential = await navigator.credentials.get({
        publicKey: {
          challenge: Uint8Array.from(challenge).buffer,
          allowCredentials: credentialIds.map(id => ({
            id: id.slice(),
            type: 'public-key' as const,
          })),
          userVerification: 'required',
          timeout: 60_000,
        },
      });
      return credential !== null;
    } catch {
      return false;
    }
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}
