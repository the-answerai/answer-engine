import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { DesktopController } from './runtime-controller.js';
import {
  DesktopChannelSchema,
  DesktopCommandSchema,
  IPC,
  type DesktopExternalActionResult,
} from './shared.js';
import { isTrustedDesktopUrl, localWebUrl } from './security.js';

export interface DesktopIpcEnvironment {
  openExternal?: (url: string) => Promise<void>;
  openPath?: (path: string) => Promise<string>;
  getLaunchAtLogin?: () => boolean;
  setLaunchAtLogin?: (enabled: boolean) => void;
  externalActionsEnabled?: boolean;
  standaloneWebDevelopment?: boolean;
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const senderFrame = event.senderFrame;
  if (!senderFrame || !isTrustedDesktopUrl(senderFrame.url)) {
    throw new Error('Rejected IPC from an untrusted renderer.');
  }
}

function guarded<T extends unknown[], R>(handler: (event: IpcMainInvokeEvent, ...args: T) => Promise<R> | R) {
  return async (event: IpcMainInvokeEvent, ...args: T): Promise<R> => {
    assertTrustedSender(event);
    return handler(event, ...args);
  };
}

export function registerDesktopIpc(
  controller: DesktopController,
  environment: DesktopIpcEnvironment = {},
): () => void {
  const openExternal = environment.openExternal ?? ((url: string) => shell.openExternal(url));
  const openPath = environment.openPath ?? ((path: string) => shell.openPath(path));
  const getLaunchAtLogin = environment.getLaunchAtLogin ?? (() => app.getLoginItemSettings().openAtLogin);
  const setLaunchAtLogin = environment.setLaunchAtLogin ?? ((enabled: boolean) => app.setLoginItemSettings({ openAtLogin: enabled }));
  ipcMain.handle(IPC.status, guarded(async (_event, raw: unknown) => controller.getStatus(DesktopChannelSchema.parse(raw))));
  ipcMain.handle(IPC.run, guarded(async (_event, raw: unknown) => controller.run(DesktopCommandSchema.parse(raw))));
  ipcMain.handle(IPC.openUi, guarded(async (_event, raw: unknown) => {
    const channel = DesktopChannelSchema.parse(raw);
    const status = await controller.getStatus(channel);
    if (environment.externalActionsEnabled === false || status.runtimeMode === 'fixture') {
      return {
        opened: false,
        message: 'Demo mode is simulated; the web app was not opened.',
      } satisfies DesktopExternalActionResult;
    }
    const target = localWebUrl(status.apiUrl, status.channel, {
      standaloneWebDevelopment: environment.standaloneWebDevelopment,
    });
    await openExternal(target);
    return { opened: true, target, message: `Opened the ${channel} web app.` } satisfies DesktopExternalActionResult;
  }));
  ipcMain.handle(IPC.openLogs, guarded(async (_event, raw: unknown) => {
    const channel = DesktopChannelSchema.parse(raw);
    const status = await controller.getStatus(channel);
    if (environment.externalActionsEnabled === false || status.runtimeMode === 'fixture') {
      return {
        opened: false,
        message: 'Demo mode is simulated; a logs folder was not opened.',
      } satisfies DesktopExternalActionResult;
    }
    const target = controller.getLogsDirectory(channel);
    const error = await openPath(target);
    if (error) throw new Error(error);
    return { opened: true, target, message: `Opened ${channel} logs.` } satisfies DesktopExternalActionResult;
  }));
  ipcMain.handle(IPC.getLaunchAtLogin, guarded(() => getLaunchAtLogin()));
  ipcMain.handle(IPC.setLaunchAtLogin, guarded((_event, raw: unknown) => {
    const enabled = z.boolean().parse(raw);
    setLaunchAtLogin(enabled);
    return getLaunchAtLogin();
  }));

  return () => {
    for (const channel of Object.values(IPC)) ipcMain.removeHandler(channel);
  };
}
