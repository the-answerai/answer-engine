import type { DesktopStatus } from './shared.js';

export interface TrayPresentation {
  health: string;
  header: string;
  tooltip: string;
}

export function presentTrayStatus(status: DesktopStatus): TrayPresentation {
  const health = status.healthy ? 'Healthy' : status.installed ? 'Needs repair' : 'Not installed';
  return {
    health,
    header: `${status.channel === 'staging' ? 'STAGING — ' : ''}${health}`,
    tooltip: `Answer Engine ${status.channel} — ${health}`,
  };
}
