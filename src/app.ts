import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import { pool } from './config/database.js';
import { createApiKeyAuth } from './middleware/api-key-auth.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createLocalUiSessionCookie } from './middleware/local-ui-session.js';
import { createAgentRoutes } from './routes/agent-routes.js';
import { createApplicationRoutes } from './routes/application-routes.js';
import { createContentRoutes } from './routes/content-routes.js';
import { OpenAiCompatibleProvider } from './services/ai/openai-compatible.js';
import { ApplicationService } from './services/application/application-service.js';
import { ContentService } from './services/content/content-service.js';
import { LocalBlobStorage } from './services/storage/local-blob-storage.js';
import { logger } from './utils/logger.js';
import {
  validateApplicationExtensions,
  type ApplicationCompositionContext,
  type CreateAppOptions,
} from './runtime/application-composition.js';

export type {
  ApplicationCapabilityExtension, ApplicationCompositionContext, ApplicationExtensions,
  ApplicationRegistrar, ApplicationRouteExtension, CreateAppOptions, LocalRequestContext,
  PaidExtensionFamily,
} from './runtime/application-composition.js';
export type { LanguageProvider } from './services/ai/openai-compatible.js';

// A normalized history item can include a multi-file raw-archive manifest and
// thousands of bounded event references. Raw source bytes stay on disk, but
// the lineage envelope for large Cowork sessions can legitimately exceed the
// generic Express 10 MiB default used previously.
const MAX_JSON_BODY_SIZE = '64mb';

export function createApp<TConfig = Record<string, never>>(options: CreateAppOptions<TConfig> = {}): Express {
  validateApplicationExtensions(options.extensions);
  const app = express();
  const database = options.dependencies?.database ?? pool;
  const language = options.dependencies?.languageProvider ?? new OpenAiCompatibleProvider();
  const service = new ContentService(database, language);
  const applicationService = new ApplicationService(
    database,
    language,
    options.dependencies?.blobStorage ?? new LocalBlobStorage(env.AE_HOME),
  );
  const extensions = options.extensions;
  const localUiApiKey = !extensions?.authentication && env.LOCAL_UI_AUTO_AUTH
    ? env.ANSWER_ENGINE_API_KEY
    : undefined;
  const context: ApplicationCompositionContext<TConfig> = {
    nodeEnv: env.NODE_ENV,
    config: (extensions?.config ?? {}) as TConfig,
  };

  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: '*' }));
  app.use(express.json({ limit: MAX_JSON_BODY_SIZE }));
  if (env.NODE_ENV !== 'test') {
    app.use(morgan('combined', { stream: { write: (message) => logger.http(message.trim()) } }));
  }

  app.get('/health', (_req, res) => res.json({ status: 'healthy', uptime: process.uptime() }));
  if (localUiApiKey) {
    app.get('/local-ui/session', createLocalUiSessionCookie(localUiApiKey), (_req, res) => res.status(204).end());
  }
  if (!env.WEB_UI_DIR) {
    app.get('/', (_req, res) => res.json({ name: 'Answer Engine API', version: '1.1.0', status: 'running' }));
  }
  extensions?.registerPublicRoutes?.(app, context);

  app.use('/api/v1', extensions?.authentication ?? createApiKeyAuth(database, { localUiApiKey }));
  extensions?.registerAuthenticatedRoutes?.(app, context);
  app.get('/api/v1', (_req, res) => res.json({
    message: 'Answer Engine API v1',
    endpoints: {
      content: '/api/v1/content', agent: '/api/v1/agent',
      tags: '/api/v1/tags', libraries: '/api/v1/libraries',
      batchJobs: '/api/v1/batch-jobs', accessTokens: '/api/v1/access-tokens',
      audit: '/api/v1/audit',
      settings: '/api/v1/settings',
      ...(extensions?.endpointMetadata ?? {}),
    },
    extensions: {
      capabilities: extensions?.capabilities ?? [],
      routes: extensions?.routes ?? [],
    },
  }));
  app.use('/api/v1', createApplicationRoutes(applicationService));
  app.use('/api/v1/content', createContentRoutes(service));
  app.use('/api/v1/agent', createAgentRoutes(service));

  if (env.WEB_UI_DIR) {
    const webUiDirectory = resolve(env.WEB_UI_DIR);
    const indexPath = resolve(webUiDirectory, 'index.html');
    if (existsSync(indexPath)) {
      app.use(express.static(webUiDirectory));
      app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/')) {
          next();
          return;
        }
        res.sendFile(indexPath);
      });
    }
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export default createApp();
