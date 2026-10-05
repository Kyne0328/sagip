import {IngestionConflictError, IngestionTransientError, type ServerReceipt} from '../ingestion/service.js';
import {MAX_ENVELOPE_BYTES} from '../protocol/envelopeV1.js';
import {MAX_RECEIPT_BYTES} from '../protocol/receiptV2.js';
import {ProtocolValidationError} from '../protocol/errors.js';
import {
  RESPONDER_SESSION_TTL_SECONDS,
  ResponderNotFoundError,
  type ResponderService,
  ResponderValidationError,
} from '../responder/service.js';
import {parseReportStatusAccessProof, validReportStatusCursor} from '../responder/reportStatusAccess.js';
import type {ResponderIdentity, ResponderStatus} from '../responder/types.js';
import type {IncidentSnapshotService} from '../responder/incidentSnapshot.js';
import type {ActionCommitResult, ActionIntent, ReceiptService} from '../responder/receiptService.js';
import type {GatewayGrantRequest, GrantProvisioningService, TimeChallenge} from '../responder/grantProvisioning.js';
import {responderDashboardResponse} from '../responder/dashboard.js';
import {
  createLocalSagipRateLimiters,
  type RateLimiter,
  type SagipRateLimiters,
} from './rateLimiter.js';

export interface SagipServerDependencies {
  ingestEnvelope(bytes: Buffer): Promise<ServerReceipt>;
  responderService?: ResponderService;
  receiptService?: ReceiptService;
  authorityService?: GrantProvisioningService;
  incidentSnapshotService?: IncidentSnapshotService;
  rateLimiter?: RateLimiter;
  rateLimiters?: SagipRateLimiters;
}

export interface SagipRequestContext {
  clientIp?: string;
  discardBody?: () => void;
}

const defaultRateLimiters = createLocalSagipRateLimiters();

class RequestBodyTooLargeError extends Error {}

const UUID_SEGMENT = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const REPORT_STATUS_RE = new RegExp(`^/v1/reports/(${UUID_SEGMENT})/status$`, 'u');
const INCIDENT_ACK_RE = new RegExp(`^/v1/incidents/(${UUID_SEGMENT})/ack$`, 'u');
const INCIDENT_DETAIL_RE = new RegExp(`^/v1/incidents/(${UUID_SEGMENT})$`, 'u');
const RESPONDER_SESSION_PATH = '/v1/responder/session';
const RECEIPT_IMPORT_PATH = '/v2/responder/receipts/import';
const RESPONDER_ACTIONS_PATH = '/v2/responder/actions';
const RESPONDER_ACTION_RE = new RegExp(`^/v2/responder/actions/(${UUID_SEGMENT})$`, 'u');
const RESPONDER_ACTION_RECEIPT_RE = new RegExp(`^/v2/responder/actions/(${UUID_SEGMENT})/receipt$`, 'u');
const RESPONDER_SNAPSHOTS_PATH = '/v2/responder/snapshots';
const RESPONDER_SNAPSHOT_PAGE_RE = new RegExp(`^/v2/responder/snapshots/(${UUID_SEGMENT})/pages$`, 'u');
const RECEIPT_ACCESS_CHALLENGE_RE = new RegExp(`^/v2/reports/(${UUID_SEGMENT})/receipt-access/challenges$`, 'u');
const RECEIPT_ACCESS_RE = new RegExp(`^/v2/reports/(${UUID_SEGMENT})/receipt-access$`, 'u');
const RECEIPT_PAGE_RE = new RegExp(`^/v2/reports/(${UUID_SEGMENT})/receipts$`, 'u');
const RECEIPT_READ_COOKIE = '__Host-sagip-receipt-read';
const AUTHORITY_GRANTS_PATH = '/v2/authority/grants';
const AUTHORITY_REVOKE_RE = new RegExp(`^/v2/authority/grants/(${UUID_SEGMENT})/revoke$`, 'u');
const AUTHORITY_STATUS_PATH = '/v2/authority/status';
const AUTHORITY_TIME_PATH = '/v2/authority/time';
const UUID_VALUE_RE = new RegExp(`^${UUID_SEGMENT}$`, 'u');
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const MAX_U64 = 18446744073709551615n;
const RESPONDER_SESSION_COOKIE = '__Host-sagip-responder';
const RESPONDER_STATUSES = new Set(['PENDING', 'ACKNOWLEDGED', 'EN_ROUTE', 'ON_SCENE', 'RESOLVED']);

export async function handleSagipRequest(
  request: Request,
  deps: SagipServerDependencies,
  context: SagipRequestContext = {},
): Promise<Response> {
  try {
    const parsedUrl = new URL(request.url);
    const pathname = parsedUrl.pathname;
    const method = request.method || 'GET';

    const dashboard = responderDashboardResponse(pathname, method);
    if (dashboard) return dashboard;
    if (pathname === '/' && method === 'GET') {
      return new Response(null, {status: 302, headers: {location: '/responder'}});
    }
    if (pathname === '/healthz' && method === 'GET') {
      return jsonResponse(200, {status: 'ok'});
    }

    const rateLimitSelection = selectRateLimiter(pathname, deps);
    if (rateLimitSelection) {
      const clientIp = context.clientIp ?? '127.0.0.1';
      let allowed: boolean;
      try {
        allowed = await rateLimitSelection.limiter.isAllowed(
          `${rateLimitSelection.bucket}:${clientIp}`,
        );
      } catch {
        discardRequestBody(context);
        return jsonResponse(503, {error: 'SERVICE_UNAVAILABLE'});
      }
      if (!allowed) {
        discardRequestBody(context);
        return jsonResponse(429, {error: 'TOO_MANY_REQUESTS'}, {'retry-after': '60'});
      }
    }

    if (pathname === '/v1/envelopes') {
      if (method !== 'POST') {
        discardRequestBody(context);
        return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'POST'});
      }
      if ((request.headers.get('content-type') ?? '').trim().toLowerCase() !== 'application/octet-stream') {
        discardRequestBody(context);
        return jsonResponse(415, {error: 'UNSUPPORTED_MEDIA_TYPE'});
      }

      const bytes = await readBoundedBody(request, MAX_ENVELOPE_BYTES);
      const receipt = await deps.ingestEnvelope(bytes);
      return jsonResponse(200, receipt);
    }

    if (pathname === AUTHORITY_GRANTS_PATH || AUTHORITY_REVOKE_RE.test(pathname) || pathname === AUTHORITY_STATUS_PATH || pathname === AUTHORITY_TIME_PATH) {
      if (!deps.responderService || !deps.authorityService) {
        discardRequestBody(context);
        return jsonResponse(501, {error: 'NOT_IMPLEMENTED'});
      }
      const responder = await extractAndAuthResponder(request, deps.responderService);
      if (!responder) {
        discardRequestBody(context);
        return jsonResponse(401, {error: 'SESSION_REQUIRED'});
      }
      if (pathname === AUTHORITY_GRANTS_PATH) {
        if (method !== 'POST') {
          discardRequestBody(context);
          return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'POST'});
        }
        if (responder.role !== 'AUTHORITY_ADMIN') {
          discardRequestBody(context);
          return jsonResponse(403, {error: 'ROLE_REQUIRED'});
        }
        if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') {
          discardRequestBody(context);
          return jsonResponse(415, {error: 'UNSUPPORTED_MEDIA_TYPE'});
        }
        const requestBody = parseGatewayGrantRequest(await readBoundedBody(request, 4096));
        const result = await deps.authorityService.issueGatewayGrantResult(requestBody, responder);
        return binaryResponse(result.created ? 201 : 200, result.bytes);
      }
      const revokeMatch = AUTHORITY_REVOKE_RE.exec(pathname);
      if (revokeMatch) {
        if (method !== 'POST') {
          discardRequestBody(context);
          return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'POST'});
        }
        if (responder.role !== 'AUTHORITY_ADMIN') {
          discardRequestBody(context);
          return jsonResponse(403, {error: 'ROLE_REQUIRED'});
        }
        if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') {
          discardRequestBody(context);
          return jsonResponse(415, {error: 'UNSUPPORTED_MEDIA_TYPE'});
        }
        const reason = parseRevokeReason(await readBoundedBody(request, 4096));
        return jsonResponse(200, await deps.authorityService.revokeGrant(revokeMatch[1] as string, responder, reason));
      }
      if (pathname === AUTHORITY_STATUS_PATH) {
        if (method !== 'GET') {
          discardRequestBody(context);
          return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'GET'});
        }
        const grantId = parsedUrl.searchParams.get('grantId');
        if (!grantId || !UUID_VALUE_RE.test(grantId) || parsedUrl.searchParams.size !== 1) {
          return jsonResponse(400, {error: 'INVALID_FIELDS'});
        }
        return jsonResponse(200, await deps.authorityService.authorityStatus(grantId, responder));
      }
      if (pathname === AUTHORITY_TIME_PATH) {
        if (method !== 'POST') {
          discardRequestBody(context);
          return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'POST'});
        }
        if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') {
          discardRequestBody(context);
          return jsonResponse(415, {error: 'UNSUPPORTED_MEDIA_TYPE'});
        }
        const challenge = parseTimeChallenge(await readBoundedBody(request, 4096));
        return binaryResponse(200, await deps.authorityService.issueAuthorityTimeProof(challenge, responder));
      }
    }
    const receiptChallengeMatch = RECEIPT_ACCESS_CHALLENGE_RE.exec(pathname);
    if (receiptChallengeMatch) {
      if (method !== 'POST') {
        discardRequestBody(context);
        return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'POST'});
      }
      if (!deps.receiptService) {
        discardRequestBody(context);
        return jsonResponse(501, {error: 'NOT_IMPLEMENTED'});
      }
      if (!deps.responderService) return jsonResponse(501, {error: 'NOT_IMPLEMENTED'});
      const reportId = (receiptChallengeMatch[1] as string).toLowerCase();
      const proof = parseReportStatusAccessProof(request.headers);
      if (!proof || !await deps.responderService.authenticateReportStatusAccess(reportId, proof, null)) {
        return jsonResponse(401, {error: 'ORIGIN_PROOF_REQUIRED'});
      }
      const challenge = await deps.receiptService.createReceiptAccessChallenge(reportId);
      return jsonResponse(201, {
        ...challenge,
        originKeyId: Buffer.from(challenge.originKeyId).toString('base64'),
        nonce: Buffer.from(challenge.nonce).toString('base64'),
      });
    }

    const receiptAccessMatch = RECEIPT_ACCESS_RE.exec(pathname);
    if (receiptAccessMatch) {
      if (method !== 'POST') {
        discardRequestBody(context);
        return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'POST'});
      }
      if (!deps.receiptService) {
        discardRequestBody(context);
        return jsonResponse(501, {error: 'NOT_IMPLEMENTED'});
      }
      if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        discardRequestBody(context);
        return jsonResponse(415, {error: 'UNSUPPORTED_MEDIA_TYPE'});
      }
      const body = await readBoundedBody(request, 4096);
      let parsed: {challengeId: string; signature: Buffer};
      try {
        parsed = parseReceiptAccessBody(body);
      } catch {
        return jsonResponse(400, {error: 'INVALID_FIELDS'});
      }
      const session = await deps.receiptService.authorizeReceiptAccess(
        receiptAccessMatch[1] as string,
        parsed.challengeId,
        parsed.signature,
      );
      return jsonResponse(
        200,
        {expiresAtMs: session.expiresAtMs},
        {'set-cookie': createReceiptReadCookie(session.sessionToken)},
      );
    }

    const receiptPageMatch = RECEIPT_PAGE_RE.exec(pathname);
    if (receiptPageMatch) {
      if (method !== 'GET') {
        discardRequestBody(context);
        return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'GET'});
      }
      if (!deps.receiptService) {
        discardRequestBody(context);
        return jsonResponse(501, {error: 'NOT_IMPLEMENTED'});
      }
      const sessionToken = extractCookieValue(request, RECEIPT_READ_COOKIE);
      if (!sessionToken) return jsonResponse(401, {error: 'SESSION_REQUIRED'});
      try {
        const page = await deps.receiptService.listReportReceipts(
          receiptPageMatch[1] as string,
          sessionToken,
          parsedUrl.searchParams.get('cursor'),
        );
        return jsonResponse(200, page);
      } catch (error) {
        if (error instanceof Error && error.message === 'UNAUTHORIZED') {
          return jsonResponse(401, {error: 'SESSION_EXPIRED'}, {'set-cookie': clearReceiptReadCookie()});
        }
        throw error;
      }
    }
    if (pathname === RESPONDER_ACTIONS_PATH || RESPONDER_ACTION_RE.test(pathname) || RESPONDER_ACTION_RECEIPT_RE.test(pathname)) {
      if (!deps.responderService || !deps.receiptService) {
        discardRequestBody(context);
        return jsonResponse(501, {error: 'NOT_IMPLEMENTED'});
      }
      const responder = await extractAndAuthResponder(request, deps.responderService);
      if (!responder) {
        discardRequestBody(context);
        return jsonResponse(401, {error: 'UNAUTHORIZED'});
      }
      if (pathname === RESPONDER_ACTIONS_PATH) {
        if (method !== 'POST') {
          discardRequestBody(context);
          return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'POST'});
        }
        if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') {
          discardRequestBody(context);
          return jsonResponse(415, {error: 'UNSUPPORTED_MEDIA_TYPE'});
        }
        const bodyBytes = await readBoundedBody(request, 4096);
        let intent: ActionIntent;
        try {
          intent = parseActionIntent(bodyBytes);
        } catch {
          return jsonResponse(400, {error: 'INVALID_FIELDS'});
        }
        const allocation = await deps.receiptService.allocateActionResult(intent, responder);
        const committed = await deps.receiptService.prepareReceipt(intent.actionId);
        return jsonResponse(allocation.created ? 201 : 200, actionResultJson(committed));
      }
      const receiptMatch = RESPONDER_ACTION_RECEIPT_RE.exec(pathname);
      if (receiptMatch) {
        if (method !== 'GET') {
          discardRequestBody(context);
          return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'GET'});
        }
        const actionId = receiptMatch[1] as string;
        const owned = await deps.receiptService.getActionResult(actionId, responder);
        if (!owned) return jsonResponse(404, {error: 'NOT_FOUND'});
        if (owned.state !== 'SIGNED') return jsonResponse(409, {error: 'RECEIPT_NOT_READY'});
        const bytes = await deps.receiptService.getReceipt(actionId);
        if (!bytes) return jsonResponse(409, {error: 'RECEIPT_NOT_READY'});
        return binaryResponse(200, bytes);
      }
      const actionMatch = RESPONDER_ACTION_RE.exec(pathname);
      if (actionMatch) {
        if (method !== 'GET') {
          discardRequestBody(context);
          return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'GET'});
        }
        const result = await deps.receiptService.getActionResult(actionMatch[1] as string, responder);
        return result
          ? jsonResponse(200, actionResultJson(result))
          : jsonResponse(404, {error: 'NOT_FOUND'});
      }
    }

    if (pathname === RESPONDER_SNAPSHOTS_PATH || RESPONDER_SNAPSHOT_PAGE_RE.test(pathname)) {
      if (!deps.responderService || !deps.incidentSnapshotService) {
        discardRequestBody(context);
        return jsonResponse(501, {error: 'NOT_IMPLEMENTED'});
      }
      const responder = await extractAndAuthResponder(request, deps.responderService);
      if (!responder) {
        discardRequestBody(context);
        return jsonResponse(401, {error: 'UNAUTHORIZED'});
      }
      if (pathname === RESPONDER_SNAPSHOTS_PATH) {
        if (method !== 'POST') {
          discardRequestBody(context);
          return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'POST'});
        }
        return jsonResponse(201, await deps.incidentSnapshotService.createIncidentSnapshot(responder));
      }
      const match = RESPONDER_SNAPSHOT_PAGE_RE.exec(pathname);
      if (!match || method !== 'GET') {
        discardRequestBody(context);
        return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'GET'});
      }
      const cursor = parsedUrl.searchParams.get('cursor');
      if (!cursor || parsedUrl.searchParams.size !== 1) return jsonResponse(400, {error: 'INVALID_CURSOR'});
      return jsonResponse(200, await deps.incidentSnapshotService.readIncidentSnapshotPage(match[1] as string, cursor, responder));
    }

    if (pathname === RECEIPT_IMPORT_PATH) {
      if (method !== 'POST') {
        discardRequestBody(context);
        return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'POST'});
      }
      if (!deps.responderService || !deps.receiptService) {
        discardRequestBody(context);
        return jsonResponse(501, {error: 'NOT_IMPLEMENTED'});
      }
      const responder = await extractAndAuthResponder(request, deps.responderService);
      if (!responder) {
        discardRequestBody(context);
        return jsonResponse(401, {error: 'UNAUTHORIZED'});
      }
      if ((request.headers.get('content-type') ?? '').trim().toLowerCase() !== 'application/octet-stream') {
        discardRequestBody(context);
        return jsonResponse(415, {error: 'UNSUPPORTED_MEDIA_TYPE'});
      }
      const bytes = await readBoundedBody(request, MAX_RECEIPT_BYTES);
      const result = await deps.receiptService.importGatewayReceipt(bytes, responder);
      return jsonResponse(200, {
        ...result,
        issuerProviderId: result.issuerProviderId
          ? Buffer.from(result.issuerProviderId).toString('base64')
          : null,
      });
    }
    const reportStatusMatch = REPORT_STATUS_RE.exec(pathname);
    if (reportStatusMatch) {
      if (method !== 'GET') {
        discardRequestBody(context);
        return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'GET'});
      }
      if (!deps.responderService) {
        discardRequestBody(context);
        return jsonResponse(501, {error: 'NOT_IMPLEMENTED'});
      }
      const reportId = (reportStatusMatch[1] as string).toLowerCase();
      const cursor = parsedUrl.searchParams.get('cursor');
      if (parsedUrl.searchParams.size > (cursor === null ? 0 : 1) || !validReportStatusCursor(cursor)) {
        return jsonResponse(400, {error: 'INVALID_CURSOR'});
      }
      const proof = parseReportStatusAccessProof(request.headers);
      if (!proof || !await deps.responderService.authenticateReportStatusAccess(reportId, proof, cursor)) {
        return jsonResponse(401, {error: 'ORIGIN_PROOF_REQUIRED'});
      }
      return jsonResponse(200, await deps.responderService.getReportStatusHistory(reportId, cursor));
    }

    if (pathname === RESPONDER_SESSION_PATH) {
      if (!deps.responderService) {
        discardRequestBody(context);
        return jsonResponse(501, {error: 'NOT_IMPLEMENTED'});
      }

      if (method === 'POST') {
        if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') {
          discardRequestBody(context);
          return jsonResponse(415, {error: 'UNSUPPORTED_MEDIA_TYPE'});
        }

        const bodyBytes = await readBoundedBody(request, 8192);
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(bodyBytes.toString('utf8')) as unknown;
        } catch {
          return jsonResponse(400, {error: 'INVALID_JSON'});
        }

        if (!isRecord(parsedBody) || typeof parsedBody.token !== 'string') {
          return jsonResponse(400, {error: 'INVALID_SESSION_BODY'});
        }

        const session = await deps.responderService.createBrowserSession(parsedBody.token);
        if (!session) {
          return jsonResponse(401, {error: 'UNAUTHORIZED'});
        }

        return jsonResponse(
          200,
          {
            responder: session.responder,
            expiresAt: session.expiresAt,
          },
          {'set-cookie': createResponderSessionCookie(session.sessionToken, session.expiresAt)},
        );
      }

      if (method === 'GET') {
        const session = await extractBrowserSession(request, deps.responderService);
        if (!session) {
          return jsonResponse(
            401,
            {error: 'UNAUTHORIZED'},
            {'set-cookie': clearResponderSessionCookie()},
          );
        }
        return jsonResponse(200, {
          responder: session.responder,
          expiresAt: session.expiresAt,
        });
      }

      if (method === 'DELETE') {
        const sessionToken = extractResponderSessionToken(request);
        if (sessionToken) {
          await deps.responderService.revokeBrowserSession(sessionToken);
        }
        return emptyResponse(204, {'set-cookie': clearResponderSessionCookie()});
      }

      discardRequestBody(context);
      return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'GET, POST, DELETE'});
    }

    if (pathname.startsWith('/v1/incidents')) {
      if (!deps.responderService) {
        discardRequestBody(context);
        return jsonResponse(501, {error: 'NOT_IMPLEMENTED'});
      }

      const responder = await extractAndAuthResponder(request, deps.responderService);
      if (!responder) {
        discardRequestBody(context);
        return jsonResponse(401, {error: 'UNAUTHORIZED'});
      }

      if (pathname === '/v1/incidents/summary') {
        if (method !== 'GET') {
          discardRequestBody(context);
          return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'GET'});
        }
        return jsonResponse(200, await deps.responderService.getIncidentQueueSummary());
      }

      if (pathname === '/v1/incidents') {
        if (method !== 'GET') {
          discardRequestBody(context);
          return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'GET'});
        }
        const statusFilter = parsedUrl.searchParams.get('status') ?? undefined;
        if (statusFilter && !RESPONDER_STATUSES.has(statusFilter)) {
          return jsonResponse(400, {error: 'INVALID_STATUS_FILTER'});
        }
        const limitParam = parsedUrl.searchParams.get('limit');
        const limit = limitParam === null ? 50 : Number(limitParam);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          return jsonResponse(400, {error: 'INVALID_LIMIT'});
        }
        const offsetParam = parsedUrl.searchParams.get('offset');
        const offset = offsetParam === null ? 0 : Number(offsetParam);
        if (!Number.isInteger(offset) || offset < 0 || offset > 10_000) {
          return jsonResponse(400, {error: 'INVALID_OFFSET'});
        }
        const sort = parsedUrl.searchParams.get('sort') ?? 'newest_received';
        if (sort !== 'newest_received' && sort !== 'urgency') {
          return jsonResponse(400, {error: 'INVALID_SORT'});
        }
        const incidents = await deps.responderService.listIncidents(statusFilter, limit, offset, sort);
        return jsonResponse(200, incidents);
      }

      const ackMatch = INCIDENT_ACK_RE.exec(pathname);
      if (ackMatch) {
        if (method !== 'POST') {
          discardRequestBody(context);
          return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'POST'});
        }
        if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') {
          discardRequestBody(context);
          return jsonResponse(415, {error: 'UNSUPPORTED_MEDIA_TYPE'});
        }
        const reportId = ackMatch[1] as string;
        const bodyBytes = await readBoundedBody(request, 8192);
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(bodyBytes.toString('utf8')) as unknown;
        } catch {
          return jsonResponse(400, {error: 'INVALID_JSON'});
        }
        if (
          !isRecord(parsedBody) ||
          typeof parsedBody.status !== 'string' ||
          (parsedBody.note !== undefined &&
            parsedBody.note !== null &&
            typeof parsedBody.note !== 'string')
        ) {
          return jsonResponse(400, {error: 'INVALID_ACK_BODY'});
        }

        const status = parsedBody.status as ResponderStatus;
        const ack = await deps.responderService.acknowledgeIncident(
          reportId,
          responder.responderId,
          status,
          parsedBody.note,
        );
        return jsonResponse(200, ack);
      }

      const detailMatch = INCIDENT_DETAIL_RE.exec(pathname);
      if (detailMatch) {
        if (method !== 'GET') {
          discardRequestBody(context);
          return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'GET'});
        }
        const reportId = detailMatch[1] as string;
        const detail = await deps.responderService.getIncidentDetail(reportId);
        if (!detail) {
          return jsonResponse(404, {error: 'INCIDENT_NOT_FOUND'});
        }
        return jsonResponse(200, detail);
      }
    }

    discardRequestBody(context);
    return jsonResponse(404, {error: 'NOT_FOUND'});
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonResponse(413, {error: 'PAYLOAD_TOO_LARGE'});
    }
    if (error instanceof ProtocolValidationError || error instanceof ResponderValidationError) {
      return jsonResponse(400, {error: error.message || 'VALIDATION_FAILED'});
    }
    if (error instanceof IngestionConflictError) {
      return jsonResponse(409, {error: 'INGESTION_CONFLICT'});
    }
    if (error instanceof IngestionTransientError) {
      return jsonResponse(503, {error: 'SERVICE_UNAVAILABLE'});
    }
    if (error instanceof ResponderNotFoundError) {
      return jsonResponse(404, {error: 'NOT_FOUND'});
    }
    if (error instanceof Error) {
      const code = error.message;
      if (code === 'ROLE_REQUIRED' || code === 'AUTHORITY_UNAVAILABLE' || code === 'SCOPE_DENIED' || code === 'PURPOSE_DENIED' || code === 'KEY_NOT_APPROVED' || code === 'RESPONDER_NOT_APPROVED' || code === 'CIVILIAN_KEY_REUSE' || code === 'VERIFIER_NOT_APPROVED') {
        return jsonResponse(403, {error: code});
      }
      if (code === 'ACTION_CONFLICT' || code === 'PROVIDER_CONFLICT' || code === 'DIGEST_CONFLICT') {
        return jsonResponse(409, {error: 'ACTION_CONFLICT'});
      }
      if (code === 'INCIDENT_VERSION_CONFLICT' || code === 'EVENT_EQUIVOCATION' || code === 'REQUEST_CONFLICT' || code === 'GRANT_REVOKED' || code === 'SEQUENCE_CONFLICT' || code === 'CHALLENGE_CONSUMED') {
        return jsonResponse(409, {error: code});
      }
      if (code === 'ACTION_NOT_FOUND' || code === 'RECEIPT_NOT_FOUND' || code === 'REPORT_NOT_FOUND' || code === 'CHALLENGE_NOT_FOUND' || code === 'SNAPSHOT_NOT_FOUND') {
        return jsonResponse(404, {error: code});
      }
      if (code === 'SNAPSHOT_EXPIRED') return jsonResponse(410, {error: code});
      if (code === 'CAPACITY_FULL') return jsonResponse(429, {error: code});
      if (code === 'SIGNER_UNAVAILABLE' || code === 'TIME_UNAVAILABLE' || code === 'STORAGE_UNAVAILABLE') {
        return jsonResponse(503, {error: code});
      }
      if (code === 'INVALID_SIGNATURE' || code === 'SIGNATURE_INVALID' || code === 'GRANT_INVALID' || code === 'REPORT_BINDING_INVALID' || code === 'REPORT_IDENTITY_CONFLICT' || code === 'KEY_BINDING') {
        return jsonResponse(422, {error: code});
      }
      if (code === 'UNAUTHORIZED') return jsonResponse(401, {error: 'SESSION_REQUIRED'});
      if (code === 'CHALLENGE_EXPIRED') return jsonResponse(401, {error: 'SESSION_EXPIRED'});
      if (code === 'INVALID_JSON' || code === 'INVALID_FIELDS' || code === 'INVALID_REVOCATION_REASON' || code === 'INVALID_CURSOR' || code === 'INVALID_TIME' || code === 'INVALID_UUID' || code === 'NOT_RECEIPT') {
        return jsonResponse(400, {error: code === 'INVALID_REVOCATION_REASON' ? 'INVALID_FIELDS' : code});
      }
    }
    return jsonResponse(500, {error: 'INTERNAL_ERROR'});
  }
}

function isRateLimitedEndpointPath(pathname: string): boolean {
  return (
    pathname === '/v1/envelopes' ||
    pathname === RESPONDER_SESSION_PATH ||
    pathname === RECEIPT_IMPORT_PATH ||
    pathname.startsWith('/v2/responder/actions') ||
    pathname.startsWith('/v2/responder/snapshots') ||
    pathname.startsWith('/v2/reports/') ||
    pathname.startsWith('/v2/authority/') ||
    REPORT_STATUS_RE.test(pathname) ||
    pathname.startsWith('/v1/incidents')
  );
}

function selectRateLimiter(
  pathname: string,
  deps: SagipServerDependencies,
): {bucket: string; limiter: RateLimiter} | null {
  if (!isRateLimitedEndpointPath(pathname)) return null;
  if (deps.rateLimiter) return {bucket: 'legacy', limiter: deps.rateLimiter};

  const limiters = deps.rateLimiters ?? defaultRateLimiters;
  if (pathname === '/v1/envelopes') {
    return {bucket: 'envelope-ingest', limiter: limiters.envelopeIngest};
  }
  if (REPORT_STATUS_RE.test(pathname)) {
    return {bucket: 'report-status', limiter: limiters.reportStatus};
  }
  if (pathname === RESPONDER_SESSION_PATH) {
    return {bucket: 'responder-session', limiter: limiters.responderSession};
  }
  return {bucket: 'responder-api', limiter: limiters.responderApi};
}

function strictJsonObject(bytes: Buffer, keys: string[]): Record<string, unknown> {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new Error('INVALID_JSON');
  }
  if (!isRecord(value) || JSON.stringify(value) !== text.trim()) throw new Error('INVALID_JSON');
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw new Error('INVALID_FIELDS');
  return value;
}

function canonicalBase64(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string') throw new Error('INVALID_FIELDS');
  const bytes = Buffer.from(value, 'base64');
  if ((length !== undefined && bytes.length !== length) || bytes.toString('base64') !== value) throw new Error('INVALID_FIELDS');
  return bytes;
}

function safeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('INVALID_FIELDS');
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('INVALID_FIELDS');
  return value;
}

function nonNilUuid(value: unknown): string {
  const parsed = requiredString(value);
  if (!UUID_VALUE_RE.test(parsed) || parsed === NIL_UUID)
    throw new Error('INVALID_FIELDS');
  return parsed;
}

function boundedNote(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0') ||
      Buffer.byteLength(value, 'utf8') > 1024 ||
      Buffer.from(value, 'utf8').toString('utf8') !== value)
    throw new Error('INVALID_FIELDS');
  return value;
}

function parseGatewayGrantRequest(bytes: Buffer): GatewayGrantRequest {
  const value = strictJsonObject(bytes, [
    'requestId','issuerKeyId','issuerPublicKeyDer','issuerProviderId','grantId',
    'responderId','callsign','statusMask','purposeMask','scope',
  ]);
  return {
    requestId: requiredString(value.requestId),
    issuerKeyId: canonicalBase64(value.issuerKeyId, 32),
    issuerPublicKeyDer: canonicalBase64(value.issuerPublicKeyDer),
    issuerProviderId: canonicalBase64(value.issuerProviderId, 32),
    grantId: requiredString(value.grantId),
    responderId: requiredString(value.responderId),
    callsign: requiredString(value.callsign),
    statusMask: safeInteger(value.statusMask),
    purposeMask: safeInteger(value.purposeMask),
    scope: requiredString(value.scope),
  };
}

function parseRevokeReason(bytes: Buffer): string {
  const value = strictJsonObject(bytes, ['reason']);
  return requiredString(value.reason);
}

function parseTimeChallenge(bytes: Buffer): TimeChallenge {
  const value = strictJsonObject(bytes, ['verifierId','verifierBootSessionId','nonce']);
  const verifierBootSessionId = requiredString(value.verifierBootSessionId);
  if (!UUID_VALUE_RE.test(verifierBootSessionId)) throw new Error('INVALID_FIELDS');
  return {
    verifierId: canonicalBase64(value.verifierId, 32),
    verifierBootSessionId,
    nonce: canonicalBase64(value.nonce, 32),
  };
}
function parseReceiptAccessBody(bytes: Buffer): {challengeId: string; signature: Buffer} {
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || JSON.stringify(value) !== text.trim()) throw new Error('INVALID_JSON');
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('challengeId') || !keys.includes('signatureBase64')) throw new Error('INVALID_FIELDS');
  if (typeof value.challengeId !== 'string' || typeof value.signatureBase64 !== 'string') throw new Error('INVALID_FIELDS');
  const signature = Buffer.from(value.signatureBase64, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== value.signatureBase64) throw new Error('INVALID_FIELDS');
  return {challengeId: value.challengeId, signature};
}

function extractCookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value && value.length <= 256 ? value : null;
  }
  return null;
}

function createReceiptReadCookie(sessionToken: string): string {
  return [
    `${RECEIPT_READ_COOKIE}=${sessionToken}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Max-Age=900',
  ].join('; ');
}

function clearReceiptReadCookie(): string {
  return [
    `${RECEIPT_READ_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ].join('; ');
}
function parseActionIntent(bytes: Buffer): ActionIntent {
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || JSON.stringify(parsed) !== text.trim()) throw new Error('INVALID_JSON');
  const keys = ['actionId','providerKind','issuerProviderId','reportId','reportProtocolVersion','revision','payloadDigest','originKeyId','responderId','observedIncidentVersion','status','note','actionDigest'];
  if (Object.keys(parsed).length !== keys.length || Object.keys(parsed).some(k => !keys.includes(k))) throw new Error('INVALID_FIELDS');
  const providerKind = safeInteger(parsed.providerKind);
  const reportProtocolVersion = safeInteger(parsed.reportProtocolVersion);
  const revision = safeInteger(parsed.revision);
  const status = safeInteger(parsed.status);
  if ((providerKind !== 1 && providerKind !== 2) ||
      (reportProtocolVersion !== 1 && reportProtocolVersion !== 2) ||
      revision < 1 || revision > 2147483647 || status < 1 || status > 4)
    throw new Error('INVALID_FIELDS');
  if (typeof parsed.observedIncidentVersion !== 'string' ||
      !/^(0|[1-9][0-9]*)$/u.test(parsed.observedIncidentVersion))
    throw new Error('INVALID_FIELDS');
  const observedIncidentVersion = BigInt(parsed.observedIncidentVersion);
  if (observedIncidentVersion > MAX_U64) throw new Error('INVALID_FIELDS');
  return {
    actionId: nonNilUuid(parsed.actionId),
    providerKind,
    issuerProviderId: canonicalBase64(parsed.issuerProviderId, 32),
    reportId: nonNilUuid(parsed.reportId),
    reportProtocolVersion,
    revision,
    payloadDigest: canonicalBase64(parsed.payloadDigest, 32),
    originKeyId: canonicalBase64(parsed.originKeyId, 32),
    responderId: nonNilUuid(parsed.responderId),
    observedIncidentVersion,
    status,
    note: boundedNote(parsed.note),
    actionDigest: canonicalBase64(parsed.actionDigest, 32),
  };
}

function actionResultJson(result: ActionCommitResult) {
  return {
    ...result,
    issuerProviderId: Buffer.from(result.issuerProviderId).toString('base64'),
    actionDigest: Buffer.from(result.actionDigest).toString('base64'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function extractAndAuthResponder(
  request: Request,
  responderService: ResponderService,
): Promise<ResponderIdentity | null> {
  const authHeader = request.headers.get('authorization');
  if (authHeader) {
    const match = /^Bearer\s+(\S+)$/iu.exec(authHeader);
    if (!match || !match[1]) return null;
    return responderService.authenticate(match[1]);
  }

  const browserSession = await extractBrowserSession(request, responderService);
  return browserSession?.responder ?? null;
}

async function extractBrowserSession(
  request: Request,
  responderService: ResponderService,
) {
  const sessionToken = extractResponderSessionToken(request);
  if (!sessionToken) return null;
  return responderService.authenticateBrowserSession(sessionToken);
}

function extractResponderSessionToken(request: Request): string | null {
  const rawCookie = request.headers.get('cookie');
  if (!rawCookie) return null;

  for (const part of rawCookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== RESPONDER_SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    if (!value || value.length > 256) return null;
    return value;
  }
  return null;
}

function createResponderSessionCookie(sessionToken: string, expiresAt: string): string {
  const expires = new Date(expiresAt);
  const maxAge = Math.max(
    0,
    Math.min(RESPONDER_SESSION_TTL_SECONDS, Math.floor((expires.getTime() - Date.now()) / 1000)),
  );
  return [
    `${RESPONDER_SESSION_COOKIE}=${sessionToken}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    `Expires=${expires.toUTCString()}`,
  ].join('; ');
}

function clearResponderSessionCookie(): string {
  return [
    `${RESPONDER_SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ].join('; ');
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Buffer> {
  if (request.body === null) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let tooLarge = false;

  try {
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (done) break;
      const value = result.value;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        tooLarge = true;
        continue;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  if (tooLarge) throw new RequestBodyTooLargeError();
  return Buffer.concat(chunks, totalBytes);
}

function discardRequestBody(context: SagipRequestContext): void {
  context.discardBody?.();
}

function binaryResponse(status: number, body: Uint8Array): Response {
  const bytes = Buffer.from(body);
  return new Response(bytes, {
    status,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function emptyResponse(
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(null, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function jsonResponse(
  status: number,
  body: object,
  extraHeaders: Record<string, string> = {},
): Response {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  return new Response(bytes, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(bytes.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}
