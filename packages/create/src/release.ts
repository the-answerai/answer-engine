import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const DigestReferenceSchema = z.string().regex(/^[a-z0-9./_-]+(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/);
export const RELEASE_SOURCE_COMMIT_PLACEHOLDER = '__RELEASE_SOURCE_COMMIT__';
export const RELEASE_RUNTIME_IMAGE_PLACEHOLDER = '__ANSWER_ENGINE_RUNTIME_IMAGE__';
const RELEASE_ARTIFACTS = [
  'docker-compose.yml',
  'env.compose.tmpl',
  'integrations/answer-engine/.claude-plugin/plugin.json',
  'integrations/answer-engine/.codex-plugin/plugin.json',
  'integrations/answer-engine/.mcp.json',
  'integrations/answer-engine/evals/install-answer-engine.json',
  'integrations/answer-engine/evals/organize-answer-engine.json',
  'integrations/answer-engine/evals/use-answer-engine.json',
  'integrations/answer-engine/evals/fixtures/duplicate-project-memories.json',
  'integrations/answer-engine/evals/fixtures/onboarding-scope.json',
  'integrations/answer-engine/references/capabilities.md',
  'integrations/answer-engine/references/safety.md',
  'integrations/answer-engine/references/tools.md',
  'integrations/answer-engine/skills/install-answer-engine/SKILL.md',
  'integrations/answer-engine/skills/organize-answer-engine/SKILL.md',
  'integrations/answer-engine/skills/use-answer-engine/SKILL.md',
] as const;
export const ReleaseManifestSchema = z.object({
  schemaVersion: z.literal(2),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  tag: z.string().regex(/^v\d+\.\d+\.\d+$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  promptUrl: z.string().url(),
  releaseBaseUrl: z.string().url(),
  images: z.object({
    answerEngine: DigestReferenceSchema,
    postgres: DigestReferenceSchema,
    redis: DigestReferenceSchema,
  }).strict(),
  assets: z.object({
    installer: z.string().min(1),
    cli: z.string().min(1),
    bashBootstrap: z.string().min(1),
    powershellBootstrap: z.string().min(1),
    checksums: z.literal('SHA256SUMS'),
    provenance: z.literal('provenance.json'),
  }).strict(),
  bootstrapInputs: z.array(z.object({
    platform: z.enum(['macos', 'windows-wsl2']),
    architecture: z.enum(['arm64', 'x64']),
    bootstrap: z.enum(['bash', 'powershell']),
  }).strict()).length(2),
  artifacts: z.array(z.object({ path: z.string().min(1), sha256: Sha256Schema }).strict()).min(1),
}).strict();
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

export const ReleaseManifestTemplateSchema = ReleaseManifestSchema.extend({
  sourceCommit: z.literal(RELEASE_SOURCE_COMMIT_PLACEHOLDER),
  images: ReleaseManifestSchema.shape.images.extend({
    answerEngine: z.literal(RELEASE_RUNTIME_IMAGE_PLACEHOLDER),
  }).strict(),
}).strict();
export type ReleaseManifestTemplate = z.infer<typeof ReleaseManifestTemplateSchema>;

export const ReleaseDownloadManifestSchema = ReleaseManifestSchema.extend({
  releaseArtifacts: z.array(z.object({
    name: z.string().min(1),
    sha256: Sha256Schema,
    bytes: z.number().int().positive(),
  }).strict()).min(6),
}).strict();
export type ReleaseDownloadManifest = z.infer<typeof ReleaseDownloadManifestSchema>;

const ReleaseSubjectSchema = z.object({
  name: z.string().min(1),
  sha256: Sha256Schema,
  bytes: z.number().int().positive(),
}).strict();

const ReleaseProvenanceSchema = z.object({
  predicateType: z.literal('https://slsa.dev/provenance/v1'),
  buildType: z.literal('https://github.com/the-answerai/answer-engine/release-assets@v1'),
  invocation: z.object({
    tag: z.string().regex(/^v\d+\.\d+\.\d+$/),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    runtimeImage: DigestReferenceSchema,
    packageManager: z.literal('pnpm@10.33.0'),
  }).strict(),
  materials: z.array(z.object({
    name: z.string().min(1),
    gitCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    sha256: Sha256Schema.optional(),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  }).strict()).length(3),
  subjects: z.array(ReleaseSubjectSchema).length(5),
}).strict();

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const templatesRoot = fileURLToPath(new URL('../templates/', import.meta.url));

function verifyManifestMetadata<T extends ReleaseManifest | ReleaseManifestTemplate>(manifest: T): T {
  if (manifest.tag !== `v${manifest.version}`) throw new Error('Release manifest version and tag do not agree.');
  if (!manifest.promptUrl.includes(`/${manifest.tag}/`)) {
    throw new Error('Release prompt URL must use the immutable release tag.');
  }
  const expectedPromptUrl = `https://raw.githubusercontent.com/the-answerai/answer-engine/${manifest.tag}/INSTALL_AGENT.md`;
  if (manifest.promptUrl !== expectedPromptUrl) {
    throw new Error('Release prompt URL must use the official tagged release.');
  }
  const expectedReleaseBaseUrl = `https://github.com/the-answerai/answer-engine/releases/download/${manifest.tag}`;
  if (manifest.releaseBaseUrl !== expectedReleaseBaseUrl) {
    throw new Error('Release asset URL must use the official immutable release tag.');
  }
  const expectedAssets = {
    installer: `answer-engine-installer-v${manifest.version}.tgz`,
    cli: `answer-engine-cli-v${manifest.version}.tgz`,
    bashBootstrap: `answer-engine-bootstrap-v${manifest.version}.sh`,
    powershellBootstrap: `answer-engine-bootstrap-v${manifest.version}.ps1`,
    checksums: 'SHA256SUMS' as const,
    provenance: 'provenance.json' as const,
  };
  if (JSON.stringify(manifest.assets) !== JSON.stringify(expectedAssets)) {
    throw new Error('Release asset identities must match the immutable installer version.');
  }
  const bootstrapInputs = [...manifest.bootstrapInputs]
    .map((input) => `${input.platform}/${input.architecture}/${input.bootstrap}`).sort();
  if (JSON.stringify(bootstrapInputs) !== JSON.stringify([
    'macos/arm64/bash', 'windows-wsl2/x64/powershell',
  ])) throw new Error('Release bootstrap inputs must exactly cover supported platforms.');
  const artifactPaths = manifest.artifacts.map((artifact) => artifact.path).sort();
  if (JSON.stringify(artifactPaths) !== JSON.stringify([...RELEASE_ARTIFACTS].sort())) {
    throw new Error('Release checksums must exactly cover every bundled executable template.');
  }
  return manifest;
}

export function verifyReleaseManifest(value: unknown): ReleaseManifest {
  const parsed = ReleaseManifestSchema.safeParse(value);
  if (!parsed.success) {
    const unresolved = ReleaseManifestTemplateSchema.safeParse(value);
    if (unresolved.success) {
      throw new Error('Release manifest is an unresolved source template; build it with an exact commit and runtime image digest.');
    }
    const imageFailure = parsed.error.issues.some((issue) => issue.path[0] === 'images');
    if (imageFailure) throw new Error('Release container references must be versioned or digest-pinned as required.');
    throw new Error(`Invalid release manifest: ${parsed.error.message}`);
  }
  return verifyManifestMetadata(parsed.data);
}

export function verifyReleaseManifestTemplate(value: unknown): ReleaseManifestTemplate {
  const parsed = ReleaseManifestTemplateSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid release manifest template: ${parsed.error.message}`);
  return verifyManifestMetadata(parsed.data);
}

export function loadReleaseManifest(path = join(packageRoot, 'release-manifest.json')): ReleaseManifest {
  return verifyReleaseManifest(JSON.parse(readFileSync(path, 'utf8')));
}

export function loadReleaseManifestTemplate(
  path = join(packageRoot, 'release-manifest.json'),
): ReleaseManifestTemplate {
  return verifyReleaseManifestTemplate(JSON.parse(readFileSync(path, 'utf8')));
}

export function verifyReleaseArtifacts(
  manifest: Pick<ReleaseManifest, 'artifacts'>,
  root = templatesRoot,
): void {
  for (const artifact of manifest.artifacts) {
    const actual = createHash('sha256').update(readFileSync(join(root, artifact.path))).digest('hex');
    if (actual !== artifact.sha256) throw new Error(`Release artifact checksum mismatch: ${artifact.path}.`);
  }
}

export function verifyDownloadedRelease(
  value: unknown,
  root: string,
  platform: 'macos' | 'windows-wsl2',
  architecture: 'arm64' | 'x64',
): ReleaseDownloadManifest {
  const parsed = ReleaseDownloadManifestSchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid release download manifest: ${parsed.error.message}`);
  const { releaseArtifacts, ...bundledManifest } = parsed.data;
  const manifest = verifyReleaseManifest(bundledManifest);
  const bootstrap = manifest.bootstrapInputs.find((input) => (
    input.platform === platform && input.architecture === architecture
  ));
  if (!bootstrap) throw new Error(`Release does not support ${platform}/${architecture}.`);
  const expectedNames = [
    manifest.assets.installer,
    manifest.assets.cli,
    manifest.assets.bashBootstrap,
    manifest.assets.powershellBootstrap,
    manifest.assets.provenance,
    'INSTALL_AGENT.md',
  ].sort();
  const actualNames = releaseArtifacts.map((artifact) => artifact.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error('Release download artifacts do not match the manifest identities.');
  }
  for (const artifact of releaseArtifacts) {
    const path = join(root, artifact.name);
    const contents = readFileSync(path);
    if (contents.byteLength !== artifact.bytes) throw new Error(`Release artifact size mismatch: ${artifact.name}.`);
    const actual = createHash('sha256').update(contents).digest('hex');
    if (actual !== artifact.sha256) throw new Error(`Release artifact checksum mismatch: ${artifact.name}.`);
  }
  const provenancePath = join(root, manifest.assets.provenance);
  const provenanceResult = ReleaseProvenanceSchema.safeParse(JSON.parse(readFileSync(provenancePath, 'utf8')));
  if (!provenanceResult.success) {
    throw new Error(`Invalid release provenance: ${provenanceResult.error.message}`);
  }
  const provenance = provenanceResult.data;
  if (provenance.invocation.tag !== manifest.tag) throw new Error('Release provenance tag does not match the manifest.');
  if (provenance.invocation.sourceCommit !== manifest.sourceCommit) {
    throw new Error('Release provenance source commit does not match the manifest.');
  }
  if (provenance.invocation.runtimeImage !== manifest.images.answerEngine) {
    throw new Error('Release provenance runtime image does not match the manifest.');
  }
  const materials = new Map(provenance.materials.map((material) => [material.name, material]));
  if (materials.size !== 3
    || materials.get('git+https://github.com/the-answerai/answer-engine')?.gitCommit !== manifest.sourceCommit
    || materials.get('pnpm-lock.yaml')?.sha256 === undefined
    || materials.get('runtime-image')?.digest !== manifest.images.answerEngine.split('@')[1]) {
    throw new Error('Release provenance materials do not match the verified release inputs.');
  }
  const expectedSubjects = releaseArtifacts
    .filter((artifact) => artifact.name !== manifest.assets.provenance)
    .sort((left, right) => left.name.localeCompare(right.name));
  const actualSubjects = [...provenance.subjects]
    .sort((left, right) => left.name.localeCompare(right.name));
  if (!isDeepStrictEqual(actualSubjects, expectedSubjects)) {
    throw new Error('Release provenance subjects do not match the downloaded artifacts.');
  }
  return parsed.data;
}

export function assertReleaseManifestAgreement(
  downloadedValue: unknown,
  bundledValue: unknown,
): ReleaseManifest {
  const downloaded = ReleaseDownloadManifestSchema.parse(downloadedValue);
  const { releaseArtifacts: _releaseArtifacts, ...downloadedManifest } = downloaded;
  const bundledManifest = verifyReleaseManifest(bundledValue);
  if (!isDeepStrictEqual(downloadedManifest, bundledManifest)) {
    throw new Error('Downloaded release manifest does not match the bundled installer manifest.');
  }
  return bundledManifest;
}

export function verifyBundledRelease(): ReleaseManifest {
  const manifest = loadReleaseManifest();
  const packageManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version?: unknown };
  if (packageManifest.version !== manifest.version) {
    throw new Error('Installer package version does not match the bundled release manifest.');
  }
  verifyReleaseArtifacts(manifest);
  return manifest;
}

export function assertImmutableImageReference(reference: string): string {
  const value = z.string().trim().min(1).regex(/^\S+$/).parse(reference);
  const parsed = DigestReferenceSchema.safeParse(value);
  if (!parsed.success) throw new Error('Runtime image must be content-addressed with an exact @sha256 digest.');
  return parsed.data;
}
