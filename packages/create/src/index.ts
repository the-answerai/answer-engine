#!/usr/bin/env node

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import chalk from 'chalk';
import { Command } from 'commander';
import { install } from './install.js';
import type { InstallerOptions } from './options.js';
import { uninstall } from './uninstall.js';

export function buildProgram(): Command {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return new Command()
    .name('create-answer-engine')
    .description('Install and wire a local Answer Engine in one command')
    .version(manifest.version)
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
    .option('--uninstall', 'stop and remove the local Compose stack')
    .option('--purge', 'with --uninstall, also delete volumes and AE_HOME');
}

export async function run(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  program.parse(argv);
  const options = program.opts<InstallerOptions>();
  const home = resolve(options.home ?? process.env.AE_HOME ?? join(homedir(), '.answer-engine'));

  if (options.purge && !options.uninstall) {
    throw new Error('--purge can only be used with --uninstall.');
  }
  if (options.uninstall) {
    await uninstall({ home, purge: options.purge ?? false });
    process.stdout.write(options.purge
      ? `Removed containers, volumes, and ${home}.\n`
      : `Removed containers. Data and configuration remain in ${home}.\n`);
    return;
  }
  await install({ ...options, home });
}

const invokedUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedUrl === import.meta.url) {
  run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${chalk.red('Answer Engine setup failed:')} ${message}\n`);
    process.exitCode = 1;
  });
}
