import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runLifecycleAction: vi.fn(),
  validateRuntimeChannelIsolation: vi.fn(),
  inspectLegacyStableInstallation: vi.fn(),
  adoptLegacyStableInstallation: vi.fn(),
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
vi.mock('@answer-engine/create/legacy-adoption', () => ({
  inspectLegacyStableInstallation: mocks.inspectLegacyStableInstallation,
  adoptLegacyStableInstallation: mocks.adoptLegacyStableInstallation,
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
    mocks.inspectLegacyStableInstallation.mockReset();
    mocks.inspectLegacyStableInstallation.mockResolvedValue({ state: 'unavailable' });
    mocks.adoptLegacyStableInstallation.mockReset();
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

  it('reports and adopts an eligible legacy stable home without starting it', async () => {
    mocks.runLifecycleAction.mockResolvedValue(lifecycleStatus('stable'));
    mocks.inspectLegacyStableInstallation.mockResolvedValue({
      state: 'available', message: 'A legacy stable installation can be adopted safely.',
    });
    mocks.adoptLegacyStableInstallation.mockResolvedValue({ state: 'adopted' });
    const controller = new LocalRuntimeController();

    await expect(controller.getStatus('stable')).resolves.toMatchObject({
      runtimeMode: 'live', legacyAdoptionAvailable: true,
    });
    await controller.run({ channel: 'stable', action: 'adopt' });

    expect(mocks.adoptLegacyStableInstallation).toHaveBeenCalledOnce();
    expect(mocks.runLifecycleAction).not.toHaveBeenCalledWith('start', expect.anything());
  });
});

describe('FixtureRuntimeController', () => {
  it('identifies demo mode without claiming a real runtime is healthy', async () => {
    const controller = new FixtureRuntimeController();
    const status = await controller.getStatus('stable');
    expect(status).toMatchObject({
      runtimeMode: 'fixture', installed: false, healthy: false, runningServices: [], syncInstalled: false,
    });
    expect(status.release).toBeUndefined();
    await expect(controller.run({ channel: 'stable', action: 'start' })).resolves.toMatchObject({
      runtimeMode: 'fixture', installed: false, healthy: false, runningServices: [],
    });
  });
});
