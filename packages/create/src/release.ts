import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const DigestReferenceSchema = z.string().regex(/@sha256:[a-f0-9]{64}$/);
const RELEASE_ARTIFACTS = ['docker-compose.yml', 'env.compose.tmpl'] as const;
export const ReleaseManifestSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  tag: z.string().regex(/^v\d+\.\d+\.\d+$/),
  promptUrl: z.string().url(),
  images: z.object({
    answerEngine: z.string().regex(/^ghcr\.io\/the-answerai\/answer-engine:\d+\.\d+\.\d+$/),
    postgres: DigestReferenceSchema,
    redis: DigestReferenceSchema,
  }).strict(),
  artifacts: z.array(z.object({ path: z.string().min(1), sha256: Sha256Schema }).strict()).min(1),
}).strict();
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const templatesRoot = fileURLToPath(new URL('../templates/', import.meta.url));

export function verifyReleaseManifest(value: unknown): ReleaseManifest {
  const parsed = ReleaseManifestSchema.safeParse(value);
  if (!parsed.success) {
    const imageFailure = parsed.error.issues.some((issue) => issue.path[0] === 'images');
    if (imageFailure) throw new Error('Release container references must be versioned or digest-pinned as required.');
    throw new Error(`Invalid release manifest: ${parsed.error.message}`);
  }
  const manifest = parsed.data;
  if (manifest.tag !== `v${manifest.version}`) throw new Error('Release manifest version and tag do not agree.');
  if (!manifest.promptUrl.includes(`/${manifest.tag}/`)) {
    throw new Error('Release prompt URL must use the immutable release tag.');
  }
  const expectedPromptUrl = `https://raw.githubusercontent.com/the-answerai/answer-engine/${manifest.tag}/INSTALL_AGENT.md`;
  if (manifest.promptUrl !== expectedPromptUrl) {
    throw new Error('Release prompt URL must use the official tagged release.');
  }
  if (!manifest.images.answerEngine.endsWith(`:${manifest.version}`)) {
    throw new Error('Answer Engine runtime image must match the installer version.');
  }
  const artifactPaths = manifest.artifacts.map((artifact) => artifact.path).sort();
  if (JSON.stringify(artifactPaths) !== JSON.stringify([...RELEASE_ARTIFACTS].sort())) {
    throw new Error('Release checksums must exactly cover every bundled executable template.');
  }
  return manifest;
}

export function loadReleaseManifest(path = join(packageRoot, 'release-manifest.json')): ReleaseManifest {
  return verifyReleaseManifest(JSON.parse(readFileSync(path, 'utf8')));
}

export function verifyReleaseArtifacts(manifest: ReleaseManifest, root = templatesRoot): void {
  for (const artifact of manifest.artifacts) {
    const actual = createHash('sha256').update(readFileSync(join(root, artifact.path))).digest('hex');
    if (actual !== artifact.sha256) throw new Error(`Release artifact checksum mismatch: ${artifact.path}.`);
  }
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

export function assertImmutableImageReference(reference: string, manifest = loadReleaseManifest()): string {
  const value = z.string().trim().min(1).regex(/^\S+$/).parse(reference);
  if (value !== manifest.images.answerEngine && !/@sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error('Runtime image must equal the release image or be digest-pinned with @sha256.');
  }
  return value;
}
