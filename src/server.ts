import { createServer } from 'node:http';
import app from './app.js';
import { closeDatabasePool, testDatabaseConnection } from './config/database.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { pool } from './config/database.js';
import { OpenAiCompatibleProvider } from './services/ai/openai-compatible.js';
import {
  LocalApplicationWorker,
  startLocalApplicationWorker,
} from './services/application/local-application-worker.js';

async function start(): Promise<void> {
  await testDatabaseConnection();
  const server = createServer(app);
  const stopWorker = startLocalApplicationWorker(
    new LocalApplicationWorker(pool, new OpenAiCompatibleProvider()),
    env.LOCAL_WORKER_POLL_MS,
  );
  server.listen(env.PORT, env.HOST, () => {
    logger.info('Answer Engine API started', { host: env.HOST, port: env.PORT, channel: env.AE_CHANNEL });
  });
  const shutdown = (signal: NodeJS.Signals) => {
    logger.info('Shutting down Answer Engine API', { signal });
    stopWorker();
    server.close(() => {
      void closeDatabasePool().finally(() => process.exit(0));
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

start().catch((error: unknown) => {
  logger.error('Answer Engine API failed to start', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
