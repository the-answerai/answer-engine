import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findImplementationBoundaryFailures,
  findManifestBoundaryFailures,
  parseCoreManifest,
  parseProductBoundary,
} from '../../scripts/check-public-boundary.js';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const productBoundary = parseProductBoundary(
  JSON.parse(readFileSync(resolve(repositoryRoot, 'product-boundary.json'), 'utf8')),
);
const coreManifest = parseCoreManifest(
  JSON.parse(readFileSync(resolve(repositoryRoot, 'packages/web-ui/src/core-manifest.json'), 'utf8')),
);

describe('product boundary guard', () => {
  it('pins the exact five paid extension families', () => {
    expect(productBoundary.paidExtensionFamilies)
      .toEqual(['roles', 'rbac', 'teams', 'billing', 'permissions']);
  });

  it('matches every required OSS capability and surface to the implemented manifest', () => {
    expect(findManifestBoundaryFailures(productBoundary, coreManifest)).toEqual([]);
  });

  it('fails when an implemented core surface is removed', () => {
    const manifestWithoutContent = {
      ...coreManifest,
      surfaces: coreManifest.surfaces.filter((surface) => surface.id !== 'content'),
    };

    expect(findManifestBoundaryFailures(productBoundary, manifestWithoutContent))
      .toContain('core surface content is missing from the web manifest');
  });

  it('fails when a paid capability implementation leaks into OSS source', () => {
    const leaks = [
      'export const roles = [];',
      'export const rbacPolicy = {};',
      'export const teamDirectory = [];',
      'export const billingPortal = true;',
      'export const permissionMatrix = {};',
    ];

    for (const content of leaks) {
      expect(findImplementationBoundaryFailures([{ path: 'src/leaked-feature.ts', content }]))
        .toEqual(['src/leaked-feature.ts crosses the OSS product boundary']);
    }
  });
});
