import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ignoredDirectories = new Set(['.git', '.worktrees', 'dist', 'node_modules']);
const textExtensions = new Set(['.css', '.html', '.json', '.md', '.sql', '.ts', '.tsx', '.yaml', '.yml']);
const approvedContractFiles = new Set([
  'src/runtime/application-composition.ts',
  'packages/web-ui/src/composition.tsx',
  'packages/web-ui/src/composition.type-test.tsx',
]);

const coreSurfaceSchema = z.object({
  id: z.string().min(1),
  path: z.string().startsWith('/'),
  capabilityId: z.string().min(1),
  kind: z.enum(['route', 'embedded']),
}).strict();
const productBoundarySchema = z.object({
  schemaVersion: z.literal(1),
  paidExtensionFamilies: z.tuple([
    z.literal('roles'),
    z.literal('rbac'),
    z.literal('teams'),
    z.literal('billing'),
    z.literal('permissions'),
  ]),
  requiredCoreCapabilities: z.array(z.string().min(1)).min(1),
  requiredCoreSurfaces: z.array(coreSurfaceSchema).min(1),
}).strict();
const coreNavigationSchema = z.object({
  id: z.string().min(1),
  to: z.string().startsWith('/'),
  label: z.string().min(1),
  mark: z.string().min(1),
}).strict();
const coreManifestSchema = z.object({
  schemaVersion: z.literal(1),
  capabilities: z.array(z.string().min(1)).min(1),
  surfaces: z.array(coreSurfaceSchema).min(1),
  navigation: z.array(coreNavigationSchema).min(1),
}).strict();

export type ProductBoundary = z.infer<typeof productBoundarySchema>;
export type CoreManifest = z.infer<typeof coreManifestSchema>;
export interface ImplementationFile {
  readonly path: string;
  readonly content: string;
}

export function parseProductBoundary(input: unknown): ProductBoundary {
  return productBoundarySchema.parse(input);
}

export function parseCoreManifest(input: unknown): CoreManifest {
  return coreManifestSchema.parse(input);
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return [...new Set(values.filter((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  }))];
}

export function findManifestBoundaryFailures(
  boundary: ProductBoundary,
  manifest: CoreManifest,
): string[] {
  const failures: string[] = [];
  const capabilityIds = new Set(manifest.capabilities);
  const surfacesById = new Map(manifest.surfaces.map((surface) => [surface.id, surface]));
  const requiredSurfaceIds = new Set(boundary.requiredCoreSurfaces.map((surface) => surface.id));
  for (const duplicate of duplicateValues(manifest.capabilities)) {
    failures.push(`core capability ${duplicate} is duplicated in the web manifest`);
  }
  for (const duplicate of duplicateValues(manifest.surfaces.map((surface) => surface.id))) {
    failures.push(`core surface ${duplicate} is duplicated in the web manifest`);
  }
  for (const capability of boundary.requiredCoreCapabilities) {
    if (!capabilityIds.has(capability)) failures.push(`core capability ${capability} is missing from the web manifest`);
  }
  for (const capability of manifest.capabilities) {
    if (!boundary.requiredCoreCapabilities.includes(capability)) {
      failures.push(`web manifest capability ${capability} is not in product-boundary.json`);
    }
  }
  for (const requiredSurface of boundary.requiredCoreSurfaces) {
    const implementedSurface = surfacesById.get(requiredSurface.id);
    if (!implementedSurface) {
      failures.push(`core surface ${requiredSurface.id} is missing from the web manifest`);
      continue;
    }
    if (implementedSurface.path !== requiredSurface.path
      || implementedSurface.capabilityId !== requiredSurface.capabilityId
      || implementedSurface.kind !== requiredSurface.kind) {
      failures.push(`core surface ${requiredSurface.id} does not match product-boundary.json`);
    }
  }
  for (const surface of manifest.surfaces) {
    if (!requiredSurfaceIds.has(surface.id)) {
      failures.push(`web manifest surface ${surface.id} is not in product-boundary.json`);
    }
    if (!capabilityIds.has(surface.capabilityId)) {
      failures.push(`core surface ${surface.id} references unknown capability ${surface.capabilityId}`);
    }
  }
  const routePaths = new Set(manifest.surfaces
    .filter((surface) => surface.kind === 'route')
    .map((surface) => surface.path));
  for (const navigation of manifest.navigation) {
    if (!routePaths.has(navigation.to)) {
      failures.push(`core navigation ${navigation.id} targets unknown route ${navigation.to}`);
    }
  }
  return failures;
}

const paidCapabilityPatterns = [
  /\b(role[-_ ]?based|user[-_ ]?roles?|member[-_ ]?roles?|role[-_ ]?(assignment|binding|policy|management))\b/i,
  /\b(?:role|Role)s?(?=[-_ A-Z]|$)/,
  /\brbac/i,
  /\b(?:team|Team)s?(?=[-_ A-Z]|$)/,
  /\bbilling/i,
  /\bpermissions?/i,
];
const enterpriseImplementationTerms = /\b(auth0|oidc|stripe)\b/i;

export function findImplementationBoundaryFailures(files: readonly ImplementationFile[]): string[] {
  const failures: string[] = [];
  for (const file of files) {
    if (paidCapabilityPatterns.some((pattern) => pattern.test(file.content))
      || enterpriseImplementationTerms.test(file.content)) {
      failures.push(`${file.path} crosses the OSS product boundary`);
    }
  }
  return failures;
}

function filesUnder(path: string): string[] {
  const absolute = resolve(repositoryRoot, path);
  if (!statSync(absolute).isDirectory()) return [absolute];
  const files: string[] = [];
  for (const entry of readdirSync(absolute)) {
    if (ignoredDirectories.has(entry)) continue;
    const candidate = join(absolute, entry);
    if (statSync(candidate).isDirectory()) files.push(...filesUnder(relative(repositoryRoot, candidate)));
    else if (textExtensions.has(extname(candidate))) files.push(candidate);
  }
  return files;
}

function run(): void {
  const failures: string[] = [];
  const productBoundary = parseProductBoundary(
    JSON.parse(readFileSync(resolve(repositoryRoot, 'product-boundary.json'), 'utf8')),
  );
  const coreManifest = parseCoreManifest(
    JSON.parse(readFileSync(resolve(repositoryRoot, 'packages/web-ui/src/core-manifest.json'), 'utf8')),
  );
  failures.push(...findManifestBoundaryFailures(productBoundary, coreManifest));

  const customerTerms = /kumell?o|integralads|sbi[_ -]?bid|025066246735/i;
  for (const file of filesUnder('.')) {
    if (file === fileURLToPath(import.meta.url)) continue;
    if (customerTerms.test(readFileSync(file, 'utf8'))) {
      failures.push(`${relative(repositoryRoot, file)} contains a private customer identifier`);
    }
  }

  for (const scope of ['src', 'database', 'packages/web-ui/src', 'packages/create/templates', 'openapi']) {
    const implementationFiles = filesUnder(scope)
      .map((file) => ({ path: relative(repositoryRoot, file), content: readFileSync(file, 'utf8') }))
      .filter((file) => !approvedContractFiles.has(file.path) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file.path));
    failures.push(...findImplementationBoundaryFailures(implementationFiles));
  }

  const forbiddenDependencies = [
    '@auth0/nextjs-auth0',
    'express-openid-connect',
    'stripe',
    '@mendable/firecrawl-js',
  ];
  for (const file of filesUnder('.').filter((path) => path.endsWith('package.json'))) {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const dependency of forbiddenDependencies) {
      if (dependency in dependencies) failures.push(`${relative(repositoryRoot, file)} depends on ${dependency}`);
    }
  }

  if (failures.length > 0) {
    process.stderr.write(`Public-boundary check failed:\n- ${failures.join('\n- ')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Public-boundary check passed.\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
