import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerEngineClient } from '../api-client.js';
import { createClient } from '../client.js';
import { registerOrganizationCommands } from '../commands/organize.js';
import { printJson, printSuccess } from '../output.js';

vi.mock('../client.js', () => ({
  createClient: vi.fn(),
  handleApiError: vi.fn((error: unknown) => { throw error; }),
}));
vi.mock('../output.js', () => ({ printJson: vi.fn(), printSuccess: vi.fn() }));

function program(): Command {
  const root = new Command();
  root.exitOverride();
  root.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerOrganizationCommands(root);
  return root;
}

describe('organization commands', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps model use explicit and forwards the bounded sample size', async () => {
    const createOrganizationProposal = vi.fn().mockResolvedValue({ data: { id: 'plan-1', suggestions: [] } });
    vi.mocked(createClient).mockReturnValue({ createOrganizationProposal } as unknown as AnswerEngineClient);

    await program().parseAsync(['node', 'ae', 'organize', 'propose', '--use-model', '--limit', '25']);

    expect(createOrganizationProposal).toHaveBeenCalledWith({ useModel: true, limit: 25 });
    expect(printJson).toHaveBeenCalledWith({ data: { id: 'plan-1', suggestions: [] } });
  });

  it('refuses to exceed the documented metadata exposure ceiling', async () => {
    const createOrganizationProposal = vi.fn();
    vi.mocked(createClient).mockReturnValue({ createOrganizationProposal } as unknown as AnswerEngineClient);

    await expect(program().parseAsync(['node', 'ae', 'organize', 'propose', '--limit', '51']))
      .rejects.toThrow(/1 to 50/);
    expect(createOrganizationProposal).not.toHaveBeenCalled();
  });

  it('submits each explicit accept and reject decision', async () => {
    const applyOrganizationPlan = vi.fn().mockResolvedValue({ data: { id: 'plan-1', status: 'applied' } });
    vi.mocked(createClient).mockReturnValue({ applyOrganizationPlan } as unknown as AnswerEngineClient);

    await program().parseAsync([
      'node', 'ae', 'organize', 'apply', 'plan-1',
      '--accept', 's-1111111111111111', '--accept', 's-2222222222222222',
      '--reject', 's-3333333333333333',
    ]);

    expect(applyOrganizationPlan).toHaveBeenCalledWith('plan-1', [
      { suggestionId: 's-1111111111111111', decision: 'accept' },
      { suggestionId: 's-2222222222222222', decision: 'accept' },
      { suggestionId: 's-3333333333333333', decision: 'reject' },
    ]);
    expect(printSuccess).toHaveBeenCalledWith('Applied the reviewed organization plan');
  });

  it('undoes one plan without exposing a content deletion option', async () => {
    const undoOrganizationPlan = vi.fn().mockResolvedValue({ data: { id: 'plan-1', status: 'undone' } });
    vi.mocked(createClient).mockReturnValue({ undoOrganizationPlan } as unknown as AnswerEngineClient);

    await program().parseAsync(['node', 'ae', 'organize', 'undo', 'plan-1']);

    expect(undoOrganizationPlan).toHaveBeenCalledWith('plan-1');
    expect(printSuccess).toHaveBeenCalledWith(expect.stringContaining('without deleting imported content'));
  });
});
