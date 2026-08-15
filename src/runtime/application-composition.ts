import type { Express, Request, RequestHandler } from 'express';
import type { Database } from '../config/database.js';
import type { LanguageProvider } from '../services/ai/openai-compatible.js';
import type { LocalBlobStorage } from '../services/storage/local-blob-storage.js';
import { z } from 'zod';

export type PaidExtensionFamily = 'roles' | 'rbac' | 'teams' | 'billing' | 'permissions';

export interface ApplicationCapabilityExtension {
  readonly id: string;
  readonly label: string;
  readonly family: PaidExtensionFamily;
}

export interface ApplicationRouteExtension {
  readonly id: string;
  readonly method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
  readonly path: `/${string}`;
  readonly access: 'public' | 'authenticated';
  readonly capabilityId?: string;
}

export interface LocalRequestContext {
  readonly tenantId: string;
  readonly apiKeyId: string;
  readonly libraryId?: string;
  readonly apiCapabilities: readonly ('read' | 'write')[];
}

export interface ApplicationAuthenticationExtension {
  readonly middleware: RequestHandler;
  readonly resolveRequestContext: (
    request: Request,
  ) => LocalRequestContext | Promise<LocalRequestContext>;
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
  readonly capabilities?: readonly ApplicationCapabilityExtension[];
  readonly routes?: readonly ApplicationRouteExtension[];
  readonly registerPublicRoutes?: ApplicationRegistrar<TConfig>;
  readonly authentication?: ApplicationAuthenticationExtension;
  readonly registerAuthenticatedRoutes?: ApplicationRegistrar<TConfig>;
  readonly endpointMetadata?: Readonly<Record<string, string>>;
}

const paidExtensionFamilySchema = z.enum(['roles', 'rbac', 'teams', 'billing', 'permissions']);
const capabilitySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  family: paidExtensionFamilySchema,
}).strict();
const routeSchema = z.object({
  id: z.string().min(1),
  method: z.enum(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']),
  path: z.string().startsWith('/'),
  access: z.enum(['public', 'authenticated']),
  capabilityId: z.string().min(1).optional(),
}).strict();
const authenticationSchema = z.object({
  middleware: z.custom<RequestHandler>((value) => typeof value === 'function'),
  resolveRequestContext: z.custom<ApplicationAuthenticationExtension['resolveRequestContext']>(
    (value) => typeof value === 'function',
  ),
}).strict();
const localRequestContextSchema = z.object({
  tenantId: z.string().uuid(),
  apiKeyId: z.string().uuid(),
  libraryId: z.string().uuid().optional(),
  apiCapabilities: z.array(z.enum(['read', 'write'])).min(1),
}).strict();

export function validateApplicationExtensions<TConfig>(extensions?: ApplicationExtensions<TConfig>): void {
  if (!extensions) return;
  const capabilities = z.array(capabilitySchema).parse(extensions.capabilities ?? []);
  const routes = z.array(routeSchema).parse(extensions.routes ?? []);
  if (extensions.authentication) authenticationSchema.parse(extensions.authentication);
  const capabilityIds = new Set<string>();
  for (const capability of capabilities) {
    if (capabilityIds.has(capability.id)) throw new Error(`Duplicate extension capability ${capability.id}`);
    capabilityIds.add(capability.id);
  }
  const routeIds = new Set<string>();
  const routeSignatures = new Set<string>();
  const reservedCoreRoutePrefixes = [
    '/api/v1/content', '/api/v1/agent', '/api/v1/tags', '/api/v1/libraries',
    '/api/v1/artifacts', '/api/v1/blobs', '/api/v1/batch-jobs',
    '/api/v1/access-tokens', '/api/v1/audit', '/api/v1/settings',
    '/api/v1/first-imports',
    '/api/v1/folder-sources',
    '/api/v1/organization-plans',
  ];
  for (const route of routes) {
    if (routeIds.has(route.id)) throw new Error(`Duplicate extension route ${route.id}`);
    routeIds.add(route.id);
    const signature = `${route.method} ${route.path}`;
    if (routeSignatures.has(signature)) throw new Error(`Duplicate extension route ${signature}`);
    routeSignatures.add(signature);
    if (route.capabilityId && !capabilityIds.has(route.capabilityId)) {
      throw new Error(`Extension route ${route.id} references unknown capability ${route.capabilityId}`);
    }
    if (route.access === 'public' && route.capabilityId) {
      throw new Error(`Public extension route ${route.id} cannot require a capability`);
    }
    if (route.path === '/' || route.path === '/health' || route.path === '/local-ui/session'
      || route.path === '/api/v1'
      || reservedCoreRoutePrefixes.some((prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`))) {
      throw new Error(`Extension route ${route.id} conflicts with an OSS core route`);
    }
  }
}

export function createApplicationRequestContextMiddleware(
  authentication: ApplicationAuthenticationExtension,
): RequestHandler {
  return async (request, _response, next) => {
    try {
      const context = localRequestContextSchema.parse(
        await authentication.resolveRequestContext(request),
      );
      request.tenantId = context.tenantId;
      request.apiKeyId = context.apiKeyId;
      request.libraryId = context.libraryId;
      request.apiCapabilities = context.apiCapabilities;
      next();
    } catch (error) {
      next(new Error('Application authentication returned an invalid OSS request context', {
        cause: error,
      }));
    }
  };
}

export interface CreateAppOptions<TConfig = Record<string, never>> {
  readonly extensions?: ApplicationExtensions<TConfig>;
  readonly dependencies?: {
    readonly database?: Database;
    readonly languageProvider?: LanguageProvider;
    readonly blobStorage?: LocalBlobStorage;
  };
}
