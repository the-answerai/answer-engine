#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  assertReleaseManifestAgreement,
  verifyBundledRelease,
  verifyDownloadedRelease,
} from './release.js';

function run(): void {
  const root = resolve(z.string().min(1).parse(process.argv[2]));
  const platform = z.enum(['macos', 'windows-wsl2']).parse(process.argv[3]);
  const architecture = z.enum(['arm64', 'x64']).parse(process.argv[4]);
  const downloaded = verifyDownloadedRelease(
    JSON.parse(readFileSync(join(root, 'release-manifest.json'), 'utf8')),
    root,
    platform,
    architecture,
  );
  assertReleaseManifestAgreement(downloaded, verifyBundledRelease());
  process.stdout.write(`Verified immutable Answer Engine release ${downloaded.tag}.\n`);
}

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Release verification failed: ${message}\n`);
  process.exitCode = 1;
}
