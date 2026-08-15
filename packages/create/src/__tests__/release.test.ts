import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadReleaseManifest,
  verifyReleaseArtifacts,
  verifyReleaseManifest,
} from '../release.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('release manifest verification', () => {
  it('loads the bundled immutable release and verifies every executable template', () => {
    const manifest = loadReleaseManifest();

    expect(manifest.version).toBe('1.1.0');
    expect(manifest.tag).toBe('v1.1.0');
    expect(manifest.promptUrl).toContain('/v1.1.0/INSTALL_AGENT.md');
    expect(manifest.images.postgres).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(manifest.images.redis).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(() => verifyReleaseArtifacts(manifest)).not.toThrow();
  });

  it('rejects version, mutable URL, and mutable image mismatches', () => {
    const manifest = loadReleaseManifest();

    expect(() => verifyReleaseManifest({ ...manifest, tag: 'v1.2.0' })).toThrow(/version.*tag/i);
    expect(() => verifyReleaseManifest({ ...manifest, promptUrl: manifest.promptUrl.replace('/v1.1.0/', '/master/') }))
      .toThrow(/immutable release tag/i);
    expect(() => verifyReleaseManifest({
      ...manifest,
      images: { ...manifest.images, redis: 'redis:latest' },
    })).toThrow(/digest-pinned/i);
  });

  it('requires the official tagged prompt and checksum coverage for every bundled template', () => {
    const manifest = loadReleaseManifest();

    expect(() => verifyReleaseManifest({
      ...manifest,
      promptUrl: `https://example.com/${manifest.tag}/INSTALL_AGENT.md`,
    })).toThrow(/official tagged release/i);
    expect(() => verifyReleaseManifest({
      ...manifest,
      artifacts: manifest.artifacts.filter((artifact) => artifact.path !== 'env.compose.tmpl'),
    })).toThrow(/exactly cover/i);
    expect(() => verifyReleaseManifest({
      ...manifest,
      artifacts: [...manifest.artifacts, manifest.artifacts[0]!],
    })).toThrow(/exactly cover/i);
  });

  it('rejects a tampered template before installation', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'ae-release-'));
    tempDirs.push(fixture);
    const template = join(fixture, 'docker-compose.yml');
    writeFileSync(template, 'tampered\n');
    const manifest = loadReleaseManifest();
    const expected = createHash('sha256').update(readFileSync(template)).digest('hex');

    expect(() => verifyReleaseArtifacts({
      ...manifest,
      artifacts: [{ path: 'docker-compose.yml', sha256: expected.replace(/^./, expected[0] === 'a' ? 'b' : 'a') }],
    }, fixture)).toThrow(/checksum mismatch/i);
  });
});
