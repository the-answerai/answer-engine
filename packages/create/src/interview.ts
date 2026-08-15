import { z } from 'zod';
import type { PreflightResult } from './preflight.js';
import type { Prompt } from './prompt.js';

type InstallAgentClient = 'claude-code' | 'codex' | 'cursor' | 'claude-desktop';

export const ModelProfileSchema = z.object({
  id: z.enum(['full-local', 'reduced-local', 'cloud-backed']),
  label: z.string().min(1),
  reason: z.string().min(1),
}).strict();
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export function recommendModelProfile(report: PreflightResult): ModelProfile {
  const fullLocal = report.system.ramGb >= 16
    && report.system.freeDiskGb >= 30
    && ((report.system.platform === 'macos' && report.system.architecture === 'arm64')
      || (report.system.platform === 'windows-wsl2' && report.system.gpu.vramGb >= 8));
  if (fullLocal) return ModelProfileSchema.parse({
    id: 'full-local', label: 'Full local', reason: 'This computer meets the supported local baseline.',
  });
  const reducedLocal = report.system.ramGb >= 8 && report.system.freeDiskGb >= 15
    && report.system.platform === 'macos';
  if (reducedLocal) return ModelProfileSchema.parse({
    id: 'reduced-local', label: 'Reduced local',
    reason: 'Smaller local models should fit, with reduced answer quality or speed.',
  });
  return ModelProfileSchema.parse({
    id: 'cloud-backed', label: 'Cloud backed',
    reason: 'Local model capacity is below the supported baseline; remote providers require explicit opt-in.',
  });
}

export interface InstallConsentSummary {
  home: string;
  profile: ModelProfile['id'];
  agents: readonly InstallAgentClient[];
}

export async function requireInstallConsent(prompt: Prompt, summary: InstallConsentSummary): Promise<void> {
  const clients = summary.agents.length === 0 ? 'none' : summary.agents.join(', ');
  if (!prompt.confirm) throw new Error('Interactive confirmation is unavailable.');
  const confirmed = await prompt.confirm(
    `Install to ${summary.home} using ${summary.profile} and wire ${clients}?`,
    false,
  );
  if (!confirmed) throw new Error('Setup cancelled before any changes were made.');
}
