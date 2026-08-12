import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnswerEngineClient, LibraryScope } from '../api-client.js';
import { createClient } from '../client.js';
import { registerContentCommands } from '../commands/content.js';
import {
  isInteractiveOutput,
  printJson,
  printRetrievedItems,
  printSearchResults,
} from '../output.js';

vi.mock('../client.js', () => ({
  createClient: vi.fn(),
  handleApiError: vi.fn((error: unknown) => {
    throw error;
  }),
}));

vi.mock('../output.js', () => ({
  isInteractiveOutput: vi.fn(() => true),
  printHeader: vi.fn(),
  printJson: vi.fn(),
  printRetrievedItems: vi.fn(),
  printScope: vi.fn(),
  printSearchResults: vi.fn(),
}));

const libraryScope: LibraryScope = {
  type: 'library',
  libraryId: 'library-1',
  librarySlug: 'customer-wins',
  libraryName: 'Customer Wins',
  itemCount: 7,
};

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  registerContentCommands(program);
  return program;
}

describe('content commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isInteractiveOutput).mockReturnValue(true);
  });

  it('passes --library as librarySlug for search', async () => {
    const query = vi.fn().mockResolvedValue({
      data: { results: [], total: 0, searchType: 'hybrid', scope: libraryScope },
    });
    vi.mocked(createClient).mockReturnValue({ query } as unknown as AnswerEngineClient);

    await makeProgram().parseAsync(['node', 'ae', 'search', 'release', '--library', 'customer-wins']);

    expect(query).toHaveBeenCalledWith(expect.objectContaining({
      query: 'release',
      librarySlug: 'customer-wins',
    }));
    expect(query).toHaveBeenCalledWith({
      query: 'release',
      librarySlug: 'customer-wins',
      searchType: 'hybrid',
      limit: 10,
      include: ['summary'],
      filters: {
        contentTypes: undefined,
        tags: undefined,
      },
    });
    expect(printSearchResults).toHaveBeenCalledWith(
      expect.objectContaining({ scope: libraryScope }),
      libraryScope,
    );
  });

  it('passes --library as librarySlug for get', async () => {
    const retrieve = vi.fn().mockResolvedValue({
      data: { items: [], scope: libraryScope },
    });
    vi.mocked(createClient).mockReturnValue({ retrieve } as unknown as AnswerEngineClient);

    await makeProgram().parseAsync(['node', 'ae', 'get', 'item-1', '--library', 'customer-wins']);

    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({
      ids: ['item-1'],
      librarySlug: 'customer-wins',
    }));
    expect(retrieve).toHaveBeenCalledWith({
      ids: ['item-1'],
      librarySlug: 'customer-wins',
      include: ['summary', 'content', 'metadata'],
    });
    expect(printRetrievedItems).toHaveBeenCalledWith(
      expect.objectContaining({ scope: libraryScope }),
      libraryScope,
    );
  });

  it('rejects search include fields the OSS API does not return', async () => {
    const query = vi.fn();
    vi.mocked(createClient).mockReturnValue({ query } as unknown as AnswerEngineClient);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(
      makeProgram().parseAsync(['node', 'ae', 'search', 'release', '--include', 'artifacts']),
    ).rejects.toThrow('exit:2');
    expect(query).not.toHaveBeenCalled();

    exit.mockRestore();
    error.mockRestore();
  });

  it('passes --library as librarySlug for summarize and includes scope in JSON output', async () => {
    vi.mocked(isInteractiveOutput).mockReturnValue(false);
    const summarize = vi.fn().mockResolvedValue({
      data: { summary: 'Scoped summary', sourceCount: 3, prompt: 'risks', scope: libraryScope },
    });
    vi.mocked(createClient).mockReturnValue({ summarize } as unknown as AnswerEngineClient);

    await makeProgram().parseAsync(['node', 'ae', 'summarize', 'risks', '--library', 'customer-wins']);

    expect(summarize).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'risks',
      librarySlug: 'customer-wins',
    }));
    expect(printJson).toHaveBeenCalledWith(expect.objectContaining({
      scope: libraryScope,
    }));
  });
});
