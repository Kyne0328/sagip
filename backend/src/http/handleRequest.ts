import {IngestionConflictError, IngestionTransientError, type ServerReceipt} from '../ingestion/service.js';
import {MAX_ENVELOPE_BYTES} from '../protocol/envelopeV1.js';
import {ProtocolValidationError} from '../protocol/errors.js';
import {
  ResponderNotFoundError,
  type ResponderService,
  ResponderValidationError,
} from '../responder/service.js';
import type {ResponderIdentity, ResponderStatus} from '../responder/types.js';
import {responderDashboardResponse} from '../responder/dashboard.js';
import {SlidingWindowRateLimiter, type RateLimiter} from './rateLimiter.js';

export interface SagipServerDependencies {
  ingestEnvelope(bytes: Buffer): Promise<ServerReceipt>;
  responderService?: ResponderService;
  rateLimiter?: RateLimiter;
}

export interface SagipRequestContext {
  clientIp?: string;
  discardBody?: () => void;
}

const defaultRateLimiter = new SlidingWindowRateLimiter();

class RequestBodyTooLargeError extends Error {}

const UUID_SEGMENT = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const REPORT_STATUS_RE = new RegExp(`^/v1/reports/(${UUID_SEGMENT})/status$`, 'u');
const INCIDENT_ACK_RE = new RegExp(`^/v1/incidents/(${UUID_SEGMENT})/ack$`, 'u');
const INCIDENT_DETAIL_RE = new RegExp(`^/v1/incidents/(${UUID_SEGMENT})$`, 'u');
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

    const isRateLimitedEndpoint =
      pathname === '/v1/envelopes' ||
      REPORT_STATUS_RE.test(pathname) ||
      pathname.startsWith('/v1/incidents');
    if (isRateLimitedEndpoint) {
      const clientIp = context.clientIp ?? '127.0.0.1';
      const limiter = deps.rateLimiter ?? defaultRateLimiter;
      let allowed: boolean;
      try {
        allowed = await limiter.isAllowed(clientIp);
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
      const reportId = reportStatusMatch[1] as string;
      const status = await deps.responderService.getReportStatus(reportId);
      return jsonResponse(
        200,
        status ?? {reportId, serverAccepted: false, acceptedAt: null, latestAck: null},
      );
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
        const incidents = await deps.responderService.listIncidents(statusFilter, limit, offset);
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
    return jsonResponse(500, {error: 'INTERNAL_ERROR'});
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function extractAndAuthResponder(
  request: Request,
  responderService: ResponderService,
): Promise<ResponderIdentity | null> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader) return null;

  const match = /^Bearer\s+(\S+)$/iu.exec(authHeader);
  if (!match || !match[1]) return null;

  return responderService.authenticate(match[1]);
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
