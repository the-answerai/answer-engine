/**
 * Content Commands
 * ae search, ae get, ae summarize
 */

import { Command } from 'commander';
import {
  isInteractiveOutput,
  printHeader,
  printJson,
  printRetrievedItems,
  printScope,
  printSearchResults,
} from '../output.js';
import { createClient, handleApiError } from '../client.js';

const SEARCH_INCLUDE_KEYS = [
  'summary',
  'content',
  'metadata',
] as const;

const RETRIEVE_INCLUDE_KEYS = [
  'summary',
  'content',
  'metadata',
] as const;

function parseCsv(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function parseLibrarySlug(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

function parseInclude<T extends string>(
  raw: string,
  validKeys: readonly T[],
  flagName: string,
): T[] {
  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = requested.filter(
    (v) => !(validKeys as readonly string[]).includes(v),
  );
  if (invalid.length) {
    console.error(
      `Invalid ${flagName} value(s): ${invalid.join(', ')}. ` +
        `Valid: ${validKeys.join(', ')}`,
    );
    process.exit(2);
  }
  return requested as T[];
}

export function registerContentCommands(program: Command): void {
  program
    .command('search')
    .description('Search content')
    .argument('<query>', 'Search query text')
    .option('-t, --type <type>', 'Search type: hybrid, fulltext, semantic', 'hybrid')
    .option('-l, --limit <n>', 'Max results', '10')
    .option('--include <fields>', 'Include fields (comma-separated: summary,content,metadata)', 'summary')
    .option('--content-types <types>', 'Filter by content types (comma-separated)')
    .option('--tags <tags>', 'Filter by tag slugs (comma-separated)')
    .option('--library <slug>', 'Scope search to a content library slug')
    .action(async (query: string, opts: { type: string; limit: string; include: string; contentTypes?: string; tags?: string; library?: string }) => {
      const client = createClient();
      try {
        const response = await client.query({
          query,
          librarySlug: parseLibrarySlug(opts.library),
          searchType: opts.type as 'fulltext' | 'semantic' | 'hybrid',
          limit: parseInt(opts.limit, 10),
          include: parseInclude(opts.include, SEARCH_INCLUDE_KEYS, '--include'),
          filters: {
            contentTypes: parseCsv(opts.contentTypes),
            tags: parseCsv(opts.tags),
          },
        });
        printSearchResults(
          response.data as unknown as { results: Array<Record<string, unknown>>; total: number; searchType: string },
          response.data.scope
        );
      } catch (error) {
        handleApiError(error);
      }
    });

  program
    .command('get')
    .description('Retrieve content items by ID')
    .argument('<ids...>', 'Content item UUIDs')
    .option(
      '--include <fields>',
      'Include fields (comma-separated): summary, content, metadata',
      'summary,content,metadata',
    )
    .option('--library <slug>', 'Scope retrieval to a content library slug')
    .action(async (ids: string[], opts: { include: string; library?: string }) => {
      const client = createClient();
      try {
        const response = await client.retrieve({
          ids,
          librarySlug: parseLibrarySlug(opts.library),
          include: parseInclude(opts.include, RETRIEVE_INCLUDE_KEYS, '--include'),
        });
        printRetrievedItems(
          response.data as unknown as { items: Array<Record<string, unknown>> },
          response.data.scope
        );
      } catch (error) {
        handleApiError(error);
      }
    });

  program
    .command('summarize')
    .description('Summarize content with AI')
    .argument('<prompt>', 'What to summarize or analyze')
    .option('-l, --limit <n>', 'Max items to analyze', '20')
    .option('--content-types <types>', 'Filter by content types (comma-separated)')
    .option('--tags <tags>', 'Filter by tag slugs (comma-separated)')
    .option('--library <slug>', 'Scope summary to a content library slug')
    .action(async (prompt: string, opts: { limit: string; contentTypes?: string; tags?: string; library?: string }) => {
      const client = createClient();
      try {
        const response = await client.summarize({
          prompt,
          librarySlug: parseLibrarySlug(opts.library),
          limit: parseInt(opts.limit, 10),
          filter: {
            contentTypes: parseCsv(opts.contentTypes),
            tags: parseCsv(opts.tags),
          },
        });

        if (!isInteractiveOutput()) {
          printJson({
            data: response.data,
            ...(response.data.scope ? { scope: response.data.scope } : {}),
          });
          return;
        }

        printHeader(`Summary (${response.data.sourceCount} sources analyzed)`);
        printScope(response.data.scope);
        console.log();
        console.log(response.data.summary);
        console.log();
      } catch (error) {
        handleApiError(error);
      }
    });
}
