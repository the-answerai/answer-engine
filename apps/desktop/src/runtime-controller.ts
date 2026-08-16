import {
  runLifecycleAction,
  type LifecycleStatus,
} from '@answer-engine/create/lifecycle';
import {
  channelProfiles,
  createRuntimeChannelProfile,
  validateRuntimeChannelIsolation,
} from '@answer-engine/create/runtime-channel';
import type { DesktopChannel, DesktopCommand, DesktopStatus } from './shared.js';

export interface DesktopController {
  getStatus(channel: DesktopChannel): Promise<DesktopStatus>;
  run(command: DesktopCommand): Promise<DesktopStatus>;
  getLogsDirectory(channel: DesktopChannel): string;
}

function present(status: LifecycleStatus): DesktopStatus {
  return {
    channel: status.channel,
    home: status.home,
    apiUrl: status.apiUrl,
    installed: status.installed,
    healthy: status.healthy,
    runningServices: status.runningServices,
    release: status.release,
    syncInstalled: status.syncService.installed,
    syncEnabledByDefault: status.syncService.enabledByDefault,
    checkedAt: new Date().toISOString(),
  };
}

export class LocalRuntimeController implements DesktopController {
  async getStatus(channel: DesktopChannel): Promise<DesktopStatus> {
    const status = await runLifecycleAction('status', createRuntimeChannelProfile(channel));
    if (!status) throw new Error(`No ${channel} status was returned.`);
    return present(status);
  }

  async run(command: DesktopCommand): Promise<DesktopStatus> {
    const profile = createRuntimeChannelProfile(command.channel);
    await validateRuntimeChannelIsolation(channelProfiles(command.channel));
    if (command.action === 'restart') {
      await runLifecycleAction('stop', profile);
      await runLifecycleAction('start', profile);
    } else {
      const action = command.action === 'update' ? 'upgrade' : command.action;
      await runLifecycleAction(action, profile);
    }
    return this.getStatus(command.channel);
  }

  getLogsDirectory(channel: DesktopChannel): string {
    return createRuntimeChannelProfile(channel).logsDir;
  }
}

export class FixtureRuntimeController implements DesktopController {
  private readonly states = new Map<DesktopChannel, DesktopStatus>();

  constructor() {
    for (const channel of ['stable', 'staging'] as const) {
      const profile = createRuntimeChannelProfile(channel, { home: `/tmp/answer-engine-fixture-${channel}` });
      this.states.set(channel, {
        channel,
        home: profile.home,
        apiUrl: profile.apiUrl,
        installed: true,
        healthy: channel === 'stable',
        runningServices: channel === 'stable' ? ['api', 'web', 'postgres', 'redis'] : [],
        release: 'ghcr.io/the-answerai/answer-engine:1.1.0',
        syncInstalled: channel === 'stable',
        syncEnabledByDefault: channel === 'stable',
        checkedAt: new Date().toISOString(),
      });
    }
  }

  getStatus(channel: DesktopChannel): Promise<DesktopStatus> {
    const current = this.states.get(channel);
    if (!current) throw new Error(`Unknown fixture channel ${channel}.`);
    return Promise.resolve({ ...current, checkedAt: new Date().toISOString() });
  }

  async run(command: DesktopCommand): Promise<DesktopStatus> {
    const current = await this.getStatus(command.channel);
    const running = !['stop'].includes(command.action);
    const next: DesktopStatus = {
      ...current,
      healthy: running,
      runningServices: running ? ['api', 'web', 'postgres', 'redis'] : [],
      checkedAt: new Date().toISOString(),
    };
    this.states.set(command.channel, next);
    return next;
  }

  getLogsDirectory(channel: DesktopChannel): string {
    return `/tmp/answer-engine-fixture-${channel}/logs`;
  }
}
