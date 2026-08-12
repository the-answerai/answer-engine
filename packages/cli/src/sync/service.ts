import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { logsDir, resolveAeHome } from '../home.js';

export const SERVICE_LABEL = 'ai.answer-engine.sync';
export const SYSTEMD_UNIT_NAME = 'answer-engine-sync.service';

export type ServicePlatform = 'darwin' | 'linux';

export interface ServiceTarget {
  platform: ServicePlatform;
  unitPath: string;
}

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type ServiceCommandRunner = (
  command: string,
  args: readonly string[],
) => CommandResult;

export interface ServiceStatus extends ServiceTarget {
  installed: boolean;
  running: boolean;
  enabled: boolean;
  detail: string;
}

interface ServiceBaseOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  xdgConfigHome?: string;
  aeHome?: string;
  runner?: ServiceCommandRunner;
}

interface ServiceInstallOptions extends ServiceBaseOptions {
  nodePath?: string;
  scriptPath?: string;
}

interface ServiceStatusOptions extends ServiceBaseOptions {
  userId?: number;
}

interface ServiceTemplateOptions {
  nodePath: string;
  scriptPath: string;
  aeHome: string;
  logDir: string;
}

interface LaunchdTemplateOptions extends ServiceTemplateOptions {
  workingDir: string;
}

export class ServicePlatformError extends Error {
  constructor(platform: NodeJS.Platform) {
    super(`Background sync services are supported on macOS and Linux only (received ${platform})`);
    this.name = 'ServicePlatformError';
  }
}

export class ServiceCommandError extends Error {
  constructor(action: string, result: CommandResult) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    super(`Unable to ${action}: ${detail}`);
    this.name = 'ServiceCommandError';
  }
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

export const defaultServiceCommandRunner: ServiceCommandRunner = (command, args) => {
  try {
    const stdout = execFileSync(command, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const commandError = error as NodeJS.ErrnoException & {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    const commandMissing = commandError.code === 'ENOENT';
    return {
      status: commandMissing ? 127 : commandError.status ?? 1,
      stdout: outputText(commandError.stdout),
      stderr: commandMissing
        ? `${command}: command not found`
        : outputText(commandError.stderr) || commandError.message,
    };
  }
};

export function resolveServiceTargets(
  platform: NodeJS.Platform,
  homeDir: string,
  xdgConfigHome: string | undefined = process.env.XDG_CONFIG_HOME,
): ServiceTarget {
  if (platform === 'darwin') {
    return {
      platform,
      unitPath: join(homeDir, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`),
    };
  }
  if (platform === 'linux') {
    return {
      platform,
      unitPath: join(xdgConfigHome || join(homeDir, '.config'), 'systemd', 'user', SYSTEMD_UNIT_NAME),
    };
  }
  throw new ServicePlatformError(platform);
}

export function resolveDaemonInvocation(options: {
  nodePath?: string;
  scriptPath?: string;
} = {}): { nodePath: string; scriptPath: string } {
  const scriptPath = options.scriptPath ?? process.argv[1];
  if (!scriptPath) {
    throw new Error('Unable to resolve the ae CLI entrypoint for the sync service');
  }
  return {
    nodePath: resolve(options.nodePath ?? process.execPath),
    scriptPath: resolve(scriptPath),
  };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function systemdEscape(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
    .replaceAll('%', '%%');
}

function systemdQuote(value: string): string {
  return `"${systemdEscape(value)}"`;
}

function systemdPathValue(value: string): string {
  return systemdEscape(value);
}

export function renderLaunchdPlist(options: LaunchdTemplateOptions): string {
  const strings = [options.nodePath, options.scriptPath, 'sync', 'run']
    .map((value) => `      <string>${xmlEscape(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${strings}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(options.workingDir)}</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(join(options.logDir, 'sync.out.log'))}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(join(options.logDir, 'sync.err.log'))}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>AE_HOME</key>
      <string>${xmlEscape(options.aeHome)}</string>
    </dict>
</dict>
</plist>
`;
}

export function renderSystemdUnit(options: ServiceTemplateOptions): string {
  const invocation = [options.nodePath, options.scriptPath, 'sync', 'run']
    .map(systemdQuote)
    .join(' ');
  return `[Unit]
Description=Answer Engine sync daemon
After=network.target

[Service]
Type=simple
ExecStart=${invocation}
Environment=${systemdQuote(`AE_HOME=${options.aeHome}`)}
WorkingDirectory=${systemdQuote(options.aeHome)}
Restart=always
RestartSec=5
StandardOutput=append:${systemdPathValue(join(options.logDir, 'sync.out.log'))}
StandardError=append:${systemdPathValue(join(options.logDir, 'sync.err.log'))}

[Install]
WantedBy=default.target
`;
}

function resolveOptions(options: ServiceBaseOptions): {
  target: ServiceTarget;
  aeHome: string;
  logDir: string;
  runner: ServiceCommandRunner;
} {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const aeHome = options.aeHome ?? resolveAeHome();
  return {
    target: resolveServiceTargets(platform, homeDir, options.xdgConfigHome),
    aeHome,
    logDir: options.aeHome ? join(aeHome, 'logs') : logsDir(),
    runner: options.runner ?? defaultServiceCommandRunner,
  };
}

function requireSuccess(action: string, result: CommandResult): void {
  if (result.status !== 0) throw new ServiceCommandError(action, result);
}

export function installService(options: ServiceInstallOptions = {}): ServiceTarget {
  const { target, aeHome, logDir, runner } = resolveOptions(options);
  const invocation = resolveDaemonInvocation(options);
  mkdirSync(logDir, { recursive: true });
  mkdirSync(dirname(target.unitPath), { recursive: true });

  const contents = target.platform === 'darwin'
    ? renderLaunchdPlist({ ...invocation, aeHome, logDir, workingDir: aeHome })
    : renderSystemdUnit({ ...invocation, aeHome, logDir });
  writeFileSync(target.unitPath, contents, { encoding: 'utf8', mode: 0o600 });
  chmodSync(target.unitPath, 0o600);

  if (target.platform === 'darwin') {
    runner('launchctl', ['unload', target.unitPath]);
    requireSuccess(
      'load the launchd sync service',
      runner('launchctl', ['load', '-w', target.unitPath]),
    );
  } else {
    requireSuccess(
      'reload systemd user services',
      runner('systemctl', ['--user', 'daemon-reload']),
    );
    requireSuccess(
      'enable the systemd sync service',
      runner('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME]),
    );
  }
  return target;
}

export function uninstallService(options: ServiceBaseOptions = {}): ServiceTarget {
  const { target, runner } = resolveOptions(options);
  if (!existsSync(target.unitPath)) return target;

  if (target.platform === 'darwin') {
    runner('launchctl', ['unload', '-w', target.unitPath]);
    rmSync(target.unitPath, { force: true });
  } else {
    requireSuccess(
      'disable the systemd sync service',
      runner('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME]),
    );
    rmSync(target.unitPath, { force: true });
    requireSuccess(
      'reload systemd user services',
      runner('systemctl', ['--user', 'daemon-reload']),
    );
  }
  return target;
}

function commandUnavailable(result: CommandResult): boolean {
  return result.status === 127 || /command not found|ENOENT/i.test(result.stderr);
}

function launchdDetail(output: string): string {
  const state = output.match(/\bstate\s*=\s*([^\n]+)/)?.[1]?.trim() ?? 'loaded';
  const pid = output.match(/\bpid\s*=\s*(\d+)/)?.[1];
  const lastExit = output.match(/\blast exit code\s*=\s*(-?\d+)/)?.[1];
  const details = [pid ? `pid ${pid}` : undefined, lastExit ? `last exit ${lastExit}` : undefined]
    .filter((value): value is string => value !== undefined);
  return details.length > 0 ? `${state} (${details.join(', ')})` : state;
}

export function queryServiceStatus(options: ServiceStatusOptions = {}): ServiceStatus {
  const { target, runner } = resolveOptions(options);
  const installed = existsSync(target.unitPath);
  if (!installed) {
    return { ...target, installed, running: false, enabled: false, detail: 'not installed' };
  }

  if (target.platform === 'darwin') {
    const userId = options.userId ?? process.getuid?.();
    const serviceTarget = userId === undefined ? `user/${SERVICE_LABEL}` : `gui/${userId}/${SERVICE_LABEL}`;
    const result = runner('launchctl', ['print', serviceTarget]);
    if (commandUnavailable(result)) {
      return { ...target, installed, running: false, enabled: false, detail: 'launchctl unavailable' };
    }
    const running = result.status === 0 && /\bstate\s*=\s*running\b/.test(result.stdout);
    return {
      ...target,
      installed,
      running,
      enabled: result.status === 0,
      detail: result.status === 0 ? launchdDetail(result.stdout) : 'installed but not loaded',
    };
  }

  const active = runner('systemctl', ['--user', 'is-active', SYSTEMD_UNIT_NAME]);
  const enabled = runner('systemctl', ['--user', 'is-enabled', SYSTEMD_UNIT_NAME]);
  if (commandUnavailable(active) || commandUnavailable(enabled)) {
    return { ...target, installed, running: false, enabled: false, detail: 'systemctl unavailable' };
  }
  const activeDetail = active.stdout.trim() || 'inactive';
  const enabledDetail = enabled.stdout.trim() || 'disabled';
  return {
    ...target,
    installed,
    running: active.status === 0 && activeDetail === 'active',
    enabled: enabled.status === 0 && enabledDetail === 'enabled',
    detail: `${activeDetail}, ${enabledDetail}`,
  };
}
