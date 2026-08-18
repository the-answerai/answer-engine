import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(path), 'utf8');
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function executable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function bootstrapFixture(platform: 'macos' | 'windows-wsl2', node: 'ready' | 'missing') {
  const fixture = mkdtempSync(join(tmpdir(), 'ae-bootstrap-test-'));
  fixtures.push(fixture);
  const bin = join(fixture, 'bin');
  const home = join(fixture, 'home');
  const temporary = join(fixture, 'tmp');
  mkdirSync(bin);
  mkdirSync(home);
  mkdirSync(temporary);
  executable(join(bin, 'uname'), platform === 'macos'
    ? '#!/bin/sh\n[ "$1" = "-s" ] && echo Darwin || echo arm64\n'
    : '#!/bin/sh\n[ "$1" = "-s" ] && echo Linux || echo x86_64\n');
  executable(join(bin, 'grep'), platform === 'windows-wsl2'
    ? '#!/bin/sh\nexit 0\n' : '#!/bin/sh\nexec /usr/bin/grep "$@"\n');
  executable(join(bin, 'docker'), `#!/bin/sh
if [ "$1" = "info" ]; then echo 27.0.0; exit 0; fi
if [ "$1" = "compose" ]; then echo 2.30.0; exit 0; fi
exit 1
`);
  executable(join(bin, 'node'), node === 'ready'
    ? '#!/bin/sh\n[ "$1" = "--version" ] && echo v22.16.0\nexit 0\n'
    : '#!/bin/sh\nexit 1\n');
  return {
    fixture,
    bin,
    home,
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: temporary,
      PATH: `${bin}:/usr/bin:/bin`,
    },
  };
}

describe('immutable installer release assets', () => {
  it('keeps both bootstrap paths pinned, checksum-first, and dependency-aware', () => {
    const bash = read('scripts/release/bootstrap.sh');
    const powershell = read('scripts/release/bootstrap.ps1');
    const installAgent = read('INSTALL_AGENT.md');

    expect(spawnSync('bash', ['-n', 'scripts/release/bootstrap.sh']).status).toBe(0);
    expect(bash).toContain('/releases/download/${TAG}');
    const verificationLoop = 'do verify_from_sums "$asset"; done';
    expect(bash).toContain(verificationLoop);
    expect(bash.indexOf(verificationLoop))
      .toBeLessThan(bash.indexOf('tar -xzf "$STAGING_DIRECTORY/$INSTALLER_ASSET"'));
    expect(bash).toContain('--preflight');
    expect(bash).toContain('Install or start Docker Desktop manually');
    expect(bash).toContain('Node.js 22.16.0 can be installed');
    expect(bash).toContain('Refusing a floating release input.');
    expect(bash).toContain('NODE_EXECUTABLE="$(command -v node)"');
    expect(bash).toContain('exec "$NODE_EXECUTABLE" "$target" "$@"');
    expect(bash).not.toContain('ln -s "$target" "$launcher"');
    expect(bash).toContain('dist/verify-release-download.js');
    expect(bash.indexOf('dist/verify-release-download.js'))
      .toBeLessThan(bash.indexOf('INSTALL_ROOT="${HOME}/.local/share/answer-engine/releases/${VERSION}"'));
    expect(bash).toContain('"$BASH_ASSET" "$POWERSHELL_ASSET" INSTALL_AGENT.md');

    expect(powershell).toContain('Get-FileHash -Algorithm SHA256');
    expect(powershell.indexOf('Get-FileHash -Algorithm SHA256'))
      .toBeLessThan(powershell.indexOf('& wsl.exe bash'));
    expect(powershell).toContain('Windows 11 build 22000');
    expect(powershell).toContain('WSL2 is required');
    expect(installAgent).toContain(createHash('sha256').update(bash).digest('hex'));
    expect(installAgent).toContain(createHash('sha256').update(powershell).digest('hex'));
  });

  it('builds candidates from exact inputs without an npm publication step', () => {
    const builder = read('scripts/build-release-assets.mjs');
    const workflow = read('.github/workflows/release-installer.yml');
    const runtimeWorkflow = read('.github/workflows/release-runtime-image.yml');
    const sourceManifest = read('packages/create/release-manifest.json');

    expect(builder).toContain('checked-out commit');
    expect(builder).toContain("'--sort=name', '--mtime=@0'");
    expect(builder).toContain('pruneDeployMetadata(installerStage)');
    expect(builder).toContain('loadReleaseManifestTemplate');
    expect(builder).toContain('verifyReleaseManifest');
    expect(builder).toContain('provenance.json');
    expect(sourceManifest).toContain('__RELEASE_SOURCE_COMMIT__');
    expect(sourceManifest).toContain('__ANSWER_ENGINE_RUNTIME_IMAGE__');
    expect(sourceManifest).not.toContain('c0fa1c0f0771800e40b678ff42c43f1c26e322020bec9cd713d7198dd0ab165f');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('production-release');
    expect(workflow).toContain('sha256sum --check SHA256SUMS');
    expect(workflow).toContain('$RUNNER_TEMP/runtime-index.json');
    expect(workflow).not.toContain('> runtime-index.json');
    expect(workflow).toContain('RUNTIME_IMAGE: ${{ inputs.runtime_image }}');
    expect(workflow).toContain('--image "$RUNTIME_IMAGE"');
    expect(workflow).not.toContain("--image '${{ inputs.runtime_image }}'");
    expect(workflow).toContain('^ghcr\\.io/the-answerai/answer-engine@sha256:');
    expect(workflow).not.toContain('--clobber');
    expect(runtimeWorkflow).toContain('workflow_dispatch:');
    expect(runtimeWorkflow).toContain('environment: production-release');
    expect(runtimeWorkflow).toContain('packages: write');
    expect(runtimeWorkflow).toContain('^v[0-9]+\\.[0-9]+\\.[0-9]+$');
    expect(runtimeWorkflow).toContain('^[a-f0-9]{40}$');
    expect(runtimeWorkflow).toContain('git rev-parse "$RELEASE_TAG^{commit}"');
    expect(runtimeWorkflow).toContain('IMAGE=ghcr.io/the-answerai/answer-engine');
    expect(runtimeWorkflow).toContain('platforms: linux/amd64,linux/arm64');
    expect(runtimeWorkflow).toContain('push: true');
    expect(runtimeWorkflow).toContain('^sha256:[a-f0-9]{64}$');
    expect(runtimeWorkflow).toContain('$RUNNER_TEMP/runtime-index.json');
    expect(runtimeWorkflow).toContain('This workflow does not change GHCR package visibility.');
    expect(runtimeWorkflow).toContain('docs/installer-release.md');
    expect(runtimeWorkflow).not.toContain('/orgs/the-answerai/packages/container/answer-engine');
    expect(runtimeWorkflow).not.toContain('--field visibility=public');
    expect(runtimeWorkflow).toContain('runtime-image-${{ inputs.tag }}-${{ inputs.source_commit }}');
    expect(runtimeWorkflow).toContain('docker/setup-qemu-action@96fe6ef7f33517b61c61be40b68a1882f3264fb8');
    expect(runtimeWorkflow).toContain('docker/login-action@dbcb813823bdd20940b903addbd779551569679f');
    expect(`${builder}\n${workflow}\n${runtimeWorkflow}`).not.toMatch(/npm publish|pnpm publish/);
  });

  it.each([
    ['macos', 'node-v22.16.0-darwin-arm64.tar.xz', 'aaf7fc3c936f1b359bc312b63638e41f258689ac2303966ad932cda18c54ea00'],
    ['windows-wsl2', 'node-v22.16.0-linux-x64.tar.xz', 'f4cb75bb036f0d0eddf6b79d9596df1aaab9ddccd6a20bf489be5abe9467e84e'],
  ] as const)('generates the verified %s Node proposal without mutation', (platform, archive, checksum) => {
    const fixture = bootstrapFixture(platform, 'missing');
    const result = spawnSync('/bin/bash', ['scripts/release/bootstrap.sh', '--preflight'], {
      cwd: resolve('.'), env: fixture.env, encoding: 'utf8',
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain(`https://nodejs.org/dist/v22.16.0/${archive}`);
    expect(result.stdout).toContain(checksum);
    expect(readdirSync(fixture.home)).toEqual([]);
  });

  it('leaves the user home unchanged when dependency consent is refused', () => {
    const fixture = bootstrapFixture('macos', 'missing');
    const result = spawnSync('/bin/bash', ['scripts/release/bootstrap.sh'], {
      cwd: resolve('.'), env: fixture.env, encoding: 'utf8', input: 'n\n',
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain('Cancelled before system or Answer Engine changes.');
    expect(readdirSync(fixture.home)).toEqual([]);
  });

  it('reuses a compatible installed Node dependency without mutation', () => {
    const fixture = bootstrapFixture('macos', 'ready');
    const result = spawnSync('/bin/bash', ['scripts/release/bootstrap.sh', '--preflight'], {
      cwd: resolve('.'), env: fixture.env, encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[READY|required|reuse] Node.js v22.16.0');
    expect(readdirSync(fixture.home)).toEqual([]);
  });

  it('reuses a managed Node dependency after an interrupted bootstrap', () => {
    const fixture = bootstrapFixture('macos', 'missing');
    executable(join(fixture.bin, 'curl'), `#!/bin/sh
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; output="$1"; fi
  shift
done
case "$output" in
  *node-v22.16.0-darwin-arm64.tar.xz) printf archive > "$output"; exit 0 ;;
  *) exit 22 ;;
esac
`);
    executable(join(fixture.bin, 'shasum'), `#!/bin/sh
path=
for argument in "$@"; do path="$argument"; done
printf '%s  %s\n' aaf7fc3c936f1b359bc312b63638e41f258689ac2303966ad932cda18c54ea00 "$path"
`);
    executable(join(fixture.bin, 'tar'), `#!/bin/sh
destination=
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-C" ]; then shift; destination="$1"; fi
  shift
done
mkdir -p "$destination/bin"
printf '%s\n' '#!/bin/sh' '[ "$1" = "--version" ] && echo v22.16.0' 'exit 0' > "$destination/bin/node"
chmod 755 "$destination/bin/node"
`);

    const interrupted = spawnSync('/bin/bash', ['scripts/release/bootstrap.sh', '--approve-node'], {
      cwd: resolve('.'), env: fixture.env, encoding: 'utf8',
    });
    expect(interrupted.status).toBe(22);
    expect(interrupted.stdout).toContain('Node.js readiness passed after installation.');

    const resumed = spawnSync('/bin/bash', ['scripts/release/bootstrap.sh', '--preflight'], {
      cwd: resolve('.'), env: fixture.env, encoding: 'utf8',
    });
    expect(resumed.status).toBe(0);
    expect(resumed.stdout).toContain('[READY|required|reuse] Node.js v22.16.0');
  });
});
