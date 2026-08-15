import { Command } from 'commander';
import { createClient, handleApiError } from '../client.js';
import { printJson, printSuccess } from '../output.js';
import type { OrganizationDecision } from '../api-client.js';

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseLimit(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new Error('--limit must be an integer from 1 to 50');
  }
  return value;
}

export function registerOrganizationCommands(program: Command): void {
  const organize = program.command('organize')
    .description('Preview, approve, apply, and undo local memory organization');

  organize.command('propose')
    .description('Create a non-mutating evidence-backed organization proposal')
    .option('--use-model', 'Explicitly send bounded metadata to the configured model', false)
    .option('--limit <count>', 'Maximum records sampled (1-50)', '50')
    .action(async (options: { useModel: boolean; limit: string }) => {
      try {
        const response = await createClient().createOrganizationProposal({
          useModel: options.useModel,
          limit: parseLimit(options.limit),
        });
        printJson({ data: response.data });
      } catch (error) { handleApiError(error); }
    });

  organize.command('list')
    .description('List recent organization proposals')
    .action(async () => {
      try { printJson({ data: (await createClient().listOrganizationPlans()).data }); }
      catch (error) { handleApiError(error); }
    });

  organize.command('show')
    .description('Show suggestions, evidence, decisions, and status')
    .argument('<plan-id>', 'Organization plan UUID')
    .action(async (planId: string) => {
      try { printJson({ data: (await createClient().getOrganizationPlan(planId)).data }); }
      catch (error) { handleApiError(error); }
    });

  organize.command('apply')
    .description('Apply after accepting or rejecting every suggestion')
    .argument('<plan-id>', 'Organization plan UUID')
    .option('--accept <suggestion-id>', 'Accept one suggestion (repeatable)', collect, [])
    .option('--reject <suggestion-id>', 'Reject one suggestion (repeatable)', collect, [])
    .action(async (planId: string, options: { accept: string[]; reject: string[] }) => {
      const decisions: OrganizationDecision[] = [
        ...options.accept.map((suggestionId) => ({ suggestionId, decision: 'accept' as const })),
        ...options.reject.map((suggestionId) => ({ suggestionId, decision: 'reject' as const })),
      ];
      try {
        const response = await createClient().applyOrganizationPlan(planId, decisions);
        printJson({ data: response.data });
        printSuccess('Applied the reviewed organization plan');
      } catch (error) { handleApiError(error); }
    });

  organize.command('undo')
    .description('Undo only the taxonomy and memberships introduced by one plan')
    .argument('<plan-id>', 'Applied organization plan UUID')
    .action(async (planId: string) => {
      try {
        const response = await createClient().undoOrganizationPlan(planId);
        printJson({ data: response.data });
        printSuccess('Undid the organization plan without deleting imported content');
      } catch (error) { handleApiError(error); }
    });
}
