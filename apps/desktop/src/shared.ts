import { z } from 'zod';

export const DesktopChannelSchema = z.enum(['stable', 'staging']);
export type DesktopChannel = z.infer<typeof DesktopChannelSchema>;

export const DesktopActionSchema = z.enum([
  'adopt', 'start', 'stop', 'restart', 'repair', 'update', 'rollback',
]);
export type DesktopAction = z.infer<typeof DesktopActionSchema>;

export const DesktopCommandSchema = z.object({
  channel: DesktopChannelSchema,
  action: DesktopActionSchema,
}).strict();
export type DesktopCommand = z.infer<typeof DesktopCommandSchema>;

export interface DesktopStatus {
  channel: DesktopChannel;
  home: string;
  apiUrl: string;
  installed: boolean;
  healthy: boolean;
  runningServices: string[];
  release?: string;
  syncInstalled: boolean;
  syncEnabledByDefault: boolean;
  runtimeMode: 'live' | 'fixture';
  legacyAdoptionAvailable: boolean;
  legacyAdoptionError?: string;
  checkedAt: string;
}

export interface DesktopExternalActionResult {
  opened: boolean;
  message: string;
  target?: string;
}

export interface DesktopBridge {
  getStatus(channel: DesktopChannel): Promise<DesktopStatus>;
  run(command: DesktopCommand): Promise<DesktopStatus>;
  openUi(channel: DesktopChannel): Promise<DesktopExternalActionResult>;
  openLogs(channel: DesktopChannel): Promise<DesktopExternalActionResult>;
  getLaunchAtLogin(): Promise<boolean>;
  setLaunchAtLogin(enabled: boolean): Promise<boolean>;
}

export const IPC = {
  status: 'desktop:status',
  run: 'desktop:run',
  openUi: 'desktop:open-ui',
  openLogs: 'desktop:open-logs',
  getLaunchAtLogin: 'desktop:get-launch-at-login',
  setLaunchAtLogin: 'desktop:set-launch-at-login',
} as const;
