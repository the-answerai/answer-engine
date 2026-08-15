import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

export function assertRegularFileTarget(path: string, label: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link.`);
  }
}

export function writePrivateFileAtomic(path: string, contents: string, label: string): void {
  assertRegularFileTarget(path, label);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}
