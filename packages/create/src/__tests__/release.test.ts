import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertImmutableImageReference,
  loadReleaseManifest,
  verifyDownloadedRelease,
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
    expect(manifest.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.releaseBaseUrl).toContain('/releases/download/v1.1.0');
    expect(manifest.images.answerEngine).toMatch(/@sha256:[a-f0-9]{64}$/);
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
    expect(() => verifyReleaseManifest({
      ...manifest,
      images: { ...manifest.images, answerEngine: 'ghcr.io/the-answerai/answer-engine:1.1.0' },
    })).toThrow(/versioned or digest-pinned/i);
  });

  it('requires exact versioned release asset identities and supported bootstrap inputs', () => {
    const manifest = loadReleaseManifest();

    expect(() => verifyReleaseManifest({
      ...manifest,
      assets: { ...manifest.assets, installer: 'answer-engine-installer-latest.tgz' },
    })).toThrow(/asset identities/i);
    expect(() => verifyReleaseManifest({
      ...manifest,
      bootstrapInputs: manifest.bootstrapInputs.map((input) => ({ ...input, architecture: 'x64' })),
    })).toThrow(/bootstrap inputs/i);
  });

  it('rejects mutable lifecycle image references', () => {
    const manifest = loadReleaseManifest();

    expect(assertImmutableImageReference(manifest.images.answerEngine, manifest)).toBe(manifest.images.answerEngine);
    expect(() => assertImmutableImageReference('ghcr.io/the-answerai/answer-engine:1.1.0', manifest))
      .toThrow(/exact @sha256 digest/i);
    expect(() => assertImmutableImageReference('ghcr.io/the-answerai/answer-engine:latest', manifest))
      .toThrow(/exact @sha256 digest/i);
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

  it('verifies downloaded identities, platform input, size, and checksum before execution', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'ae-download-release-'));
    tempDirs.push(fixture);
    const manifest = loadReleaseManifest();
    const names = [
      manifest.assets.installer, manifest.assets.cli, manifest.assets.bashBootstrap,
      manifest.assets.powershellBootstrap, manifest.assets.provenance, 'INSTALL_AGENT.md',
    ];
    const releaseArtifacts = names.map((name, index) => {
      const path = join(fixture, name);
      writeFileSync(path, `verified-${index}\n`);
      return {
        name,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        bytes: statSync(path).size,
      };
    });
    const downloadManifest = { ...manifest, releaseArtifacts };

    expect(() => verifyDownloadedRelease(downloadManifest, fixture, 'macos', 'arm64')).not.toThrow();
    expect(() => verifyDownloadedRelease(downloadManifest, fixture, 'windows-wsl2', 'arm64'))
      .toThrow(/does not support/i);
    writeFileSync(join(fixture, manifest.assets.installer), 'tampered\n');
    expect(() => verifyDownloadedRelease(downloadManifest, fixture, 'macos', 'arm64'))
      .toThrow(/size mismatch|checksum mismatch/i);
    expect(() => verifyDownloadedRelease({
      ...downloadManifest,
      releaseArtifacts: releaseArtifacts.map((artifact, index) => index === 0
        ? { ...artifact, name: 'answer-engine-installer-latest.tgz' } : artifact),
    }, fixture, 'macos', 'arm64')).toThrow(/do not match.*identities/i);
  });
});
