#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import chalk from 'chalk';
import { Command } from 'commander';
import { install } from './install.js';
import type { InstallerOptions } from './options.js';
import { parseLifecycleAction, runLifecycleAction } from './lifecycle.js';
import {
  channelProfiles,
  createRuntimeChannelProfile,
  parseRuntimeChannel,
  validateRuntimeChannelIsolation,
} from './runtime-channel.js';

export function buildProgram(): Command {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return new Command()
    .name('create-answer-engine')
    .description('Install and wire a local Answer Engine in one command')
    .version(manifest.version)
    .argument('[action]', 'install, start, stop, status, repair, upgrade, rollback, or uninstall', 'install')
    .option('--channel <channel>', 'runtime channel: stable or staging')
    .option('-y, --yes', 'run without interactive prompts')
    .option('--models <models>', 'LM Studio models: chat=<id>,embedding=<id>')
    .option('--agents <agents>', 'agents to wire, comma-separated, or none')
    .option('--home <directory>', 'installation directory (AE_HOME)')
    .option('--lm-studio-url <url>', 'LM Studio OpenAI-compatible base URL')
    .option('--llm-provider <provider>', 'cloud chat provider: anthropic or openai')
    .option('--llm-key <key>', 'cloud chat provider API key')
    .option('--chat-model <id>', 'cloud chat model ID')
    .option('--embedding-provider <provider>', 'cloud embedding provider: openai')
    .option('--embedding-key <key>', 'OpenAI embedding API key')
    .option('--embedding-model <id>', 'embedding model ID')
    .option('--embedding-dimension <number>', 'LM Studio embedding width', '768')
    .option('--api-key <key>', 'existing local Answer Engine API key')
    .option('--image <reference>', 'pinned image reference for upgrade')
    .option('--uninstall', 'stop and remove the local Compose stack')
    .option('--purge', 'with uninstall, also delete selected-channel volumes and AE_HOME');
}

export async function run(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  program.parse(argv);
  const options = program.opts<InstallerOptions>();
  const action = parseLifecycleAction(options.uninstall ? 'uninstall' : program.args[0]);
  if (options.uninstall && program.args[0] !== 'install' && program.args[0] !== 'uninstall') {
    throw new Error('--uninstall cannot be combined with another lifecycle action.');
  }
  const channel = parseRuntimeChannel(options.channel ?? process.env.AE_CHANNEL);
  const homeOverride = options.home ?? process.env.AE_HOME;
  const profile = createRuntimeChannelProfile(channel, {
    ...(homeOverride ? { home: resolve(homeOverride) } : {}),
  });
  const home = profile.home;
  await validateRuntimeChannelIsolation(channelProfiles(channel, home));

  if (options.purge && action !== 'uninstall') {
    throw new Error('--purge can only be used with the uninstall action.');
  }
  if (options.image && action !== 'upgrade') {
    throw new Error('--image can only be used with the upgrade action.');
  }
  if (action === 'uninstall') {
    await runLifecycleAction('uninstall', profile, { purge: options.purge });
    process.stdout.write(options.purge
      ? `Removed ${channel} containers, volumes, and ${home}.\n`
      : `Removed ${channel} containers. Data and configuration remain in ${home}.\n`);
    return;
  }
  if (action === 'install') {
    await install({ ...options, channel, home });
    return;
  }
  const result = await runLifecycleAction(action, profile, { image: options.image });
  if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${channel} ${action} completed.\n`);
}

const invokedUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedUrl === import.meta.url) {
  run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${chalk.red('Answer Engine setup failed:')} ${message}\n`);
    process.exitCode = 1;
  });
}
