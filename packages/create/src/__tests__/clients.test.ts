import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIENT_IDS,
  capabilityForClient,
  defaultNonInteractiveClients,
  detectAgentClients,
  parseClientSelection,
} from '../clients.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('agent client capability matrix', () => {
  it('keeps surface, execution mode, packaging, access, and verification explicit', () => {
    expect(CLIENT_IDS).toEqual([
      'codex',
      'chatgpt-desktop',
      'chatgpt-work',
      'chatgpt-web',
      'claude-code',
      'claude-desktop',
      'claude-cowork',
      'cursor',
    ]);
    expect(capabilityForClient('codex')).toMatchObject({
      surface: 'codex', execution: 'local', localhost: true,
      packaging: 'plugin', access: 'stdio-mcp', verification: 'command', supported: true,
    });
    expect(capabilityForClient('claude-code')).toMatchObject({
      surface: 'claude-code', execution: 'local', packaging: 'plugin',
      access: 'stdio-mcp', verification: 'command', supported: true,
    });
    expect(capabilityForClient('chatgpt-web')).toMatchObject({
      execution: 'remote', localhost: false, access: 'remote-mcp', supported: false,
    });
    expect(capabilityForClient('chatgpt-desktop')).toMatchObject({
      execution: 'local', localhost: true, packaging: 'plugin',
      access: 'stdio-mcp', verification: 'guided', supported: true,
    });
    expect(capabilityForClient('claude-cowork', 'remote').limitation).toMatch(/cannot reach localhost/i);
    expect(capabilityForClient('claude-cowork', 'local')).toMatchObject({
      execution: 'local', localhost: true, packaging: 'none',
      verification: 'unavailable', supported: false,
    });
    expect(capabilityForClient('claude-desktop', 'unknown', true)).toMatchObject({
      execution: 'local', localhost: false, packaging: 'none', access: 'none',
      verification: 'unavailable', supported: false,
    });
    const wslLimitation = capabilityForClient('chatgpt-desktop', 'unknown', true).limitation;
    expect(wslLimitation).toMatch(/wsl2/i);
    expect(wslLimitation).toMatch(/windows host/i);
  });

  it('automatically selects only clients that can be verified without a prompt', () => {
    const detected = [
      capabilityForClient('codex'),
      capabilityForClient('chatgpt-desktop'),
      capabilityForClient('chatgpt-web'),
      capabilityForClient('claude-code'),
    ];

    expect(defaultNonInteractiveClients(detected)).toEqual(['codex', 'claude-code']);
  });

  it('detects all applicable installed surfaces without pretending web is locally detectable', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'ae-clients-'));
    tempDirs.push(homeDir);
    mkdirSync(join(homeDir, '.codex'), { recursive: true });
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    mkdirSync(join(homeDir, '.cursor'), { recursive: true });
    mkdirSync(join(homeDir, 'Library', 'Application Support', 'Claude'), { recursive: true });

    const detected = detectAgentClients({
      homeDir,
      platform: 'darwin',
      commandExists: (command) => command === 'codex' || command === 'claude',
      applicationExists: (name) => name === 'ChatGPT.app' || name === 'Claude.app',
    });

    expect(detected.map((client) => client.id)).toEqual([
      'codex', 'chatgpt-desktop', 'claude-code', 'claude-desktop', 'claude-cowork', 'cursor',
    ]);
    expect(detected.find((client) => client.id === 'claude-cowork')).toMatchObject({
      supported: false,
      limitation: expect.stringMatching(/choose local or remote/i),
    });
  });

  it('parses the client-oriented selection and keeps --agents compatible', () => {
    expect(parseClientSelection('codex,claude-code,codex')).toEqual(['codex', 'claude-code']);
    expect(parseClientSelection('none')).toEqual([]);
    expect(() => parseClientSelection('graphify')).toThrow(/unknown client/i);
  });
});
