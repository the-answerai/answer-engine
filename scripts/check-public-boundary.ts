import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ignoredDirectories = new Set(['.git', 'dist', 'node_modules']);
const textExtensions = new Set(['.css', '.html', '.json', '.md', '.sql', '.ts', '.tsx', '.yaml', '.yml']);

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

const failures: string[] = [];
const customerTerms = /kumell?o|integralads|sbi[_ -]?bid|025066246735/i;
for (const file of filesUnder('.')) {
  if (file === fileURLToPath(import.meta.url)) continue;
  if (customerTerms.test(readFileSync(file, 'utf8'))) {
    failures.push(`${relative(repositoryRoot, file)} contains a private customer identifier`);
  }
}

const paidCapabilityPatterns = [
  /\b(role[-_ ]?based|user[-_ ]?roles?|member[-_ ]?roles?|role[-_ ]?(assignment|binding|policy|management))\b/i,
  /\brbac\b/i,
  /\bteams?\b/i,
  /\bbilling\b/i,
  /\bpermissions?\b/i,
];
const enterpriseImplementationTerms = /\b(auth0|oidc|stripe)\b/i;
for (const scope of ['src', 'database', 'packages/web-ui/src', 'packages/create/templates', 'openapi']) {
  for (const file of filesUnder(scope)) {
    const content = readFileSync(file, 'utf8');
    if (paidCapabilityPatterns.some((pattern) => pattern.test(content)) || enterpriseImplementationTerms.test(content)) {
      failures.push(`${relative(repositoryRoot, file)} crosses the OSS product boundary`);
    }
  }
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
    if (dependency in dependencies) {
      failures.push(`${relative(repositoryRoot, file)} depends on ${dependency}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`Public-boundary check failed:\n- ${failures.join('\n- ')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Public-boundary check passed.\n');
}
