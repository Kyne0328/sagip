import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';

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

const defaultRateLimiter = new SlidingWindowRateLimiter();

class RequestBodyTooLargeError extends Error {}

export function createSagipServer(deps: SagipServerDependencies): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, deps);
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: SagipServerDependencies,
): Promise<void> {
  try {
    const rawUrl = request.url ?? '/';
    const parsedUrl = new URL(rawUrl, 'http://localhost');
    const pathname = parsedUrl.pathname;
    const method = request.method ?? 'GET';

    // Check rate limit on public endpoints
    const isPublicRateLimitedEndpoint = pathname === '/v1/envelopes' || /^\/v1\/reports\/[0-9a-fA-F-]+\/status$/u.test(pathname);
    if (isPublicRateLimitedEndpoint) {
      const clientIp = request.socket.remoteAddress ?? '127.0.0.1';
      const limiter = deps.rateLimiter ?? defaultRateLimiter;
      if (!limiter.isAllowed(clientIp)) {
        request.resume();
        response.setHeader('retry-after', '60');
        sendJson(response, 429, {error: 'TOO_MANY_REQUESTS'});
        return;
      }
    }

    // 1. Envelope ingestion: POST /v1/envelopes
    if (pathname === '/v1/envelopes') {
      if (method !== 'POST') {
        request.resume();
        response.setHeader('allow', 'POST');
        sendJson(response, 405, {error: 'METHOD_NOT_ALLOWED'});
        return;
      }
      if ((request.headers['content-type'] ?? '').trim().toLowerCase() !== 'application/octet-stream') {
        request.resume();
        sendJson(response, 415, {error: 'UNSUPPORTED_MEDIA_TYPE'});
        return;
      }

      const bytes = await readBoundedBody(request, MAX_ENVELOPE_BYTES);
      const receipt = await deps.ingestEnvelope(bytes);
      sendJson(response, 200, receipt);
      return;
    }

    // 2. Public Report Status: GET /v1/reports/:reportId/status
    const reportStatusMatch = /^\/v1\/reports\/([0-9a-fA-F-]+)\/status$/u.exec(pathname);
    if (reportStatusMatch) {
      if (method !== 'GET') {
        request.resume();
        response.setHeader('allow', 'GET');
        sendJson(response, 405, {error: 'METHOD_NOT_ALLOWED'});
        return;
      }
      if (!deps.responderService) {
        request.resume();
        sendJson(response, 501, {error: 'NOT_IMPLEMENTED'});
        return;
      }
      const reportId = reportStatusMatch[1] as string;
      const status = await deps.responderService.getReportStatus(reportId);
      sendJson(response, 200, status ?? {reportId, serverAccepted: false, acceptedAt: null, latestAck: null});
      return;
    }

    // 3. Responder-authorized routes
    if (pathname.startsWith('/v1/incidents')) {
      if (!deps.responderService) {
        request.resume();
        sendJson(response, 501, {error: 'NOT_IMPLEMENTED'});
        return;
      }

      // Check Bearer Token Auth
      const responder = await extractAndAuthResponder(request, deps.responderService);
      if (!responder) {
        request.resume();
        sendJson(response, 401, {error: 'UNAUTHORIZED'});
        return;
      }

      // 3a. GET /v1/incidents
      if (pathname === '/v1/incidents') {
        if (method !== 'GET') {
          request.resume();
          response.setHeader('allow', 'GET');
          sendJson(response, 405, {error: 'METHOD_NOT_ALLOWED'});
          return;
        }
        const statusFilter = parsedUrl.searchParams.get('status') ?? undefined;
        const limitParam = parsedUrl.searchParams.get('limit');
        const limit = limitParam ? Number.parseInt(limitParam, 10) : 50;
        const incidents = await deps.responderService.listIncidents(statusFilter, limit);
        sendJson(response, 200, incidents);
        return;
      }

      // 3b. POST /v1/incidents/:reportId/ack
      const ackMatch = /^\/v1\/incidents\/([0-9a-fA-F-]+)\/ack$/u.exec(pathname);
      if (ackMatch) {
        if (method !== 'POST') {
          request.resume();
          response.setHeader('allow', 'POST');
          sendJson(response, 405, {error: 'METHOD_NOT_ALLOWED'});
          return;
        }
        const reportId = ackMatch[1] as string;
        const bodyBytes = await readBoundedBody(request, 8192);
        let parsedBody: {status?: string; note?: string | null} = {};
        try {
          parsedBody = JSON.parse(bodyBytes.toString('utf8')) as {status?: string; note?: string | null};
        } catch {
          sendJson(response, 400, {error: 'INVALID_JSON'});
          return;
        }

        const status = parsedBody.status as ResponderStatus;
        const ack = await deps.responderService.acknowledgeIncident(
          reportId,
          responder.responderId,
          status,
          parsedBody.note,
        );
        sendJson(response, 200, ack);
        return;
      }

      // 3c. GET /v1/incidents/:reportId
      const detailMatch = /^\/v1\/incidents\/([0-9a-fA-F-]+)$/u.exec(pathname);
      if (detailMatch) {
        if (method !== 'GET') {
          request.resume();
          response.setHeader('allow', 'GET');
          sendJson(response, 405, {error: 'METHOD_NOT_ALLOWED'});
          return;
        }
        const reportId = detailMatch[1] as string;
        const detail = await deps.responderService.getIncidentDetail(reportId);
        if (!detail) {
          sendJson(response, 404, {error: 'INCIDENT_NOT_FOUND'});
          return;
        }
        sendJson(response, 200, detail);
        return;
      }
    }

    request.resume();
    sendJson(response, 404, {error: 'NOT_FOUND'});
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, {error: 'PAYLOAD_TOO_LARGE'});
      return;
    }
    if (error instanceof ProtocolValidationError || error instanceof ResponderValidationError) {
      sendJson(response, 400, {error: error.message || 'VALIDATION_FAILED'});
      return;
    }
    if (error instanceof IngestionConflictError) {
      sendJson(response, 409, {error: 'INGESTION_CONFLICT'});
      return;
    }
    if (error instanceof IngestionTransientError) {
      sendJson(response, 503, {error: 'SERVICE_UNAVAILABLE'});
      return;
    }
    if (error instanceof ResponderNotFoundError) {
      sendJson(response, 404, {error: 'NOT_FOUND'});
      return;
    }
    sendJson(response, 500, {error: 'INTERNAL_ERROR'});
  }
}

async function extractAndAuthResponder(
  request: IncomingMessage,
  responderService: ResponderService,
): Promise<ResponderIdentity | null> {
  const authHeader = request.headers.authorization;
  if (!authHeader) return null;

  const match = /^Bearer\s+(\S+)$/iu.exec(authHeader);
  if (!match || !match[1]) return null;

  return responderService.authenticate(match[1]);
}

async function readBoundedBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let tooLarge = false;

  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > maxBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(bytes);
  }

  if (tooLarge) throw new RequestBodyTooLargeError();
  return Buffer.concat(chunks, totalBytes);
}

function sendJson(response: ServerResponse, statusCode: number, body: object): void {
  if (response.headersSent || response.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', bytes.length);
  response.end(bytes);
}
