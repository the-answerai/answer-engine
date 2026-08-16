import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value?: unknown) => Promise<unknown>>(),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  openExternal: vi.fn(),
  openPath: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: vi.fn(),
  },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, value?: unknown) => Promise<unknown>) => {
      electron.handlers.set(channel, handler);
      electron.handle(channel, handler);
    },
    removeHandler: electron.removeHandler,
  },
  shell: { openExternal: electron.openExternal, openPath: electron.openPath },
}));

import { registerDesktopIpc } from '../ipc.js';
import { IPC, type DesktopStatus } from '../shared.js';

const trustedEvent = { senderFrame: { url: 'answer-engine://desktop/index.html' } };

function status(overrides: Partial<DesktopStatus> = {}): DesktopStatus {
  return {
    channel: 'stable', home: '/home/stable', apiUrl: 'http://localhost:5050',
    installed: true, healthy: true, runningServices: ['api'], syncInstalled: true,
    syncEnabledByDefault: true, runtimeMode: 'live', legacyAdoptionAvailable: false,
    checkedAt: '2026-08-16T00:00:00.000Z', ...overrides,
  };
}

async function invoke(channel: string, value: unknown): Promise<unknown> {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler for ${channel}`);
  return handler(trustedEvent, value);
}

describe('desktop external actions', () => {
  beforeEach(() => {
    electron.handlers.clear();
    electron.handle.mockClear();
    electron.openExternal.mockReset();
    electron.openPath.mockReset();
  });

  it('returns the actual production UI origin after opening it', async () => {
    electron.openExternal.mockResolvedValue(undefined);
    registerDesktopIpc({
      runtimeMode: 'live',
      getStatus: () => Promise.resolve(status()),
      run: () => Promise.resolve(status()),
      getLogsDirectory: () => '/logs',
    });

    await expect(invoke(IPC.openUi, 'stable')).resolves.toEqual({
      opened: true, target: 'http://localhost:5050/',
      message: 'Opened the stable web app.',
    });
    expect(electron.openExternal).toHaveBeenCalledWith('http://localhost:5050/');
  });

  it('truthfully reports disabled fixture URL and log side effects', async () => {
    registerDesktopIpc({
      runtimeMode: 'fixture',
      getStatus: () => Promise.resolve(status({ runtimeMode: 'fixture', installed: false, healthy: false })),
      run: () => Promise.resolve(status()),
      getLogsDirectory: () => '/fixture/logs',
    }, { externalActionsEnabled: false });

    const uiResult = await invoke(IPC.openUi, 'stable');
    const logsResult = await invoke(IPC.openLogs, 'stable');
    expect(uiResult).toMatchObject({ opened: false });
    expect(logsResult).toMatchObject({ opened: false });
    if (!uiResult || typeof uiResult !== 'object' || !('message' in uiResult)) {
      throw new Error('Open UI result did not include a message.');
    }
    if (!logsResult || typeof logsResult !== 'object' || !('message' in logsResult)) {
      throw new Error('Open logs result did not include a message.');
    }
    expect(uiResult.message).toMatch(/demo mode.*not opened/i);
    expect(logsResult.message).toMatch(/demo mode.*not opened/i);
    expect(electron.openExternal).not.toHaveBeenCalled();
    expect(electron.openPath).not.toHaveBeenCalled();
  });

  it('opens live logs even when runtime status is unavailable', async () => {
    electron.openPath.mockResolvedValue('');
    registerDesktopIpc({
      runtimeMode: 'live',
      getStatus: () => Promise.reject(new Error('Docker is unavailable')),
      run: () => Promise.resolve(status()),
      getLogsDirectory: () => '/logs',
    });

    await expect(invoke(IPC.openLogs, 'stable')).resolves.toEqual({
      opened: true, target: '/logs', message: 'Opened stable logs.',
    });
    expect(electron.openPath).toHaveBeenCalledWith('/logs');
  });
});
