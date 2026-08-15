# @answer-engine/cli

Local-first CLI for Answer Engine memory, retrieval, content import, history sync,
and evaluation.

## Requirements

- Node.js 22.16 or newer
- A running local Answer Engine API (default: `http://localhost:5050`)
- A local API key

## Install and configure

```bash
npm install -g @answer-engine/cli@1.1.0
ae auth login
ae auth status
```

The API URL is local by default. To use a different API explicitly:

```bash
ae config set api_url http://127.0.0.1:5050
# or
export ANSWER_ENGINE_API_URL=http://127.0.0.1:5050
```

Select isolated staging home, API, credentials, cursor state, and service
identity with `ae --channel staging <command>`. Stable remains the default and
keeps the legacy `~/.answer-engine` and `config.yml` paths.

## Local content and memory

```bash
ae search "what did we decide?"
ae get <content-id>
ae summarize "summarize the release decisions"
ae schema
ae status
```

Search supports fulltext, semantic, and hybrid retrieval plus content-type, tag,
and library filters. `get` retrieves local content by ID.

## Import local content

```bash
ae import csv ./notes.csv --type document
ae import json ./items.json --type document
ae import csv ./notes.csv --dry-run
```

CSV and JSON imports are normalized and previewed before being saved. Stable
`source_identifier` values make repeated imports idempotent.

## Sync agent history

```bash
ae sync first-import
ae sync first-import --resume <session-id>
ae sync once --source claude-code
ae sync once --source codex
ae sync once --source cowork
ae sync run --source claude-code
ae sync install-service
ae sync status
ae sync uninstall-service
```

`first-import` performs metadata-only discovery, waits for source-by-source
approval in the `/import` web surface, merges only approved transcript sources
into `config.yaml`, verifies the full bundle fingerprint again before reading,
and records a resumable reconciled inventory. Changed bundles require a fresh
preview and approval; inaccessible sources receive safe permission guidance.
Supported history sources are Claude Code, Codex, and Cowork.
The sync cursor and raw source archive remain local under `AE_HOME`.

## Permissioned local folders

```bash
ae folders add ./notes --include '**/*.md' --exclude 'private/**'
ae folders resume --source <source-id>
ae folders refresh --source <source-id>
ae folders remove <source-id> --retention keep
ae folders remove <source-id> --retention delete
```

`add` requires an exact user-selected root, creates a bounded preview using
metadata and a small binary-classification sample, and waits for approval in
`/import` before reading full bytes. Symlinks are not
followed; hidden, ignored, unsupported, binary, oversized, aggregate-limited,
permission-denied, and changed paths receive explicit outcomes. Manifests and
SHA-256 archives remain in the active channel home. Direct `local_dir` sync is
rejected so legacy configurations cannot bypass approval.

Staging history discovery is refused unless staging `config.yaml` contains
`history_sync: { enabled: true }` and the command also includes
`--confirm-staging-history-sync`. The same confirmation is required when
installing the staging background service.

## Evaluate retrieval

```bash
ae eval label --set my-memory
ae eval run --set my-memory
```

Evaluation artifacts are deterministic when `AE_EVAL_TIMESTAMP` is set.

## Configuration

```bash
ae config path
ae config show
ae config validate
ae config gen-env
```

The CLI reads `ANSWER_ENGINE_API_URL` and `ANSWER_ENGINE_API_KEY`. Configuration
and generated environment files are stored with owner-only permissions.

## License

MIT
