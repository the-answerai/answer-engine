import type { ReactNode } from 'react';
import { clearLegacyBrowserApiKey, health, initializeLocalUiSession } from './api';
import { coreNavigationManifest, coreRouteManifest } from './core-manifest';

export type PaidExtensionFamily = 'roles' | 'rbac' | 'teams' | 'billing' | 'permissions';

export interface WebCapabilityExtension {
  readonly id: string;
  readonly label: string;
  readonly family: PaidExtensionFamily;
}

export interface WebRouteExtension {
  readonly id: string;
  readonly path: `/${string}`;
  readonly capabilityId: string;
  readonly element: ReactNode;
}

export interface WebNavigationExtension {
  readonly id: string;
  readonly to: `/${string}`;
  readonly label: string;
  readonly mark?: string;
  readonly capabilityId: string;
}

export interface WebIdentity {
  readonly subject: string;
  readonly label: string;
  readonly detail?: string;
  readonly workspaceLabel?: string;
  readonly shortLabel?: string;
}

export interface WebIdentityExtension {
  readonly bootstrap: () => Promise<WebIdentity>;
  readonly render?: (identity: WebIdentity) => ReactNode;
}

export interface WebAuthorizationRequest {
  readonly identity: WebIdentity;
  readonly capabilityId: string;
}

export interface WebAuthorizationDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface WebAuthorizationExtension {
  readonly decide: (request: WebAuthorizationRequest) => WebAuthorizationDecision;
}

export interface WebSettingsExtension {
  readonly id: string;
  readonly title: string;
  readonly capabilityId: string;
  readonly element: ReactNode;
}

export interface WebAppExtensions {
  readonly capabilities?: readonly WebCapabilityExtension[];
  readonly routes?: readonly WebRouteExtension[];
  readonly navigation?: readonly WebNavigationExtension[];
  readonly identity?: WebIdentityExtension;
  readonly authorization?: WebAuthorizationExtension;
  readonly settings?: readonly WebSettingsExtension[];
}

export interface ComposedNavigation {
  readonly id: string;
  readonly to: `/${string}`;
  readonly label: string;
  readonly mark: string;
}

export interface VisibleWebComposition {
  readonly navigation: readonly ComposedNavigation[];
  readonly routes: readonly WebRouteExtension[];
  readonly settings: readonly WebSettingsExtension[];
}

export interface WebComposition {
  readonly identity: WebIdentityExtension;
  readonly forIdentity: (identity: WebIdentity) => VisibleWebComposition;
}

const paidExtensionFamilies = new Set<PaidExtensionFamily>([
  'roles', 'rbac', 'teams', 'billing', 'permissions',
]);

export const localIdentityExtension: WebIdentityExtension = {
  async bootstrap() {
    clearLegacyBrowserApiKey();
    await initializeLocalUiSession();
    if (!await health()) throw new Error('The local API health check failed.');
    return {
      subject: 'local-owner',
      label: 'LOCAL SESSION',
      detail: 'No login or API key required',
      workspaceLabel: 'LOCAL WORKSPACE',
      shortLabel: 'LOCAL',
    };
  },
};

function assertUnique(label: string, values: readonly string[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label} ${value}`);
    seen.add(value);
  }
}

function validateExtensions(extensions: WebAppExtensions): void {
  const capabilities = extensions.capabilities ?? [];
  const routes = extensions.routes ?? [];
  const navigation = extensions.navigation ?? [];
  const settings = extensions.settings ?? [];
  assertUnique('extension capability', capabilities.map((capability) => capability.id));
  assertUnique('extension route', routes.map((route) => route.id));
  assertUnique('extension navigation', navigation.map((item) => item.id));
  assertUnique('extension settings section', settings.map((section) => section.id));

  const capabilityIds = new Set(capabilities.map((capability) => capability.id));
  const coreRoutePaths = new Set(coreRouteManifest.map((route) => route.path));
  const extensionRoutePaths = new Set<string>();
  for (const capability of capabilities) {
    if (!capability.id.trim() || !capability.label.trim()) throw new Error('Extension capabilities require an id and label');
    if (!paidExtensionFamilies.has(capability.family)) {
      throw new Error(`Unsupported paid extension family ${capability.family}`);
    }
  }
  for (const route of routes) {
    if (!route.path.startsWith('/')) throw new Error(`Extension route ${route.id} must use an absolute path`);
    if (coreRoutePaths.has(route.path)) throw new Error(`Extension route ${route.id} conflicts with an OSS core route`);
    if (extensionRoutePaths.has(route.path)) throw new Error(`Duplicate extension route path ${route.path}`);
    extensionRoutePaths.add(route.path);
  }
  for (const contribution of [...routes, ...navigation, ...settings]) {
    if (!capabilityIds.has(contribution.capabilityId)) {
      throw new Error(`Extension contribution ${contribution.id} references unknown capability ${contribution.capabilityId}`);
    }
  }
  if ((routes.length > 0 || navigation.length > 0 || settings.length > 0) && !extensions.authorization) {
    throw new Error('Extension contributions require an authorization adapter');
  }
  for (const item of navigation) {
    if (!extensionRoutePaths.has(item.to)) {
      throw new Error(`Extension navigation ${item.id} targets unknown extension route ${item.to}`);
    }
  }
}

export function createWebComposition(extensions: WebAppExtensions = {}): WebComposition {
  validateExtensions(extensions);
  const identity = extensions.identity ?? localIdentityExtension;
  const authorization = extensions.authorization;
  const allowed = (identityState: WebIdentity, capabilityId: string) =>
    authorization?.decide({ identity: identityState, capabilityId }).allowed ?? false;

  return {
    identity,
    forIdentity(identityState) {
      const extensionNavigation = (extensions.navigation ?? [])
        .filter((item) => allowed(identityState, item.capabilityId))
        .map((item) => ({ ...item, mark: item.mark ?? 'EX' }));
      return {
        navigation: [...coreNavigationManifest, ...extensionNavigation],
        routes: (extensions.routes ?? []).filter((route) => allowed(identityState, route.capabilityId)),
        settings: (extensions.settings ?? []).filter((section) => allowed(identityState, section.capabilityId)),
      };
    },
  };
}
