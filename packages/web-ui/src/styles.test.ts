import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Blueprint app styling', () => {
  it('uses semantic design tokens instead of component-level hex colors', () => {
    const path = resolve(process.cwd(), 'src/styles.css');
    const css = readFileSync(path, 'utf8');

    expect(css).toContain('var(--surface)');
    expect(css).toContain('var(--accent)');
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it('includes responsive and reduced-motion rules', () => {
    const path = resolve(process.cwd(), 'src/styles.css');
    const css = readFileSync(path, 'utf8');

    expect(css).toContain('@media (max-width: 780px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
