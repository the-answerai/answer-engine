import { join, resolve } from 'node:path';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
import { readEnvValue } from './scaffold.js';
import { verifyMemoryRoundTrip } from './verify.js';
import { selectAgents, wireAgents } from './wire.js';
import {
  assertRuntimeChannelConfiguration,
  channelProfiles,
  createRuntimeChannelProfile,
  parseRuntimeChannel,
  validateRuntimeChannelIsolation,
  writeRuntimeOwnershipMarker,
} from './runtime-channel.js';

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
  selectAgents?: typeof selectAgents;
  startStack?: typeof startStack;
  activateApiKey?: typeof activateApiKey;
  wireAgents?: typeof wireAgents;
  verifyMemoryRoundTrip?: typeof verifyMemoryRoundTrip;
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
  if (channel === 'staging' && options.agents && options.agents.trim().toLowerCase() !== 'none') {
    throw new Error('Staging cannot write global agent configuration; use --agents none.');
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

  const legacyFiles = ['docker-compose.yml', '.env.compose', 'config.yaml']
    .map((name) => join(home, name));
  if (channel === 'stable' && legacyFiles.every(existsSync) && !existsSync(profile.markerFile)) {
    if (prompt) await requireInstallConsent(prompt, { home, profile: recommendation.id, agents: [] });
    const envPath = join(home, '.env.compose');
    const environment = readFileSync(envPath, 'utf8');
    const project = readEnvValue(environment, 'COMPOSE_PROJECT_NAME');
    if (project !== profile.composeProject) {
      throw new Error(`Refusing stable adoption: existing Compose project is ${project ?? '(missing)'}.`);
    }
    assertRuntimeChannelConfiguration(profile, { allowMissingChannel: true });
    if (!readEnvValue(environment, 'AE_CHANNEL')) {
      writeFileSync(envPath, `${environment.trimEnd()}\nAE_CHANNEL=stable\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(envPath, 0o600);
    }
    writeRuntimeOwnershipMarker(profile);
    assertRuntimeChannelConfiguration(profile);
    output.write(chalk.green(`Adopted the existing stable installation at ${home} without restarting or changing data.`));
    return;
  }

  if (preflight.installation === 'managed') {
    const status = await (dependencies.runLifecycleAction ?? runLifecycleAction)('status', profile);
    if (status?.healthy && installationIsComplete(profile, release.tag)) {
      output.write(chalk.green(`Answer Engine is already healthy at ${profile.apiUrl}; no changes were made.`));
      writeInstallAgentGuidance(output);
      return;
    }
  }

  output.write(chalk.cyan('2/6 Models'));
  const modelSetup = await (dependencies.resolveModelSetup ?? resolveModelSetup)(options, { prompt });
  const agents = channel === 'staging' ? [] : await (dependencies.selectAgents ?? selectAgents)(options, prompt);
  if (prompt) await requireInstallConsent(prompt, { home, profile: recommendation.id, agents });
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

  output.write(chalk.cyan('5/6 Wire agents'));
  const wiring = (dependencies.wireAgents ?? wireAgents)(agents, apiKey, profile.apiUrl);
  if (wiring.length === 0) output.write('  No agent configs selected.');
  for (const result of wiring) output.write(chalk.green(`  Wired ${result.path}`));

  output.write(chalk.cyan('6/6 Verify'));
  const contentId = await (dependencies.verifyMemoryRoundTrip ?? verifyMemoryRoundTrip)({
    apiKey,
    apiUrl: profile.apiUrl,
  });
  output.write(chalk.green(`  remember → recall → inspect_memory passed (${contentId}).`));

  writeInstallationCompletion(profile, release.tag);

  output.write(chalk.bold.green('Answer Engine is ready.'));
  output.write(`Config: ${scaffold.configPath}`);
  writeInstallAgentGuidance(output);
}
