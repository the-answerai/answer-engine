import {
  findNodeAtLocation,
  parse,
  parseTree,
  printParseErrorCode,
} from 'jsonc-parser';
import type { Node, ParseError } from 'jsonc-parser';
import { buildMcpEntry } from './mcp-entry.js';
import type { WiringInput } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonConfig(contents: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed = parse(contents, errors, {
    allowTrailingComma: false,
    disallowComments: false,
  }) as unknown;
  if (errors.length > 0) {
    const details = errors.map((error) => printParseErrorCode(error.error)).join(', ');
    throw new Error(`Invalid JSON MCP config: ${details}`);
  }
  if (!isRecord(parsed)) throw new Error('Invalid JSON MCP config: root must be an object');
  if (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)) {
    throw new Error('Invalid JSON MCP config: mcpServers must be an object');
  }
  return parsed;
}

export function mergeJsonClientConfig(existing: string, input: WiringInput): string {
  const source = existing.trim().length === 0 ? '{}' : existing;
  parseJsonConfig(source);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const root = parseTree(source);
  if (!root || root.type !== 'object') {
    throw new Error('Invalid JSON MCP config: root must be an object');
  }

  const mcpServers = findNodeAtLocation(root, ['mcpServers']);
  const merged = mcpServers
    ? setObjectProperty(source, mcpServers, 'answer-engine', buildMcpEntry(input), eol)
    : setObjectProperty(
      source,
      root,
      'mcpServers',
      { 'answer-engine': buildMcpEntry(input) },
      eol,
    );
  parseJsonConfig(merged);
  return merged.endsWith(eol) ? merged : `${merged}${eol}`;
}

export function removeJsonClientConfig(existing: string): string {
  if (existing.trim().length === 0) return existing;
  parseJsonConfig(existing);
  const root = parseTree(existing);
  if (!root || root.type !== 'object') {
    throw new Error('Invalid JSON MCP config: root must be an object');
  }
  const mcpServers = findNodeAtLocation(root, ['mcpServers']);
  if (!mcpServers) return existing;
  const answerEngine = findNodeAtLocation(mcpServers, ['answer-engine']);
  if (!answerEngine?.parent) return existing;
  const property = answerEngine.parent;
  const properties = mcpServers.children ?? [];
  const index = properties.indexOf(property);
  if (index < 0) return existing;

  let start = property.offset;
  let end = property.offset + property.length;
  if (properties.length === 1) {
    start = mcpServers.offset + 1;
    end = mcpServers.offset + mcpServers.length - 1;
  } else if (index < properties.length - 1) {
    end = properties[index + 1].offset;
  } else {
    start = properties[index - 1].offset + properties[index - 1].length;
  }
  const removed = `${existing.slice(0, start)}${existing.slice(end)}`;
  parseJsonConfig(removed);
  return removed;
}

export function restoreJsonClientConfig(existing: string, original: string): string {
  const originalRoot = parseJsonConfig(original.trim().length === 0 ? '{}' : original);
  const originalServers = originalRoot.mcpServers as Record<string, unknown> | undefined;
  if (!originalServers || !Object.hasOwn(originalServers, 'answer-engine')) {
    return removeJsonClientConfig(existing);
  }
  const source = existing.trim().length === 0 ? '{}' : existing;
  parseJsonConfig(source);
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const root = parseTree(source);
  if (!root || root.type !== 'object') {
    throw new Error('Invalid JSON MCP config: root must be an object');
  }
  const mcpServers = findNodeAtLocation(root, ['mcpServers']);
  const restored = mcpServers
    ? setObjectProperty(source, mcpServers, 'answer-engine', originalServers['answer-engine'], eol)
    : setObjectProperty(
      source,
      root,
      'mcpServers',
      { 'answer-engine': originalServers['answer-engine'] },
      eol,
    );
  parseJsonConfig(restored);
  return restored.endsWith(eol) ? restored : `${restored}${eol}`;
}

function lineIndentAt(contents: string, offset: number): string {
  const lineStart = Math.max(contents.lastIndexOf('\n', offset - 1) + 1, 0);
  return contents.slice(lineStart, offset).match(/^[ \t]*/)?.[0] ?? '';
}

function indentJson(value: unknown, indent: string, eol: string): string {
  return JSON.stringify(value, null, 2).replaceAll('\n', `${eol}${indent}`);
}

function setObjectProperty(
  contents: string,
  objectNode: Node,
  propertyName: string,
  value: unknown,
  eol: string,
): string {
  if (objectNode.type !== 'object') {
    throw new Error('Invalid JSON MCP config: mcpServers must be an object');
  }

  const existingValue = findNodeAtLocation(objectNode, [propertyName]);
  if (existingValue) {
    const propertyIndent = lineIndentAt(contents, existingValue.parent?.offset ?? existingValue.offset);
    const rendered = indentJson(value, propertyIndent, eol);
    return `${contents.slice(0, existingValue.offset)}${rendered}${contents.slice(existingValue.offset + existingValue.length)}`;
  }

  const properties = objectNode.children ?? [];
  const parentIndent = lineIndentAt(contents, objectNode.parent?.offset ?? objectNode.offset);
  const childIndent = properties[0]
    ? lineIndentAt(contents, properties[0].offset)
    : `${parentIndent}  `;
  const rendered = `${JSON.stringify(propertyName)}: ${indentJson(value, childIndent, eol)}`;
  const closeBraceOffset = objectNode.offset + objectNode.length - 1;

  if (properties.length === 0) {
    const replacement = `${eol}${childIndent}${rendered}${eol}${parentIndent}`;
    return `${contents.slice(0, objectNode.offset + 1)}${replacement}${contents.slice(closeBraceOffset)}`;
  }

  const lastProperty = properties.at(-1);
  if (!lastProperty) throw new Error('Unable to locate JSON object property');
  const insertion = `,${eol}${childIndent}${rendered}`;
  const insertionOffset = lastProperty.offset + lastProperty.length;
  return `${contents.slice(0, insertionOffset)}${insertion}${contents.slice(insertionOffset)}`;
}
