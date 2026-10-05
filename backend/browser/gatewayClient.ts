import {
  RESPONDER_STATUS_NAMES,
  type ActionCommitResult,
  type ActionIntent,
  type ConsoleProvider,
  type IncidentSnapshotEntry,
  type IncidentSnapshotPage,
  type SnapshotDescriptor,
  type TimeChallengeRequest,
} from './consoleTypes.js';

export interface NativeAuthorizationContext {
  method: string;
  path: string;
  body: Uint8Array;
}

export type NativeRequestAuthorizer = (
  context: NativeAuthorizationContext,
) => Promise<Record<string, string>>;

export interface GatewayClientOptions {
  providerKind: 1 | 2;
  providerId: Uint8Array;
  responderId: string;
  baseUrl?: string;
  authorizeNativeRequest?: NativeRequestAuthorizer;
}

export class GatewayClient implements ConsoleProvider {
  readonly providerKind: 1 | 2;
  readonly providerId: Uint8Array;
  readonly responderId: string;
  private readonly baseUrl: string;
  private readonly authorizeNativeRequest?: NativeRequestAuthorizer;

  constructor(options: GatewayClientOptions) {
    if (options.providerId.length !== 32) throw new Error('Provider ID must be 32 bytes');
    this.providerKind = options.providerKind;
    this.providerId = options.providerId.slice();
    this.responderId = options.responderId;
    this.baseUrl = (options.baseUrl ?? location.origin).replace(/\/$/u, '');
    this.authorizeNativeRequest = options.authorizeNativeRequest;
  }

  async createSnapshot(): Promise<SnapshotDescriptor> {
    const path = this.providerKind === 2 ? '/gateway/v1/snapshots' : '/v2/responder/snapshots';
    const response = await this.request(path, {method: 'POST'});
    return parseDescriptor(await response.json());
  }

  async readSnapshotPage(snapshotId: string, cursor: string): Promise<IncidentSnapshotPage> {
    requireUuid(snapshotId);
    if (!/^[A-Za-z0-9_-]{1,512}$/u.test(cursor)) throw new Error('INVALID_CURSOR');
    const prefix = this.providerKind === 2 ? '/gateway/v1/snapshots' : '/v2/responder/snapshots';
    const path = `${prefix}/${snapshotId}/pages?cursor=${encodeURIComponent(cursor)}`;
    const response = await this.request(path, {method: 'GET'});
    const raw = await response.json() as Record<string, unknown>;
    const descriptor = parseDescriptor(raw);
    const entries = requireArray(raw.entries).map(value =>
      parseEntry(requireRecord(value), this.providerKind),
    );
    return {...descriptor, entries};
  }

  async commitAction(intent: ActionIntent): Promise<ActionCommitResult> {
    validateBoundIntent(intent, this.providerId, this.responderId);
    const path = this.providerKind === 2 ? '/gateway/v1/actions' : '/v2/responder/actions';
    const body = new TextEncoder().encode(JSON.stringify(serializeIntent(intent, this.providerKind)));
    const response = await this.request(path, {
      method: 'POST',
      body,
      contentType: 'application/json',
    });
    return parseActionResult(await response.json());
  }

  async getAction(actionId: string): Promise<ActionCommitResult | null> {
    requireUuid(actionId);
    const prefix = this.providerKind === 2 ? '/gateway/v1/actions' : '/v2/responder/actions';
    const response = await this.request(`${prefix}/${actionId}`, {method: 'GET'}, true);
    if (response.status === 404) return null;
    return parseActionResult(await response.json());
  }

  async getActionReceipt(actionId: string): Promise<Uint8Array | null> {
    requireUuid(actionId);
    const prefix = this.providerKind === 2 ? '/gateway/v1/actions' : '/v2/responder/actions';
    const response = await this.request(`${prefix}/${actionId}/receipt`, {method: 'GET'}, true);
    if (response.status === 404 || response.status === 409) return null;
    return new Uint8Array(await response.arrayBuffer());
  }

  async fetchTimeProof(challenge: TimeChallengeRequest): Promise<Uint8Array> {
    const path = this.providerKind === 2 ? '/gateway/v1/time' : '/v2/authority/time';
    const payload: Record<string, unknown> = {
      verifierId: bytesToBase64(challenge.verifierId),
      verifierBootSessionId: challenge.verifierBootSessionId,
      nonce: bytesToBase64(challenge.nonce),
    };
    if (this.providerKind === 2) payload.challengeId = challenge.challengeId;
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const response = await this.request(path, {
      method: 'POST',
      body,
      contentType: 'application/json',
    });
    return new Uint8Array(await response.arrayBuffer());
  }

  async logout(): Promise<Response> {
    const path = this.providerKind === 2 ? '/gateway/v1/session' : '/v1/responder/session';
    return this.request(path, {method: 'DELETE'}, true);
  }

  private async request(
    path: string,
    options: {
      method: string;
      body?: Uint8Array;
      contentType?: string;
    },
    allowExpectedError = false,
  ): Promise<Response> {
    const body = options.body ?? new Uint8Array(0);
    const headers: Record<string, string> = {};
    if (options.contentType) headers['content-type'] = options.contentType;
    if (this.providerKind === 2) {
      if (!this.authorizeNativeRequest) throw new Error('NATIVE_AUTHORIZATION_REQUIRED');
      Object.assign(headers, await this.authorizeNativeRequest({
        method: options.method,
        path,
        body,
      }));
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method,
      headers,
      body: body.length > 0 ? ownedArrayBuffer(body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok && !allowExpectedError) throw await responseError(response);
    if (!response.ok && allowExpectedError && ![404, 409].includes(response.status)) {
      throw await responseError(response);
    }
    return response;
  }
}

function serializeIntent(intent: ActionIntent, providerKind: 1 | 2): Record<string, unknown> {
  return {
    actionId: intent.actionId,
    providerKind: intent.providerKind,
    issuerProviderId: providerKind === 2
      ? bytesToHex(intent.issuerProviderId)
      : bytesToBase64(intent.issuerProviderId),
    reportId: intent.reportId,
    reportProtocolVersion: intent.reportProtocolVersion,
    revision: intent.revision,
    payloadDigest: providerKind === 2
      ? bytesToHex(intent.payloadDigest)
      : bytesToBase64(intent.payloadDigest),
    originKeyId: providerKind === 2
      ? bytesToHex(intent.originKeyId)
      : bytesToBase64(intent.originKeyId),
    responderId: intent.responderId,
    observedIncidentVersion: intent.observedIncidentVersion,
    status: providerKind === 2 ? RESPONDER_STATUS_NAMES[intent.status] : intent.status,
    note: intent.note,
    actionDigest: providerKind === 2
      ? bytesToHex(intent.actionDigest)
      : bytesToBase64(intent.actionDigest),
  };
}

function parseActionResult(raw: unknown): ActionCommitResult {
  const value = requireRecord(raw);
  return {
    actionId: requireString(value.actionId),
    issuerProviderId: decodeDigest(requireString(value.issuerProviderId)),
    actionDigest: decodeDigest(requireString(value.actionDigest)),
    state: requireString(value.state) as ActionCommitResult['state'],
    eventDigest: value.eventDigest === null ? null : requireString(value.eventDigest),
    reason: value.reason === null ? null : requireString(value.reason),
  };
}

function parseDescriptor(raw: unknown): SnapshotDescriptor {
  const value = requireRecord(raw);
  const summaryRaw = requireRecord(value.summary);
  const summary: Record<string, number> = {};
  for (const [key, item] of Object.entries(summaryRaw)) {
    if (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0) summary[key] = item;
  }
  const total = requireSafeInteger(value.total);
  summary.total = typeof summary.total === 'number' ? summary.total : total;
  return {
    snapshotId: requireString(value.snapshotId),
    createdAtMs: requireSafeInteger(value.createdAtMs),
    expiresAtMs: requireSafeInteger(value.expiresAtMs),
    total,
    summary: summary as unknown as SnapshotDescriptor['summary'],
    nextCursor: value.nextCursor === null ? null : requireString(value.nextCursor),
  };
}

function parseEntry(value: Record<string, unknown>, providerKind: 1 | 2): IncidentSnapshotEntry {
  const locationRaw = value.location === null ? null : requireRecord(value.location);
  const evidence = requireArray(value.receiptEvidence ?? []).map(item => {
    const record = requireRecord(item);
    return {
      eventId: requireString(record.eventId),
      eventDigest: requireString(record.eventDigest),
      bytes: base64ToBytes(requireString(record.bytesBase64)),
      kind: requireString(record.kind) as 'SGA2' | 'SGR2',
      revision: typeof record.revision === 'number'
        ? requireSafeInteger(record.revision)
        : requireSafeInteger(value.revision),
      verification: requireString(record.verification),
      issuerProviderId: record.issuerProviderId === null || record.issuerProviderId === undefined
        ? null
        : requireString(record.issuerProviderId),
    };
  });
  const pendingActions = requireArray(value.pendingActions ?? []).map(item => {
    const record = requireRecord(item);
    return {
      actionId: requireString(record.actionId),
      observedIncidentVersion: requireString(record.observedIncidentVersion),
      status: requireString(record.status) as IncidentSnapshotEntry['pendingActions'][number]['status'],
      note: requireString(record.note),
    };
  });
  return {
    reportId: requireString(value.reportId),
    reportProtocolVersion: requireSafeInteger(value.reportProtocolVersion) as 1 | 2,
    revision: requireSafeInteger(value.revision),
    payloadDigest: decodeDigest(requireString(value.payloadDigest), providerKind),
    originKeyId: decodeDigest(requireString(value.originKeyId), providerKind),
    observedIncidentVersion: requireString(value.observedIncidentVersion),
    emergencyType: requireString(value.emergencyType),
    message: value.message === null || value.message === undefined ? null : requireString(value.message),
    urgency: requireString(value.urgency),
    location: locationRaw
      ? {
          latitude: requireFinite(locationRaw.latitude),
          longitude: requireFinite(locationRaw.longitude),
          accuracyMeters: locationRaw.accuracyMeters === null ? null : requireFinite(locationRaw.accuracyMeters),
          capturedAtMs: locationRaw.capturedAtMs === null ? null : requireSafeInteger(locationRaw.capturedAtMs),
          source: locationRaw.source === null ? null : requireString(locationRaw.source),
          freshness: locationRaw.freshness === null ? null : requireString(locationRaw.freshness),
        }
      : null,
    reportCreatedAtMs: requireSafeInteger(value.reportCreatedAtMs),
    receivedAtMs: requireSafeInteger(value.receivedAtMs),
    syncedAtMs: value.syncedAtMs === null ? null : requireSafeInteger(value.syncedAtMs),
    receiptEvidence: evidence,
    pendingActions,
    latestAck: value.latestAck === undefined
      ? undefined
      : value.latestAck === null
        ? null
        : parseLatestAck(requireRecord(value.latestAck)),
    revisions: Array.isArray(value.revisions) ? value.revisions : undefined,
    acknowledgements: Array.isArray(value.acknowledgements) ? value.acknowledgements : undefined,
  };
}

function parseLatestAck(value: Record<string, unknown>): NonNullable<IncidentSnapshotEntry['latestAck']> {
  return {
    ackId: requireString(value.ackId),
    callsign: requireString(value.callsign),
    status: requireString(value.status) as NonNullable<IncidentSnapshotEntry['latestAck']>['status'],
    note: value.note === null ? null : requireString(value.note),
    acknowledgedAt: requireString(value.acknowledgedAt),
  };
}

function validateBoundIntent(intent: ActionIntent, providerId: Uint8Array, responderId: string): void {
  if (
    !equalBytes(intent.issuerProviderId, providerId) ||
    intent.providerKind < 1 ||
    intent.providerKind > 2 ||
    intent.responderId !== responderId
  ) throw new Error('ACTION_PROVIDER_BINDING');
}

function decodeDigest(value: string, providerKind?: 1 | 2): Uint8Array {
  if (providerKind === 2 || /^[0-9a-f]{64}$/u.test(value)) return hexToBytes(value);
  return base64ToBytes(value);
}

async function responseError(response: Response): Promise<Error> {
  try {
    const body = await response.json() as {error?: unknown};
    return new Error(typeof body.error === 'string' ? body.error : `HTTP_${response.status}`);
  } catch {
    return new Error(`HTTP_${response.status}`);
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('INVALID_RESPONSE');
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('INVALID_RESPONSE');
  return value;
}

function requireSafeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('INVALID_RESPONSE');
  return value;
}

function requireFinite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('INVALID_RESPONSE');
  return value;
}

function requireUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error('INVALID_UUID');
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error('INVALID_DIGEST');
  const bytes = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (bytesToBase64(bytes) !== value) throw new Error('INVALID_BASE64');
  return bytes;
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) different |= left[index]! ^ right[index]!;
  return different === 0;
}
