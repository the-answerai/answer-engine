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
import { createAgentRoutes } from './routes/agent-routes.js';
import { createContentRoutes } from './routes/content-routes.js';
import { OpenAiCompatibleProvider } from './services/ai/openai-compatible.js';
import { ContentService } from './services/content/content-service.js';
import { logger } from './utils/logger.js';
import type { ApplicationCompositionContext, CreateAppOptions } from './runtime/application-composition.js';

export type {
  ApplicationCompositionContext, ApplicationExtensions, ApplicationRegistrar, CreateAppOptions,
  LocalRequestContext,
} from './runtime/application-composition.js';
export type { LanguageProvider } from './services/ai/openai-compatible.js';

export function createApp<TConfig = Record<string, never>>(options: CreateAppOptions<TConfig> = {}): Express {
  const app = express();
  const database = options.dependencies?.database ?? pool;
  const language = options.dependencies?.languageProvider ?? new OpenAiCompatibleProvider();
  const service = new ContentService(database, language);
  const extensions = options.extensions;
  const context: ApplicationCompositionContext<TConfig> = {
    nodeEnv: env.NODE_ENV,
    config: (extensions?.config ?? {}) as TConfig,
  };

  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: '*' }));
  app.use(express.json({ limit: '10mb' }));
  if (env.NODE_ENV !== 'test') {
    app.use(morgan('combined', { stream: { write: (message) => logger.http(message.trim()) } }));
  }

  app.get('/health', (_req, res) => res.json({ status: 'healthy', uptime: process.uptime() }));
  if (!env.WEB_UI_DIR) {
    app.get('/', (_req, res) => res.json({ name: 'Answer Engine API', version: '1.1.0', status: 'running' }));
  }
  extensions?.registerPublicRoutes?.(app, context);

  app.use('/api/v1', extensions?.authentication ?? createApiKeyAuth(database));
  extensions?.registerAuthenticatedRoutes?.(app, context);
  app.get('/api/v1', (_req, res) => res.json({
    message: 'Answer Engine API v1',
    endpoints: {
      content: '/api/v1/content', agent: '/api/v1/agent',
      ...(extensions?.endpointMetadata ?? {}),
    },
  }));
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
