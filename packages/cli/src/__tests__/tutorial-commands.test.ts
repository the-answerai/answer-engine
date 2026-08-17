import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerEngineClient } from '../api-client.js';
import { createClient } from '../client.js';
import { registerTutorialCommands } from '../commands/tutorial.js';
import { printJson, printSuccess } from '../output.js';

vi.mock('../client.js', () => ({ createClient: vi.fn(), handleApiError: vi.fn((error: unknown) => { throw error; }) }));
vi.mock('../output.js', () => ({ printJson: vi.fn(), printSuccess: vi.fn() }));

function program() { const root = new Command(); root.exitOverride(); root.configureOutput({ writeOut: () => undefined, writeErr: () => undefined }); registerTutorialCommands(root); return root; }

describe('tutorial commands', () => {
  beforeEach(() => vi.clearAllMocks());

  it('starts a cross-client challenge with explicit clients', async () => {
    const createRecallTutorial = vi.fn().mockResolvedValue({ data: { id: 'tutorial-1', status: 'planned' } });
    vi.mocked(createClient).mockReturnValue({ createRecallTutorial } as unknown as AnswerEngineClient);
    await program().parseAsync(['node', 'ae', 'tutorial', 'start', '--write-client', 'codex', '--recall-client', 'claude-code']);
    expect(createRecallTutorial).toHaveBeenCalledWith({ writeClient: 'codex', recallClient: 'claude-code', environment: 'native' });
    expect(printSuccess).toHaveBeenCalledWith(expect.stringContaining('harmless'));
  });

  it('forwards diagnostics without claiming proof completion', async () => {
    const checkRecallTutorial = vi.fn().mockResolvedValue({ data: { id: 'tutorial-1', status: 'remembered', diagnostic: { code: 'access' } } });
    vi.mocked(createClient).mockReturnValue({ checkRecallTutorial } as unknown as AnswerEngineClient);
    await program().parseAsync(['node', 'ae', 'tutorial', 'check', 'tutorial-1', '--report', 'access']);
    expect(checkRecallTutorial).toHaveBeenCalledWith('tutorial-1', 'access');
    expect(printJson).toHaveBeenCalled();
    expect(printSuccess).not.toHaveBeenCalled();
  });

  it('prints success only for audited completion', async () => {
    const checkRecallTutorial = vi.fn().mockResolvedValue({ data: { id: 'tutorial-1', status: 'verified' } });
    vi.mocked(createClient).mockReturnValue({ checkRecallTutorial } as unknown as AnswerEngineClient);
    await program().parseAsync(['node', 'ae', 'tutorial', 'check', 'tutorial-1']);
    expect(printSuccess).toHaveBeenCalledWith(expect.stringContaining('source evidence'));
  });
});
