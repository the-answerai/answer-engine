import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import { activateApiKey, detectOwnedPorts, startStack } from './docker.js';
import { parseModelSpec, prepareLmStudioModels, resolveModelSetup } from './models.js';
import type { InstallerOptions } from './options.js';
import { formatPreflightFailures, runPreflight } from './preflight.js';
import { formatPreflightReport } from './preflight.js';
import { createPrompt } from './prompt.js';
import type { Prompt } from './prompt.js';
import { recommendModelProfile, requireInstallConsent } from './interview.js';
import { loadReleaseManifest, verifyBundledRelease } from './release.js';
import {
  clearInstallationCompletion,
  installationIsComplete,
  writeInstallationCompletion,
} from './install-state.js';
import { runLifecycleAction } from './lifecycle.js';
import { scaffoldInstallation } from './scaffold.js';
import { verifyClientIntegrations, verifyMemoryRoundTrip } from './verify.js';
import { selectClients } from './wire.js';
import {
  applyIntegrationPlan,
  buildIntegrationPlan,
  updateIntegrationVerification,
} from './integrations.js';
import { CoworkModeSchema } from './clients.js';
import {
  assertRuntimeChannelConfiguration,
  channelProfiles,
  createRuntimeChannelProfile,
  parseRuntimeChannel,
  validateRuntimeChannelIsolation,
} from './runtime-channel.js';
import {
  adoptLegacyStableInstallation,
  inspectLegacyStableInstallation,
} from './legacy-adoption.js';

export interface InstallOutput {
  write(message: string): void;
}

export interface InstallDependencies {
  prompt?: Prompt;
  detectOwnedPorts?: typeof detectOwnedPorts;
  runPreflight?: typeof runPreflight;
  verifyBundledRelease?: typeof verifyBundledRelease;
  runLifecycleAction?: typeof runLifecycleAction;
  resolveModelSetup?: typeof resolveModelSetup;
  selectClients?: typeof selectClients;
  startStack?: typeof startStack;
  activateApiKey?: typeof activateApiKey;
  applyIntegrationPlan?: typeof applyIntegrationPlan;
  verifyMemoryRoundTrip?: typeof verifyMemoryRoundTrip;
  verifyClientIntegrations?: typeof verifyClientIntegrations;
  updateIntegrationVerification?: typeof updateIntegrationVerification;
}

export const INSTALL_AGENT_URL = loadReleaseManifest().promptUrl;

export function writeInstallAgentGuidance(output: InstallOutput): void {
  output.write(`Agent-guided configuration: ${INSTALL_AGENT_URL}`);
}

const defaultOutput: InstallOutput = {
  write: (message) => process.stdout.write(`${message}\n`),
};

export async function install(
  options: InstallerOptions,
  output: InstallOutput = defaultOutput,
  dependencies: InstallDependencies = {},
): Promise<void> {
  const channel = parseRuntimeChannel(options.channel ?? process.env.AE_CHANNEL);
  const prompt = options.yes ? undefined : dependencies.prompt ?? createPrompt();
  const configuredHome = options.home ?? process.env.AE_HOME;
  const defaultHome = createRuntimeChannelProfile(channel).home;
  const homeOverride = configuredHome
    ?? (prompt ? await prompt.input('Installation folder', defaultHome) : undefined);
  const profile = createRuntimeChannelProfile(channel, {
    ...(homeOverride ? { home: resolve(homeOverride) } : {}),
  });
  const home = profile.home;
  await validateRuntimeChannelIsolation(channelProfiles(channel, home));
  const requestedClients = options.clients ?? options.agents;
  if (channel === 'staging' && requestedClients && requestedClients.trim().toLowerCase() !== 'none') {
    throw new Error('Staging cannot write global client configuration; use --clients none.');
  }

  const legacy = await inspectLegacyStableInstallation(profile);
  if (legacy.state === 'invalid') throw new Error(legacy.message);
  if (legacy.state === 'available') {
    if (prompt) {
      if (!prompt.confirm) throw new Error('Interactive confirmation is unavailable.');
      const confirmed = await prompt.confirm(
        `Adopt the existing stable installation at ${home} without restarting or changing data?`,
        false,
      );
      if (!confirmed) throw new Error('Setup cancelled before any changes were made.');
    }
    await adoptLegacyStableInstallation(profile);
    output.write(chalk.green(`Adopted the existing stable installation at ${home} without restarting or changing data.`));
    return;
  }

  output.write(chalk.cyan('1/6 Preflight'));
  const ownedPorts = await (dependencies.detectOwnedPorts ?? detectOwnedPorts)(home, {}, profile);
  const preflight = await (dependencies.runPreflight ?? runPreflight)({
    home, ownedPorts, requiredPorts: Object.values(profile.ports),
  });
  if (!preflight.ok) throw new Error(formatPreflightFailures(preflight.failures));
  output.write(preflight.status === 'pass'
    ? chalk.green('  Supported local baseline is ready.')
    : chalk.yellow(formatPreflightReport(preflight)));

  const release = (dependencies.verifyBundledRelease ?? verifyBundledRelease)();
  output.write(chalk.green(`  Verified installer ${release.tag} and bundled checksums.`));

  const recommendation = recommendModelProfile(preflight);
  output.write(`  Recommended profile: ${recommendation.label}. ${recommendation.reason}`);

  if (preflight.installation === 'managed') {
    const status = await (dependencies.runLifecycleAction ?? runLifecycleAction)('status', profile);
    if (status?.healthy && requestedClients === undefined && installationIsComplete(profile, release.tag)) {
      output.write(chalk.green(`Answer Engine is already healthy at ${profile.apiUrl}; no changes were made.`));
      writeInstallAgentGuidance(output);
      return;
    }
  }

  output.write(chalk.cyan('2/6 Models'));
  const modelSetup = await (dependencies.resolveModelSetup ?? resolveModelSetup)(options, { prompt });
  const clients = channel === 'staging' ? [] : await (dependencies.selectClients ?? selectClients)(options, prompt);
  const coworkMode = CoworkModeSchema.parse(options.coworkMode ?? 'unknown');
  const integrationPlan = buildIntegrationPlan({
    channel,
    aeHome: home,
    clients,
    coworkMode,
    runningInWsl: preflight.system.platform === 'windows-wsl2',
  });
  output.write('  Planned client integration changes:');
  if (integrationPlan.operations.length === 0) output.write('    No supported global client paths selected.');
  for (const operation of integrationPlan.operations) {
    output.write(`    ${operation.client}: ${operation.description} (${operation.path})`);
  }
  for (const client of integrationPlan.clients.filter((candidate) => !candidate.supported)) {
    output.write(chalk.yellow(`    ${client.label}: unavailable — ${client.limitation}`));
  }
  if (prompt) await requireInstallConsent(prompt, { home, profile: recommendation.id, agents: clients });
  clearInstallationCompletion(profile);
  process.env.AE_HOME = home;
  process.env.AE_CHANNEL = channel;
  if (modelSetup.config.models.chat_provider === 'lmstudio') {
    await prepareLmStudioModels(
      parseModelSpec(
        `chat=${modelSetup.config.models.chat},embedding=${modelSetup.config.models.embedding}`,
      ),
      options.lmStudioUrl,
    );
  }
  output.write(chalk.green(
    `  ${modelSetup.config.models.chat_provider}: ${modelSetup.config.models.chat}; `
    + `${modelSetup.config.models.embedding_provider}: ${modelSetup.config.models.embedding}`,
  ));

  output.write(chalk.cyan('3/6 Scaffold'));
  const scaffold = scaffoldInstallation({
    home,
    config: { ...modelSetup.config, server: { ...modelSetup.config.server, port: profile.ports.api } },
    runtime: modelSetup.runtime,
    profile,
  });
  assertRuntimeChannelConfiguration(profile);
  await validateRuntimeChannelIsolation(channelProfiles(channel, home));
  output.write(chalk.green(scaffold.changes.length === 0
    ? `  Configuration already matched at ${scaffold.configPath}; no files changed.`
    : `  Configuration: ${scaffold.configPath} (${scaffold.changes.join(', ')} updated).`));

  output.write(chalk.cyan('4/6 Start'));
  const loggedKey = await (dependencies.startStack ?? startStack)(home, {}, profile);
  const providedKey = options.apiKey?.trim();
  const apiKey = providedKey || scaffold.apiKey || loggedKey;
  if (!apiKey) {
    throw new Error(
      'The local API key is unavailable because init already ran without this installer. '
      + 'Pass --api-key <key>, or run --uninstall --purge and install again.',
    );
  }
  if (!scaffold.apiKey) {
    await (dependencies.activateApiKey ?? activateApiKey)(home, scaffold.envPath, apiKey, {}, profile);
  }
  output.write(chalk.green(`  ${channel} Answer Engine is healthy at ${profile.apiUrl}.`));

  output.write(chalk.cyan('5/6 Connect clients'));
  if (integrationPlan.operations.length === 0) output.write('  No supported client integrations selected.');
  else {
    const applied = await (dependencies.applyIntegrationPlan ?? applyIntegrationPlan)(integrationPlan, {
      apiKey,
      apiUrl: profile.apiUrl,
    });
    output.write(chalk.green(applied.changed === 0
      ? '  Client integrations already matched; no files changed.'
      : `  Applied ${applied.changed} managed client integration changes.`));
  }

  output.write(chalk.cyan('6/6 Verify'));
  const marker = `aecreate${randomUUID().replaceAll('-', '')}`;
  const contentId = await (dependencies.verifyMemoryRoundTrip ?? verifyMemoryRoundTrip)({
    apiKey,
    apiUrl: profile.apiUrl,
    marker,
  });
  output.write(chalk.green(`  remember → recall → inspect_memory passed (${contentId}).`));
  const clientVerification = await (dependencies.verifyClientIntegrations ?? verifyClientIntegrations)({
    clients,
    coworkMode,
    runningInWsl: preflight.system.platform === 'windows-wsl2',
    marker,
    contentId,
    ...(prompt ? { prompt } : {}),
  });
  for (const result of clientVerification) {
    output.write(result.status === 'passed'
      ? chalk.green(`  ${result.client}: ${result.detail}`)
      : chalk.yellow(`  ${result.client}: ${result.detail}`));
  }
  if (integrationPlan.operations.length > 0) {
    (dependencies.updateIntegrationVerification ?? updateIntegrationVerification)(home, clientVerification);
  }

  writeInstallationCompletion(profile, release.tag);

  output.write(chalk.bold.green('Answer Engine is ready.'));
  output.write(`Config: ${scaffold.configPath}`);
  writeInstallAgentGuidance(output);
}
