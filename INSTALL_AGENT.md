# Install Answer Engine with a coding agent

> Runbook version 1.1.0 for `@answer-engine/create` and
> `@answer-engine/cli` 1.1.x.

Coding agent: follow this runbook from the prerequisite checks through a recall
of the user's own data. Do not stop after scaffolding or after the synthetic
installer check.

Stable source:
<https://raw.githubusercontent.com/the-answerai/answer-engine/v1.1.0/INSTALL_AGENT.md>

## Copy and paste this one prompt

<!-- INSTALL_PROMPT:START -->
```text
Install Answer Engine stable 1.1.0 on this computer. Follow only the immutable
v1.1.0 instructions at:
https://raw.githubusercontent.com/the-answerai/answer-engine/v1.1.0/INSTALL_AGENT.md

First explain that bootstrap preflight is read-only and ask permission to run
the matching Apple Silicon Bash or Windows 11 PowerShell command in the
"Verified bootstrap commands" section. Download only the exact v1.1.0 asset,
verify its SHA-256 entry before execution, and run it first with --preflight.

Translate every pass, warning, or unsupported result into plain language. Never
silently install Docker Desktop, WSL2, LM Studio, drivers, a model runtime, or
another privileged prerequisite. The only supported automatic dependency is
the displayed official Node.js 22.16.0 user-scoped archive, and it still
requires my explicit approval. Recommend full-local only for supported hardware,
reduced-local for constrained Apple Silicon, or cloud-backed only after explicit
opt-in. Ask me in one short interview for the install folder, model route, every
agent client surface I use, and whether Cowork sessions are local or remote.
Never ask me to paste a secret into chat.

After readiness passes, show the exact source, version, checksum, destination,
and command for every proposed change, then ask for one confirmation. Run the
same verified bootstrap without --preflight; it installs the versioned installer
and CLI assets without npm. Verify the release manifest, provenance, every
downloaded artifact, and the content-addressed runtime image digest before any
Answer Engine mutation. Cancel without changing Answer Engine files if I decline.
Use the stable channel, preserve existing data and unrelated client configuration,
and retry safely if setup is partial. Never print or request the local API key.

Finish only when health, the local UI, the direct memory round trip, and a real
Answer Engine recall in every selected supported client pass. Explain that
ChatGPT web/Work and remote Cowork cannot connect directly to localhost; do not
claim or create a remote relay. Report no-op, repair, removal, and rollback paths
clearly. History import, folder ingestion, organization mutation, and the
cross-chat tutorial remain separate consented handoffs.
```
<!-- INSTALL_PROMPT:END -->

## Completion criteria

Setup is complete only when:

1. `http://127.0.0.1:5050/health` returns healthy.
2. `http://127.0.0.1:5050` opens ready to use without API-key entry.
3. Every selected supported client has its skill/plugin and tool configuration,
   and completes its automated or guided real recall check.
4. `$AE_HOME/config.yaml` validates.
5. At least one selected history or document source has been imported.
6. A full-text recall returns one of those real records and its lineage endpoint
   shows the source identifier and current artifact.

The installer's generated remember/recall/lineage check proves the stack works;
it does not replace the user's-data check in steps 5 and 6.

## Safety

- Keep the API bound to `127.0.0.1` unless the user explicitly asks for a
  secured alternative.
- Never print, paste into chat, or commit model credentials or the local API
  key. Let the user enter secrets directly in their terminal.
- Back up an existing `config.yaml` before editing it and preserve existing
  values when merging source entries.
- Never use `--uninstall --purge` without explicit confirmation because it
  deletes the local database and Answer Engine home.
- This runbook installs `stable`. Never point staging at `$AE_HOME`; staging
  defaults to `~/.answer-engine-staging` and must use `--clients none`.

## 1. Check prerequisites

### Verified bootstrap commands

Ask before downloading into a temporary folder and running the read-only
preflight. On Apple Silicon macOS, use:

```bash
AE_RELEASE_URL=https://github.com/the-answerai/answer-engine/releases/download/v1.1.0
AE_BOOTSTRAP=answer-engine-bootstrap-v1.1.0.sh
AE_EXPECTED=c1e65b8943709ede0109b2af566f72fd3b97d311261f44df6e64cf136db304bb
AE_STAGE="$(mktemp -d)"
trap 'rm -rf "$AE_STAGE"' EXIT HUP INT TERM
curl --fail --location --proto '=https' --tlsv1.2 "$AE_RELEASE_URL/SHA256SUMS" -o "$AE_STAGE/SHA256SUMS"
curl --fail --location --proto '=https' --tlsv1.2 "$AE_RELEASE_URL/$AE_BOOTSTRAP" -o "$AE_STAGE/$AE_BOOTSTRAP"
AE_LISTED="$(awk -v name="$AE_BOOTSTRAP" '$2 == name { print $1 }' "$AE_STAGE/SHA256SUMS")"
test "$AE_LISTED" = "$AE_EXPECTED"
printf '%s  %s\n' "$AE_EXPECTED" "$AE_STAGE/$AE_BOOTSTRAP" | shasum -a 256 -c -
bash "$AE_STAGE/$AE_BOOTSTRAP" --preflight
```

On Windows 11 x64 in PowerShell, use:

```powershell
$ReleaseUrl = 'https://github.com/the-answerai/answer-engine/releases/download/v1.1.0'
$Bootstrap = 'answer-engine-bootstrap-v1.1.0.ps1'
$Expected = '8adf1b0720b40354ef660c669824c79d197d49671fb61d161f3d40b7b6ada519'
$Stage = Join-Path ([IO.Path]::GetTempPath()) ('answer-engine-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $Stage | Out-Null
try {
  Invoke-WebRequest "$ReleaseUrl/SHA256SUMS" -OutFile "$Stage/SHA256SUMS"
  Invoke-WebRequest "$ReleaseUrl/$Bootstrap" -OutFile "$Stage/$Bootstrap"
  $Line = Get-Content "$Stage/SHA256SUMS" | Where-Object { $_ -match "^[a-f0-9]{64}\s+\*?$([regex]::Escape($Bootstrap))$" } | Select-Object -First 1
  if (-not $Line -or ($Line -split '\s+')[0] -ne $Expected) { throw 'Release checksum does not match the pinned bootstrap checksum.' }
  $Actual = (Get-FileHash -Algorithm SHA256 "$Stage/$Bootstrap").Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { throw 'Bootstrap checksum mismatch; refusing execution.' }
  & "$Stage/$Bootstrap" --preflight
} finally {
  Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
}
```

Both commands use the exact `v1.1.0` GitHub Release path and verify the
bootstrap before execution. After readiness and dependency consent, rerun the
same checksum-first command without `--preflight`; add `--approve-node` only after
the user approves the displayed official Node source, version, checksum,
destination, and command. Do not substitute `/latest`, a branch URL, or an
unverified local copy.

The installed launcher provides the read-only structured check:

```bash
create-answer-engine preflight --json --channel stable
# Use --json when the agent will interpret the result.
```

Answer Engine requires Node.js 22.16 or newer, Docker, and Compose v2. Docker
must be running and local port 5050 must be available or already owned by this
installation.

For the default local model route, start LM Studio, load one chat model and one
embedding model, then discover their exact IDs:

```bash
curl --fail --silent http://127.0.0.1:1234/v1/models
```

Do not guess model IDs or embedding width. OpenAI-compatible chat/embeddings and
Anthropic chat with OpenAI embeddings are also supported.

## 2. Interview the user

The installer asks for setup and issue-#43 client choices in one concise interview. If an
agent is driving it, ask these questions in one batch and wait for the answers:

1. Use the default `~/.answer-engine`, or another local home?
2. Use LM Studio, OpenAI, or Anthropic? Collect exact model IDs. For LM Studio,
   also collect the embedding width. Have the user enter keys locally.
3. Which client surfaces are used: Codex, ChatGPT Desktop Codex, hosted ChatGPT
   Chat/Work or web, Claude Code, Claude Desktop, Claude Cowork, or a
   Cursor-style JSON MCP adapter? For Cowork, are sessions local or remote?

The installer performs supported client wiring and verification. History import,
document ingestion, organization mutation, and the cross-chat tutorial remain
separate downstream steps; do not silently perform them here.

Default history discovery:

- Claude Code: `~/.claude/projects/**/*.jsonl`
- Codex: rollout JSONL under `$CODEX_HOME` (default `~/.codex`) plus local
  metadata from `state_5.sqlite`
- Cowork on macOS: `~/Library/Application Support/Claude/local-agent-mode-sessions`

## 3. Run the installer

Use `AE_HOME` for every later command:

```bash
export AE_HOME="${AE_HOME:-$HOME/.answer-engine}"
```

LM Studio example, using IDs returned by `/v1/models`:

```bash
create-answer-engine --yes \
  --channel stable \
  --home "$AE_HOME" \
  --models chat=<loaded-chat-id>,embedding=<loaded-embedding-id> \
  --embedding-dimension <actual-width> \
  --clients claude-code,codex
```

OpenAI example (the user enters the key in the local shell):

```bash
create-answer-engine --yes \
  --channel stable \
  --home "$AE_HOME" \
  --llm-provider openai \
  --llm-key "$OPENAI_API_KEY" \
  --chat-model <openai-chat-model-id> \
  --embedding-provider openai \
  --embedding-key "$OPENAI_API_KEY" \
  --embedding-model text-embedding-3-small \
  --clients claude-code,codex
```

Anthropic chat with OpenAI embeddings:

```bash
create-answer-engine --yes \
  --channel stable \
  --home "$AE_HOME" \
  --llm-provider anthropic \
  --llm-key "$ANTHROPIC_API_KEY" \
  --chat-model <anthropic-chat-model-id> \
  --embedding-provider openai \
  --embedding-key "$OPENAI_API_KEY" \
  --embedding-model text-embedding-3-small \
  --clients claude-code,codex
```

Use only the clients selected by the user; `--clients none` is valid and
`--agents` remains a compatibility alias. Use `--cowork-mode local` only after
the user confirms local sessions and applicable desktop policy. Do not
continue unless all six installer stages pass.

Capability boundary:

- Codex receives the Personal marketplace plugin; Claude Code receives the same
  skills through a local Claude marketplace plugin. Both launch stdio MCP from
  the installer-managed runtime and complete a non-interactive real recall.
- ChatGPT Desktop Codex receives the shared Personal plugin source with its
  bundled MCP configuration, then requires plugin install/restart and guided confirmation.
- Claude Desktop and Cursor-style JSON adapters receive local stdio MCP plus
  CLI handoff and require restart with guided recall confirmation.
- Hosted ChatGPT Chat/Work/web and Cowork are not wired to localhost. Cowork
  uses account-synced skills and policy-approved connectors; this installer does
  not claim local plugin support or operate a remote relay.
- When the installer runs inside WSL2, Windows-host ChatGPT Desktop and Claude
  Desktop are explained as unavailable and receive no Linux-home wiring.

The installer stores a redacted ownership ledger and private backups under
`$AE_HOME/integrations`. To reverse client integration without removing memory:

```bash
create-answer-engine remove-integrations \
  --channel stable --home "$AE_HOME"
```

## 4. Add the selected sources

The verified bootstrap installs the matching CLI asset. If `ae` is missing,
rerun that same exact-version bootstrap; do not fetch an npm package:

```bash
command -v ae >/dev/null 2>&1 || { echo 'Rerun the verified v1.1.0 bootstrap.' >&2; exit 1; }
cp "$AE_HOME/config.yaml" "$AE_HOME/config.yaml.before-sources"
chmod 600 "$AE_HOME/config.yaml.before-sources"
```

Merge the requested source entries with a YAML-aware edit. Preserve `models`
and `server`. Valid source types are `claude-code`, `codex`, `cowork`, and
`local_dir`:

```yaml
models:
  chat: qwen2.5
  embedding: nomic-embed-text
  chat_provider: lmstudio
  embedding_provider: lmstudio
  embedding_dimension: 768

sources:
  - type: claude-code
    library: personal-memory
  - type: codex
    library: personal-memory
  - type: cowork
    library: personal-memory
  - type: local_dir
    path: /Users/alex/Documents/notes
    include: ['**/*.md', '**/*.txt']
    exclude: ['private/**']
    content_type: document
    on_delete: leave
    max_file_bytes: 5242880
    library: personal-memory

connectors: {}

server:
  port: 5050
  bind: 127.0.0.1
```

Omit `path` to use default history discovery. `local_dir` always requires a
path. Use multiple entries when the same source type needs multiple paths.

Validate without exposing secrets:

```bash
chmod 600 "$AE_HOME/config.yaml"
ae config validate
ae config gen-env
```

## 5. Import and prove real recall

The installer-managed client/CLI authentication handoff is available. Never ask
the user to copy the local API key into the UI or paste it into chat. Continue
with:

```bash
ae auth status
ae sync first-import
ae sync status
```

The command performs metadata-only discovery and waits. Have the user open the
local `/import` page, review the paths, estimated counts and sizes, privacy
posture, and exclusions, then explicitly approve any subset. Nothing is read or
imported before approval except file names and statistics needed for the preview.
The approved bundle fingerprint is checked again before transcript bodies are
read. If it changed, run a fresh discovery and approval. If the command is interrupted, use the recovery
command shown by the page: `ae sync first-import --resume <session-id>`.

Choose a distinctive phrase from one imported conversation or document and run:

```bash
ae search "<distinctive phrase>" --type fulltext --limit 5
ae get <returned-content-id> --include content,metadata
```

Also request `GET /api/v1/content/<returned-content-id>/lineage` through the
configured local client or MCP `inspect_memory` tool. Confirm that the source,
source identifier, and current raw artifact refer to the user's imported data.

If requested, install continuous capture only after the one-time sync succeeds:

```bash
ae sync install-service
ae sync status
```

Finish by restarting each wired agent client and calling MCP `recall` for the
same phrase.

## Troubleshooting

- API unavailable: inspect `docker compose` status and the `migrate`, `init`,
  and `api` logs under `$AE_HOME`.
- LM Studio unavailable from containers: confirm its server is running and the
  generated base URL uses `host.docker.internal`.
- Semantic search fails: confirm the embedding model is loaded and its width
  matches the value selected before the first migration.
- Authentication fails: confirm the key begins with `ae_live_` and re-run
  `ae auth login` without sharing the key.
- A first import is interrupted or fails: open `/import`, use Retry when
  offered, and run `ae sync first-import --resume <session-id>`. Safe errors
  identify the source and recovery action without transcript content.
- A source discovers nothing: confirm the displayed default path, then use
  `ae sync once --source <type> --path <path>` for manual diagnosis.

## Uninstall

Preserve data:

```bash
create-answer-engine uninstall --channel stable --home "$AE_HOME"
```

Delete data only after explicit user confirmation:

```bash
create-answer-engine uninstall --channel stable --purge --home "$AE_HOME"
```
