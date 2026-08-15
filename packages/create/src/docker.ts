import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner } from './process.js';
import { runCommand as defaultRunCommand } from './process.js';
import { createRuntimeChannelProfile, type RuntimeChannelProfile } from './runtime-channel.js';

export interface DockerDependencies {
  runCommand?: CommandRunner;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  healthAttempts?: number;
}

function composeArgs(home: string, args: string[]): string[] {
  return [
    'compose',
    '--project-directory', home,
    '--env-file', join(home, '.env.compose'),
    '-f', join(home, 'docker-compose.yml'),
    ...args,
  ];
}

export function extractApiKey(logs: string): string | undefined {
  return logs.match(/(?:^|\s)ANSWER_ENGINE_API_KEY=(ae_[^\s]+)/m)?.[1];
}

export function persistApiKey(envPath: string, apiKey: string): void {
  const assignment = `ANSWER_ENGINE_API_KEY=${apiKey}`;
  const existing = readFileSync(envPath, 'utf8');
  const lines = existing.split(/\r?\n/);
  const output: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (/^\s*ANSWER_ENGINE_API_KEY\s*=/.test(line)) {
      if (!replaced) output.push(assignment);
      replaced = true;
    } else {
      output.push(line);
    }
  }
  while (output.at(-1) === '') output.pop();
  if (!replaced) output.push(assignment);
  writeFileSync(envPath, `${output.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(envPath, 0o600);
}

export async function activateApiKey(
  home: string,
  envPath: string,
  apiKey: string,
  dependencies: DockerDependencies = {},
  profile: RuntimeChannelProfile = createRuntimeChannelProfile('stable', { home }),
): Promise<void> {
  persistApiKey(envPath, apiKey);
  const command = dependencies.runCommand ?? defaultRunCommand;
  await command('docker', composeArgs(home, ['up', '-d', '--force-recreate', 'api']));
  await waitForHealth(
    dependencies.fetchImpl ?? fetch,
    dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    dependencies.healthAttempts ?? 180,
    profile.apiUrl,
  );
}

export async function detectOwnedPorts(
  home: string,
  dependencies: Pick<DockerDependencies, 'runCommand'> = {},
  profile: RuntimeChannelProfile = createRuntimeChannelProfile('stable', { home }),
): Promise<Set<number>> {
  const owned = new Set<number>();
  if (!existsSync(join(home, 'docker-compose.yml'))) return owned;
  try {
    const command = dependencies.runCommand ?? defaultRunCommand;
    const { stdout } = await command('docker', composeArgs(home, [
      'ps', '--services', '--status', 'running',
    ]));
    const services = new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    if (services.has('api')) owned.add(profile.ports.api);
    if (services.has('postgres')) owned.add(profile.ports.database);
    if (services.has('redis')) owned.add(profile.ports.redis);
  } catch {
    // Preflight will produce the actionable Docker failure. A stale home does
    // not grant ownership of occupied ports.
  }
  return owned;
}

async function waitForHealth(
  fetchImpl: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
  attempts: number,
  apiUrl = 'http://127.0.0.1:5050',
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${apiUrl}/health`);
      if (response.ok) return;
    } catch {
      // The API is expected to refuse connections while Compose starts.
    }
    if (attempt + 1 < attempts) await sleep(1_000);
  }
  throw new Error(`Answer Engine did not become healthy at ${apiUrl}/health.`);
}

export async function startStack(
  home: string,
  dependencies: DockerDependencies = {},
  profile: RuntimeChannelProfile = createRuntimeChannelProfile('stable', { home }),
): Promise<string | undefined> {
  const command = dependencies.runCommand ?? defaultRunCommand;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep = dependencies.sleep
    ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  await command('docker', composeArgs(home, ['up', '-d', '--remove-orphans']));
  try {
    await waitForHealth(fetchImpl, sleep, dependencies.healthAttempts ?? 180, profile.apiUrl);
  } catch (error) {
    const diagnostics = await command('docker', composeArgs(home, [
      'logs', '--no-color', '--tail', '100', 'migrate', 'init', 'api',
    ])).then((result) => result.stdout).catch(() => 'Unable to read Compose logs.');
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n\nCompose diagnostics:\n${diagnostics}`);
  }
  const logs = await command('docker', composeArgs(home, [
    'logs', '--no-color', '--no-log-prefix', 'init',
  ]));
  return extractApiKey(logs.stdout);
}

export function dockerComposeArgs(home: string, args: string[]): string[] {
  return composeArgs(home, args);
}
