import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly pnpm?: {
    readonly overrides?: Readonly<Record<string, string>>;
  };
}

interface LockfileDependency {
  readonly version: string;
}

interface Lockfile {
  readonly importers: Readonly<Record<string, {
    readonly dependencies?: Readonly<Record<string, LockfileDependency>>;
    readonly devDependencies?: Readonly<Record<string, LockfileDependency>>;
  }>>;
}

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function numericVersion(value: string): readonly number[] {
  const match = value.match(/\d+\.\d+\.\d+/);
  if (!match) throw new Error(`Dependency version does not contain semver: ${value}`);
  return match[0].split('.').map(Number);
}

function atLeast(value: string, minimum: string): boolean {
  const actual = numericVersion(value);
  const floor = numericVersion(minimum);
  for (let index = 0; index < 3; index += 1) {
    const difference = (actual[index] ?? 0) - (floor[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function packageManifests(): readonly string[] {
  return [
    'package.json',
    ...readdirSync(resolve(root, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}/package.json`),
  ];
}

describe('dependency security posture', () => {
  it('keeps every declared Vitest tool above the patched server floor', () => {
    for (const path of packageManifests()) {
      const manifest = JSON.parse(read(path)) as PackageManifest;
      for (const dependency of ['vitest', '@vitest/coverage-v8']) {
        const declared = manifest.devDependencies?.[dependency];
        if (declared) expect(atLeast(declared, '3.2.6'), `${path} ${dependency}`).toBe(true);
      }
    }
  });

  it('keeps OSS routing declarations and frozen resolutions above the patched floor', () => {
    const manifest = JSON.parse(read('packages/web-ui/package.json')) as PackageManifest;
    expect(atLeast(manifest.dependencies?.['react-router-dom'] ?? '', '7.18.2')).toBe(true);

    const lockfile = parse(read('pnpm-lock.yaml')) as Lockfile;
    const importer = lockfile.importers['packages/web-ui'];
    expect(importer).toBeDefined();
    expect(atLeast(importer?.dependencies?.['react-router-dom']?.version ?? '', '7.18.2')).toBe(true);

    const vitestResolutions = Object.entries(lockfile.importers).flatMap(([path, entry]) => {
      const version = entry.devDependencies?.vitest?.version;
      return version ? [{ path, version }] : [];
    });
    expect(vitestResolutions.length).toBeGreaterThan(0);
    for (const resolution of vitestResolutions) {
      expect(atLeast(resolution.version, '3.2.6'), `${resolution.path} vitest`).toBe(true);
    }
  });

  it('pins patched transitives for the production server and MCP dependency graph', () => {
    const manifest = JSON.parse(read('package.json')) as PackageManifest;
    const overrides = manifest.pnpm?.overrides;
    expect(overrides).toBeDefined();
    expect(atLeast(manifest.dependencies?.morgan ?? '', '1.11.0'), 'morgan').toBe(true);
    for (const [dependency, floor] of Object.entries({
      '@hono/node-server': '1.19.15',
      'body-parser@1.20.5': '1.20.6',
      'body-parser@2.2.2': '2.3.0',
      'fast-uri': '3.1.5',
      'form-data': '4.0.6',
      hono: '4.12.34',
      'ip-address': '10.3.1',
      ws: '8.21.0',
    })) {
      expect(atLeast(overrides?.[dependency] ?? '', floor), dependency).toBe(true);
    }
  });
});
