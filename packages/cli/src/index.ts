#!/usr/bin/env node
/**
 * Answer Engine CLI
 * Terminal-native interface for local memory, content, sync, and evaluation
 */

import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth.js';
import { registerContentCommands } from './commands/content.js';
import { registerSystemCommands } from './commands/system.js';
import { registerImportCommands } from './commands/import.js';
import { registerSyncCommands } from './commands/sync.js';
import { registerFolderCommands } from './commands/folders.js';
import { registerConfigCommands } from './commands/config.js';
import { registerEvalCommands } from './commands/eval.js';
import { registerOrganizationCommands } from './commands/organize.js';
import { registerTutorialCommands } from './commands/tutorial.js';
import { setOutputMode } from './output.js';
import { getConfig } from './config.js';
import { resolveRuntimeChannel } from './channel.js';

const program = new Command();

program
  .name('ae')
  .description('Answer Engine CLI — local memory, search, import, sync, and evaluation')
  .version('1.1.2')
  .option('--json', 'Force JSON output')
  .option('--channel <channel>', 'Runtime channel: stable or staging')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.optsWithGlobals() as { json?: boolean; channel?: string };
    process.env.AE_CHANNEL = resolveRuntimeChannel(opts.channel);
    if (opts.json) {
      setOutputMode('json');
    } else {
      const config = getConfig();
      if (config.default_output !== 'auto') {
        setOutputMode(config.default_output);
      }
    }
  });

// Register all command groups
registerAuthCommands(program);
registerContentCommands(program);
registerSystemCommands(program);
registerConfigCommands(program);
registerImportCommands(program);
registerSyncCommands(program);
registerFolderCommands(program);
registerEvalCommands(program);
registerOrganizationCommands(program);
registerTutorialCommands(program);

// Add full usage reference to help output
program.addHelpText('after', `
Examples:
  ae search "release decisions"               Search with default options (hybrid, limit 10)
  ae search "onboarding notes" -t semantic -l 5
  ae search "bugs" --tags bug,urgent           Filter by tags
  ae search "docs" --content-types page,document
  ae search "profile" --include summary,content

  ae get <uuid> [uuid2...]                    Retrieve items by ID
  ae get <uuid> --include content,metadata    Choose which fields to return

  ae summarize "top themes across all calls"  Summarize local content
  ae summarize "risks" --tags finance -l 50   Summarize filtered content

  ae import csv ./notes.csv --type document   Import rows from CSV
  ae import csv ./data.csv --dry-run          Validate and preview a CSV import
  ae import json ./items.json --type document Import rows from a JSON array

  ae sync once --source claude-code           Import changed Claude Code conversations once
  ae sync first-import                        Preview, approve, import, and reconcile agent history
  ae sync first-import --resume <session-id>  Resume an interrupted approved first import
  ae sync run --source claude-code            Poll Claude Code conversations continuously
  ae folders add ./notes                     Preview a selected folder and wait for approval
  ae folders refresh --source <source-id>    Preview folder changes before reading them
  ae organize propose                        Preview local deterministic organization
  ae organize apply <plan-id> --accept <id> --reject <id>
                                                Decide every suggestion before mutation
  ae organize undo <plan-id>                 Restore pre-organization taxonomy and memberships
  ae tutorial start --write-client codex --recall-client claude-code
                                                Create a harmless cross-chat memory proof
  ae tutorial check <tutorial-id>             Verify recall and source tool evidence
  ae sync install-service                     Start sync now and automatically after login
  ae sync status                              Show service health and per-source cursors
  ae sync uninstall-service                   Stop and remove the background service
  ae --channel staging sync once --confirm-staging-history-sync
                                                Sync opted-in staging history explicitly

  ae config path                              Show the AE_HOME layout
  ae config validate                          Validate AE_HOME/config.yaml
  ae config gen-env                           Generate AE_HOME/.env from config.yaml

  ae eval label --set my-library              Label retrieval results interactively
  ae eval label --set my-library --file judgments.jsonl
                                                Import labeled JSONL judgments
  ae eval run --set my-library                Score fulltext, semantic, and hybrid retrieval
  AE_EVAL_TIMESTAMP=2026-08-11T00:00:00.000Z ae eval run --set my-library
                                                Reproduce identical artifact bytes

  ae auth login                               Save API key to config
  ae auth status                              Check local API authentication

  ae status                                   API health check
  ae schema                                   Full content schema dump
  ae config show                              Show current configuration
  ae config set api_url http://localhost:5050  Set an explicit API URL
`);

// Show help if no command provided (exit 0, not 1)
if (process.argv.length <= 2) {
  program.help();
} else {
  await program.parseAsync();
}
