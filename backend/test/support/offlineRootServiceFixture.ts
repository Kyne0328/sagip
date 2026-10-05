import {createHash, sign, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {applyMigrations} from '../../src/db/migrate.js';
import {IngestionRepository} from '../../src/ingestion/repository.js';
import {verifyEnvelopeV1} from '../../src/protocol/envelopeV1.js';
import {canonicalizeNewReceiptSignature} from '../../src/protocol/receiptV2.js';
import {actionDigest, issuerProviderId} from '../../src/responder/receiptAuthority.js';
import {createOfflineReceiptRuntime} from '../../src/responder/offlineReceiptRuntime.js';
import {type ActionIntent, type AuthoritySigner} from '../../src/responder/receiptService.js';
import {type OfflineRootSnapshotPolicy} from '../../src/protocol/offlineRootSnapshot.js';
import {createCompatibilityPostgres} from './compatibilityPostgres.js';
import {buildSignedEnvelope, createTestIdentity} from './envelopeFactory.js';
const NIL = '00000000-0000-0000-0000-000000000000';
export const T = 1700000000000;
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest();
export async function offlineRootServiceFixture(uncertaintyMs = 10) {
  const database = await createCompatibilityPostgres(), pool = database.pool;
  await applyMigrations(pool, fileURLToPath(new URL('../../migrations/', import.meta.url)));
  const root = createTestIdentity(), signer = createTestIdentity(), origin = createTestIdentity();
  const envelopeBytes = buildSignedEnvelope({identity: origin});
  const envelope = verifyEnvelopeV1(envelopeBytes);
  await new IngestionRepository(pool).accept({bytes: envelopeBytes, envelope, acceptedAt: new Date(T)});
  const responder = {responderId: '33333333-3333-4333-8333-333333333333',
    callsign: 'SYNTHETIC TEAM', role: 'RESPONDER', registeredAt: new Date(T).toISOString()};
  const admin = {...responder, responderId: '44444444-4444-4444-8444-444444444444',
    callsign: 'SYNTHETIC ADMIN', role: 'AUTHORITY_ADMIN'};
  for (const who of [responder, admin]) await pool.query('INSERT INTO responder_identities VALUES ($1,$2,$3,$4,$5)',
    [who.responderId, who.callsign, who.role, who.responderId.replaceAll('-', '').repeat(2), who.registeredAt]);
  const rootId = hash(root.publicKeyDer), signerId = hash(signer.publicKeyDer),
    provider = issuerProviderId(1, rootId, NIL);
  const policy: OfflineRootSnapshotPolicy = {
    mode: 'BOUNDED_OFFLINE_ROOT_SNAPSHOT', authorityDomainId: 'SYNTHETIC_AUTHORITY',
    signerBindings: [{checkpointSignerKeyId: signerId.toString('hex'),
      receiptRootKeyId: rootId.toString('hex'), issuerProviderId: provider.toString('hex')}],
    allowedScopes: ['SYNTHETIC_SCOPE'], allowedStatuses: [1,2,3,4],
    maxAuthorityStalenessMs: 900000, maxReceiptIssuanceAgeMs: 86400000,
    maxProofValidityMs: 900000, qualifiedTimeSourceIds: ['SYNTHETIC_QUALIFIED_SOURCE'],
    disseminationAudience: 'ORIGIN_AND_CUSTODY_RELAYS',
    providerConflictHandling: 'KEEP_SEPARATE_NO_AUTOMATIC_CLOSURE',
    resolvedHandling: 'REPORTED_STATUS_ONLY_NO_AUTOMATIC_CLOSURE', maxReplayRecords: 100000,
  };
  let now = T, signerFails = false;
  const makeSigner = (key: typeof root): AuthoritySigner => ({
    publicKeyDer: key.publicKeyDer, sign: async bytes => {
      if (signerFails && key === signer) throw new Error('synthetic checkpoint outage');
      return canonicalizeNewReceiptSignature(sign('sha256', bytes,
        {key: key.privateKey, dsaEncoding: 'ieee-p1363'}));
    },
  });
  const makeRuntime = () => createOfflineReceiptRuntime(pool, {SAGIP_OFFLINE_RECEIPTS_MODE: 'ADAPTER'}, {
    signer: makeSigner(root), pinnedRootKeyId: rootId.toString('hex'),
    qualifiedTime: () => ({timeMs: now, uncertaintyMs, validForMs: 3600000}),
    isQualified: () => true,
    authorityPolicy: {approvedIssuerKeyIds: new Set(), allowedScopes: new Set(['SYNTHETIC_SCOPE']),
      allowedResponderRoles: new Set(['RESPONDER']), verifierOwners: new Map(), statusMask: 15, purposeMask: 9},
    gatewayAccess: {allowedRoles: new Set(['RESPONDER']),
      isReportAuthorized: (actor, report) => actor.responderId === responder.responderId && report === envelope.reportId},
    offlineRoot: {checkpointSigner: makeSigner(signer), pinnedCheckpointSignerKeyId: signerId.toString('hex'),
      policy, scope: 'SYNTHETIC_SCOPE', allowedResponderRoles: new Set(['RESPONDER']),
      qualifiedSourceId: 'SYNTHETIC_QUALIFIED_SOURCE'},
  });
  const runtime = makeRuntime();
  const snapshots = runtime.offlineRootSnapshotService!, service = runtime.receiptService!;
  const createAction = async (status = 2, note = '', actionId = randomUUID()) => {
    const version = (await pool.query<{receipt_version: string}>(
      'SELECT receipt_version FROM incidents WHERE report_id=$1', [envelope.reportId])).rows[0]!.receipt_version;
    const intent: ActionIntent = {
      actionId, providerKind: 1, issuerProviderId: provider, reportId: envelope.reportId,
      reportProtocolVersion: 1, revision: 1, payloadDigest: envelope.payloadDigest,
      originKeyId: envelope.originKeyId, responderId: responder.responderId,
      observedIncidentVersion: BigInt(version), status, note, actionDigest: Buffer.alloc(32),
    };
    intent.actionDigest = actionDigest({...intent, purpose: 1, issuerKeyId: rootId, grantId: NIL,
      callsign: responder.callsign, sequence: 1n, issuedAtMs: now - 10, forwardingExpiresAtMs: now + 604800000});
    await service.allocateAction(intent, responder);
    const result = await service.prepareReceipt(actionId);
    return {result, actionId, receipt: Buffer.from((await service.getReceipt(actionId))!)};
  };
  return {pool, root, signer, origin, responder, admin, envelope, envelopeBytes, policy, snapshots,
    runtime, makeRuntime, service, createAction, close: database.close,
    setTime: (time: number) => {now = time;}, failSigner: (fail: boolean) => {signerFails = fail;}};
}
