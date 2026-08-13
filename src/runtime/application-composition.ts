import type { Express, RequestHandler } from 'express';
import type { Database } from '../config/database.js';
import type { LanguageProvider } from '../services/ai/openai-compatible.js';
import type { LocalBlobStorage } from '../services/storage/local-blob-storage.js';

export interface LocalRequestContext {
  readonly tenantId: string;
  readonly apiKeyId: string;
  readonly libraryId?: string;
}

export interface ApplicationCompositionContext<TConfig = Record<string, never>> {
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly config: TConfig;
}

export type ApplicationRegistrar<TConfig = Record<string, never>> = (
  app: Express,
  context: ApplicationCompositionContext<TConfig>,
) => void;

export interface ApplicationExtensions<TConfig = Record<string, never>> {
  readonly config?: TConfig;
  readonly registerPublicRoutes?: ApplicationRegistrar<TConfig>;
  readonly authentication?: RequestHandler;
  readonly registerAuthenticatedRoutes?: ApplicationRegistrar<TConfig>;
  readonly endpointMetadata?: Readonly<Record<string, string>>;
}

export interface CreateAppOptions<TConfig = Record<string, never>> {
  readonly extensions?: ApplicationExtensions<TConfig>;
  readonly dependencies?: {
    readonly database?: Database;
    readonly languageProvider?: LanguageProvider;
    readonly blobStorage?: LocalBlobStorage;
  };
}
