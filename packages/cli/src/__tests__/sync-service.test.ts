import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installService,
  queryServiceStatus,
  renderLaunchdPlist,
  renderSystemdUnit,
  resolveServiceTargets,
  uninstallService,
  type CommandResult,
  type ServiceCommandRunner,
} from '../sync/service.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'ae-sync-service-'));
  tempDirs.push(path);
  return path;
}

function result(status = 0, stdout = '', stderr = ''): CommandResult {
  return { status, stdout, stderr };
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('sync service templates', () => {
  it('renders a deterministic launchd agent with escaped paths and persistent logs', () => {
    const plist = renderLaunchdPlist({
      nodePath: '/Applications/Node & Tools/node',
      scriptPath: '/Users/Test User/answer<engine>/index.js',
      aeHome: '/Users/Test User/.answer-engine',
      logDir: '/Users/Test User/.answer-engine/logs',
      workingDir: '/Users/Test User/.answer-engine',
    });

    expect(plist).toContain('<string>ai.answer-engine.sync</string>');
    expect(plist).toContain('<string>/Applications/Node &amp; Tools/node</string>');
    expect(plist).toContain('<string>/Users/Test User/answer&lt;engine&gt;/index.js</string>');
    expect(plist).toContain('<string>sync</string>\n      <string>run</string>');
    expect(plist).toContain('<key>RunAtLoad</key>\n    <true/>');
    expect(plist).toContain('<key>KeepAlive</key>\n    <true/>');
    expect(plist).toContain('<key>AE_HOME</key>\n      <string>/Users/Test User/.answer-engine</string>');
    expect(plist).toContain('<string>/Users/Test User/.answer-engine/logs/sync.out.log</string>');
    expect(plist).toContain('<string>/Users/Test User/.answer-engine/logs/sync.err.log</string>');
    expect(plist.endsWith('\n')).toBe(true);
  });

  it('renders a systemd user unit with safely quoted invocation and restart policy', () => {
    const unit = renderSystemdUnit({
      nodePath: '/opt/Node Runtime/node',
      scriptPath: '/home/test/Answer Engine/index.js',
      aeHome: '/home/test/Answer Engine',
      logDir: '/home/test/Answer Engine/logs',
    });

    expect(unit).toContain('[Unit]\nDescription=Answer Engine sync daemon');
    expect(unit).toContain('ExecStart="/opt/Node Runtime/node" "/home/test/Answer Engine/index.js" "sync" "run"');
    expect(unit).toContain('Environment="AE_HOME=/home/test/Answer Engine"');
    expect(unit).toContain('WorkingDirectory="/home/test/Answer Engine"');
    expect(unit).toContain('Restart=always\nRestartSec=5');
    expect(unit).toContain('StandardOutput=append:/home/test/Answer Engine/logs/sync.out.log');
    expect(unit).toContain('StandardError=append:/home/test/Answer Engine/logs/sync.err.log');
    expect(unit).toContain('[Install]\nWantedBy=default.target');
    expect(unit.endsWith('\n')).toBe(true);
  });
});

describe('sync service lifecycle', () => {
  it('resolves launchd and XDG-aware systemd targets and rejects unsupported platforms', () => {
    expect(resolveServiceTargets('darwin', '/Users/test')).toEqual({
      platform: 'darwin',
      unitPath: '/Users/test/Library/LaunchAgents/ai.answer-engine.sync.plist',
    });
    expect(resolveServiceTargets('linux', '/home/test', '/custom/config')).toEqual({
      platform: 'linux',
      unitPath: '/custom/config/systemd/user/answer-engine-sync.service',
    });
    expect(() => resolveServiceTargets('win32', 'C:\\Users\\test')).toThrow(
      'Background sync services are supported on macOS and Linux only',
    );
  });

  it('installs, replaces, and uninstalls a launchd service idempotently', () => {
    const root = makeTempDir();
    const calls: Array<[string, readonly string[]]> = [];
    const runner: ServiceCommandRunner = (command, args) => {
      calls.push([command, args]);
      return result(command === 'launchctl' && args[0] === 'unload' ? 113 : 0);
    };
    const options = {
      platform: 'darwin' as const,
      homeDir: join(root, 'user'),
      aeHome: join(root, 'ae home'),
      nodePath: '/usr/local/bin/node',
      scriptPath: '/opt/answer-engine/index.js',
      runner,
    };

    const first = installService(options);
    const firstContents = readFileSync(first.unitPath, 'utf8');
    const second = installService(options);
    expect(statSync(second.unitPath).mode & 0o777).toBe(0o600);
    uninstallService(options);
    uninstallService(options);

    expect(second).toEqual(first);
    expect(firstContents).toContain('<key>KeepAlive</key>');
    expect(existsSync(second.unitPath)).toBe(false);
    expect(calls).toEqual([
      ['launchctl', ['unload', first.unitPath]],
      ['launchctl', ['load', '-w', first.unitPath]],
      ['launchctl', ['unload', first.unitPath]],
      ['launchctl', ['load', '-w', first.unitPath]],
      ['launchctl', ['unload', '-w', first.unitPath]],
    ]);
  });

  it('installs, enables, and uninstalls a systemd user service idempotently', () => {
    const root = makeTempDir();
    const calls: Array<[string, readonly string[]]> = [];
    const runner: ServiceCommandRunner = (command, args) => {
      calls.push([command, args]);
      return result();
    };
    const options = {
      platform: 'linux' as const,
      homeDir: join(root, 'user'),
      xdgConfigHome: join(root, 'xdg'),
      aeHome: join(root, 'ae'),
      nodePath: '/usr/bin/node',
      scriptPath: '/opt/answer-engine/index.js',
      runner,
    };

    const installed = installService(options);
    expect(existsSync(installed.unitPath)).toBe(true);
    expect(statSync(installed.unitPath).mode & 0o777).toBe(0o600);
    uninstallService(options);
    uninstallService(options);

    expect(existsSync(installed.unitPath)).toBe(false);
    expect(calls).toEqual([
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', 'answer-engine-sync.service']],
      ['systemctl', ['--user', 'disable', '--now', 'answer-engine-sync.service']],
      ['systemctl', ['--user', 'daemon-reload']],
    ]);
  });

  it('parses manager status while keeping installation separate from liveness', () => {
    const root = makeTempDir();
    const installOptions = {
      platform: 'darwin' as const,
      homeDir: join(root, 'user'),
      aeHome: join(root, 'ae'),
      nodePath: '/usr/bin/node',
      scriptPath: '/opt/answer-engine/index.js',
      runner: (() => result()) satisfies ServiceCommandRunner,
    };
    installService(installOptions);

    const running = queryServiceStatus({
      platform: 'darwin',
      homeDir: installOptions.homeDir,
      userId: 501,
      runner: (_command, args) => args[0] === 'print'
        ? result(0, 'state = running\npid = 42\nlast exit code = 0\n')
        : result(1),
    });
    expect(running).toMatchObject({
      installed: true,
      running: true,
      enabled: true,
      detail: 'running (pid 42, last exit 0)',
    });

    const unavailable = queryServiceStatus({
      platform: 'darwin',
      homeDir: installOptions.homeDir,
      runner: () => result(127, '', 'launchctl not found'),
    });
    expect(unavailable).toMatchObject({
      installed: true,
      running: false,
      enabled: false,
      detail: 'launchctl unavailable',
    });
  });

  it('reports systemd active and enabled state independently', () => {
    const root = makeTempDir();
    const options = {
      platform: 'linux' as const,
      homeDir: join(root, 'user'),
      xdgConfigHome: join(root, 'xdg'),
      aeHome: join(root, 'ae'),
      nodePath: '/usr/bin/node',
      scriptPath: '/opt/answer-engine/index.js',
      runner: (() => result()) satisfies ServiceCommandRunner,
    };
    installService(options);

    const status = queryServiceStatus({
      platform: 'linux',
      homeDir: options.homeDir,
      xdgConfigHome: options.xdgConfigHome,
      runner: (_command, args) => args.includes('is-active')
        ? result(0, 'active\n')
        : result(1, 'disabled\n'),
    });

    expect(status).toMatchObject({
      installed: true,
      running: true,
      enabled: false,
      detail: 'active, disabled',
    });
  });
});
