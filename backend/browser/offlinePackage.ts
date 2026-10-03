const DATABASE_NAME = 'sagip-public-map-v1';
const DATABASE_VERSION = 1;
const PACKAGE_STORE = 'packages';
const RESOURCE_STORE = 'resources';
const STATE_STORE = 'state';
const ACTIVE_PACKAGE_KEY = 'activePackageId';
const DATABASE_OPEN_TIMEOUT_MS = 4_000;

export type OfflineResourceKind =
  | 'archive'
  | 'style'
  | 'font'
  | 'sprite'
  | 'shell';

export interface OfflineResourceManifest {
  path: string;
  sha256: string;
  bytes: number;
  kind: OfflineResourceKind;
}

export interface OfflineManifest {
  packageId: string;
  version: string;
  sourceDate: string;
  rights: string;
  attribution: string;
  appShellVersion: string;
  extent: readonly [number, number, number, number];
  bufferMeters: number;
  minZoom: number;
  maxZoom: number;
  totalBytes: number;
  resources: readonly OfflineResourceManifest[];
}

export type PreparationResult =
  | {kind: 'READY'; packageId: string; persistentStorage: boolean}
  | {kind: 'INCOMPLETE'; reason: string}
  | {kind: 'INSUFFICIENT_STORAGE'; availableBytes: number; requiredBytes: number};

export type ReadinessResult =
  | {
      kind: 'READY';
      packageId: string;
      persistentStorage: boolean;
      manifest: OfflineManifest;
    }
  | {kind: 'INCOMPLETE'; reason: string};

interface PackageRecord {
  packageId: string;
  state: 'STAGING' | 'READY';
  manifest: OfflineManifest;
  storedBytes: number;
  persistentStorage: boolean;
}

interface ResourceRecord {
  id: string;
  packageId: string;
  path: string;
  kind: OfflineResourceKind;
  bytes: Blob;
  size: number;
  sha256: string;
}

interface StateRecord {
  key: string;
  value: string;
}

export async function preparePackage(manifest: OfflineManifest): Promise<PreparationResult> {
  const validationError = validateManifest(manifest);
  if (validationError) return {kind: 'INCOMPLETE', reason: validationError};

  const storage = await inspectStorage(manifest.totalBytes);
  if (storage.kind === 'INSUFFICIENT_STORAGE') return storage;

  const database = await openDatabase();
  try {
    const current = await readPackage(database, manifest.packageId);
    if (current?.state === 'READY' && manifestsEqual(current.manifest, manifest)) {
      return {
        kind: 'READY',
        packageId: manifest.packageId,
        persistentStorage: current.persistentStorage,
      };
    }

    const activePackageId = await readActivePackageId(database);
    if (activePackageId === manifest.packageId && current?.state === 'READY') {
      return {kind: 'INCOMPLETE', reason: 'PACKAGE_ID_CONFLICT'};
    }

    await resetStagingPackage(database, manifest, storage.persistentStorage);

    let storedBytes = 0;
    for (const resource of manifest.resources) {
      let response: Response;
      try {
        response = await fetch(resource.path, {
          cache: 'no-store',
          credentials: 'same-origin',
        });
      } catch {
        return {kind: 'INCOMPLETE', reason: `RESOURCE_FETCH_FAILED:${resource.path}`};
      }

      if (!response.ok) {
        return {kind: 'INCOMPLETE', reason: `RESOURCE_FETCH_FAILED:${resource.path}`};
      }

      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== resource.bytes) {
        return {kind: 'INCOMPLETE', reason: `RESOURCE_SIZE_MISMATCH:${resource.path}`};
      }

      const digest = await sha256Hex(bytes);
      if (digest !== resource.sha256.toLowerCase()) {
        return {kind: 'INCOMPLETE', reason: `RESOURCE_DIGEST_MISMATCH:${resource.path}`};
      }

      await writeResource(database, manifest.packageId, resource, bytes);
      storedBytes += bytes.byteLength;
      await updateStagingBytes(database, manifest.packageId, storedBytes);
    }

    if (storedBytes !== manifest.totalBytes) {
      return {kind: 'INCOMPLETE', reason: 'PACKAGE_SIZE_MISMATCH'};
    }

    await activatePackage(database, manifest.packageId, storedBytes);
    return {
      kind: 'READY',
      packageId: manifest.packageId,
      persistentStorage: storage.persistentStorage,
    };
  } finally {
    database.close();
  }
}

export async function inspectReadiness(): Promise<ReadinessResult> {
  const database = await openDatabase();
  try {
    const packageId = await readActivePackageId(database);
    if (!packageId) return {kind: 'INCOMPLETE', reason: 'NO_ACTIVE_PACKAGE'};

    const record = await readPackage(database, packageId);
    if (!record || record.state !== 'READY') {
      return {kind: 'INCOMPLETE', reason: 'ACTIVE_PACKAGE_INCOMPLETE'};
    }

    const resources = await readPackageResources(database, packageId);
    if (resources.length !== record.manifest.resources.length) {
      return {kind: 'INCOMPLETE', reason: 'MISSING_RESOURCE'};
    }

    const resourcesByPath = new Map(resources.map(resource => [resource.path, resource]));
    for (const expected of record.manifest.resources) {
      const actual = resourcesByPath.get(expected.path);
      if (
        !actual ||
        actual.size !== expected.bytes ||
        actual.sha256 !== expected.sha256.toLowerCase() ||
        actual.kind !== expected.kind
      ) {
        return {kind: 'INCOMPLETE', reason: `RESOURCE_METADATA_MISMATCH:${expected.path}`};
      }
    }

    return {
      kind: 'READY',
      packageId,
      persistentStorage: record.persistentStorage,
      manifest: record.manifest,
    };
  } finally {
    database.close();
  }
}

export async function readArchiveRange(
  packageId: string,
  offset: number,
  length: number,
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError('Archive offset must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new RangeError('Archive length must be a positive safe integer');
  }

  const database = await openDatabase();
  try {
    const packageRecord = await readPackage(database, packageId);
    if (!packageRecord || packageRecord.state !== 'READY') {
      throw new Error('Offline map package is not ready');
    }

    const archive = packageRecord.manifest.resources.find(resource => resource.kind === 'archive');
    if (!archive) throw new Error('Offline map archive is missing');
    if (offset + length > archive.bytes) {
      throw new RangeError('Archive range exceeds the prepared map archive');
    }

    const stored = await requestToPromise<ResourceRecord | undefined>(
      database
        .transaction(RESOURCE_STORE, 'readonly')
        .objectStore(RESOURCE_STORE)
        .get(resourceKey(packageId, archive.path)),
    );
    if (!stored) throw new Error('Offline map archive is missing');

    return stored.bytes.slice(offset, offset + length).arrayBuffer();
  } finally {
    database.close();
  }
}

function validateManifest(manifest: OfflineManifest): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(manifest.packageId)) {
    return 'INVALID_PACKAGE_ID';
  }
  if (!isNonEmptyBounded(manifest.version, 80)) return 'INVALID_VERSION';
  if (!isNonEmptyBounded(manifest.sourceDate, 80)) return 'INVALID_SOURCE_DATE';
  if (!isNonEmptyBounded(manifest.rights, 1024)) return 'INVALID_RIGHTS';
  if (!isNonEmptyBounded(manifest.attribution, 1024)) return 'INVALID_ATTRIBUTION';
  if (!isNonEmptyBounded(manifest.appShellVersion, 80)) return 'INVALID_APP_SHELL_VERSION';

  const [west, south, east, north] = manifest.extent;
  if (
    !Number.isFinite(west) ||
    !Number.isFinite(south) ||
    !Number.isFinite(east) ||
    !Number.isFinite(north) ||
    west < -180 ||
    east > 180 ||
    south < -90 ||
    north > 90 ||
    west >= east ||
    south >= north
  ) {
    return 'INVALID_EXTENT';
  }

  if (!Number.isSafeInteger(manifest.bufferMeters) || manifest.bufferMeters < 0) {
    return 'INVALID_BUFFER';
  }
  if (
    !Number.isInteger(manifest.minZoom) ||
    !Number.isInteger(manifest.maxZoom) ||
    manifest.minZoom < 0 ||
    manifest.maxZoom > 24 ||
    manifest.minZoom > manifest.maxZoom
  ) {
    return 'INVALID_ZOOM_RANGE';
  }
  if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes <= 0) {
    return 'INVALID_TOTAL_BYTES';
  }
  if (manifest.resources.length === 0) return 'NO_RESOURCES';

  const paths = new Set<string>();
  let expectedTotal = 0;
  let archiveCount = 0;
  for (const resource of manifest.resources) {
    if (!resource.path.startsWith('/')) return 'RESOURCE_NOT_SAME_ORIGIN';
    const url = new URL(resource.path, location.origin);
    if (url.origin !== location.origin || url.username || url.password) {
      return 'RESOURCE_NOT_SAME_ORIGIN';
    }
    if (paths.has(url.pathname + url.search)) return 'DUPLICATE_RESOURCE';
    paths.add(url.pathname + url.search);
    if (!/^[0-9a-f]{64}$/u.test(resource.sha256.toLowerCase())) {
      return 'INVALID_RESOURCE_DIGEST';
    }
    if (!Number.isSafeInteger(resource.bytes) || resource.bytes <= 0) {
      return 'INVALID_RESOURCE_SIZE';
    }
    expectedTotal += resource.bytes;
    if (!Number.isSafeInteger(expectedTotal)) return 'INVALID_TOTAL_BYTES';
    if (resource.kind === 'archive') archiveCount += 1;
  }
  if (expectedTotal !== manifest.totalBytes) return 'PACKAGE_SIZE_MISMATCH';
  if (archiveCount !== 1) return 'ARCHIVE_COUNT_INVALID';

  return null;
}

async function inspectStorage(
  requiredBytes: number,
): Promise<
  | {kind: 'OK'; persistentStorage: boolean}
  | {kind: 'INSUFFICIENT_STORAGE'; availableBytes: number; requiredBytes: number}
> {
  const storage = navigator.storage;
  const estimate = await storage?.estimate?.();
  if (
    typeof estimate?.quota === 'number' &&
    typeof estimate.usage === 'number'
  ) {
    const availableBytes = Math.max(0, estimate.quota - estimate.usage);
    if (availableBytes < requiredBytes) {
      return {kind: 'INSUFFICIENT_STORAGE', availableBytes, requiredBytes};
    }
  }

  const persistentStorage = (await storage?.persist?.()) ?? false;
  return {kind: 'OK', persistentStorage};
}

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('OFFLINE_MAP_STORE_TIMEOUT'));
    }, DATABASE_OPEN_TIMEOUT_MS);

    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      reject(error);
    };

    request.onerror = () =>
      rejectOnce(request.error ?? new Error('Unable to open offline map store'));
    request.onblocked = () =>
      rejectOnce(new Error('OFFLINE_MAP_STORE_BLOCKED'));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PACKAGE_STORE)) {
        database.createObjectStore(PACKAGE_STORE, {keyPath: 'packageId'});
      }
      if (!database.objectStoreNames.contains(RESOURCE_STORE)) {
        const store = database.createObjectStore(RESOURCE_STORE, {keyPath: 'id'});
        store.createIndex('packageId', 'packageId', {unique: false});
      }
      if (!database.objectStoreNames.contains(STATE_STORE)) {
        database.createObjectStore(STATE_STORE, {keyPath: 'key'});
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      resolve(request.result);
    };
  });
}

async function resetStagingPackage(
  database: IDBDatabase,
  manifest: OfflineManifest,
  persistentStorage: boolean,
): Promise<void> {
  const transaction = database.transaction(
    [PACKAGE_STORE, RESOURCE_STORE],
    'readwrite',
  );
  const packages = transaction.objectStore(PACKAGE_STORE);
  const resources = transaction.objectStore(RESOURCE_STORE);
  const packageIndex = resources.index('packageId');
  const cursorRequest = packageIndex.openCursor(IDBKeyRange.only(manifest.packageId));

  await new Promise<void>((resolve, reject) => {
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('Unable to reset map package'));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
  });

  packages.put({
    packageId: manifest.packageId,
    state: 'STAGING',
    manifest: cloneManifest(manifest),
    storedBytes: 0,
    persistentStorage,
  } satisfies PackageRecord);
  await transactionDone(transaction);
}

async function writeResource(
  database: IDBDatabase,
  packageId: string,
  resource: OfflineResourceManifest,
  bytes: ArrayBuffer,
): Promise<void> {
  const transaction = database.transaction(RESOURCE_STORE, 'readwrite');
  transaction.objectStore(RESOURCE_STORE).put({
    id: resourceKey(packageId, resource.path),
    packageId,
    path: resource.path,
    kind: resource.kind,
    bytes: new Blob([bytes]),
    size: bytes.byteLength,
    sha256: resource.sha256.toLowerCase(),
  } satisfies ResourceRecord);
  await transactionDone(transaction);
}

async function updateStagingBytes(
  database: IDBDatabase,
  packageId: string,
  storedBytes: number,
): Promise<void> {
  const transaction = database.transaction(PACKAGE_STORE, 'readwrite');
  const store = transaction.objectStore(PACKAGE_STORE);
  const record = await requestToPromise<PackageRecord | undefined>(store.get(packageId));
  if (!record || record.state !== 'STAGING') {
    transaction.abort();
    throw new Error('Offline map staging record disappeared');
  }
  record.storedBytes = storedBytes;
  store.put(record);
  await transactionDone(transaction);
}

async function activatePackage(
  database: IDBDatabase,
  packageId: string,
  storedBytes: number,
): Promise<void> {
  const transaction = database.transaction(
    [PACKAGE_STORE, STATE_STORE],
    'readwrite',
  );
  const packages = transaction.objectStore(PACKAGE_STORE);
  const record = await requestToPromise<PackageRecord | undefined>(packages.get(packageId));
  if (!record || record.state !== 'STAGING' || record.storedBytes !== storedBytes) {
    transaction.abort();
    throw new Error('Offline map package is not complete');
  }

  record.state = 'READY';
  packages.put(record);
  transaction.objectStore(STATE_STORE).put({
    key: ACTIVE_PACKAGE_KEY,
    value: packageId,
  } satisfies StateRecord);
  await transactionDone(transaction);
}

async function readPackage(
  database: IDBDatabase,
  packageId: string,
): Promise<PackageRecord | undefined> {
  return requestToPromise<PackageRecord | undefined>(
    database.transaction(PACKAGE_STORE, 'readonly').objectStore(PACKAGE_STORE).get(packageId),
  );
}

async function readActivePackageId(database: IDBDatabase): Promise<string | null> {
  const record = await requestToPromise<StateRecord | undefined>(
    database.transaction(STATE_STORE, 'readonly').objectStore(STATE_STORE).get(ACTIVE_PACKAGE_KEY),
  );
  return record?.value ?? null;
}

async function readPackageResources(
  database: IDBDatabase,
  packageId: string,
): Promise<ResourceRecord[]> {
  return requestToPromise<ResourceRecord[]>(
    database
      .transaction(RESOURCE_STORE, 'readonly')
      .objectStore(RESOURCE_STORE)
      .index('packageId')
      .getAll(IDBKeyRange.only(packageId)),
  );
}

function resourceKey(packageId: string, path: string): string {
  return `${packageId}\u0000${path}`;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
}

function manifestsEqual(left: OfflineManifest, right: OfflineManifest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneManifest(manifest: OfflineManifest): OfflineManifest {
  return structuredClone(manifest);
}

function isNonEmptyBounded(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength;
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
