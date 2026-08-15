import { describe, expect, it, vi } from 'vitest';
import { verifyClientIntegrations, verifyMemoryRoundTrip } from '../verify.js';

function response(data: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(data) } as Response;
}

describe('verifyMemoryRoundTrip', () => {
  it('proves remember, recall citation, and inspect_memory lineage over HTTP', async () => {
    const responses = [
      response({
        data: { contentIds: ['content-1'], completedItems: 1 },
      }),
      response({
        data: { results: [{ id: 'content-1' }] },
      }),
      response({
        data: {
          source: 'create-installer',
          origin: { externalId: 'create-installer:marker-1' },
          currentArtifacts: [],
          lineage: [],
        },
      }),
    ];
    const requestedUrls: string[] = [];
    const requestHeaders: Array<NonNullable<RequestInit['headers']>> = [];
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = (input, init) => {
      requestedUrls.push(String(input));
      if (init?.headers) requestHeaders.push(init.headers);
      if (typeof init?.body === 'string') {
        requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      const next = responses.shift();
      if (!next) return Promise.reject(new Error('Unexpected request'));
      return Promise.resolve(next);
    };

    const contentId = await verifyMemoryRoundTrip({
      apiKey: 'ae_live_test',
      marker: 'marker-1',
      fetchImpl,
    });

    expect(contentId).toBe('content-1');
    expect(requestedUrls).toEqual([
      'http://localhost:5050/api/v1/content/import',
      'http://localhost:5050/api/v1/agent/query',
      'http://localhost:5050/api/v1/content/content-1/lineage',
    ]);
    expect(requestHeaders[0]).toMatchObject({ 'X-AE-Surface': 'mcp' });
    expect(requestBodies[0]).toMatchObject({ options: { forceStore: true } });
  });

  it('fails when recall does not cite the memory that was just stored', async () => {
    const responses = [
      response({
        data: { contentIds: ['content-1'], completedItems: 1 },
      }),
      response({ data: { results: [] } }),
    ];
    const fetchImpl: typeof fetch = () => {
      const next = responses.shift();
      if (!next) return Promise.reject(new Error('Unexpected request'));
      return Promise.resolve(next);
    };

    await expect(verifyMemoryRoundTrip({
      apiKey: 'ae_live_test',
      marker: 'marker-2',
      fetchImpl,
    })).rejects.toThrow('did not cite remembered content content-1');
  });
});

describe('verifyClientIntegrations', () => {
  it('requires real recall tool evidence from Codex and Claude Code command output', async () => {
    const runCommand = vi.fn(async (command: string) => ({
      stdout: command === 'codex'
        ? '{"type":"item.completed","item":{"type":"mcp_tool_call","server":"answer-engine","tool":"recall","result":"marker-unique content-1"}}\n'
        : [
          '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-1","name":"mcp__answer-engine__recall"}]}}',
          '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"marker-unique content-1"}]}}',
        ].join('\n'),
      stderr: '',
    }));

    const results = await verifyClientIntegrations({
      clients: ['codex', 'claude-code'], marker: 'marker-unique', contentId: 'content-1', runCommand,
    });

    expect(results).toEqual([
      { client: 'codex', status: 'passed', detail: 'Verified a real recall tool call.' },
      { client: 'claude-code', status: 'passed', detail: 'Verified a real recall tool call.' },
    ]);
    expect(runCommand.mock.calls[0]?.[0]).toBe('codex');
    expect(runCommand.mock.calls[1]?.[0]).toBe('claude');
  });

  it('rejects a plausible answer without recall tool evidence', async () => {
    await expect(verifyClientIntegrations({
      clients: ['codex'], marker: 'marker-unique', contentId: 'content-1',
      runCommand: async () => ({ stdout: 'marker-unique content-1', stderr: '' }),
    })).rejects.toThrow(/did not show an Answer Engine recall tool call/i);
  });

  it('rejects prose that merely imitates serialized tool-event vocabulary', async () => {
    await expect(verifyClientIntegrations({
      clients: ['codex'], marker: 'marker-unique', contentId: 'content-1',
      runCommand: async () => ({
        stdout: 'I saw an mcp_tool_call for answer-engine recall with marker-unique content-1.',
        stderr: '',
      }),
    })).rejects.toThrow(/did not show an Answer Engine recall tool call/i);
  });

  it('rejects a recall event when only unrelated output echoes the expected memory', async () => {
    await expect(verifyClientIntegrations({
      clients: ['codex'], marker: 'marker-unique', contentId: 'content-1',
      runCommand: async () => ({
        stdout: [
          '{"type":"item.completed","item":{"type":"mcp_tool_call","server":"answer-engine","tool":"recall","result":"no matches"}}',
          '{"type":"item.completed","item":{"type":"agent_message","text":"marker-unique content-1"}}',
        ].join('\n'),
        stderr: '',
      }),
    })).rejects.toThrow(/did not show an Answer Engine recall tool call/i);
  });

  it('rejects a Claude recall result from a different tool invocation', async () => {
    await expect(verifyClientIntegrations({
      clients: ['claude-code'], marker: 'marker-unique', contentId: 'content-1',
      runCommand: async () => ({
        stdout: [
          '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"recall-1","name":"mcp__answer-engine__recall"}]}}',
          '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"other-1","content":"marker-unique content-1"}]}}',
        ].join('\n'),
        stderr: '',
      }),
    })).rejects.toThrow(/did not show an Answer Engine recall tool call/i);
  });

  it('requires explicit guided confirmation for GUI-only supported clients', async () => {
    await expect(verifyClientIntegrations({
      clients: ['claude-desktop'], marker: 'marker-unique', contentId: 'content-1',
    })).rejects.toThrow(/interactive verification is required/i);
    const prompt = {
      input: vi.fn(), secret: vi.fn(), select: vi.fn(), confirm: vi.fn(async () => true),
    };
    await expect(verifyClientIntegrations({
      clients: ['claude-desktop'], marker: 'marker-unique', contentId: 'content-1', prompt,
    })).resolves.toEqual([
      { client: 'claude-desktop', status: 'passed', detail: 'User confirmed the guided recall challenge.' },
    ]);
  });

  it('records honest unavailable explanations for remote-only surfaces', async () => {
    const results = await verifyClientIntegrations({
      clients: ['chatgpt-web', 'claude-cowork'], coworkMode: 'remote',
      marker: 'marker-unique', contentId: 'content-1',
    });
    expect(results.every((result) => result.status === 'unavailable')).toBe(true);
    expect(results.map((result) => result.detail).join(' ')).toMatch(/remote mcp|cannot reach localhost/i);
  });

  it('does not guide a false localhost check for Windows desktop clients from WSL2', async () => {
    const results = await verifyClientIntegrations({
      clients: ['chatgpt-desktop', 'claude-desktop'], runningInWsl: true,
      marker: 'marker-unique', contentId: 'content-1',
    });

    expect(results.every((result) => result.status === 'unavailable')).toBe(true);
    expect(results.map((result) => result.detail).join(' ')).toMatch(/windows host/i);
  });
});
