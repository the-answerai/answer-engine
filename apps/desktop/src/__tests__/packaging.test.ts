import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('desktop packaging policy', () => {
  it('builds signed-platform-ready macOS and Windows artifacts without publishing', () => {
    const config = readFileSync(join(packageRoot, 'electron-builder.yml'), 'utf8');
    expect(config).toContain('hardenedRuntime: true');
    expect(config).toContain('target: dmg');
    expect(config).toContain('target: zip');
    expect(config).toContain('target: nsis');
    expect(config).toContain('deleteAppDataOnUninstall: false');
    expect(config).toContain('publish: null');
    expect(config).toContain('output: ../../tmp/desktop-release');
    expect(readFileSync(join(packageRoot, 'assets/icon.svg'), 'utf8')).toContain('aria-label="Answer Engine"');
    const cleaner = readFileSync(join(packageRoot, 'scripts/clean-release.mjs'), 'utf8');
    expect(cleaner).toContain("basename(target) !== 'desktop-release'");
    expect(cleaner).toContain("basename(dirname(target)) !== 'tmp'");
  });

  it('ships a restrictive CSP and an unmistakable staging treatment', () => {
    const html = readFileSync(join(packageRoot, 'src/renderer/index.html'), 'utf8');
    const css = readFileSync(join(packageRoot, 'src/renderer/styles.css'), 'utf8');
    const renderer = readFileSync(join(packageRoot, 'src/renderer/renderer.js'), 'utf8');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('STAGING · ISOLATED DATA');
    expect(html).toContain('Demo mode');
    expect(css).toContain('body[data-channel="staging"]');
    expect(css).toContain('body[data-runtime-mode="fixture"]');
    expect(css).toContain('[hidden] { display: none !important; }');
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(renderer).toContain('returnFocus?.focus()');
    expect(renderer).toContain("document.querySelector('#refresh').focus()");
  });
});
