import type {ConsoleStore} from './consoleStore.js';
import type {
  ConsoleProvider,
  IncidentSnapshot,
  IncidentSnapshotEntry,
  SnapshotDescriptor,
} from './consoleTypes.js';

export type SnapshotSyncResult =
  | {kind: 'COMPLETE'; snapshotId: string; count: number; total: number}
  | {kind: 'INCOMPLETE'; reason: string};

export async function syncSnapshot(
  provider: ConsoleProvider,
  store: Pick<ConsoleStore, 'activateSnapshot'>,
  packageId: string | null,
): Promise<SnapshotSyncResult> {
  try {
    const descriptor = await provider.createSnapshot();
    validateDescriptor(descriptor);
    const entries: IncidentSnapshotEntry[] = [];
    const reportIds = new Set<string>();
    let cursor = descriptor.nextCursor;
    let pageCount = 0;

    while (cursor !== null) {
      if (++pageCount > 101) return {kind: 'INCOMPLETE', reason: 'PAGE_LIMIT'};
      const page = await provider.readSnapshotPage(descriptor.snapshotId, cursor);
      if (!sameSnapshot(descriptor, page)) {
        return {kind: 'INCOMPLETE', reason: 'SNAPSHOT_CHANGED'};
      }
      for (const entry of page.entries) {
        if (reportIds.has(entry.reportId)) {
          return {kind: 'INCOMPLETE', reason: 'DUPLICATE_REPORT'};
        }
        reportIds.add(entry.reportId);
        entries.push(entry);
      }
      if (entries.length > descriptor.total) {
        return {kind: 'INCOMPLETE', reason: 'COUNT_OVERFLOW'};
      }
      cursor = page.nextCursor;
    }

    if (entries.length !== descriptor.total) {
      return {kind: 'INCOMPLETE', reason: 'COUNT_MISMATCH'};
    }

    const snapshot: IncidentSnapshot = {
      ...descriptor,
      packageId,
      loadedCount: entries.length,
      entries,
      nextCursor: null,
    };
    await store.activateSnapshot(snapshot);
    return {
      kind: 'COMPLETE',
      snapshotId: snapshot.snapshotId,
      count: entries.length,
      total: snapshot.total,
    };
  } catch (error) {
    return {
      kind: 'INCOMPLETE',
      reason: error instanceof Error ? error.message : 'SNAPSHOT_FAILED',
    };
  }
}

function validateDescriptor(descriptor: SnapshotDescriptor): void {
  if (
    !descriptor.snapshotId ||
    !Number.isSafeInteger(descriptor.createdAtMs) ||
    descriptor.createdAtMs < 0 ||
    !Number.isSafeInteger(descriptor.expiresAtMs) ||
    descriptor.expiresAtMs <= descriptor.createdAtMs ||
    !Number.isSafeInteger(descriptor.total) ||
    descriptor.total < 0 ||
    descriptor.total > 10_000 ||
    descriptor.summary.total !== descriptor.total
  ) {
    throw new Error('INVALID_SNAPSHOT');
  }
  if (descriptor.total === 0 && descriptor.nextCursor !== null) {
    throw new Error('INVALID_SNAPSHOT');
  }
  if (descriptor.total > 0 && descriptor.nextCursor === null) {
    throw new Error('INVALID_SNAPSHOT');
  }
}

function sameSnapshot(
  descriptor: SnapshotDescriptor,
  page: SnapshotDescriptor,
): boolean {
  return page.snapshotId === descriptor.snapshotId &&
    page.createdAtMs === descriptor.createdAtMs &&
    page.expiresAtMs === descriptor.expiresAtMs &&
    page.total === descriptor.total &&
    JSON.stringify(page.summary) === JSON.stringify(descriptor.summary);
}
