import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adoptLegacyStableInstallation,
  inspectLegacyStableInstallation,
} from '../legacy-adoption.js';
import { createRuntimeChannelProfile } from '../runtime-channel.js';

const tempDirs: string[] = [];

const LEGACY_COMPOSE = `services:
  postgres:
    image: pgvector/pgvector:pg16
    volumes: [postgres_data:/var/lib/postgresql/data]
  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes: [redis_data:/data]
  migrate:
    image: \${ANSWER_ENGINE_IMAGE:-ghcr.io/the-answerai/answer-engine:1.1.0}
    command: [node, dist/scripts/migrate.js]
    env_file: [.env.compose]
  init:
    image: \${ANSWER_ENGINE_IMAGE:-ghcr.io/the-answerai/answer-engine:1.1.0}
    command: [node, dist/scripts/init.js]
    env_file: [.env.compose]
  api:
    image: \${ANSWER_ENGINE_IMAGE:-ghcr.io/the-answerai/answer-engine:1.1.0}
    command: [node, dist/server.js]
    env_file: [.env.compose]
    ports: [127.0.0.1:5050:5000]
    volumes: [answerengine_blobs:/data]
volumes:
  postgres_data:
  redis_data:
  answerengine_blobs:
`;

function legacyFixture(environment = 'COMPOSE_PROJECT_NAME=answer-engine-local\nENCRYPTION_KEY=stable-secret\n') {
  const home = mkdtempSync(join(tmpdir(), 'ae-legacy-adoption-'));
  tempDirs.push(home);
  writeFileSync(join(home, 'docker-compose.yml'), LEGACY_COMPOSE);
  writeFileSync(join(home, '.env.compose'), environment);
  writeFileSync(join(home, 'config.yaml'), 'models: {}\n');
  writeFileSync(join(home, 'database.fixture'), 'database bytes remain unchanged');
  writeFileSync(join(home, 'archive.fixture'), 'archive bytes remain unchanged');
  return { home, profile: createRuntimeChannelProfile('stable', { home }) };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('legacy stable adoption', () => {
  it('inspects without mutation and adopts only channel metadata', async () => {
    const { home, profile } = legacyFixture();
    const before = new Map([
      ['database.fixture', readFileSync(join(home, 'database.fixture'))],
      ['archive.fixture', readFileSync(join(home, 'archive.fixture'))],
    ]);

    await expect(inspectLegacyStableInstallation(profile)).resolves.toMatchObject({ state: 'available' });
    expect(existsSync(profile.markerFile)).toBe(false);
    expect(readFileSync(profile.credentialsFile, 'utf8')).not.toContain('AE_CHANNEL');

    await expect(adoptLegacyStableInstallation(profile)).resolves.toMatchObject({ state: 'adopted' });

    expect(readFileSync(profile.credentialsFile, 'utf8')).toContain('AE_CHANNEL=stable');
    expect(existsSync(profile.markerFile)).toBe(true);
    for (const [name, bytes] of before) {
      expect(readFileSync(join(home, name))).toEqual(bytes);
    }
  });

  it.each([
    ['wrong project', 'COMPOSE_PROJECT_NAME=answer-engine-staging\n', /Compose project.*answer-engine-local/i],
    ['conflicting channel', 'COMPOSE_PROJECT_NAME=answer-engine-local\nAE_CHANNEL=staging\n', /channel.*expected stable/i],
  ])('fails closed for a %s', async (_name, environment, message) => {
    const { profile } = legacyFixture(environment);

    await expect(inspectLegacyStableInstallation(profile)).resolves.toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(message),
    });
    await expect(adoptLegacyStableInstallation(profile)).rejects.toThrow(message);
    expect(existsSync(profile.markerFile)).toBe(false);
  });

  it('refuses symlinked homes and required files without changing their targets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ae-legacy-link-'));
    tempDirs.push(root);
    const linkedHome = join(root, 'linked');
    const { home } = legacyFixture();
    symlinkSync(home, linkedHome);
    const linkedProfile = createRuntimeChannelProfile('stable', { home: linkedHome });
    await expect(adoptLegacyStableInstallation(linkedProfile)).rejects.toThrow(/home.*symbolic link/i);

    const configTarget = join(root, 'config-target.yaml');
    writeFileSync(configTarget, readFileSync(join(home, 'config.yaml')));
    rmSync(join(home, 'config.yaml'));
    symlinkSync(configTarget, join(home, 'config.yaml'));
    const original = readFileSync(configTarget);
    await expect(adoptLegacyStableInstallation(createRuntimeChannelProfile('stable', { home })))
      .rejects.toThrow(/config.*symbolic link/i);
    expect(readFileSync(configTarget)).toEqual(original);
    expect(existsSync(join(home, '.runtime-channel.json'))).toBe(false);
  });

  it('fails closed for symlinks even when the legacy home is partial or empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ae-legacy-partial-link-'));
    tempDirs.push(root);
    const emptyTarget = join(root, 'empty-target');
    mkdirSync(emptyTarget);
    const linkedHome = join(root, 'linked-home');
    symlinkSync(emptyTarget, linkedHome);

    await expect(inspectLegacyStableInstallation(
      createRuntimeChannelProfile('stable', { home: linkedHome }),
    )).resolves.toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(/home.*symbolic link/i),
    });

    const partialHome = join(root, 'partial-home');
    mkdirSync(partialHome);
    const configTarget = join(root, 'partial-config.yaml');
    writeFileSync(configTarget, 'models: {}\n');
    symlinkSync(configTarget, join(partialHome, 'config.yaml'));

    await expect(inspectLegacyStableInstallation(
      createRuntimeChannelProfile('stable', { home: partialHome }),
    )).resolves.toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(/config\.yaml.*symbolic link/i),
    });
  });

  it('fails closed for a dangling symbolic-link home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ae-legacy-dangling-link-'));
    tempDirs.push(root);
    const linkedHome = join(root, 'linked-home');
    symlinkSync(join(root, 'missing-target'), linkedHome);

    await expect(inspectLegacyStableInstallation(
      createRuntimeChannelProfile('stable', { home: linkedHome }),
    )).resolves.toMatchObject({
      state: 'invalid',
      message: expect.stringMatching(/home.*symbolic link/i),
    });
  });

  it('refuses malformed mappings and non-regular required paths', async () => {
    const malformed = legacyFixture();
    writeFileSync(join(malformed.home, 'docker-compose.yml'), 'services: [\n');
    await expect(adoptLegacyStableInstallation(malformed.profile))
      .rejects.toThrow(/valid Compose mapping/i);
    expect(existsSync(malformed.profile.markerFile)).toBe(false);

    const nonRegular = legacyFixture();
    rmSync(join(nonRegular.home, 'config.yaml'));
    mkdirSync(join(nonRegular.home, 'config.yaml'));
    await expect(adoptLegacyStableInstallation(nonRegular.profile))
      .rejects.toThrow(/config\.yaml must be a regular file/i);
    expect(existsSync(nonRegular.profile.markerFile)).toBe(false);
  });

  it('refuses to grant lifecycle ownership to an arbitrary Compose project', async () => {
    const arbitrary = legacyFixture();
    writeFileSync(join(arbitrary.home, 'docker-compose.yml'), `services:
  exfiltrate:
    image: attacker/example
    privileged: true
    volumes: [/var/run/docker.sock:/var/run/docker.sock]
`);

    await expect(adoptLegacyStableInstallation(arbitrary.profile))
      .rejects.toThrow(/Answer Engine service topology/i);
    expect(existsSync(arbitrary.profile.markerFile)).toBe(false);
    expect(readFileSync(arbitrary.profile.credentialsFile, 'utf8')).not.toContain('AE_CHANNEL');

    const unsafeKnownTopology = legacyFixture();
    const unsafeCompose = LEGACY_COMPOSE.replace(
      '    volumes: [answerengine_blobs:/data]',
      '    privileged: true\n    volumes: [/var/run/docker.sock:/var/run/docker.sock]',
    );
    writeFileSync(join(unsafeKnownTopology.home, 'docker-compose.yml'), unsafeCompose);

    await expect(adoptLegacyStableInstallation(unsafeKnownTopology.profile))
      .rejects.toThrow(/unsupported privileged/i);
    expect(existsSync(unsafeKnownTopology.profile.markerFile)).toBe(false);
    expect(readFileSync(unsafeKnownTopology.profile.credentialsFile, 'utf8')).not.toContain('AE_CHANNEL');
  });

  it('never offers adoption for staging', async () => {
    const { home } = legacyFixture();
    const staging = createRuntimeChannelProfile('staging', { home });
    await expect(inspectLegacyStableInstallation(staging)).resolves.toMatchObject({ state: 'unavailable' });
    await expect(adoptLegacyStableInstallation(staging)).rejects.toThrow(/stable/i);
  });
});
