import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runLifecycleAction: vi.fn(),
  validateRuntimeChannelIsolation: vi.fn(),
}));

vi.mock('@answer-engine/create/lifecycle', () => ({
  runLifecycleAction: mocks.runLifecycleAction,
}));
vi.mock('@answer-engine/create/runtime-channel', () => ({
  createRuntimeChannelProfile: (channel: 'stable' | 'staging', options?: { home?: string }) => ({
    channel,
    home: options?.home ?? `/home/${channel}`,
    logsDir: `${options?.home ?? `/home/${channel}`}/logs`,
  }),
  channelProfiles: () => [{ channel: 'stable' }, { channel: 'staging' }],
  validateRuntimeChannelIsolation: mocks.validateRuntimeChannelIsolation,
}));

import { FixtureRuntimeController, LocalRuntimeController } from '../runtime-controller.js';

const lifecycleStatus = (channel: 'stable' | 'staging') => ({
  channel,
  home: `/home/${channel}`,
  composeProject: `answer-engine-${channel}`,
  apiUrl: channel === 'stable' ? 'http://localhost:5050' : 'http://127.0.0.1:5150',
  ports: { api: 5050, database: 5433, redis: 6380, web: 3200, mcp: 5051 },
  installed: true,
  healthy: true,
  runningServices: ['api'],
  release: 'verified-release',
  syncService: {
    launchdLabel: 'example', systemdUnit: 'example', enabledByDefault: true,
    historyAccessEnabled: false, installed: false,
  },
});

describe('LocalRuntimeController', () => {
  beforeEach(() => {
    mocks.runLifecycleAction.mockReset();
    mocks.validateRuntimeChannelIsolation.mockReset();
  });

  it('validates channel isolation and delegates only the selected action', async () => {
    mocks.runLifecycleAction
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(lifecycleStatus('staging'));
    const controller = new LocalRuntimeController();

    const status = await controller.run({ channel: 'staging', action: 'update' });

    expect(mocks.validateRuntimeChannelIsolation).toHaveBeenCalledOnce();
    expect(mocks.runLifecycleAction).toHaveBeenNthCalledWith(1, 'upgrade', expect.objectContaining({ channel: 'staging' }));
    expect(mocks.runLifecycleAction).toHaveBeenNthCalledWith(2, 'status', expect.objectContaining({ channel: 'staging' }));
    expect(status.channel).toBe('staging');
  });

  it('implements restart as guarded stop then start', async () => {
    mocks.runLifecycleAction
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(lifecycleStatus('stable'));
    await new LocalRuntimeController().run({ channel: 'stable', action: 'restart' });
    expect(mocks.runLifecycleAction).toHaveBeenNthCalledWith(1, 'stop', expect.objectContaining({ channel: 'stable' }));
    expect(mocks.runLifecycleAction).toHaveBeenNthCalledWith(2, 'start', expect.objectContaining({ channel: 'stable' }));
    expect(mocks.runLifecycleAction).toHaveBeenNthCalledWith(3, 'status', expect.objectContaining({ channel: 'stable' }));
  });
});

describe('FixtureRuntimeController', () => {
  it('changes only in-memory fixture state', async () => {
    const controller = new FixtureRuntimeController();
    expect((await controller.getStatus('stable')).healthy).toBe(true);
    expect((await controller.run({ channel: 'stable', action: 'stop' })).healthy).toBe(false);
    expect((await controller.getStatus('staging')).healthy).toBe(false);
  });
});
