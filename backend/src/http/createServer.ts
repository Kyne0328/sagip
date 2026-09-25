import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {Readable} from 'node:stream';

import {
  handleSagipRequest,
  type SagipServerDependencies,
} from './handleRequest.js';

export type {SagipServerDependencies} from './handleRequest.js';

export function createSagipServer(deps: SagipServerDependencies): Server {
  return createServer((request, response) => {
    void handleNodeRequest(request, response, deps);
  });
}

async function handleNodeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: SagipServerDependencies,
): Promise<void> {
  try {
    const fetchRequest = toFetchRequest(request);
    const fetchResponse = await handleSagipRequest(fetchRequest, deps, {
      clientIp: request.socket.remoteAddress ?? '127.0.0.1',
      discardBody: () => request.resume(),
    });

    response.statusCode = fetchResponse.status;
    fetchResponse.headers.forEach((value, name) => response.setHeader(name, value));
    const bytes = Buffer.from(await fetchResponse.arrayBuffer());
    response.end(bytes);
  } catch {
    sendInternalError(response);
  }
}

function toFetchRequest(request: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }

  const method = request.method ?? 'GET';
  const init: RequestInit & {duplex?: 'half'} = {method, headers};
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }

  const url = new URL(request.url ?? '/', 'http://localhost');
  return new Request(url, init);
}

function sendInternalError(response: ServerResponse): void {
  if (response.headersSent || response.writableEnded) return;
  const bytes = Buffer.from(JSON.stringify({error: 'INTERNAL_ERROR'}), 'utf8');
  response.statusCode = 500;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', bytes.length);
  response.end(bytes);
}
