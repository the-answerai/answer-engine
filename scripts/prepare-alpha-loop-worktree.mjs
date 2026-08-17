#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';

const DEFAULT_STABLE_PROJECTS = [
  'answer-engine-local',
  'answer-engine-oss',
  'answer-engine-stable',
];
const DEFAULT_STABLE_PORTS = [3200, 5050, 5433, 6380];

function fail(message) {
  process.stderr.write(`[alpha-loop:prepare] ${message}\n`);
  process.exit(1);
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function splitList(value, fallback, delimiter = ',') {
  if (!value?.trim()) return fallback;
  return value.split(delimiter).map((entry) => entry.trim()).filter(Boolean);
}

function parsePorts(value) {
  return splitList(value, []).map((entry) => {
    const port = Number(entry);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      fail(`invalid stable port: ${entry}`);
    }
    return port;
  });
}

function commonRepositoryRoot(commonDirectory) {
  const marker = `${sep}.git${sep}worktrees${sep}`;
  const markerIndex = commonDirectory.indexOf(marker);
  if (markerIndex >= 0) return commonDirectory.slice(0, markerIndex);
  if (basename(commonDirectory) === '.git') return dirname(commonDirectory);
  fail(`cannot resolve common repository root from ${commonDirectory}`);
}

function pathsOverlap(left, right) {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  const nested = (value) => value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
  return nested(leftToRight) || nested(rightToLeft);
}

function replacePrivateFile(path, content) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) unlinkSync(path);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function createPrivateDirectory(path) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    fail(`refusing symbolic-link staging directory: ${path}`);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function readOrCreateCredentials(runtimeDirectory) {
  const credentialsPath = join(runtimeDirectory, 'credentials.json');
  if (existsSync(credentialsPath)) {
    if (lstatSync(credentialsPath).isSymbolicLink()) {
      fail(`refusing symbolic-link staging credentials file: ${credentialsPath}`);
    }
    const parsed = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    if (
      typeof parsed.databasePassword !== 'string'
      || typeof parsed.apiKey !== 'string'
      || typeof parsed.tenantId !== 'string'
    ) {
      fail(`invalid staging credentials file: ${credentialsPath}`);
    }
    return parsed;
  }

  const credentials = {
    databasePassword: randomBytes(24).toString('base64url'),
    apiKey: `ae_live_${randomBytes(24).toString('base64url')}`,
    tenantId: randomUUID(),
  };
  replacePrivateFile(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`);
  return credentials;
}

async function assertPortAvailable(port) {
  await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once('error', (error) => rejectPromise(error));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close((error) => error ? rejectPromise(error) : resolvePromise());
    });
  });
}

function composeProjectOwnsPort(project, worktree, port) {
  try {
    const ids = execFileSync('docker', [
      'ps', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.ID}}',
    ], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
    if (ids.length === 0) return false;
    const containers = JSON.parse(execFileSync('docker', ['inspect', ...ids], { encoding: 'utf8' }));
    const expectedConfig = resolve(worktree, 'docker-compose.yml');
    return containers.some((container) => {
      const labels = container?.Config?.Labels ?? {};
      const configFiles = String(labels['com.docker.compose.project.config_files'] ?? '')
        .split(',').map((path) => resolve(path.trim())).filter(Boolean);
      const bindings = Object.values(container?.NetworkSettings?.Ports ?? {}).flatMap((value) => value ?? []);
      return container?.State?.Running === true
        && labels['com.docker.compose.project'] === project
        && resolve(String(labels['com.docker.compose.project.working_dir'] ?? '')) === worktree
        && configFiles.includes(expectedConfig)
        && bindings.some((binding) => Number(binding?.HostPort) === port);
    });
  } catch {
    return false;
  }
}

const worktreeRoot = resolve(git(['rev-parse', '--show-toplevel'], process.cwd()));
const commonDirectory = resolve(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktreeRoot));
const repositoryRoot = commonRepositoryRoot(commonDirectory);
const worktreeRelativePath = relative(repositoryRoot, worktreeRoot);
const branch = git(['branch', '--show-current'], worktreeRoot);

if (!worktreeRelativePath.startsWith(`.worktrees${sep}`)) {
  fail(`refusing to prepare non-Alpha-Loop checkout: ${worktreeRoot}`);
}
if (!branch.startsWith('session/epic-') && !branch.startsWith('agent/issue-')) {
  fail(`refusing to prepare unexpected worktree branch: ${branch || '(detached)'}`);
}

const identity = createHash('sha256').update(worktreeRoot).digest('hex').slice(0, 12);
const numericSeed = Number.parseInt(identity.slice(0, 8), 16) % 900;
const composeProject = `answer-engine-alpha-${identity}`;
const runtimeDirectory = join(worktreeRoot, '.alpha-loop-runtime');
const stagingHome = join(runtimeDirectory, 'home');
const ports = {
  api: 15_000 + numericSeed,
  database: 16_000 + numericSeed,
  redis: 17_000 + numericSeed,
  web: 18_000 + numericSeed,
  mcp: 19_000 + numericSeed,
};

const stableProjects = new Set([
  ...DEFAULT_STABLE_PROJECTS,
  ...splitList(process.env.AE_ALPHA_STABLE_COMPOSE_PROJECTS, []),
]);
if (stableProjects.has(composeProject)) {
  fail(`staging Compose project collides with stable project: ${composeProject}`);
}

const stableHomes = splitList(
  process.env.AE_ALPHA_STABLE_HOMES,
  [],
  process.platform === 'win32' ? ';' : ':',
);
stableHomes.push(join(homedir(), '.answer-engine'));
if (process.env.AE_HOME?.trim()) stableHomes.push(process.env.AE_HOME.trim());
const resolvedStableHomes = new Set(stableHomes.map((path) => resolve(path)));
for (const stableHome of resolvedStableHomes) {
  if (pathsOverlap(stagingHome, stableHome)) {
    fail(`staging home overlaps stable home: ${stableHome}`);
  }
}

const stablePorts = new Set([
  ...DEFAULT_STABLE_PORTS,
  ...parsePorts(process.env.AE_ALPHA_STABLE_PORTS),
]);
for (const [name, port] of Object.entries(ports)) {
  if (stablePorts.has(port)) fail(`staging ${name} port collides with stable port: ${port}`);
  try {
    await assertPortAvailable(port);
  } catch (error) {
    if (composeProjectOwnsPort(composeProject, worktreeRoot, port)) {
      process.stdout.write(`[alpha-loop:prepare] reusing ${composeProject} on staging ${name} port ${port}\n`);
      continue;
    }
    fail(`staging ${name} port ${port} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

createPrivateDirectory(runtimeDirectory);
createPrivateDirectory(stagingHome);
createPrivateDirectory(join(runtimeDirectory, 'logs'));
createPrivateDirectory(join(runtimeDirectory, 'raw-archive'));
const credentials = readOrCreateCredentials(runtimeDirectory);

const identityLines = [
  `COMPOSE_PROJECT_NAME=${composeProject}`,
  'AE_CHANNEL=staging',
  'AE_HISTORY_SYNC_ENABLED=false',
  'ANSWER_ENGINE_SYNC_ENABLED=false',
  'DATABASE_NAME=answerengine_staging',
  'DATABASE_USER=postgres',
  `DATABASE_PASSWORD=${credentials.databasePassword}`,
  `DEFAULT_TENANT_ID=${credentials.tenantId}`,
  `ANSWER_ENGINE_API_KEY=${credentials.apiKey}`,
];

replacePrivateFile(join(worktreeRoot, '.env'), `${[
  'NODE_ENV=development',
  ...identityLines,
  `AE_HOME=${stagingHome}`,
  'HOST=127.0.0.1',
  `PORT=${ports.api}`,
  `ANSWER_ENGINE_PORT=${ports.api}`,
  `ANSWER_ENGINE_API_URL=http://127.0.0.1:${ports.api}`,
  'DATABASE_HOST=127.0.0.1',
  `DATABASE_PORT=${ports.database}`,
  `DATABASE_PORT_HOST=${ports.database}`,
  'REDIS_HOST=127.0.0.1',
  `REDIS_PORT=${ports.redis}`,
  `REDIS_PORT_HOST=${ports.redis}`,
  `WEB_UI_PORT=${ports.web}`,
  `ANSWER_ENGINE_MCP_PORT=${ports.mcp}`,
  `BASE_URL=http://127.0.0.1:${ports.api}`,
].join('\n')}\n`);
replacePrivateFile(join(worktreeRoot, '.env.compose'), `${[
  'NODE_ENV=production',
  ...identityLines,
  'HOST=0.0.0.0',
  'PORT=5000',
  `ANSWER_ENGINE_PORT=${ports.api}`,
  `BASE_URL=http://127.0.0.1:${ports.api}`,
  'DATABASE_HOST=postgres',
  'DATABASE_PORT=5432',
  `DATABASE_PORT_HOST=${ports.database}`,
  'REDIS_HOST=redis',
  'REDIS_PORT=6379',
  `REDIS_PORT_HOST=${ports.redis}`,
  'AUTH_MODE=api_key',
  'LOCAL_UI_AUTO_AUTH=true',
  'AE_HOME=/data',
  'STORAGE_DRIVER=local',
  'RERANK_ENABLED=false',
].join('\n')}\n`);

replacePrivateFile(join(runtimeDirectory, 'bootstrap.json'), `${JSON.stringify({
  channel: 'staging',
  composeProject,
  worktreeRoot,
  stagingHome,
  ports,
  historySyncEnabled: false,
}, null, 2)}\n`);

process.stdout.write(
  `[alpha-loop:prepare] isolated staging runtime ${composeProject} `
  + `(api ${ports.api}, db ${ports.database}, redis ${ports.redis}, web ${ports.web}, mcp ${ports.mcp})\n`,
);
