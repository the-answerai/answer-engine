import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entrypoint = join(packageRoot, 'src', 'index.ts');
const tempDirectories: string[] = [];
const servers: Server[] = [];

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ae-cli-entrypoint-'));
  tempDirectories.push(directory);
  return directory;
}

describe('CLI executable entrypoint', () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    await Promise.all(tempDirectories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    )));
  });

  it('waits for an asynchronous API command before exiting', async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (request.url === '/health') {
        response.end(JSON.stringify({ status: 'healthy', uptime: 1, channel: 'stable' }));
        return;
      }
      response.end(JSON.stringify({
        success: true,
        data: {
          contentTypes: {},
          tags: [],
          capabilities: ['fulltext_search'],
          dateRange: { earliest: null, latest: null },
        },
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');

    const home = await makeTempDirectory();
    const configDirectory = join(home, '.config', 'answer-engine');
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, 'config.yml'), [
      'api_key: ae_live_test',
      `api_url: http://127.0.0.1:${address.port}`,
      'default_output: auto',
      '',
    ].join('\n'), 'utf8');

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', entrypoint, 'schema'],
      {
        cwd: packageRoot,
        env: { ...process.env, HOME: home },
        timeout: 10_000,
      },
    );

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      data: { capabilities: ['fulltext_search'] },
    });
  });
});
