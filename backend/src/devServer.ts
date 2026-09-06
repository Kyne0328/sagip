import {fileURLToPath} from 'node:url';

import {applyMigrations} from './db/migrate.js';
import {createMemoryPostgresPool} from './db/memoryPool.js';
import {createPool} from './db/pool.js';
import {createSagipServer} from './http/createServer.js';
import {IngestionService} from './ingestion/service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

async function startDevServer(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const isMemoryDb = databaseUrl === undefined || databaseUrl.trim().length === 0;

  const pool = isMemoryDb ? createMemoryPostgresPool() : createPool(databaseUrl);
  const dbType = isMemoryDb ? 'In-memory PostgreSQL (pg-mem)' : 'PostgreSQL Database';

  const port = parsePort(process.env.PORT);

  try {
    console.log(`[SAGIP Dev] Applying schema migrations from: ${MIGRATIONS_DIR}`);
    await applyMigrations(pool, MIGRATIONS_DIR);
    console.log('[SAGIP Dev] Database schema up to date.');

    const ingestion = new IngestionService(pool);

    const server = createSagipServer({
      ingestEnvelope: async bytes => {
        console.log(`[SAGIP Dev] --> Received envelope payload (${bytes.length} bytes)`);
        try {
          const receipt = await ingestion.ingestEnvelope(bytes);
          console.log(
            `[SAGIP Dev] <-- Accepted! Receipt: ${receipt.receiptId} | Report: ${receipt.reportId} (rev ${receipt.revision})`,
          );
          return receipt;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[SAGIP Dev] <-- Ingestion rejected: ${message}`);
          throw error;
        }
      },
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => resolve());
    });

    console.log('\n' + [
      '====================================================================',
      '               SAGIP INGESTION DEVELOPMENT SERVER                   ',
      `  Endpoint:   http://0.0.0.0:${port}/v1/envelopes                    `,
      `  Android:    http://10.0.2.2:${port}/v1/envelopes (emulator)        `,
      `  Database:   ${dbType}                                              `,
      '  Status:     Ready to accept SGP1 / SRP1 signed envelopes          ',
      '====================================================================\n',
    ].join('\n'));

    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('\n[SAGIP Dev] Shutting down development server...');
      server.close(() => {
        void pool.end().finally(() => {
          console.log('[SAGIP Dev] Server stopped.');
          process.exitCode = 0;
        });
      });
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    await pool.end().catch(() => undefined);
    console.error('[SAGIP Dev] Startup failed:', error);
    process.exitCode = 1;
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

void startDevServer();
