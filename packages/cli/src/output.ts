/**
 * Output Formatting
 * Auto-detect TTY: tables for humans, JSON for pipes
 */

import chalk from 'chalk';

export type OutputMode = 'auto' | 'json' | 'table';

export interface LibraryScope {
  type: 'library';
  libraryId: string;
  librarySlug: string;
  libraryName: string;
  itemCount: number;
}

let forceMode: OutputMode = 'auto';

export function setOutputMode(mode: OutputMode): void {
  forceMode = mode;
}

function isInteractive(): boolean {
  if (forceMode === 'json') return false;
  if (forceMode === 'table') return true;
  return process.stdout.isTTY === true;
}

export function isInteractiveOutput(): boolean {
  return isInteractive();
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function printError(msg: string): void {
  process.stderr.write(chalk.red('Error: ') + msg + '\n');
}

export function printSuccess(msg: string): void {
  if (isInteractive()) {
    console.log(chalk.green('✓') + ' ' + msg);
  }
}

export function printHeader(msg: string): void {
  if (isInteractive()) {
    console.log('\n' + chalk.bold(msg));
  }
}

export function printWarning(msg: string): void {
  if (isInteractive()) {
    console.log(chalk.yellow('⚠') + ' ' + msg);
  }
}

function formatScope(scope: LibraryScope): string {
  return `Scope: library "${scope.librarySlug}" (${scope.itemCount} items)`;
}

export function printScope(scope: LibraryScope | undefined): void {
  if (scope && isInteractive()) {
    console.log(chalk.dim(formatScope(scope)));
  }
}

export function printSearchResults(
  data: { results: Array<Record<string, unknown>>; total: number; searchType: string },
  scope?: LibraryScope
): void {
  if (!isInteractive()) {
    printJson({ data, ...(scope ? { scope } : {}) });
    return;
  }

  printHeader(`Search Results (${data.total} total, ${data.searchType})`);
  printScope(scope);
  console.log();

  for (const item of data.results) {
    console.log(chalk.bold(item.title as string));
    const textKind = item.textKind ? ` | Text: ${item.textKind}` : '';
    console.log(`  ID: ${item.id} | Type: ${item.contentType}${textKind} | Score: ${(item.relevanceScore as number).toFixed(3)}`);
    if (item.summary) console.log(`  ${(item.summary as string).slice(0, 200)}`);
    console.log();
  }

}

export function printRetrievedItems(
  data: { items: Array<Record<string, unknown>> },
  scope?: LibraryScope
): void {
  if (!isInteractive()) {
    printJson({ data, ...(scope ? { scope } : {}) });
    return;
  }

  if (scope) {
    printScope(scope);
    console.log();
  }

  for (const item of data.items) {
    printHeader(item.title as string);
    const textKind = item.textKind ? ` | Text: ${item.textKind}` : '';
    console.log(`  Type: ${item.contentType}${textKind} | Created: ${item.createdAt}`);
    if (item.sourceUrl) console.log(`  URL: ${item.sourceUrl}`);
    if (item.summary) console.log(`\n  Summary: ${item.summary}`);
    if (item.content) console.log(`\n${item.content}`);
    console.log();
  }

}

export function printSchema(
  data: Record<string, unknown>
): void {
  if (!isInteractive()) {
    printJson({ data });
    return;
  }

  const types = data.contentTypes as Record<string, number>;
  const tags = data.tags as Array<Record<string, string | null>>;

  printHeader('Content Schema');
  console.log('\n  Content Types:');
  for (const [type, count] of Object.entries(types)) {
    console.log(`    ${type}: ${count} items`);
  }

  console.log(`\n  Tags: ${tags.length} total`);
  for (const tag of tags.slice(0, 20)) {
    const desc = tag.description ? ` — ${tag.description}` : '';
    console.log(`    [${tag.category || 'uncategorized'}] ${tag.label}${desc}`);
  }
  if (tags.length > 20) console.log(`    ... and ${tags.length - 20} more`);

  console.log(`\n  Capabilities: ${(data.capabilities as string[]).join(', ')}`);
  const dateRange = data.dateRange as { earliest: string | null; latest: string | null };
  console.log(`  Date Range: ${dateRange.earliest ?? 'n/a'} → ${dateRange.latest ?? 'n/a'}`);
}
