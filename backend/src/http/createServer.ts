import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';

import {IngestionConflictError, IngestionTransientError, type ServerReceipt} from '../ingestion/service.js';
import {MAX_ENVELOPE_BYTES} from '../protocol/envelopeV1.js';
import {ProtocolValidationError} from '../protocol/errors.js';

export interface SagipServerDependencies {
  ingestEnvelope(bytes: Buffer): Promise<ServerReceipt>;
}

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
    if (request.url !== '/v1/envelopes') {
      request.resume();
      sendJson(response, 404, {error: 'NOT_FOUND'});
      return;
    }
    if (request.method !== 'POST') {
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

    const bytes = await readBoundedBody(request);
    const receipt = await deps.ingestEnvelope(bytes);
    sendJson(response, 200, receipt);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      sendJson(response, 413, {error: 'PAYLOAD_TOO_LARGE'});
      return;
    }
    if (error instanceof ProtocolValidationError) {
      sendJson(response, 400, {error: 'INVALID_ENVELOPE'});
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
    sendJson(response, 500, {error: 'INTERNAL_ERROR'});
  }
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let tooLarge = false;

  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > MAX_ENVELOPE_BYTES) {
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
