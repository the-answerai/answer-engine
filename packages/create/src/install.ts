import { resolve } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';
import { detectOwnedPorts, persistApiKey, startStack } from './docker.js';
import { parseModelSpec, prepareLmStudioModels, resolveModelSetup } from './models.js';
import type { InstallerOptions } from './options.js';
import { formatPreflightFailures, runPreflight } from './preflight.js';
import { createPrompt } from './prompt.js';
import { scaffoldInstallation } from './scaffold.js';
import { verifyMemoryRoundTrip } from './verify.js';
import { selectAgents, wireAgents } from './wire.js';

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
  const home = resolve(options.home ?? process.env.AE_HOME ?? `${homedir()}/.answer-engine`);
  process.env.AE_HOME = home;
  const prompt = options.yes ? undefined : createPrompt();

  output.write(chalk.cyan('1/6 Preflight'));
  const ownedPorts = await detectOwnedPorts(home);
  const preflight = await runPreflight({ ownedPorts });
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
    config: modelSetup.config,
    runtime: modelSetup.runtime,
  });
  output.write(chalk.green(`  Configuration: ${scaffold.configPath}`));

  output.write(chalk.cyan('4/6 Start'));
  const loggedKey = await startStack(home);
  const providedKey = options.apiKey?.trim();
  const apiKey = providedKey || scaffold.apiKey || loggedKey;
  if (!apiKey) {
    throw new Error(
      'The local API key is unavailable because init already ran without this installer. '
      + 'Pass --api-key <key>, or run --uninstall --purge and install again.',
    );
  }
  if (!scaffold.apiKey) persistApiKey(scaffold.envPath, apiKey);
  output.write(chalk.green('  Answer Engine is healthy at http://localhost:5050.'));

  output.write(chalk.cyan('5/6 Wire agents'));
  const agents = await selectAgents(options, prompt);
  const wiring = wireAgents(agents, apiKey);
  if (wiring.length === 0) output.write('  No agent configs selected.');
  for (const result of wiring) output.write(chalk.green(`  Wired ${result.path}`));

  output.write(chalk.cyan('6/6 Verify'));
  const contentId = await verifyMemoryRoundTrip({ apiKey });
  output.write(chalk.green(`  remember → recall → inspect_memory passed (${contentId}).`));

  if (!providedKey && !scaffold.apiKey && loggedKey) {
    output.write(chalk.yellow(`ANSWER_ENGINE_API_KEY=${loggedKey}`));
    output.write('Save this key now. It is also secured in $AE_HOME/.env.compose.');
  }
  output.write(chalk.bold.green('Answer Engine is ready.'));
  output.write(`Config: ${scaffold.configPath}`);
  writeInstallAgentGuidance(output);
}
