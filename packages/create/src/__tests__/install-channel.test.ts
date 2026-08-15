import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { install } from '../install.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('stable channel adoption', () => {
  it('adds channel ownership to a legacy installer home without touching data or archives', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ae-adopt-'));
    tempDirs.push(home);
    writeFileSync(join(home, 'docker-compose.yml'), 'services: {}\n');
    writeFileSync(join(home, '.env.compose'), 'COMPOSE_PROJECT_NAME=answer-engine-local\nENCRYPTION_KEY=stable-secret\n');
    writeFileSync(join(home, 'config.yaml'), 'models: {}\n');
    writeFileSync(join(home, 'stable-database.fixture'), 'database unchanged');
    writeFileSync(join(home, 'stable-archive.fixture'), 'archive unchanged');
    const messages: string[] = [];

    await install({ channel: 'stable', home }, { write: (message) => messages.push(message) });

    expect(existsSync(join(home, '.runtime-channel.json'))).toBe(true);
    expect(readFileSync(join(home, '.env.compose'), 'utf8')).toContain('AE_CHANNEL=stable');
    expect(readFileSync(join(home, 'stable-database.fixture'), 'utf8')).toBe('database unchanged');
    expect(readFileSync(join(home, 'stable-archive.fixture'), 'utf8')).toBe('archive unchanged');
    expect(messages.join('\n')).toContain('without restarting or changing data');
  });
});
