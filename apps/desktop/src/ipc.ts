import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { DesktopController } from './runtime-controller.js';
import { DesktopChannelSchema, DesktopCommandSchema, IPC } from './shared.js';
import { isTrustedDesktopUrl, localWebUrl } from './security.js';

export interface DesktopIpcEnvironment {
  openExternal?: (url: string) => Promise<void>;
  openPath?: (path: string) => Promise<string>;
  getLaunchAtLogin?: () => boolean;
  setLaunchAtLogin?: (enabled: boolean) => void;
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
    const status = await controller.getStatus(DesktopChannelSchema.parse(raw));
    await openExternal(localWebUrl(status.apiUrl, status.channel));
  }));
  ipcMain.handle(IPC.openLogs, guarded(async (_event, raw: unknown) => {
    const error = await openPath(controller.getLogsDirectory(DesktopChannelSchema.parse(raw)));
    if (error) throw new Error(error);
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
