import type {ActionIntent, ResponderStatusCode} from './consoleTypes.js';

const DOMAIN = new TextEncoder().encode('SAGIP-ACTION-V2\0');
const MAX_SAFE_U64 = 9_007_199_254_740_991n;

export interface ActionDraft {
  providerKind: 1 | 2;
  issuerProviderId: Uint8Array;
  reportId: string;
  reportProtocolVersion: 1 | 2;
  revision: number;
  payloadDigest: Uint8Array;
  originKeyId: Uint8Array;
  responderId: string;
  observedIncidentVersion: string;
  status: ResponderStatusCode;
  note: string;
}

export async function createActionIntent(
  draft: ActionDraft,
  actionId = crypto.randomUUID(),
): Promise<ActionIntent> {
  if (
    draft.issuerProviderId.length !== 32 ||
    draft.payloadDigest.length !== 32 ||
    draft.originKeyId.length !== 32 ||
    !Number.isInteger(draft.revision) ||
    draft.revision < 1 ||
    draft.revision > 0xffff_ffff
  ) {
    throw new Error('INVALID_ACTION_BINDING');
  }
  if (!/^(0|[1-9][0-9]*)$/u.test(draft.observedIncidentVersion)) {
    throw new Error('INVALID_INCIDENT_VERSION');
  }
  const observed = BigInt(draft.observedIncidentVersion);
  if (observed > MAX_SAFE_U64) throw new Error('INVALID_INCIDENT_VERSION');

  const noteBytes = new TextEncoder().encode(draft.note);
  if (draft.note.includes('\0') || noteBytes.length > 1024) {
    throw new Error('INVALID_NOTE');
  }

  const revision = new Uint8Array(4);
  new DataView(revision.buffer).setUint32(0, draft.revision, false);
  const observedBytes = new Uint8Array(8);
  new DataView(observedBytes.buffer).setBigUint64(0, observed, false);
  const noteLength = new Uint8Array(2);
  new DataView(noteLength.buffer).setUint16(0, noteBytes.length, false);

  const material = concatBytes(
    DOMAIN,
    uuidBytes(actionId),
    Uint8Array.of(draft.providerKind),
    draft.issuerProviderId,
    uuidBytes(draft.reportId),
    Uint8Array.of(draft.reportProtocolVersion),
    revision,
    draft.payloadDigest,
    draft.originKeyId,
    uuidBytes(draft.responderId),
    observedBytes,
    Uint8Array.of(draft.status),
    noteLength,
    noteBytes,
  );
  const actionDigest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', Uint8Array.from(material).buffer),
  );

  return {
    ...draft,
    actionId,
    issuerProviderId: draft.issuerProviderId.slice(),
    payloadDigest: draft.payloadDigest.slice(),
    originKeyId: draft.originKeyId.slice(),
    actionDigest,
  };
}

function uuidBytes(value: string): Uint8Array {
  const hex = value.replaceAll('-', '');
  if (!/^[0-9a-fA-F]{32}$/u.test(hex)) throw new Error('INVALID_UUID');
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
