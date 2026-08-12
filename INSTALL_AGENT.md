# Install Answer Engine with a coding agent

> Runbook version 1.1.0 for `@answer-engine/create` and
> `@answer-engine/cli` 1.1.x.

Coding agent: follow this runbook from the prerequisite checks through a recall
of the user's own data. Do not stop after scaffolding or after the synthetic
installer check.

Stable source:
<https://raw.githubusercontent.com/the-answerai/answer-engine/master/INSTALL_AGENT.md>

## Completion criteria

Setup is complete only when:

1. `http://127.0.0.1:5050/health` returns healthy.
2. `http://127.0.0.1:5050` opens ready to use without API-key entry.
3. Every selected local agent client is wired to the MCP server.
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

## 1. Check prerequisites

Run:

```bash
node --version
docker version
docker compose version
docker info
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

Ask these questions in one concise batch and wait for the answers:

1. Use the default `~/.answer-engine`, or another local home?
2. Use LM Studio, OpenAI, or Anthropic? Collect exact model IDs. For LM Studio,
   also collect the embedding width. Have the user enter keys locally.
3. Which clients should be wired: Claude Code, Codex, Cursor, or Claude Desktop?
4. Which histories should be imported: Claude Code, Codex, and/or Cowork?
5. Which local document directories should be imported? Ask for include/exclude
   globs and whether a deleted file should leave its memory in place (default)
   or forget it.
6. Run one sync now only, or also install the per-user background sync service?

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
npx @answer-engine/create@1.1.0 --yes \
  --home "$AE_HOME" \
  --models chat=<loaded-chat-id>,embedding=<loaded-embedding-id> \
  --embedding-dimension <actual-width> \
  --agents claude-code,codex
```

OpenAI example (the user enters the key in the local shell):

```bash
npx @answer-engine/create@1.1.0 --yes \
  --home "$AE_HOME" \
  --llm-provider openai \
  --llm-key "$OPENAI_API_KEY" \
  --chat-model <openai-chat-model-id> \
  --embedding-provider openai \
  --embedding-key "$OPENAI_API_KEY" \
  --embedding-model text-embedding-3-small \
  --agents claude-code,codex
```

Anthropic chat with OpenAI embeddings:

```bash
npx @answer-engine/create@1.1.0 --yes \
  --home "$AE_HOME" \
  --llm-provider anthropic \
  --llm-key "$ANTHROPIC_API_KEY" \
  --chat-model <anthropic-chat-model-id> \
  --embedding-provider openai \
  --embedding-key "$OPENAI_API_KEY" \
  --embedding-model text-embedding-3-small \
  --agents claude-code,codex
```

Use only the clients selected by the user; `--agents none` is valid. Do not
continue unless all six installer stages pass.

## 4. Add the selected sources

Install the matching CLI if necessary:

```bash
command -v ae >/dev/null 2>&1 || npm install --global @answer-engine/cli@1.1.0
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

If the CLI does not yet have the local key, run `ae auth login` and have the user
paste the key directly from `$AE_HOME/.env.compose`. Then:

```bash
ae auth status
ae sync once
ae sync status
```

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
- A source imports nothing: run `ae sync once --source <type> --path <path>` and
  inspect the reported discovery and parse errors.

## Uninstall

Preserve data:

```bash
npx @answer-engine/create@1.1.0 --uninstall --home "$AE_HOME"
```

Delete data only after explicit user confirmation:

```bash
npx @answer-engine/create@1.1.0 --uninstall --purge --home "$AE_HOME"
```
