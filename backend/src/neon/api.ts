import {createPool} from '../db/pool.js';
import {
  handleSagipRequest,
  type SagipServerDependencies,
} from '../http/handleRequest.js';
import {createPostgresSagipRateLimiters} from '../http/rateLimiter.js';
import {IngestionService} from '../ingestion/service.js';
import {ResponderService} from '../responder/service.js';
import {IncidentSnapshotService} from '../responder/incidentSnapshot.js';

let dependencies: SagipServerDependencies | undefined;

export default async function api(request: Request): Promise<Response> {
  return handleSagipRequest(request, getDependencies(), {
    clientIp: getClientIp(request),
  });
}

function getDependencies(): SagipServerDependencies {
  if (dependencies) return dependencies;

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = createPool(databaseUrl);
  const ingestion = new IngestionService(pool);
  dependencies = {
    ingestEnvelope: bytes => ingestion.ingestEnvelope(bytes),
    responderService: new ResponderService(pool),
    incidentSnapshotService: new IncidentSnapshotService(pool),
    rateLimiters: createPostgresSagipRateLimiters(pool),
  };
  return dependencies;
}

function getClientIp(request: Request): string {
  const forwardedFor = request.headers.get('x-forwarded-for');
  const firstForwardedIp = forwardedFor?.split(',')[0]?.trim();
  return (
    request.headers.get('cf-connecting-ip')?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    firstForwardedIp ||
    'unknown'
  );
}
