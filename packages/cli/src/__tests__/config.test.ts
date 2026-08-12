import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return { ...actual, existsSync: () => false };
});

vi.mock('os', async () => {
  const actual = await vi.importActual('os');
  return { ...actual, homedir: () => '/tmp/ae-cli-test-home' };
});

describe('CLI Config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('getConfig', () => {
    it('uses localhost when no API URL is configured', async () => {
      vi.stubEnv('ANSWER_ENGINE_API_URL', '');
      const { getConfig } = await import('../config.js');

      expect(getConfig().api_url).toBe('http://localhost:5050');
    });

    it('allows the environment to select a custom API explicitly', async () => {
      vi.stubEnv('ANSWER_ENGINE_API_URL', 'http://127.0.0.1:6060');
      const { getConfig } = await import('../config.js');

      expect(getConfig().api_url).toBe('http://127.0.0.1:6060');
    });
  });

  describe('maskApiKey', () => {
    let maskApiKey: (key: string) => string;

    beforeEach(async () => {
      const config = await import('../config.js');
      maskApiKey = config.maskApiKey;
    });

    it('returns (not set) for empty string', () => {
      expect(maskApiKey('')).toBe('(not set)');
    });

    it('returns *** for short keys', () => {
      expect(maskApiKey('ae_live_abc')).toBe('***');
    });

    it('masks middle of long keys', () => {
      expect(maskApiKey('ae_live_abcdefghijklmnop')).toBe('ae_live_...mnop');
    });
  });
});
