import { join, resolve } from 'node:path';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import chalk from 'chalk';
import { activateApiKey, detectOwnedPorts, startStack } from './docker.js';
import { parseModelSpec, prepareLmStudioModels, resolveModelSetup } from './models.js';
import type { InstallerOptions } from './options.js';
import { formatPreflightFailures, runPreflight } from './preflight.js';
import { createPrompt } from './prompt.js';
import { scaffoldInstallation } from './scaffold.js';
import { readEnvValue } from './scaffold.js';
import { verifyMemoryRoundTrip } from './verify.js';
import { selectAgents, wireAgents } from './wire.js';
import {
  channelProfiles,
  createRuntimeChannelProfile,
  parseRuntimeChannel,
  validateRuntimeChannelIsolation,
  writeRuntimeOwnershipMarker,
} from './runtime-channel.js';

export interface InstallOutput {
  write(message: string): void;
}

export const INSTALL_AGENT_URL =
  'https://raw.githubusercontent.com/the-answerai/answer-engine/master/INSTALL_AGENT.md';

export function writeInstallAgentGuidance(output: InstallOutput): void {
  output.write(`Agent-guided configuration: ${INSTALL_AGENT_URL}`);
}

const defaultOutput: InstallOutput = {
  write: (message) => process.stdout.write(`${message}\n`),
};

export async function install(
  options: InstallerOptions,
  output: InstallOutput = defaultOutput,
): Promise<void> {
  const channel = parseRuntimeChannel(options.channel ?? process.env.AE_CHANNEL);
  const homeOverride = options.home ?? process.env.AE_HOME;
  const profile = createRuntimeChannelProfile(channel, {
    ...(homeOverride ? { home: resolve(homeOverride) } : {}),
  });
  const home = profile.home;
  await validateRuntimeChannelIsolation(channelProfiles(channel, home));
  process.env.AE_HOME = home;
  process.env.AE_CHANNEL = channel;
  const legacyFiles = ['docker-compose.yml', '.env.compose', 'config.yaml']
    .map((name) => join(home, name));
  if (channel === 'stable' && legacyFiles.every(existsSync) && !existsSync(profile.markerFile)) {
    const envPath = join(home, '.env.compose');
    const environment = readFileSync(envPath, 'utf8');
    const project = readEnvValue(environment, 'COMPOSE_PROJECT_NAME');
    if (project !== profile.composeProject) {
      throw new Error(`Refusing stable adoption: existing Compose project is ${project ?? '(missing)'}.`);
    }
    if (!readEnvValue(environment, 'AE_CHANNEL')) {
      writeFileSync(envPath, `${environment.trimEnd()}\nAE_CHANNEL=stable\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(envPath, 0o600);
    }
    writeRuntimeOwnershipMarker(profile);
    output.write(chalk.green(`Adopted the existing stable installation at ${home} without restarting or changing data.`));
    return;
  }
  if (channel === 'staging' && options.agents && options.agents.trim().toLowerCase() !== 'none') {
    throw new Error('Staging cannot write global agent configuration; use --agents none.');
  }
  const prompt = options.yes ? undefined : createPrompt();

  output.write(chalk.cyan('1/6 Preflight'));
  const ownedPorts = await detectOwnedPorts(home, {}, profile);
  const preflight = await runPreflight({ ownedPorts, requiredPorts: Object.values(profile.ports) });
  if (!preflight.ok) throw new Error(formatPreflightFailures(preflight.failures));
  output.write(chalk.green('  Docker, Compose, Node, and ports are ready.'));

  output.write(chalk.cyan('2/6 Models'));
  const modelSetup = await resolveModelSetup(options, { prompt });
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
  await validateRuntimeChannelIsolation(channelProfiles(channel, home));
  output.write(chalk.green(`  Configuration: ${scaffold.configPath}`));

  output.write(chalk.cyan('4/6 Start'));
  const loggedKey = await startStack(home, {}, profile);
  const providedKey = options.apiKey?.trim();
  const apiKey = providedKey || scaffold.apiKey || loggedKey;
  if (!apiKey) {
    throw new Error(
      'The local API key is unavailable because init already ran without this installer. '
      + 'Pass --api-key <key>, or run --uninstall --purge and install again.',
    );
  }
  if (!scaffold.apiKey) await activateApiKey(home, scaffold.envPath, apiKey, {}, profile);
  output.write(chalk.green(`  ${channel} Answer Engine is healthy at ${profile.apiUrl}.`));

  output.write(chalk.cyan('5/6 Wire agents'));
  const agents = channel === 'staging' ? [] : await selectAgents(options, prompt);
  const wiring = wireAgents(agents, apiKey, profile.apiUrl);
  if (wiring.length === 0) output.write('  No agent configs selected.');
  for (const result of wiring) output.write(chalk.green(`  Wired ${result.path}`));

  output.write(chalk.cyan('6/6 Verify'));
  const contentId = await verifyMemoryRoundTrip({ apiKey, apiUrl: profile.apiUrl });
  output.write(chalk.green(`  remember → recall → inspect_memory passed (${contentId}).`));

  if (!providedKey && !scaffold.apiKey && loggedKey) {
    output.write(chalk.yellow(`ANSWER_ENGINE_API_KEY=${loggedKey}`));
    output.write('Save this key now. It is also secured in $AE_HOME/.env.compose.');
  }
  output.write(chalk.bold.green('Answer Engine is ready.'));
  output.write(`Config: ${scaffold.configPath}`);
  writeInstallAgentGuidance(output);
}
