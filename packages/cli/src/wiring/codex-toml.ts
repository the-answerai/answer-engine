import { parse, stringify } from 'smol-toml';
import { buildMcpEntry } from './mcp-entry.js';
import type { WiringInput } from './types.js';

interface TomlSection {
  start: number;
  end: number;
  name: string;
}

const tableHeaderPattern = /^[ \t]*\[{1,2}([^\]\r\n]+)\]{1,2}[^\r\n]*(?:\r?\n|$)/gm;

function parseTomlConfig(contents: string): void {
  try {
    parse(contents);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Codex TOML config: ${reason}`);
  }
}

function sectionsIn(contents: string): TomlSection[] {
  const headers = [...contents.matchAll(tableHeaderPattern)];
  return headers.map((match, index) => ({
    start: match.index,
    end: headers[index + 1]?.index ?? contents.length,
    name: match[1].trim(),
  }));
}

function isAnswerEngineSection(name: string): boolean {
  return /^mcp_servers\s*\.\s*answer-engine(?:\s*\.|$)/.test(name);
}

export function renderCodexTomlBlock(input: WiringInput): string {
  return stringify({
    mcp_servers: {
      'answer-engine': buildMcpEntry(input),
    },
  }).trimEnd();
}

export function mergeCodexToml(existing: string, input: WiringInput): string {
  if (existing.length > 0) parseTomlConfig(existing);

  const block = `${renderCodexTomlBlock(input)}\n`;
  const answerSections = sectionsIn(existing).filter((section) => isAnswerEngineSection(section.name));
  let merged: string;

  if (answerSections.length === 0) {
    const separator = existing.length === 0
      ? ''
      : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    merged = `${existing}${separator}${block}`;
  } else {
    let cursor = 0;
    let inserted = false;
    const chunks: string[] = [];
    for (const section of answerSections) {
      chunks.push(existing.slice(cursor, section.start));
      if (!inserted) {
        chunks.push(block);
        inserted = true;
      }
      cursor = section.end;
    }
    // `block` ends in a single newline. Only add a blank-line separator when
    // real content follows the replaced section(s); a trailing answer-engine
    // block must stay byte-stable so re-wiring is idempotent.
    const tail = existing.slice(cursor);
    chunks.push(tail.length === 0 || tail.startsWith('\n') ? tail : `\n${tail}`);
    merged = chunks.join('');
  }

  parseTomlConfig(merged);
  return merged;
}
