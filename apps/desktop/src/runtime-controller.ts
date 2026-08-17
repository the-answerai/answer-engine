import {
  runLifecycleAction,
  type LifecycleStatus,
} from '@answer-engine/create/lifecycle';
import {
  channelProfiles,
  createRuntimeChannelProfile,
  validateRuntimeChannelIsolation,
} from '@answer-engine/create/runtime-channel';
import {
  adoptLegacyStableInstallation,
  inspectLegacyStableInstallation,
  type LegacyStableInspection,
} from '@answer-engine/create/legacy-adoption';
import type { DesktopChannel, DesktopCommand, DesktopStatus } from './shared.js';

export interface DesktopController {
  readonly runtimeMode: 'live' | 'fixture';
  getStatus(channel: DesktopChannel): Promise<DesktopStatus>;
  run(command: DesktopCommand): Promise<DesktopStatus>;
  getLogsDirectory(channel: DesktopChannel): string;
}

function present(status: LifecycleStatus, legacy: LegacyStableInspection): DesktopStatus {
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
    runtimeMode: 'live',
    legacyAdoptionAvailable: legacy.state === 'available',
    ...(legacy.state === 'invalid' ? { legacyAdoptionError: legacy.message } : {}),
    checkedAt: new Date().toISOString(),
  };
}

export class LocalRuntimeController implements DesktopController {
  readonly runtimeMode = 'live' as const;

  async getStatus(channel: DesktopChannel): Promise<DesktopStatus> {
    const profile = createRuntimeChannelProfile(channel);
    const status = await runLifecycleAction('status', profile);
    if (!status) throw new Error(`No ${channel} status was returned.`);
    const legacy = await inspectLegacyStableInstallation(profile);
    return present(status, legacy);
  }

  async run(command: DesktopCommand): Promise<DesktopStatus> {
    const profile = createRuntimeChannelProfile(command.channel);
    await validateRuntimeChannelIsolation(channelProfiles(command.channel));
    if (command.action === 'adopt') {
      const statusBeforeAdoption = await this.getStatus(command.channel);
      await adoptLegacyStableInstallation(profile);
      try {
        return await this.getStatus(command.channel);
      } catch {
        const adoptedStatus = {
          ...statusBeforeAdoption,
          installed: true,
          healthy: false,
          runningServices: [],
          legacyAdoptionAvailable: false,
          checkedAt: new Date().toISOString(),
        };
        delete adoptedStatus.legacyAdoptionError;
        return adoptedStatus;
      }
    } else if (command.action === 'restart') {
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
  readonly runtimeMode = 'fixture' as const;
  private readonly states = new Map<DesktopChannel, DesktopStatus>();

  constructor() {
    for (const channel of ['stable', 'staging'] as const) {
      const profile = createRuntimeChannelProfile(channel, { home: `/tmp/answer-engine-fixture-${channel}` });
      this.states.set(channel, {
        channel,
        home: profile.home,
        apiUrl: profile.apiUrl,
        installed: false,
        healthy: false,
        runningServices: [],
        syncInstalled: false,
        syncEnabledByDefault: channel === 'stable',
        runtimeMode: 'fixture',
        legacyAdoptionAvailable: false,
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
    const next: DesktopStatus = {
      ...current,
      installed: false,
      healthy: false,
      runningServices: [],
      checkedAt: new Date().toISOString(),
    };
    this.states.set(command.channel, next);
    return next;
  }

  getLogsDirectory(channel: DesktopChannel): string {
    return `/tmp/answer-engine-fixture-${channel}/logs`;
  }
}
