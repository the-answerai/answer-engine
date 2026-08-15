import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const start = '<!-- INSTALL_PROMPT:START -->';
const end = '<!-- INSTALL_PROMPT:END -->';

function promptBlock(path: string): string {
  const contents = readFileSync(resolve(path), 'utf8');
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end);
  expect(startIndex, `${path} start marker`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `${path} end marker`).toBeGreaterThan(startIndex);
  return contents.slice(startIndex + start.length, endIndex).trim();
}

describe('canonical one-prompt installer copy', () => {
  it('keeps README surfaces byte-for-byte synchronized with INSTALL_AGENT.md', () => {
    const canonical = promptBlock('INSTALL_AGENT.md');

    expect(promptBlock('README.md')).toBe(canonical);
    expect(promptBlock('packages/create/README.md')).toBe(canonical);
    expect(canonical).toContain('@answer-engine/create@1.1.0 preflight --json');
    expect(canonical).toContain('/v1.1.0/');
    expect(canonical).not.toContain('/master/');
  });
});
