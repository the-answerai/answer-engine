import { rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = resolve(fileURLToPath(new URL('../../../tmp/desktop-release/', import.meta.url)));
if (basename(target) !== 'desktop-release' || basename(dirname(target)) !== 'tmp') {
  throw new Error(`Refusing to clean unexpected release path: ${target}`);
}
rmSync(target, { recursive: true, force: true });
process.stdout.write(`Removed generated desktop release output: ${target}\n`);
