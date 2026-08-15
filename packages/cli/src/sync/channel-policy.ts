import { resolveRuntimeChannel } from '../channel.js';

export interface HistorySyncPolicy {
  enabled: boolean;
}

export class HistorySyncPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistorySyncPolicyError';
  }
}

export function assertHistorySyncAllowed(
  policy: HistorySyncPolicy | undefined,
  confirmed: boolean,
): void {
  if (resolveRuntimeChannel() === 'stable') return;
  if (!policy?.enabled) {
    throw new HistorySyncPolicyError(
      'Staging history sync is disabled. Set history_sync.enabled: true in the staging config first.',
    );
  }
  if (!confirmed) {
    throw new HistorySyncPolicyError(
      'Refusing staging history access without --confirm-staging-history-sync.',
    );
  }
}
