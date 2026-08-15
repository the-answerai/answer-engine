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
ae sync archive plan --target-bytes 10737418240
ae sync archive prune --target-bytes 10737418240 --confirm <token>
ae sync uninstall-service
```

`first-import` performs metadata-only discovery, waits for source-by-source
approval in the `/import` web surface, merges only approved transcript sources
into `config.yaml`, verifies the full bundle fingerprint again before reading,
and records a resumable reconciled inventory. Changed bundles require a fresh
preview and approval; inaccessible sources receive safe permission guidance.
Supported history sources are Claude Code, Codex, Cowork, and local directories.
The sync cursor and raw source archive remain local under `AE_HOME`. Raw archives
are content-addressed and reused when an import is retried. Writes fail closed
before exceeding a 256 MiB bundle limit, a 10 GiB total archive limit, or a
10 GiB free-space reserve. Override those byte counts with
`AE_RAW_ARCHIVE_MAX_BUNDLE_BYTES`, `AE_RAW_ARCHIVE_MAX_TOTAL_BYTES`, and
`AE_RAW_ARCHIVE_MIN_FREE_BYTES`. Cowork archives only supported text artifacts
explicitly named by its `mountedFiles` metadata; it never sweeps the containing
workspace. `archive plan` fetches tenant-scoped manifest references and previews
only unreferenced deletion candidates. `archive prune` refuses to run while the
sync service is active and requires the exact token from an unchanged plan.

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

## Review and apply organization

```bash
ae organize propose
ae organize propose --use-model --limit 50
ae organize list
ae organize show <plan-id>
ae organize apply <plan-id> --accept <suggestion-id> --reject <suggestion-id>
ae organize undo <plan-id>
```

`propose` never mutates content, taxonomy, or memberships. Its local default
groups explicit source metadata deterministically. `--use-model` is an explicit
opt-in that sends only bounded titles, summaries, source/type fields, existing
tag names, and content IDs to the configured provider. `apply` requires one
accept or reject decision for every suggestion and refuses a stale snapshot.
`undo` reverts only tags, assignments, and libraries introduced by that plan;
it cannot delete imported content. Run `apply` on the undone plan to review and
reapply it without duplicate tags, libraries, or memberships.

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
