import { describe, expect, it, vi } from 'vitest';
import {
  recommendModelProfile,
  requireInstallConsent,
} from '../interview.js';
import type { PreflightResult } from '../preflight.js';

function report(overrides: Partial<PreflightResult> = {}): PreflightResult {
  return {
    status: 'pass',
    ok: true,
    checks: [],
    failures: [],
    system: {
      platform: 'macos',
      architecture: 'arm64',
      ramGb: 16,
      freeDiskGb: 80,
      gpu: { kind: 'apple', vramGb: 16 },
    },
    installation: 'absent',
    ...overrides,
  };
}

describe('installer interview recommendations', () => {
  it('recommends full local on supported Apple Silicon and Windows GPU baselines', () => {
    expect(recommendModelProfile(report()).id).toBe('full-local');
    expect(recommendModelProfile(report({
      system: {
        platform: 'windows-wsl2', architecture: 'x64', ramGb: 32, freeDiskGb: 100,
        gpu: { kind: 'nvidia', vramGb: 8 },
      },
    })).id).toBe('full-local');
  });

  it('offers reduced local or explicit cloud fallback for constrained hardware', () => {
    expect(recommendModelProfile(report({
      status: 'warning',
      system: { platform: 'macos', architecture: 'arm64', ramGb: 12, freeDiskGb: 20, gpu: { kind: 'apple', vramGb: 12 } },
    })).id).toBe('reduced-local');
    expect(recommendModelProfile(report({
      status: 'unsupported', ok: false,
      system: { platform: 'linux', architecture: 'x64', ramGb: 8, freeDiskGb: 20, gpu: { kind: 'none', vramGb: 0 } },
    })).id).toBe('cloud-backed');
  });

  it('cancels before mutation unless the user explicitly confirms', async () => {
    const prompt = { input: vi.fn(), secret: vi.fn(), select: vi.fn(), confirm: vi.fn(async () => false) };

    await expect(requireInstallConsent(prompt, {
      home: '/tmp/answer-engine-test', profile: 'reduced-local', agents: ['codex'],
    })).rejects.toThrow('cancelled before any changes');
  });
});
