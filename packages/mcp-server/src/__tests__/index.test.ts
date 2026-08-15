import { describe, expect, it } from 'vitest';
import { DEFAULT_API_URL, resolveRuntimeConfig, resolveTransportMode } from '../index.js';

describe('MCP entrypoint transport selection', () => {
  it('defaults to the local API URL', () => {
    expect(resolveRuntimeConfig(['node', 'index.js'], {}).apiUrl).toBe(DEFAULT_API_URL);
    expect(DEFAULT_API_URL).toBe('http://localhost:5050');
  });

  it('allows env to override the API URL and default library', () => {
    expect(
      resolveRuntimeConfig(['node', 'index.js'], {
        ANSWER_ENGINE_API_URL: 'http://127.0.0.1:6060',
        ANSWER_ENGINE_LIBRARY: 'personal-memory',
        ANSWER_ENGINE_CLIENT_ID: 'claude-code',
      })
    ).toMatchObject({
      apiUrl: 'http://127.0.0.1:6060',
      library: 'personal-memory',
      clientId: 'claude-code',
    });
  });

  it('rejects an unknown audited client identity', () => {
    expect(() => resolveRuntimeConfig(['node', 'index.js'], { ANSWER_ENGINE_CLIENT_ID: 'unknown' })).toThrow();
  });

  it('defaults to stdio transport', () => {
    expect(resolveTransportMode(['node', 'index.js'], {})).toBe('stdio');
  });

  it('enables HTTP transport from env or CLI flag', () => {
    expect(
      resolveTransportMode(['node', 'index.js'], { ANSWER_ENGINE_MCP_TRANSPORT: 'http' })
    ).toBe('http');
    expect(resolveTransportMode(['node', 'index.js', '--transport=http'], {})).toBe('http');
    expect(resolveTransportMode(['node', 'index.js', '--transport', 'streamable-http'], {})).toBe(
      'http'
    );
  });
});
