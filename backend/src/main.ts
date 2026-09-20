import {fileURLToPath} from 'node:url';

import {applyMigrations} from './db/migrate.js';
import {createPool} from './db/pool.js';
import {createSagipServer} from './http/createServer.js';
import {IngestionService} from './ingestion/service.js';
import {ResponderService} from './responder/service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error('DATABASE_URL is required');
  }

  const port = parsePort(process.env.PORT);
  const pool = createPool(databaseUrl);
  try {
    await applyMigrations(pool, MIGRATIONS_DIR);
    const ingestion = new IngestionService(pool);
    const responderService = new ResponderService(pool);
    const server = createSagipServer({
      ingestEnvelope: bytes => ingestion.ingestEnvelope(bytes),
      responderService,
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => resolve());
    });

    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      server.close(() => {
        void pool.end().finally(() => {
          process.exitCode = 0;
        });
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return 8080;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

void main().catch(() => {
  console.error('SAGIP backend startup failed');
  process.exitCode = 1;
});
