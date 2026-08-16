import { contextBridge, ipcRenderer } from 'electron';

const IPC = {
  status: 'desktop:status',
  run: 'desktop:run',
  openUi: 'desktop:open-ui',
  openLogs: 'desktop:open-logs',
  getLaunchAtLogin: 'desktop:get-launch-at-login',
  setLaunchAtLogin: 'desktop:set-launch-at-login',
} as const;

contextBridge.exposeInMainWorld('answerEngine', Object.freeze({
  getStatus: (channel: string) => ipcRenderer.invoke(IPC.status, channel),
  run: (command: Readonly<{ channel: string; action: string }>) => ipcRenderer.invoke(IPC.run, { ...command }),
  openUi: (channel: string) => ipcRenderer.invoke(IPC.openUi, channel),
  openLogs: (channel: string) => ipcRenderer.invoke(IPC.openLogs, channel),
  getLaunchAtLogin: () => ipcRenderer.invoke(IPC.getLaunchAtLogin),
  setLaunchAtLogin: (enabled: boolean) => ipcRenderer.invoke(IPC.setLaunchAtLogin, enabled),
}));
