import type {ActionIntent, IncidentSnapshot} from './consoleTypes.js';

const DATABASE_NAME = 'sagip-responder-console-v1';
const DATABASE_VERSION = 1;
const SNAPSHOT_STORE = 'snapshots';
const INTENT_STORE = 'intents';
const META_STORE = 'meta';
const AUDIT_STORE = 'audit';

const ACTIVE_SNAPSHOT_KEY = 'activeSnapshotId';
const TIME_HIGH_WATER_KEY = 'timeHighWaterEarliestMs';
const TOTAL_PROTECTED_BYTES = 64 * 1024 * 1024;
const INTENT_RESERVED_BYTES = 8 * 1024 * 1024;
const MAX_INCIDENTS = 10_000;

export interface ConsoleStoreLimits {
  totalProtectedBytes?: number;
  intentReservedBytes?: number;
}

interface NormalizedLimits {
  totalProtectedBytes: number;
  intentReservedBytes: number;
  snapshotBudgetBytes: number;
}

export type IntentSaveResult =
  | {kind: 'SAVED'; actionId: string}
  | {kind: 'FULL'}
  | {kind: 'REJECTED'; reason: string};

export type LogoutPolicy =
  | {kind: 'EXPORT_TO_GATEWAY'}
  | {kind: 'DISCARD'; confirmed: boolean; reason: string};

export type LogoutResult =
  | {kind: 'COMPLETE'}
  | {kind: 'BLOCKED_PENDING_ACTIONS'; pending: number};

export interface StoredIntent {
  actionId: string;
  providerKey: string;
  intent: ActionIntent;
  state: 'PENDING' | 'PROVIDER_COMMITTED';
  result: {
    eventDigest: string | null;
    providerState: string;
  } | null;
  createdAtMs: number;
  updatedAtMs: number;
  byteCount: number;
}

export interface AccessGrant {
  responderId: string;
  providerKey: string;
  earliestMs: number;
  latestMs: number;
  validUntilMs: number;
  bootId: string;
  receivedElapsedMs: number;
}

interface SnapshotRecord {
  snapshotId: string;
  snapshot: IncidentSnapshot;
  byteCount: number;
}

interface MetaRecord {
  key: string;
  value: string | number;
}

interface AuditRecord {
  id: string;
  type: 'DISCARDED_PENDING_ACTIONS';
  recordedAtMs: number;
  count: number;
  reason: string;
}

export class ConsoleStore {
  private access: AccessGrant | null = null;

  private constructor(
    private readonly database: IDBDatabase,
    private readonly limits: NormalizedLimits,
  ) {}

  static async open(limits: ConsoleStoreLimits = {}): Promise<ConsoleStore> {
    return new ConsoleStore(await openDatabase(), normalizeLimits(limits));
  }

  close(): void {
    this.access = null;
    this.database.close();
  }

  lock(): void {
    this.access = null;
  }

  unlock(grant: AccessGrant): void {
    if (
      !grant.responderId ||
      !grant.providerKey ||
      !Number.isSafeInteger(grant.earliestMs) ||
      !Number.isSafeInteger(grant.latestMs) ||
      !Number.isSafeInteger(grant.validUntilMs) ||
      !Number.isFinite(grant.receivedElapsedMs) ||
      grant.earliestMs < 0 ||
      grant.latestMs < grant.earliestMs ||
      grant.validUntilMs <= grant.latestMs ||
      !grant.bootId
    ) {
      throw new Error('Invalid protected-console access grant');
    }
    this.access = structuredClone(grant);
  }

  isUnlocked(responderId?: string, providerKey?: string): boolean {
    return this.currentAccess(responderId, providerKey) !== null;
  }

  currentAccess(responderId?: string, providerKey?: string): AccessGrant | null {
    const access = this.access;
    if (!access) return null;
    if (responderId && access.responderId !== responderId) return null;
    if (providerKey && access.providerKey !== providerKey) return null;

    const elapsed = performance.now() - access.receivedElapsedMs;
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      this.access = null;
      return null;
    }
    const latestNow = access.latestMs + elapsed + Math.ceil(elapsed / 10_000);
    if (latestNow >= access.validUntilMs) {
      this.access = null;
      return null;
    }
    return structuredClone(access);
  }

  async readTimeHighWater(): Promise<number | null> {
    const value = await requestToPromise<MetaRecord | undefined>(
      this.database.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(TIME_HIGH_WATER_KEY),
    );
    return typeof value?.value === 'number' ? value.value : null;
  }

  async commitTimeHighWater(earliestMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(earliestMs) || earliestMs < 0) return false;
    const transaction = this.database.transaction(META_STORE, 'readwrite');
    const store = transaction.objectStore(META_STORE);
    const existing = await requestToPromise<MetaRecord | undefined>(store.get(TIME_HIGH_WATER_KEY));
    if (typeof existing?.value === 'number' && earliestMs < existing.value) {
      transaction.abort();
      return false;
    }
    store.put({key: TIME_HIGH_WATER_KEY, value: earliestMs} satisfies MetaRecord);
    await transactionDone(transaction);
    return true;
  }

  async activateSnapshot(snapshot: IncidentSnapshot): Promise<void> {
    this.requireAccess();
    validateSnapshot(snapshot);
    const byteCount = estimateBytes(snapshot);
    if (byteCount > this.limits.snapshotBudgetBytes) {
      throw new Error('SNAPSHOT_CAPACITY_FULL');
    }

    const transaction = this.database.transaction([SNAPSHOT_STORE, META_STORE], 'readwrite');
    const snapshots = transaction.objectStore(SNAPSHOT_STORE);
    snapshots.put({
      snapshotId: snapshot.snapshotId,
      snapshot: structuredClone(snapshot),
      byteCount,
    } satisfies SnapshotRecord);
    transaction.objectStore(META_STORE).put({
      key: ACTIVE_SNAPSHOT_KEY,
      value: snapshot.snapshotId,
    } satisfies MetaRecord);
    await transactionDone(transaction);
    await this.pruneInactiveSnapshots(snapshot.snapshotId);
  }

  async readSnapshot(): Promise<IncidentSnapshot | null> {
    this.requireAccess();
    const meta = await requestToPromise<MetaRecord | undefined>(
      this.database.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(ACTIVE_SNAPSHOT_KEY),
    );
    if (typeof meta?.value !== 'string') return null;
    const record = await requestToPromise<SnapshotRecord | undefined>(
      this.database.transaction(SNAPSHOT_STORE, 'readonly').objectStore(SNAPSHOT_STORE).get(meta.value),
    );
    return record ? structuredClone(record.snapshot) : null;
  }

  async saveIntent(intent: ActionIntent, providerKey: string): Promise<IntentSaveResult> {
    this.requireAccess(intent.responderId, providerKey);
    const validation = validateIntent(intent, providerKey);
    if (validation) return {kind: 'REJECTED', reason: validation};

    const byteCount = estimateBytes({intent, providerKey});
    const transaction = this.database.transaction(INTENT_STORE, 'readwrite');
    const store = transaction.objectStore(INTENT_STORE);
    const existing = await requestToPromise<StoredIntent | undefined>(store.get(intent.actionId));
    if (existing) {
      if (existing.providerKey !== providerKey || !sameIntent(existing.intent, intent)) {
        transaction.abort();
        return {kind: 'REJECTED', reason: 'ACTION_CONFLICT'};
      }
      await transactionDone(transaction);
      return {kind: 'SAVED', actionId: intent.actionId};
    }

    const all = await requestToPromise<StoredIntent[]>(store.getAll());
    const used = all.reduce((sum, item) => sum + item.byteCount, 0);
    if (used + byteCount > this.limits.intentReservedBytes) {
      transaction.abort();
      return {kind: 'FULL'};
    }

    const now = Date.now();
    store.put({
      actionId: intent.actionId,
      providerKey,
      intent: structuredClone(intent),
      state: 'PENDING',
      result: null,
      createdAtMs: now,
      updatedAtMs: now,
      byteCount,
    } satisfies StoredIntent);
    await transactionDone(transaction);
    return {kind: 'SAVED', actionId: intent.actionId};
  }

  async listIntents(): Promise<StoredIntent[]> {
    this.requireAccess();
    const items = await requestToPromise<StoredIntent[]>(
      this.database.transaction(INTENT_STORE, 'readonly').objectStore(INTENT_STORE).getAll(),
    );
    return items
      .sort((a, b) => a.createdAtMs - b.createdAtMs || a.actionId.localeCompare(b.actionId))
      .map(item => structuredClone(item));
  }

  async getIntent(actionId: string): Promise<StoredIntent | null> {
    this.requireAccess();
    const item = await requestToPromise<StoredIntent | undefined>(
      this.database.transaction(INTENT_STORE, 'readonly').objectStore(INTENT_STORE).get(actionId),
    );
    return item ? structuredClone(item) : null;
  }

  async pendingIntentCount(): Promise<number> {
    return (await this.listIntents()).filter(item => item.state !== 'PROVIDER_COMMITTED').length;
  }

  async markProviderCommitted(
    actionId: string,
    providerKey: string,
    providerState: string,
    eventDigest: string | null,
  ): Promise<void> {
    this.requireAccess(undefined, providerKey);
    const transaction = this.database.transaction(INTENT_STORE, 'readwrite');
    const store = transaction.objectStore(INTENT_STORE);
    const item = await requestToPromise<StoredIntent | undefined>(store.get(actionId));
    if (!item || item.providerKey !== providerKey) {
      transaction.abort();
      throw new Error('ACTION_NOT_FOUND');
    }
    item.state = 'PROVIDER_COMMITTED';
    item.result = {providerState, eventDigest};
    item.updatedAtMs = Date.now();
    store.put(item);
    await transactionDone(transaction);
  }

  async purgeSensitiveData(policy: LogoutPolicy): Promise<LogoutResult> {
    this.requireAccess();
    const intents = await this.listIntents();
    const pending = intents.filter(item => item.state !== 'PROVIDER_COMMITTED');
    if (pending.length > 0 && policy.kind !== 'DISCARD') {
      return {kind: 'BLOCKED_PENDING_ACTIONS', pending: pending.length};
    }
    if (pending.length > 0 && policy.kind === 'DISCARD' && !policy.confirmed) {
      return {kind: 'BLOCKED_PENDING_ACTIONS', pending: pending.length};
    }

    const transaction = this.database.transaction(
      [SNAPSHOT_STORE, INTENT_STORE, META_STORE, AUDIT_STORE],
      'readwrite',
    );
    transaction.objectStore(SNAPSHOT_STORE).clear();
    transaction.objectStore(INTENT_STORE).clear();
    transaction.objectStore(META_STORE).delete(ACTIVE_SNAPSHOT_KEY);
    if (pending.length > 0 && policy.kind === 'DISCARD') {
      transaction.objectStore(AUDIT_STORE).put({
        id: crypto.randomUUID(),
        type: 'DISCARDED_PENDING_ACTIONS',
        recordedAtMs: Date.now(),
        count: pending.length,
        reason: policy.reason.slice(0, 240),
      } satisfies AuditRecord);
    }
    await transactionDone(transaction);
    this.access = null;
    return {kind: 'COMPLETE'};
  }

  async readAudit(): Promise<AuditRecord[]> {
    this.requireAccess();
    return requestToPromise<AuditRecord[]>(
      this.database.transaction(AUDIT_STORE, 'readonly').objectStore(AUDIT_STORE).getAll(),
    );
  }

  private requireAccess(responderId?: string, providerKey?: string): AccessGrant {
    const access = this.currentAccess(responderId, providerKey);
    if (!access) throw new Error('PROTECTED_CONSOLE_LOCKED');
    return access;
  }

  private async pruneInactiveSnapshots(activeSnapshotId: string): Promise<void> {
    const transaction = this.database.transaction(SNAPSHOT_STORE, 'readwrite');
    const store = transaction.objectStore(SNAPSHOT_STORE);
    const cursor = store.openCursor();
    await new Promise<void>((resolve, reject) => {
      cursor.onerror = () => reject(cursor.error ?? new Error('Unable to prune snapshots'));
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) {
          resolve();
          return;
        }
        if (item.key !== activeSnapshotId) item.delete();
        item.continue();
      };
    });
    await transactionDone(transaction);
  }
}

function validateSnapshot(snapshot: IncidentSnapshot): void {
  if (
    !snapshot.snapshotId ||
    !Number.isInteger(snapshot.total) ||
    snapshot.total < 0 ||
    snapshot.total > MAX_INCIDENTS ||
    snapshot.loadedCount !== snapshot.total ||
    snapshot.entries.length !== snapshot.total
  ) {
    throw new Error('SNAPSHOT_INCOMPLETE');
  }
  const ids = new Set<string>();
  for (const entry of snapshot.entries) {
    if (!entry.reportId || ids.has(entry.reportId)) throw new Error('SNAPSHOT_DUPLICATE_REPORT');
    ids.add(entry.reportId);
  }
}

function validateIntent(intent: ActionIntent, providerKey: string): string | null {
  if (!isUuid(intent.actionId) || !isUuid(intent.reportId) || !isUuid(intent.responderId)) return 'INVALID_ACTION';
  if (intent.issuerProviderId.length !== 32 || intent.payloadDigest.length !== 32 ||
      intent.originKeyId.length !== 32 || intent.actionDigest.length !== 32) return 'INVALID_ACTION';
  if (providerKey !== bytesToHex(intent.issuerProviderId)) return 'PROVIDER_CONFLICT';
  if (!/^(0|[1-9][0-9]*)$/u.test(intent.observedIncidentVersion)) return 'INVALID_ACTION';
  const observed = BigInt(intent.observedIncidentVersion);
  if (observed > 9_007_199_254_740_991n) return 'INVALID_ACTION';
  if (intent.revision < 1 || !Number.isInteger(intent.revision) || (intent.reportProtocolVersion !== 1 && intent.reportProtocolVersion !== 2)) return 'INVALID_ACTION';
  if (intent.note.includes('\0') || new TextEncoder().encode(intent.note).length > 1024) {
    return 'INVALID_ACTION';
  }
  return null;
}

function sameIntent(left: ActionIntent, right: ActionIntent): boolean {
  return left.actionId === right.actionId &&
    left.providerKind === right.providerKind &&
    equalBytes(left.issuerProviderId, right.issuerProviderId) &&
    left.reportId === right.reportId &&
    left.reportProtocolVersion === right.reportProtocolVersion &&
    left.revision === right.revision &&
    equalBytes(left.payloadDigest, right.payloadDigest) &&
    equalBytes(left.originKeyId, right.originKeyId) &&
    left.responderId === right.responderId &&
    left.observedIncidentVersion === right.observedIncidentVersion &&
    left.status === right.status &&
    left.note === right.note &&
    equalBytes(left.actionDigest, right.actionDigest);
}

function normalizeLimits(input: ConsoleStoreLimits): NormalizedLimits {
  const totalProtectedBytes = input.totalProtectedBytes ?? TOTAL_PROTECTED_BYTES;
  const intentReservedBytes = input.intentReservedBytes ?? INTENT_RESERVED_BYTES;
  if (
    !Number.isSafeInteger(totalProtectedBytes) || totalProtectedBytes <= 0 ||
    !Number.isSafeInteger(intentReservedBytes) || intentReservedBytes <= 0 ||
    totalProtectedBytes > TOTAL_PROTECTED_BYTES ||
    intentReservedBytes > INTENT_RESERVED_BYTES ||
    intentReservedBytes >= totalProtectedBytes
  ) {
    throw new RangeError('Invalid protected-console storage limits');
  }
  return {
    totalProtectedBytes,
    intentReservedBytes,
    snapshotBudgetBytes: totalProtectedBytes - intentReservedBytes,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) different |= left[index]! ^ right[index]!;
  return different === 0;
}

function estimateBytes(value: unknown): number {
  const text = JSON.stringify(value, (_key, item) => {
    if (item instanceof Uint8Array) return {bytesHex: bytesToHex(item)};
    return item;
  });
  return new TextEncoder().encode(text).length;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error('Unable to open protected console store'));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SNAPSHOT_STORE)) {
        database.createObjectStore(SNAPSHOT_STORE, {keyPath: 'snapshotId'});
      }
      if (!database.objectStoreNames.contains(INTENT_STORE)) {
        database.createObjectStore(INTENT_STORE, {keyPath: 'actionId'});
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, {keyPath: 'key'});
      }
      if (!database.objectStoreNames.contains(AUDIT_STORE)) {
        database.createObjectStore(AUDIT_STORE, {keyPath: 'id'});
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}
