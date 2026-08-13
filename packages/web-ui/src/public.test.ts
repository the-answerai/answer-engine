import { describe, expect, it } from 'vitest';
import {
  App,
  coreWebManifest,
  createWebComposition,
  localIdentityExtension,
} from './public';

describe('public web composition entry point', () => {
  it('exports the app, local defaults, composition helper, and complete core manifest', () => {
    expect(App).toBeTypeOf('function');
    expect(createWebComposition).toBeTypeOf('function');
    expect(localIdentityExtension.bootstrap).toBeTypeOf('function');
    expect(coreWebManifest.capabilities.map((capability) => capability.id)).toContain('content');
    expect(coreWebManifest.surfaces.map((surface) => surface.id)).toContain('workspace-audit');
  });
});
