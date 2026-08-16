import { describe, expect, it } from 'vitest';
import type { DesktopStatus } from '../shared.js';
import { presentTrayStatus } from '../tray.js';

function status(overrides: Partial<DesktopStatus> = {}): DesktopStatus {
  return {
    channel: 'stable',
    home: '/home/stable',
    apiUrl: 'http://localhost:5050',
    installed: true,
    healthy: true,
    runningServices: ['api'],
    syncInstalled: true,
    syncEnabledByDefault: true,
    checkedAt: '2026-08-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('presentTrayStatus', () => {
  it('shows actual stable health', () => {
    expect(presentTrayStatus(status())).toEqual({
      health: 'Healthy',
      header: 'Healthy',
      tooltip: 'Answer Engine stable — Healthy',
    });
  });

  it('makes unhealthy staging status unmistakable', () => {
    expect(presentTrayStatus(status({ channel: 'staging', healthy: false }))).toEqual({
      health: 'Needs repair',
      header: 'STAGING — Needs repair',
      tooltip: 'Answer Engine staging — Needs repair',
    });
  });
});
