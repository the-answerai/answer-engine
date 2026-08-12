import { createHash } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { conversationSearchText, conversationToImportRow } from '../sync/importer.js';
import { claudeCodeSource } from '../sync/sources/claude-code.js';
import { coworkSource } from '../sync/sources/cowork.js';

const tempDirs: string[] = [];
const originalAeHome = process.env.AE_HOME;
const originalClaudeDesktopHome = process.env.CLAUDE_DESKTOP_HOME;
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cowork');

function makeFixtureCopy(): string {
  const root = mkdtempSync(join(tmpdir(), 'ae-cowork-normalize-'));
  tempDirs.push(root);
  cpSync(fixtureDir, root, { recursive: true });
  process.env.AE_HOME = join(root, 'ae-home');
  process.env.CLAUDE_DESKTOP_HOME = root;
  return root;
}

describe('Cowork conversation normalization', () => {
  afterEach(() => {
    if (originalAeHome === undefined) delete process.env.AE_HOME;
    else process.env.AE_HOME = originalAeHome;
    if (originalClaudeDesktopHome === undefined) delete process.env.CLAUDE_DESKTOP_HOME;
    else process.env.CLAUDE_DESKTOP_HOME = originalClaudeDesktopHome;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('uses the nested transcript as canonical and archives the signed audit sidecar unchanged', async () => {
    const root = makeFixtureCopy();
    const sessionRoot = join(root, 'local-agent-mode-sessions', 'session-one');
    const transcriptPath = join(
      sessionRoot,
      'runtime',
      '.claude',
      'projects',
      '-workspace',
      'cowork-session.jsonl',
    );
    const auditPath = join(sessionRoot, 'runtime', 'audit.jsonl');
    const outerPath = join(sessionRoot, 'local_session-one.json');
    const artifactPath = join(sessionRoot, 'runtime', 'workspace', 'output.txt');
    const copiedChatPath = join(sessionRoot, 'runtime', 'workspace', 'copied-chat.jsonl');

    const files = await coworkSource.discover();

    expect(files.map((file) => file.path)).toEqual([transcriptPath]);
    const fingerprint = await coworkSource.fingerprint!(files[0]);
    const result = await coworkSource.readConversations!(files[0]);
    expect(result.errors).toEqual([]);
    expect(result.sourceFingerprint).toBe(fingerprint);
    expect(result.conversations).toHaveLength(2);

    const parent = result.conversations.find(
      (conversation) => conversation.source_conversation_id === 'cowork-session',
    );
    expect(parent).toBeDefined();
    expect(parent).toMatchObject({
      provider: 'anthropic_claude',
      surface: 'claude_cowork',
      adapter_name: 'cowork-history',
      adapter_version: '1.0.0',
      source_path: transcriptPath,
    });
    expect(parent?.events.filter((event) => event.category === 'message')
      .map((event) => event.source_event_id)).toEqual([
      'cowork-user-1',
      'cowork-assistant-1',
    ]);
    expect(parent?.events.filter((event) => event.provider_type === 'audit')).toEqual([
      expect.objectContaining({
        source_event_id: 'cowork-audit:audit-user-record',
        category: 'lifecycle',
        role: null,
        provider_subtype: 'user',
        content_blocks: [],
      }),
      expect.objectContaining({
        source_event_id: 'cowork-audit:audit-assistant-record',
        category: 'lifecycle',
        role: null,
        provider_subtype: 'assistant',
        content_blocks: [],
      }),
    ]);
    expect(parent?.relations).toEqual(expect.arrayContaining([
      {
        relation_type: 'duplicate_of',
        source_event_id: 'cowork-audit:audit-user-record',
        target_source_event_id: 'cowork-user-1',
        rule_id: 'cowork-nested-transcript-over-audit-message',
        rule_version: '1',
      },
      {
        relation_type: 'duplicate_of',
        source_event_id: 'cowork-audit:audit-assistant-record',
        target_source_event_id: 'cowork-assistant-1',
        rule_id: 'cowork-nested-transcript-over-audit-message',
        rule_version: '1',
      },
    ]));

    expect(parent?.provider_metadata_json).toMatchObject({
      sensitive_metadata: ['cowork_session'],
      cowork_session: {
        cliSessionId: 'cowork-session',
        account: { email: 'sensitive.fixture@example.com' },
      },
      audit_sidecar: {
        source_path: auditPath,
        sha256: createHash('sha256').update(readFileSync(auditPath)).digest('hex'),
        signed: true,
        hmac_verified: false,
        record_count: 4,
        duplicate_message_records: 2,
      },
      audit_exclusive: {
        rate_limit_event_count: 1,
        result_count: 1,
      },
    });
    expect(parent?.provider_metadata_json.cowork_artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source_path: artifactPath,
        sha256: createHash('sha256').update(readFileSync(artifactPath)).digest('hex'),
      }),
      expect.objectContaining({ source_path: copiedChatPath }),
    ]));

    const searchText = conversationSearchText(parent!);
    expect(searchText).toContain('Canonical nested Cowork prompt');
    expect(searchText).toContain('Canonical nested Cowork response');
    expect(searchText).not.toContain('Audit duplicate prompt');
    expect(searchText).not.toContain('Cowork output artifact');
    expect(searchText).not.toContain('Workspace copy must not become chat history');

    const importRow = conversationToImportRow(parent!);
    expect(importRow.content).not.toContain('sensitive.fixture@example.com');
    expect(importRow['metadata.provider_metadata_json']).toMatchObject({
      sensitive_metadata: ['cowork_session'],
    });

    const archiveRoot = join(root, 'ae-home', 'raw-archive');
    const [archiveName] = readdirSync(archiveRoot);
    const archiveDir = join(archiveRoot, archiveName);
    const manifest = JSON.parse(
      readFileSync(join(archiveDir, 'manifest.json'), 'utf8'),
    ) as {
      files: Array<{ path: string; archive_path: string }>;
    };
    expect(manifest.files.map((entry) => entry.path)).toEqual(expect.arrayContaining([
      transcriptPath,
      auditPath,
      outerPath,
      artifactPath,
      copiedChatPath,
    ]));
    const auditEntry = manifest.files.find((entry) => entry.path === auditPath);
    expect(auditEntry).toBeDefined();
    expect(readFileSync(join(archiveDir, auditEntry!.archive_path))).toEqual(
      readFileSync(auditPath),
    );
  });

  it('invalidates the bundle fingerprint when only a sidecar or artifact changes', async () => {
    const root = makeFixtureCopy();
    const sessionRoot = join(root, 'local-agent-mode-sessions', 'session-one');
    const [file] = await coworkSource.discover({
      paths: [join(root, 'local-agent-mode-sessions')],
    });
    const initial = await coworkSource.fingerprint!(file);

    appendFileSync(
      join(sessionRoot, 'runtime', 'audit.jsonl'),
      `${JSON.stringify({
        type: 'result',
        uuid: 'later-result',
        _audit_hmac: 'later-signature',
        _audit_timestamp: '2026-08-10T20:00:04.000Z',
      })}\n`,
      'utf8',
    );
    const afterAudit = await coworkSource.fingerprint!(file);
    expect(afterAudit).not.toBe(initial);

    appendFileSync(join(sessionRoot, 'local_session-one.json'), ' \n', 'utf8');
    const afterOuter = await coworkSource.fingerprint!(file);
    expect(afterOuter).not.toBe(afterAudit);

    appendFileSync(
      join(sessionRoot, 'runtime', 'workspace', 'output.txt'),
      'Updated artifact.\n',
      'utf8',
    );
    expect(await coworkSource.fingerprint!(file)).not.toBe(afterOuter);
  });

  it('joins Claude Desktop launch metadata to an overlapping host conversation only', async () => {
    const root = makeFixtureCopy();
    const launchPath = join(root, 'claude-code-sessions', 'host-launch.json');
    const files = await claudeCodeSource.discover({ paths: [root] });
    expect(files).toHaveLength(1);

    const fingerprint = await claudeCodeSource.fingerprint!(files[0]);
    const result = await claudeCodeSource.readConversations!(files[0]);

    expect(result.conversations).toHaveLength(1);
    expect(result.sourceFingerprint).toBe(fingerprint);
    expect(result.conversations[0]).toMatchObject({
      surface: 'claude_code',
      source_conversation_id: 'host-overlap',
      provider_metadata_json: {
        launch_metadata: {
          cliSessionId: 'host-overlap',
          bridgeSessionId: 'bridge-fixture',
          completedTurns: 1,
        },
      },
    });
    expect(result.conversations.some(
      (conversation) => conversation.source_path === launchPath,
    )).toBe(false);

    const archiveRoot = join(root, 'ae-home', 'raw-archive');
    const [archiveName] = readdirSync(archiveRoot);
    const manifest = JSON.parse(
      readFileSync(join(archiveRoot, archiveName, 'manifest.json'), 'utf8'),
    ) as { files: Array<{ path: string }> };
    expect(manifest.files).toContainEqual(expect.objectContaining({ path: launchPath }));

    appendFileSync(launchPath, ' \n', 'utf8');
    const [updatedFile] = await claudeCodeSource.discover({ paths: [root] });
    expect(await claudeCodeSource.fingerprint!(updatedFile)).not.toBe(fingerprint);
  });
});
