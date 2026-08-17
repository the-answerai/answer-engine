#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  lutimesSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function fail(message) {
  process.stderr.write(`[release-assets] ${message}\n`);
  process.exit(1);
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) fail(`missing --${name}`);
  return process.argv[index + 1];
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function subject(path) {
  return { name: basename(path), sha256: sha256(path), bytes: statSync(path).size };
}

function archiveEntries(root, relative = '.') {
  const directory = relative === '.' ? root : join(root, relative);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = relative === '.' ? entry.name : join(relative, entry.name);
    return entry.isDirectory() ? [path, ...archiveEntries(root, path)] : [path];
  }).sort();
}

function normalizeTree(root) {
  const epoch = new Date(0);
  for (const relative of archiveEntries(root).reverse()) {
    const path = join(root, relative);
    try { lutimesSync(path, epoch, epoch); } catch { utimesSync(path, epoch, epoch); }
  }
  utimesSync(root, epoch, epoch);
}

function pruneDeployMetadata(root) {
  for (const relative of archiveEntries(root).reverse()) {
    if (relative.split('/').at(-1) === '.bin' || relative.endsWith('.modules.yaml')) {
      rmSync(join(root, relative), { recursive: true, force: true });
    }
  }
}

function createArchive(stage, output, listPath) {
  const tarPath = `${listPath}.tar`;
  const tarVersion = execFileSync('tar', ['--version'], { encoding: 'utf8' });
  if (!tarVersion.toLowerCase().includes('bsdtar')) {
    execFileSync('tar', [
      '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner',
      '-cf', tarPath, '-C', stage, '.',
    ]);
  } else {
    normalizeTree(stage);
    writeFileSync(listPath, `${archiveEntries(stage).map((entry) => `./${entry}`).join('\n')}\n`);
    execFileSync('tar', [
      '--no-recursion', '--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root',
      '-cf', tarPath, '-C', stage, '-T', listPath,
    ]);
  }
  execFileSync('gzip', ['-n', '-9', tarPath]);
  renameSync(`${tarPath}.gz`, output);
}

const repositoryRoot = resolve(new URL('..', import.meta.url).pathname);
const tag = argument('tag');
const sourceCommit = argument('commit');
const runtimeImage = argument('image');
const outputDirectory = resolve(argument('output'));
if (!/^v\d+\.\d+\.\d+$/.test(tag)) fail('tag must be an exact semantic version such as v1.1.0');
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) fail('commit must be a full 40-character Git commit');
if (!/@sha256:[a-f0-9]{64}$/.test(runtimeImage)) fail('image must use an exact @sha256 digest');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
if (head !== sourceCommit) fail(`checked-out commit ${head} does not match requested ${sourceCommit}`);
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
  cwd: repositoryRoot, encoding: 'utf8',
}).trim();
if (dirty) fail('release assets require a clean exact-commit checkout');
try {
  const taggedCommit = execFileSync('git', ['rev-parse', `${tag}^{commit}`], {
    cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (taggedCommit !== sourceCommit) fail(`${tag} points to ${taggedCommit}, not ${sourceCommit}`);
} catch {
  process.stdout.write(`[release-assets] ${tag} is not published; building a commit-pinned candidate only.\n`);
}

const version = tag.slice(1);
const createPackage = JSON.parse(readFileSync(join(repositoryRoot, 'packages/create/package.json'), 'utf8'));
const cliPackage = JSON.parse(readFileSync(join(repositoryRoot, 'packages/cli/package.json'), 'utf8'));
if (createPackage.version !== version || cliPackage.version !== version) {
  fail('tag, installer package, and CLI package versions must agree');
}
for (const path of ['packages/create/dist/index.js', 'packages/cli/dist/index.js']) {
  if (!existsSync(join(repositoryRoot, path))) fail(`${path} is missing; build packages before release assembly`);
}

const localTemporaryRoot = join(repositoryRoot, 'tmp');
mkdirSync(localTemporaryRoot, { recursive: true });
if (existsSync(outputDirectory)) fail(`output directory already exists: ${outputDirectory}`);
const staging = mkdtempSync(join(localTemporaryRoot, 'answer-engine-release-'));
mkdirSync(outputDirectory, { recursive: true });
try {
  const installerStage = join(staging, 'installer');
  const cliStage = join(staging, 'cli');
  execFileSync('pnpm', ['--filter', '@answer-engine/create', 'deploy', '--legacy', '--prod', installerStage], {
    cwd: repositoryRoot, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' },
  });
  execFileSync('pnpm', ['--filter', '@answer-engine/cli', 'deploy', '--legacy', '--prod', cliStage], {
    cwd: repositoryRoot, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' },
  });
  const releaseModule = await import(pathToFileURL(join(repositoryRoot, 'packages/create/dist/release.js')).href);
  const baseManifest = releaseModule.loadReleaseManifestTemplate(
    join(repositoryRoot, 'packages/create/release-manifest.json'),
  );
  const pinnedManifest = releaseModule.verifyReleaseManifest({
    ...baseManifest,
    sourceCommit,
    images: { ...baseManifest.images, answerEngine: runtimeImage },
  });
  writeFileSync(join(installerStage, 'release-manifest.json'), `${JSON.stringify(pinnedManifest, null, 2)}\n`);
  pruneDeployMetadata(installerStage);
  pruneDeployMetadata(cliStage);

  const installerAsset = join(outputDirectory, `answer-engine-installer-v${version}.tgz`);
  const cliAsset = join(outputDirectory, `answer-engine-cli-v${version}.tgz`);
  let archiveIndex = 0;
  for (const [stage, output] of [[installerStage, installerAsset], [cliStage, cliAsset]]) {
    createArchive(stage, output, join(staging, `archive-${archiveIndex}.list`));
    archiveIndex += 1;
  }

  const bashAsset = join(outputDirectory, `answer-engine-bootstrap-v${version}.sh`);
  const powershellAsset = join(outputDirectory, `answer-engine-bootstrap-v${version}.ps1`);
  cpSync(join(repositoryRoot, 'scripts/release/bootstrap.sh'), bashAsset);
  cpSync(join(repositoryRoot, 'scripts/release/bootstrap.ps1'), powershellAsset);
  chmodSync(bashAsset, 0o755);
  const installPrompt = join(outputDirectory, 'INSTALL_AGENT.md');
  cpSync(join(repositoryRoot, 'INSTALL_AGENT.md'), installPrompt);

  const lockfile = join(repositoryRoot, 'pnpm-lock.yaml');
  const initialSubjects = [installerAsset, cliAsset, bashAsset, powershellAsset, installPrompt].map(subject);
  const provenancePath = join(outputDirectory, 'provenance.json');
  writeFileSync(provenancePath, `${JSON.stringify({
    predicateType: 'https://slsa.dev/provenance/v1',
    buildType: 'https://github.com/the-answerai/answer-engine/release-assets@v1',
    invocation: { tag, sourceCommit, runtimeImage, packageManager: 'pnpm@10.33.0' },
    materials: [
      { name: 'git+https://github.com/the-answerai/answer-engine', gitCommit: sourceCommit },
      { name: 'pnpm-lock.yaml', sha256: sha256(lockfile) },
      { name: 'runtime-image', digest: runtimeImage.split('@')[1] },
    ],
    subjects: initialSubjects,
  }, null, 2)}\n`);

  const releaseManifestPath = join(outputDirectory, 'release-manifest.json');
  const releaseArtifacts = [...initialSubjects, subject(provenancePath)];
  writeFileSync(releaseManifestPath, `${JSON.stringify({
    ...pinnedManifest,
    releaseArtifacts,
  }, null, 2)}\n`);

  const checksumTargets = [...releaseArtifacts.map((entry) => join(outputDirectory, entry.name)), releaseManifestPath];
  writeFileSync(join(outputDirectory, 'SHA256SUMS'), `${checksumTargets
    .map((path) => `${sha256(path)}  ${basename(path)}`).sort().join('\n')}\n`);
  process.stdout.write(`[release-assets] wrote verified candidate assets for ${tag} from ${sourceCommit} to ${outputDirectory}\n`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
