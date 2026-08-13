import manifest from './core-manifest.json';

export interface CoreCapabilityManifest {
  readonly id: string;
}

export interface CoreSurfaceManifest {
  readonly id: string;
  readonly path: `/${string}`;
  readonly capabilityId: string;
  readonly kind: 'route' | 'embedded';
}

export interface CoreNavigationManifest {
  readonly id: string;
  readonly to: `/${string}`;
  readonly label: string;
  readonly mark: string;
}

export const coreCapabilityManifest: readonly CoreCapabilityManifest[] = manifest.capabilities
  .map((id) => ({ id }));
export const coreSurfaceManifest = manifest.surfaces as readonly CoreSurfaceManifest[];
export const coreRouteManifest = coreSurfaceManifest.filter((surface) => surface.kind === 'route');
export const coreNavigationManifest = manifest.navigation as readonly CoreNavigationManifest[];

export const coreWebManifest = {
  schemaVersion: manifest.schemaVersion,
  capabilities: coreCapabilityManifest,
  surfaces: coreSurfaceManifest,
  navigation: coreNavigationManifest,
} as const;
