import { existsSync, statfsSync } from 'node:fs';
import { arch, release, totalmem } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { CommandRunner } from './process.js';
import { runCommand as defaultRunCommand } from './process.js';

export const REQUIRED_PORTS = [5050] as const;

const CheckStatusSchema = z.enum(['pass', 'warning', 'unsupported']);
const RequirementSchema = z.enum(['required', 'optional']);
const DependencyStateSchema = z.enum(['ready', 'missing', 'incompatible', 'not-applicable']);
const InstallPolicySchema = z.enum(['reuse', 'user-consent', 'manual', 'privileged', 'unsupported']);
const CheckCodeSchema = z.enum([
  'OPERATING_SYSTEM', 'ARCHITECTURE', 'MEMORY', 'DISK', 'GPU', 'NODE_VERSION',
  'DOCKER_DAEMON', 'DOCKER_COMPOSE', 'WSL2', 'MODEL_RUNTIME', 'PORTS', 'INSTALLATION',
]);
const InstallationStateSchema = z.enum(['absent', 'legacy', 'managed', 'partial']);
const SystemPlatformSchema = z.enum(['macos', 'windows-wsl2', 'windows-native', 'linux', 'other']);

export type PreflightFailureCode = z.infer<typeof CheckCodeSchema> | 'PORT_IN_USE';
export type InstallationState = z.infer<typeof InstallationStateSchema>;

export interface PreflightFailure {
  code: PreflightFailureCode;
  message: string;
  fix: string;
  port?: number;
}

const PreflightCheckSchema = z.object({
  code: CheckCodeSchema,
  label: z.string().min(1),
  status: CheckStatusSchema,
  message: z.string().min(1),
  remediation: z.string().min(1).optional(),
  blocking: z.boolean(),
  requirement: RequirementSchema,
  dependencyState: DependencyStateSchema,
  installPolicy: InstallPolicySchema,
  detectedVersion: z.string().min(1).optional(),
  proposal: z.object({
    source: z.string().url(),
    version: z.string().min(1),
    command: z.string().min(1),
    destination: z.string().min(1),
    verification: z.string().min(1),
  }).strict().optional(),
}).strict();

const PreflightResultSchema = z.object({
  status: CheckStatusSchema,
  ok: z.boolean(),
  checks: z.array(PreflightCheckSchema),
  failures: z.array(z.object({
    code: z.union([CheckCodeSchema, z.literal('PORT_IN_USE')]),
    message: z.string().min(1),
    fix: z.string().min(1),
    port: z.number().int().optional(),
  }).strict()),
  system: z.object({
    platform: SystemPlatformSchema,
    architecture: z.string().min(1),
    ramGb: z.number().nonnegative(),
    freeDiskGb: z.number().nonnegative(),
    gpu: z.object({
      kind: z.enum(['apple', 'nvidia', 'none', 'unknown']),
      vramGb: z.number().nonnegative(),
    }).strict(),
  }).strict(),
  installation: InstallationStateSchema,
}).strict();

export type PreflightCheck = z.infer<typeof PreflightCheckSchema>;
export type PreflightResult = z.infer<typeof PreflightResultSchema>;

export interface PreflightDependencies {
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  osRelease?: string;
  totalMemoryBytes?: number;
  freeDiskBytes?: number;
  home?: string;
  installation?: InstallationState;
  modelRuntimeAvailable?: boolean;
  runCommand?: CommandRunner;
  probePort?: (port: number) => Promise<boolean>;
  ownedPorts?: ReadonlySet<number>;
  requiredPorts?: readonly number[];
}

export interface DependencyRemediationDependencies {
  confirm(proposal: NonNullable<PreflightCheck['proposal']>): Promise<boolean>;
  install(proposal: NonNullable<PreflightCheck['proposal']>): Promise<void>;
  rerun(): Promise<PreflightResult>;
}

export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

const MINIMUM_NODE_VERSION = [22, 16, 0] as const;
const GB = 1024 ** 3;

function supportsNode(version: string): boolean {
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < MINIMUM_NODE_VERSION.length; index += 1) {
    const difference = (actual[index] ?? 0) - MINIMUM_NODE_VERSION[index];
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function gb(bytes: number): number {
  return Math.round((bytes / GB) * 10) / 10;
}

function availableDiskBytes(path: string): number {
  let candidate = path;
  while (!existsSync(candidate) && dirname(candidate) !== candidate) candidate = dirname(candidate);
  const stats = statfsSync(candidate);
  return Number(stats.bavail) * stats.bsize;
}

function detectPlatform(platform: NodeJS.Platform, osRelease: string): PreflightResult['system']['platform'] {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows-native';
  if (platform === 'linux' && /microsoft-standard|wsl2/i.test(osRelease)) return 'windows-wsl2';
  if (platform === 'linux') return 'linux';
  return 'other';
}

export function inspectInstallation(home: string | undefined): InstallationState {
  if (!home || !existsSync(home)) return 'absent';
  const files = ['docker-compose.yml', '.env.compose', 'config.yaml'];
  const present = files.filter((name) => existsSync(join(home, name))).length;
  const marker = existsSync(join(home, '.runtime-channel.json'));
  if (marker && present === files.length) return 'managed';
  if (!marker && present === files.length) return 'legacy';
  return present === 0 && !marker ? 'absent' : 'partial';
}

function check(
  code: PreflightCheck['code'], label: string, status: PreflightCheck['status'],
  message: string, remediation?: string, blocking = false,
  metadata: Partial<Pick<PreflightCheck, 'requirement' | 'dependencyState' | 'installPolicy' | 'detectedVersion' | 'proposal'>> = {},
): PreflightCheck {
  const optional = code === 'GPU' || code === 'MODEL_RUNTIME' || code === 'INSTALLATION';
  return PreflightCheckSchema.parse({
    code, label, status, message, ...(remediation ? { remediation } : {}), blocking,
    requirement: optional ? 'optional' : 'required',
    dependencyState: status === 'pass' ? 'ready' : status === 'unsupported' ? 'incompatible' : 'missing',
    installPolicy: status === 'pass' ? 'reuse' : status === 'unsupported' ? 'unsupported' : 'manual',
    ...metadata,
  });
}

async function commandAvailable(command: CommandRunner, name: string, args: string[]): Promise<boolean> {
  try {
    await command(name, args);
    return true;
  } catch {
    return false;
  }
}

async function commandVersion(command: CommandRunner, name: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await command(name, args);
    return result.stdout.trim() || 'available (version not reported)';
  } catch {
    return undefined;
  }
}

function nodeProposal(
  systemPlatform: PreflightResult['system']['platform'],
  architecture: string,
): PreflightCheck['proposal'] | undefined {
  const archive = systemPlatform === 'macos' && architecture === 'arm64'
    ? 'node-v22.16.0-darwin-arm64.tar.xz'
    : systemPlatform === 'windows-wsl2' && architecture === 'x64'
      ? 'node-v22.16.0-linux-x64.tar.xz' : undefined;
  const checksum = systemPlatform === 'macos'
    ? 'aaf7fc3c936f1b359bc312b63638e41f258689ac2303966ad932cda18c54ea00'
    : 'f4cb75bb036f0d0eddf6b79d9596df1aaab9ddccd6a20bf489be5abe9467e84e';
  if (!archive) return undefined;
  const source = `https://nodejs.org/dist/v22.16.0/${archive}`;
  return {
    source,
    version: '22.16.0',
    destination: '~/.local/share/answer-engine/node-v22.16.0',
    command: `download ${source}; verify SHA-256 ${checksum}; extract into ~/.local/share/answer-engine/node-v22.16.0`,
    verification: `SHA-256 ${checksum} from the official Node.js v22.16.0 SHASUMS256.txt`,
  };
}

async function detectNvidiaVram(command: CommandRunner): Promise<number> {
  try {
    const result = await command('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits']);
    const values = result.stdout.split(/\r?\n/).map(Number).filter(Number.isFinite);
    return values.length === 0 ? 0 : Math.max(...values) / 1024;
  } catch {
    return 0;
  }
}

export async function runPreflight(
  dependencies: PreflightDependencies = {},
): Promise<PreflightResult> {
  const command = dependencies.runCommand ?? defaultRunCommand;
  const nativePlatform = dependencies.platform ?? process.platform;
  const systemPlatform = detectPlatform(nativePlatform, dependencies.osRelease ?? release());
  const architecture = dependencies.architecture ?? arch();
  const ramGb = gb(dependencies.totalMemoryBytes ?? totalmem());
  const freeDiskGb = gb(dependencies.freeDiskBytes ?? availableDiskBytes(dependencies.home ?? process.cwd()));
  const installation = dependencies.installation ?? inspectInstallation(dependencies.home);
  const checks: PreflightCheck[] = [];

  const platformSupported = systemPlatform === 'macos' || systemPlatform === 'windows-wsl2';
  checks.push(check('OPERATING_SYSTEM', 'Operating system', platformSupported ? 'pass' : 'unsupported',
    platformSupported ? `${systemPlatform} is supported.` : `${systemPlatform} is not an initial supported platform.`,
    platformSupported ? undefined : 'Use Apple Silicon macOS, or Windows 11 through WSL2.'));
  const architectureSupported = (systemPlatform === 'macos' && architecture === 'arm64')
    || (systemPlatform === 'windows-wsl2' && architecture === 'x64');
  checks.push(check('ARCHITECTURE', 'Architecture', architectureSupported ? 'pass' : 'unsupported',
    architectureSupported ? `${architecture} is supported.` : `${architecture} is not supported for ${systemPlatform}.`,
    architectureSupported ? undefined : 'Use Apple Silicon on macOS or x64 within Windows 11 WSL2.'));

  const memoryStatus = ramGb >= 16 ? 'pass' : ramGb >= 8 ? 'warning' : 'unsupported';
  checks.push(check('MEMORY', 'Memory', memoryStatus, `${ramGb} GB detected.`,
    memoryStatus === 'pass' ? undefined : memoryStatus === 'warning'
      ? 'Choose the reduced-local profile or a cloud-backed profile; 16 GB is required for full local.'
      : 'Use a computer with at least 8 GB RAM; 16 GB is the supported full-local baseline.'));
  const diskStatus = freeDiskGb >= 30 ? 'pass' : freeDiskGb >= 15 ? 'warning' : 'unsupported';
  checks.push(check('DISK', 'Free disk', diskStatus, `${freeDiskGb} GB available.`,
    diskStatus === 'pass' ? undefined : diskStatus === 'warning'
      ? 'Free 30 GB for the full-local profile, or choose a smaller/cloud-backed profile.'
      : 'Free at least 15 GB before installing.'));

  const nvidiaVram = systemPlatform === 'windows-wsl2' ? await detectNvidiaVram(command) : 0;
  const gpu = systemPlatform === 'macos'
    ? { kind: 'apple' as const, vramGb: ramGb }
    : nvidiaVram > 0 ? { kind: 'nvidia' as const, vramGb: Math.round(nvidiaVram * 10) / 10 }
      : { kind: 'none' as const, vramGb: 0 };
  const gpuPass = systemPlatform === 'macos' ? ramGb >= 16 : systemPlatform === 'windows-wsl2' && gpu.vramGb >= 8;
  checks.push(check('GPU', 'GPU', gpuPass ? 'pass' : 'warning',
    gpuPass ? `${gpu.kind} GPU capacity is suitable for full local.` : 'A supported 8 GB+ GPU was not detected.',
    gpuPass ? undefined : 'Choose reduced-local/cloud-backed, or install GPU support manually using the hardware vendor instructions.',
    false, gpuPass ? {} : { installPolicy: 'privileged' }));

  const version = dependencies.nodeVersion ?? process.versions.node;
  const nodeSupported = supportsNode(version);
  const proposal = nodeSupported ? undefined : nodeProposal(systemPlatform, architecture);
  checks.push(check('NODE_VERSION', 'Node.js', nodeSupported ? 'pass' : 'warning',
    nodeSupported ? `Node.js ${version} is supported.` : `Node.js ${version} is unsupported; Answer Engine requires Node.js 22.16 or newer.`,
    nodeSupported ? undefined : proposal
      ? 'Approve the displayed official user-scoped Node.js 22.16.0 archive, or install Node.js 22.16+ manually, then rerun readiness.'
      : 'Install Node.js 22.16 or newer, then run this command again.', !nodeSupported,
    {
      detectedVersion: version,
      ...(!nodeSupported ? { dependencyState: 'incompatible' as const } : {}),
      ...(proposal ? { proposal, installPolicy: 'user-consent' as const } : {}),
    }));

  const [dockerVersion, composeVersion] = await Promise.all([
    commandVersion(command, 'docker', ['info', '--format', '{{.ServerVersion}}']),
    commandVersion(command, 'docker', ['compose', 'version', '--short']),
  ]);
  const dockerReady = dockerVersion !== undefined;
  const composeReady = composeVersion !== undefined && !/^v?1(?:\.|$)/.test(composeVersion);
  checks.push(check('DOCKER_DAEMON', 'Docker', dockerReady ? 'pass' : 'warning',
    dockerReady ? `Docker daemon ${dockerVersion} is reachable.` : 'The Docker daemon is not running or is not reachable.',
    dockerReady ? undefined : 'Install or start Docker Desktop manually, then run this command again.', !dockerReady,
    { ...(dockerVersion ? { detectedVersion: dockerVersion } : {}), ...(!dockerReady ? { installPolicy: 'privileged' as const } : {}) }));
  checks.push(check('DOCKER_COMPOSE', 'Docker Compose', composeReady ? 'pass' : 'warning',
    composeReady ? `Docker Compose ${composeVersion} is available.` : 'Docker Compose v2 is not available.',
    composeReady ? undefined : 'Install Docker Desktop or Compose v2 manually so `docker compose version --short` succeeds.', !composeReady,
    { ...(composeVersion ? { detectedVersion: composeVersion } : {}), ...(!composeReady ? { installPolicy: 'privileged' as const } : {}) }));

  const wslReady = systemPlatform === 'macos' || systemPlatform === 'windows-wsl2';
  checks.push(check('WSL2', 'WSL2', wslReady ? 'pass' : 'unsupported',
    systemPlatform === 'windows-wsl2' ? 'Windows Subsystem for Linux 2 is active.' : systemPlatform === 'macos'
      ? 'WSL2 is not required on macOS.' : 'Windows WSL2 was not detected.',
    wslReady ? undefined : 'Follow Microsoft Windows 11 WSL installation instructions, restart if requested, and enter WSL2 before continuing.',
    !wslReady, !wslReady ? { installPolicy: 'privileged' }
      : systemPlatform === 'macos' ? { dependencyState: 'not-applicable' } : {}));

  const modelRuntimeAvailable = dependencies.modelRuntimeAvailable
    ?? await commandAvailable(command, 'lms', ['version']);
  checks.push(check('MODEL_RUNTIME', 'Model runtime', modelRuntimeAvailable ? 'pass' : 'warning',
    modelRuntimeAvailable ? 'LM Studio is available.' : 'LM Studio was not detected.',
    modelRuntimeAvailable ? undefined : 'Install and start a model runtime manually, or explicitly choose a cloud-backed profile.',
    false, modelRuntimeAvailable ? {} : { installPolicy: 'manual' }));

  const probePort = dependencies.probePort ?? isPortFree;
  const ownedPorts = dependencies.ownedPorts ?? new Set<number>();
  const requiredPorts = dependencies.requiredPorts ?? REQUIRED_PORTS;
  const occupied: number[] = [];
  await Promise.all(requiredPorts.map(async (port) => {
    if (!ownedPorts.has(port) && !await probePort(port)) occupied.push(port);
  }));
  occupied.sort((left, right) => left - right);
  checks.push(check('PORTS', 'Ports', occupied.length === 0 ? 'pass' : 'warning',
    occupied.length === 0 ? `Required ports are available (${requiredPorts.join(', ')}).` : `Required ports are in use: ${occupied.join(', ')}.`,
    occupied.length === 0 ? undefined : `Stop the other process using ${occupied.join(', ')}, then run preflight again.`, occupied.length > 0));

  const installationMessage: Record<InstallationState, string> = {
    absent: 'No existing installation was found.', managed: 'An installer-managed installation was found.',
    legacy: 'A legacy installation is available for safe adoption.', partial: 'A partial installation can be resumed safely.',
  };
  checks.push(check('INSTALLATION', 'Installation', installation === 'absent' || installation === 'managed' ? 'pass' : 'warning',
    installationMessage[installation], installation === 'legacy'
      ? 'Review the detected home; the installer will add an ownership marker without changing data.'
      : installation === 'partial' ? 'Retry install or run repair; credentials and data will be preserved.' : undefined));

  const status = checks.some((item) => item.status === 'unsupported') ? 'unsupported'
    : checks.some((item) => item.status === 'warning') ? 'warning' : 'pass';
  const failures: PreflightFailure[] = [];
  for (const item of checks) {
    if (item.status === 'pass' || !item.remediation) continue;
    if (item.code === 'PORTS') {
      for (const port of occupied) failures.push({
        code: 'PORT_IN_USE', port, message: `Required port ${port} is already in use.`,
        fix: `Stop the process using port ${port}, then run this command again.`,
      });
    } else {
      failures.push({ code: item.code, message: item.message, fix: item.remediation });
    }
  }
  return PreflightResultSchema.parse({
    status, ok: !checks.some((item) => item.status === 'unsupported' || item.blocking),
    checks, failures, system: { platform: systemPlatform, architecture, ramGb, freeDiskGb, gpu }, installation,
  });
}

export function formatPreflightFailures(failures: PreflightFailure[]): string {
  return failures.map((failure) => `${failure.message}\n  Fix: ${failure.fix}`).join('\n');
}

export function formatPreflightReport(result: PreflightResult, json = false): string {
  if (json) return JSON.stringify(result, null, 2);
  const details = result.checks.map((item) => {
    const line = `[${item.status.toUpperCase()}] ${item.label} (${item.requirement}; ${item.installPolicy}): ${item.message}`;
    return item.remediation ? `${line}\n  Next: ${item.remediation}` : line;
  });
  return [`Preflight: ${result.status.toUpperCase()}`, ...details].join('\n');
}

export async function remediateSupportedDependencies(
  result: PreflightResult,
  dependencies: DependencyRemediationDependencies,
): Promise<PreflightResult> {
  const proposals = result.checks.flatMap((item) => item.installPolicy === 'user-consent' && item.proposal
    ? [item.proposal] : []);
  if (proposals.length === 0) return result;
  for (const proposal of proposals) {
    if (!await dependencies.confirm(proposal)) return result;
    await dependencies.install(proposal);
  }
  return dependencies.rerun();
}
