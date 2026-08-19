import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertReleaseManifestAgreement,
  assertImmutableImageReference,
  loadReleaseManifest,
  loadReleaseManifestTemplate,
  RELEASE_RUNTIME_IMAGE_PLACEHOLDER,
  RELEASE_SOURCE_COMMIT_PLACEHOLDER,
  verifyDownloadedRelease,
  verifyReleaseArtifacts,
  verifyReleaseManifest,
} from '../release.js';
import { releaseFixture } from './release-fixture.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('release manifest verification', () => {
  it('keeps the source manifest non-runnable until the release builder injects verified inputs', () => {
    const template = loadReleaseManifestTemplate();

    expect(template.version).toBe('1.1.1');
    expect(template.tag).toBe('v1.1.1');
    expect(template.promptUrl).toContain('/v1.1.1/INSTALL_AGENT.md');
    expect(template.sourceCommit).toBe(RELEASE_SOURCE_COMMIT_PLACEHOLDER);
    expect(template.images.answerEngine).toBe(RELEASE_RUNTIME_IMAGE_PLACEHOLDER);
    expect(template.images.postgres).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(template.images.redis).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(() => loadReleaseManifest()).toThrow(/unresolved source template/i);
    expect(() => verifyReleaseArtifacts(template)).not.toThrow();
  });

  it('rejects version, mutable URL, and mutable image mismatches', () => {
    const manifest = releaseFixture();

    expect(() => verifyReleaseManifest({ ...manifest, tag: 'v1.2.0' })).toThrow(/version.*tag/i);
    expect(() => verifyReleaseManifest({ ...manifest, promptUrl: manifest.promptUrl.replace('/v1.1.1/', '/master/') }))
      .toThrow(/immutable release tag/i);
    expect(() => verifyReleaseManifest({
      ...manifest,
      images: { ...manifest.images, redis: 'redis:latest' },
    })).toThrow(/digest-pinned/i);
    expect(() => verifyReleaseManifest({
      ...manifest,
      images: { ...manifest.images, answerEngine: 'ghcr.io/the-answerai/answer-engine:1.1.1' },
    })).toThrow(/versioned or digest-pinned/i);
  });

  it('requires exact versioned release asset identities and supported bootstrap inputs', () => {
    const manifest = releaseFixture();

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
    const manifest = releaseFixture();

    expect(assertImmutableImageReference(manifest.images.answerEngine)).toBe(manifest.images.answerEngine);
    expect(() => assertImmutableImageReference('ghcr.io/the-answerai/answer-engine:1.1.1'))
      .toThrow(/exact @sha256 digest/i);
    expect(() => assertImmutableImageReference('ghcr.io/the-answerai/answer-engine:latest'))
      .toThrow(/exact @sha256 digest/i);
  });

  it('requires the official tagged prompt and checksum coverage for every bundled template', () => {
    const manifest = releaseFixture();

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
    const manifest = releaseFixture();
    const expected = createHash('sha256').update(readFileSync(template)).digest('hex');

    expect(() => verifyReleaseArtifacts({
      ...manifest,
      artifacts: [{ path: 'docker-compose.yml', sha256: expected.replace(/^./, expected[0] === 'a' ? 'b' : 'a') }],
    }, fixture)).toThrow(/checksum mismatch/i);
  });

  it('verifies downloaded identities, platform input, size, and checksum before execution', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'ae-download-release-'));
    tempDirs.push(fixture);
    const manifest = releaseFixture();
    const names = [
      manifest.assets.installer, manifest.assets.cli, manifest.assets.bashBootstrap,
      manifest.assets.powershellBootstrap, 'INSTALL_AGENT.md',
    ];
    const subjects = names.map((name, index) => {
      const path = join(fixture, name);
      writeFileSync(path, `verified-${index}\n`);
      return {
        name,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        bytes: statSync(path).size,
      };
    });
    const provenancePath = join(fixture, manifest.assets.provenance);
    const provenance = {
      predicateType: 'https://slsa.dev/provenance/v1',
      buildType: 'https://github.com/the-answerai/answer-engine/release-assets@v1',
      invocation: {
        tag: manifest.tag,
        sourceCommit: manifest.sourceCommit,
        runtimeImage: manifest.images.answerEngine,
        packageManager: 'pnpm@10.33.0',
      },
      materials: [
        { name: 'git+https://github.com/the-answerai/answer-engine', gitCommit: manifest.sourceCommit },
        { name: 'pnpm-lock.yaml', sha256: '3'.repeat(64) },
        { name: 'runtime-image', digest: manifest.images.answerEngine.split('@')[1] },
      ],
      subjects,
    };
    writeFileSync(provenancePath, `${JSON.stringify(provenance)}\n`);
    const releaseArtifacts = [...subjects, {
      name: manifest.assets.provenance,
      sha256: createHash('sha256').update(readFileSync(provenancePath)).digest('hex'),
      bytes: statSync(provenancePath).size,
    }];
    const downloadManifest = { ...manifest, releaseArtifacts };

    expect(() => verifyDownloadedRelease(downloadManifest, fixture, 'macos', 'arm64')).not.toThrow();
    expect(() => assertReleaseManifestAgreement(downloadManifest, manifest)).not.toThrow();
    expect(() => verifyDownloadedRelease(downloadManifest, fixture, 'windows-wsl2', 'arm64'))
      .toThrow(/does not support/i);

    const mismatchedProvenance = {
      ...provenance,
      invocation: {
        ...provenance.invocation,
        runtimeImage: `ghcr.io/the-answerai/answer-engine@sha256:${'4'.repeat(64)}`,
      },
    };
    writeFileSync(provenancePath, `${JSON.stringify(mismatchedProvenance)}\n`);
    const mismatchedProvenanceManifest = {
      ...downloadManifest,
      releaseArtifacts: releaseArtifacts.map((artifact) => artifact.name === manifest.assets.provenance
        ? {
            ...artifact,
            sha256: createHash('sha256').update(readFileSync(provenancePath)).digest('hex'),
            bytes: statSync(provenancePath).size,
          }
        : artifact),
    };
    expect(() => verifyDownloadedRelease(mismatchedProvenanceManifest, fixture, 'macos', 'arm64'))
      .toThrow(/provenance runtime image/i);

    writeFileSync(provenancePath, `${JSON.stringify(provenance)}\n`);
    writeFileSync(join(fixture, manifest.assets.installer), 'tampered\n');
    expect(() => verifyDownloadedRelease(downloadManifest, fixture, 'macos', 'arm64'))
      .toThrow(/size mismatch|checksum mismatch/i);
    expect(() => verifyDownloadedRelease({
      ...downloadManifest,
      releaseArtifacts: releaseArtifacts.map((artifact, index) => index === 0
        ? { ...artifact, name: 'answer-engine-installer-latest.tgz' } : artifact),
    }, fixture, 'macos', 'arm64')).toThrow(/do not match.*identities/i);
    expect(() => assertReleaseManifestAgreement({
      ...downloadManifest,
      images: {
        ...downloadManifest.images,
        answerEngine: `ghcr.io/the-answerai/answer-engine@sha256:${'5'.repeat(64)}`,
      },
    }, manifest)).toThrow(/bundled installer manifest/i);
  });
});
