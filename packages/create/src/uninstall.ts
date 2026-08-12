import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import type { CommandRunner } from './process.js';
import { runCommand as defaultRunCommand } from './process.js';
import { dockerComposeArgs } from './docker.js';

export interface UninstallOptions {
  home: string;
  purge: boolean;
}

export interface UninstallDependencies {
  runCommand?: CommandRunner;
}

function assertSafePurgeHome(home: string): string {
  const target = resolve(home);
  const forbidden = new Set([
    parse(target).root,
    resolve(homedir()),
    resolve(process.cwd()),
    resolve(dirname(process.cwd())),
  ]);
  if (forbidden.has(target)) {
    throw new Error(`Refusing to purge unsafe AE_HOME path: ${target}`);
  }
  return target;
}

export async function uninstall(
  options: UninstallOptions,
  dependencies: UninstallDependencies = {},
): Promise<void> {
  const home = resolve(options.home);
  if (!existsSync(home)) return;
  const composePath = join(home, 'docker-compose.yml');
  const installerManaged = existsSync(composePath);
  if (options.purge && !installerManaged) {
    throw new Error(
      `Refusing to purge ${home}: installer-managed docker-compose.yml was not found.`,
    );
  }
  if (installerManaged) {
    const command = dependencies.runCommand ?? defaultRunCommand;
    const args = ['down', '--remove-orphans'];
    if (options.purge) args.push('--volumes');
    await command('docker', dockerComposeArgs(home, args));
  }
  if (options.purge && existsSync(home)) {
    rmSync(assertSafePurgeHome(home), { recursive: true, force: true });
  }
}
