import { Command, Option } from 'commander';
import { createClient, handleApiError } from '../client.js';
import { printJson, printSuccess } from '../output.js';
import type { RecallDiagnosticCode, RecallTutorialClient } from '../api-client.js';

const clients = ['codex', 'chatgpt-desktop', 'chatgpt-work', 'chatgpt-web', 'claude-code', 'claude-desktop', 'claude-cowork', 'cursor', 'cli'];
const failures = ['runtime', 'wiring', 'access', 'indexing', 'retrieval'];

export function registerTutorialCommands(program: Command): void {
  const tutorial = program.command('tutorial')
    .description('Prove memory across a fresh chat with tool and source evidence');

  tutorial.command('clients')
    .description('Preflight supported remember and recall clients')
    .addOption(new Option('--environment <environment>', 'Runtime environment').choices(['native', 'wsl']).default('native'))
    .action(async (options: { environment: 'native' | 'wsl' }) => {
      try { printJson({ data: (await createClient().recallTutorialCapabilities(options.environment)).data }); }
      catch (error) { handleApiError(error); }
    });

  tutorial.command('start')
    .description('Create a harmless first-memory challenge')
    .requiredOption('--write-client <client>', 'Client used in the first chat', (value) => value)
    .requiredOption('--recall-client <client>', 'Client used in the fresh chat', (value) => value)
    .addOption(new Option('--environment <environment>', 'Runtime environment').choices(['native', 'wsl']).default('native'))
    .action(async (options: { writeClient: string; recallClient: string; environment: 'native' | 'wsl' }) => {
      try {
        if (!clients.includes(options.writeClient) || !clients.includes(options.recallClient)) throw new Error(`client must be one of: ${clients.join(', ')}`);
        const result = await createClient().createRecallTutorial({
          writeClient: options.writeClient as RecallTutorialClient,
          recallClient: options.recallClient as RecallTutorialClient,
          environment: options.environment,
        });
        printJson({ data: result.data });
        printSuccess('Created a harmless first-memory proof; follow the remember instruction first');
      } catch (error) { handleApiError(error); }
    });

  tutorial.command('list').description('List recent first-memory proofs').action(async () => {
    try { printJson({ data: (await createClient().listRecallTutorials()).data }); }
    catch (error) { handleApiError(error); }
  });

  tutorial.command('show').argument('<tutorial-id>', 'Tutorial UUID').action(async (id: string) => {
    try { printJson({ data: (await createClient().getRecallTutorial(id)).data }); }
    catch (error) { handleApiError(error); }
  });

  tutorial.command('check')
    .description('Check audited remember, recall, and source-inspection evidence')
    .argument('<tutorial-id>', 'Tutorial UUID')
    .addOption(new Option('--report <failure>', 'Report a client-side failure for targeted recovery').choices(failures))
    .action(async (id: string, options: { report?: RecallDiagnosticCode }) => {
      try {
        const result = await createClient().checkRecallTutorial(id, options.report);
        printJson({ data: result.data });
        if (result.data.status === 'verified') printSuccess('First-memory proof passed with recall and source evidence');
      } catch (error) { handleApiError(error); }
    });
}
