import {IngestionConflictError, IngestionTransientError, type ServerReceipt} from '../ingestion/service.js';
import {MAX_ENVELOPE_BYTES} from '../protocol/envelopeV1.js';
import {ProtocolValidationError} from '../protocol/errors.js';
import {
  ResponderNotFoundError,
  type ResponderService,
  ResponderValidationError,
} from '../responder/service.js';
import type {ResponderIdentity, ResponderStatus} from '../responder/types.js';
import {SlidingWindowRateLimiter} from './rateLimiter.js';

export interface SagipServerDependencies {
  ingestEnvelope(bytes: Buffer): Promise<ServerReceipt>;
  responderService?: ResponderService;
  rateLimiter?: SlidingWindowRateLimiter;
}

export interface SagipRequestContext {
  clientIp?: string;
  discardBody?: () => void;
}

const defaultRateLimiter = new SlidingWindowRateLimiter();

class RequestBodyTooLargeError extends Error {}

export async function handleSagipRequest(
  request: Request,
  deps: SagipServerDependencies,
  context: SagipRequestContext = {},
): Promise<Response> {
  try {
    const parsedUrl = new URL(request.url);
    const pathname = parsedUrl.pathname;
    const method = request.method || 'GET';

    const isPublicRateLimitedEndpoint =
      pathname === '/v1/envelopes' || /^\/v1\/reports\/[0-9a-fA-F-]+\/status$/u.test(pathname);
    if (isPublicRateLimitedEndpoint) {
      const clientIp = context.clientIp ?? '127.0.0.1';
      const limiter = deps.rateLimiter ?? defaultRateLimiter;
      if (!limiter.isAllowed(clientIp)) {
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

    const reportStatusMatch = /^\/v1\/reports\/([0-9a-fA-F-]+)\/status$/u.exec(pathname);
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
        const limitParam = parsedUrl.searchParams.get('limit');
        const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
        const incidents = await deps.responderService.listIncidents(statusFilter, limit);
        return jsonResponse(200, incidents);
      }

      const ackMatch = /^\/v1\/incidents\/([0-9a-fA-F-]+)\/ack$/u.exec(pathname);
      if (ackMatch) {
        if (method !== 'POST') {
          discardRequestBody(context);
          return jsonResponse(405, {error: 'METHOD_NOT_ALLOWED'}, {allow: 'POST'});
        }
        const reportId = ackMatch[1] as string;
        const bodyBytes = await readBoundedBody(request, 8192);
        let parsedBody: {status?: string; note?: string | null} = {};
        try {
          parsedBody = JSON.parse(bodyBytes.toString('utf8')) as {
            status?: string;
            note?: string | null;
          };
        } catch {
          return jsonResponse(400, {error: 'INVALID_JSON'});
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

      const detailMatch = /^\/v1\/incidents\/([0-9a-fA-F-]+)$/u.exec(pathname);
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
      ...extraHeaders,
    },
  });
}
