import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(path), 'utf8');

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

    expect(builder).toContain('checked-out commit');
    expect(builder).toContain("'--sort=name', '--mtime=@0'");
    expect(builder).toContain('pruneDeployMetadata(installerStage)');
    expect(builder).toContain('provenance.json');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('production-release');
    expect(workflow).toContain('sha256sum --check SHA256SUMS');
    expect(`${builder}\n${workflow}`).not.toMatch(/npm publish|pnpm publish/);
  });
});
