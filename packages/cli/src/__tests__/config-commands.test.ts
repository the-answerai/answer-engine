import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerConfigCommands } from '../commands/config.js';
import { printJson, printSuccess } from '../output.js';

vi.mock('../output.js', () => ({
  printError: vi.fn(),
  printHeader: vi.fn(),
  printJson: vi.fn(),
  printSuccess: vi.fn(),
}));

const originalAeHome = process.env.AE_HOME;
const tempDirs: string[] = [];

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerConfigCommands(program);
  return program;
}

function writeValidConfig(): string {
  const home = mkdtempSync(join(tmpdir(), 'ae-config-command-'));
  tempDirs.push(home);
  process.env.AE_HOME = home;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.yaml'), `
models:
  chat: local-chat
  embedding: local-embedding
  chat_provider: lmstudio
  embedding_provider: lmstudio
  embedding_dimension: 768
`);
  return home;
}

describe('config commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    if (originalAeHome === undefined) delete process.env.AE_HOME;
    else process.env.AE_HOME = originalAeHome;
    process.exitCode = undefined;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registers legacy client commands and AE_HOME commands under one group', () => {
    const config = makeProgram().commands.find((command) => command.name() === 'config');

    expect(config?.commands.map((command) => command.name())).toEqual([
      'show',
      'set',
      'path',
      'validate',
      'gen-env',
    ]);
  });

  it('prints the canonical AE_HOME paths', async () => {
    const home = writeValidConfig();

    await makeProgram().parseAsync(['node', 'ae', 'config', 'path']);

    expect(printJson).toHaveBeenCalledWith(expect.objectContaining({
      home,
      config: join(home, 'config.yaml'),
      env: join(home, '.env'),
      blobs: join(home, 'blobs'),
      eval_sets: join(home, 'eval', 'sets'),
      eval_results: join(home, 'eval', 'results'),
    }));
  });

  it('validates config.yaml and generates a private .env', async () => {
    const home = writeValidConfig();
    const program = makeProgram();

    await program.parseAsync(['node', 'ae', 'config', 'validate']);
    await makeProgram().parseAsync(['node', 'ae', 'config', 'gen-env']);

    const envPath = join(home, '.env');
    expect(printSuccess).toHaveBeenCalledTimes(2);
    expect(existsSync(envPath)).toBe(true);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });
});
