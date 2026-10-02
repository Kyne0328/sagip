import {createActionIntent, type ActionDraft} from './actionCodec.js';
import type {ConsoleStore, LogoutPolicy, StoredIntent} from './consoleStore.js';
import type {ActionCommitResult, ActionIntent, ConsoleProvider} from './consoleTypes.js';

export type QueueResult =
  | {kind: 'SAVED_LOCAL'; actionId: string; actionDigest: string}
  | {kind: 'FULL'}
  | {kind: 'REJECTED'; reason: string};

export type DrainItemResult =
  | {actionId: string; kind: 'PROVIDER_COMMITTED'; state: string; eventDigest: string | null}
  | {actionId: string; kind: 'PENDING'; reason: string}
  | {actionId: string; kind: 'REJECTED'; reason: string};

export interface DrainResult {
  providerKey: string;
  attempted: number;
  committed: number;
  remaining: number;
  items: DrainItemResult[];
}

export type SafeLogoutResult =
  | {kind: 'COMPLETE'}
  | {kind: 'BLOCKED_PENDING_ACTIONS'; pending: number}
  | {kind: 'PROVIDER_REFUSED'; status: number};

export class ActionOutbox {
  readonly providerKey: string;

  constructor(
    private readonly store: ConsoleStore,
    private readonly provider: ConsoleProvider,
  ) {
    this.providerKey = bytesToHex(provider.providerId);
  }

  async queue(draft: ActionDraft): Promise<QueueResult> {
    if (
      draft.providerKind !== this.provider.providerKind ||
      draft.responderId !== this.provider.responderId ||
      !equalBytes(draft.issuerProviderId, this.provider.providerId)
    ) {
      return {kind: 'REJECTED', reason: 'PROVIDER_CONFLICT'};
    }
    let intent: ActionIntent;
    try {
      intent = await createActionIntent(draft);
    } catch (error) {
      return {kind: 'REJECTED', reason: error instanceof Error ? error.message : 'INVALID_ACTION'};
    }
    const stored = await this.store.saveIntent(intent, this.providerKey);
    if (stored.kind === 'FULL') return {kind: 'FULL'};
    if (stored.kind === 'REJECTED') return stored;
    return {
      kind: 'SAVED_LOCAL',
      actionId: intent.actionId,
      actionDigest: bytesToHex(intent.actionDigest),
    };
  }

  async drain(): Promise<DrainResult> {
    const intents = await this.store.listIntents();
    const pending = intents.filter(item => item.state !== 'PROVIDER_COMMITTED');
    const items: DrainItemResult[] = [];
    let committed = 0;
    for (const item of pending) {
      if (item.providerKey !== this.providerKey) {
        items.push({actionId: item.actionId, kind: 'REJECTED', reason: 'PROVIDER_CONFLICT'});
        continue;
      }
      const result = await this.reconcile(item);
      items.push(result);
      if (result.kind === 'PROVIDER_COMMITTED') committed += 1;
    }
    return {
      providerKey: this.providerKey,
      attempted: pending.length,
      committed,
      remaining: await this.store.pendingIntentCount(),
      items,
    };
  }

  async safeLogout(policy: LogoutPolicy): Promise<SafeLogoutResult> {
    await this.drain();
    const pending = await this.store.pendingIntentCount();
    if (pending > 0 && policy.kind !== 'DISCARD') {
      return {kind: 'BLOCKED_PENDING_ACTIONS', pending};
    }
    if (pending > 0 && policy.kind === 'DISCARD' && !policy.confirmed) {
      return {kind: 'BLOCKED_PENDING_ACTIONS', pending};
    }

    if (this.provider.logout) {
      let response: Response;
      try {
        response = await this.provider.logout();
      } catch {
        return {kind: 'PROVIDER_REFUSED', status: 0};
      }
      if (!response.ok) {
        return {kind: 'PROVIDER_REFUSED', status: response.status};
      }
    }

    const purged = await this.store.purgeSensitiveData(policy);
    if (purged.kind !== 'COMPLETE') {
      return {kind: 'BLOCKED_PENDING_ACTIONS', pending: purged.pending};
    }
    return {kind: 'COMPLETE'};
  }

  private async reconcile(item: StoredIntent): Promise<DrainItemResult> {
    let existing: ActionCommitResult | null = null;
    try {
      existing = await this.provider.getAction(item.actionId);
    } catch {
      return {actionId: item.actionId, kind: 'PENDING', reason: 'PROVIDER_QUERY_FAILED'};
    }
    if (existing) return this.acceptProviderResult(item, existing);

    let committed: ActionCommitResult;
    try {
      committed = await this.provider.commitAction(structuredClone(item.intent));
    } catch {
      return {actionId: item.actionId, kind: 'PENDING', reason: 'COMMIT_OUTCOME_UNKNOWN'};
    }
    return this.acceptProviderResult(item, committed);
  }

  private async acceptProviderResult(
    item: StoredIntent,
    result: ActionCommitResult,
  ): Promise<DrainItemResult> {
    if (
      result.actionId !== item.actionId ||
      !equalBytes(result.issuerProviderId, item.intent.issuerProviderId) ||
      !equalBytes(result.actionDigest, item.intent.actionDigest)
    ) {
      return {actionId: item.actionId, kind: 'REJECTED', reason: 'PROVIDER_EVIDENCE_CONFLICT'};
    }
    if (result.state === 'CONFLICT' || result.state === 'REJECTED') {
      return {
        actionId: item.actionId,
        kind: 'REJECTED',
        reason: result.reason ?? result.state,
      };
    }
    if (result.state !== 'PREPARING' && result.state !== 'SIGNED') {
      return {actionId: item.actionId, kind: 'PENDING', reason: result.state};
    }

    await this.store.markProviderCommitted(
      item.actionId,
      item.providerKey,
      result.state,
      result.eventDigest,
    );
    return {
      actionId: item.actionId,
      kind: 'PROVIDER_COMMITTED',
      state: result.state,
      eventDigest: result.eventDigest,
    };
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) {
    different |= left[index]! ^ right[index]!;
  }
  return different === 0;
}
