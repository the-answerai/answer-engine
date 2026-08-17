import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const target = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: checksums.mjs <artifact-directory>');

const files = readdirSync(target)
  .map((name) => join(target, name))
  .filter((path) => statSync(path).isFile() && basename(path) !== 'SHA256SUMS')
  .sort();
if (files.length === 0) throw new Error(`No release artifacts found in ${target}.`);

const lines = files.map((path) => `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${basename(path)}`);
writeFileSync(join(target, 'SHA256SUMS'), `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o644 });
process.stdout.write(`${lines.length} artifact checksum(s) written.\n`);
