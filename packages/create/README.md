# @answer-engine/create

One-command local installer for Answer Engine 1.1.0.

## Requirements

- Node.js 22.16 or newer
- Docker with Compose
- Either LM Studio models or configured cloud model credentials

## Install

```bash
npx @answer-engine/create@1.1.0
```

For a non-interactive LM Studio install:

```bash
npx @answer-engine/create@1.1.0 --yes \
  --models "chat=<chat-model-id>,embedding=<embedding-model-id>" \
  --agents codex,claude-code
```

The installer writes configuration beneath `~/.answer-engine`, starts the
local Compose stack, waits for health, captures the local API key, wires selected
agent clients, and verifies remember, recall, and memory inspection.

Generated client entries use exact package versions:

- `@answer-engine/cli@1.1.0`
- `@answer-engine/mcp-server@1.1.0`

The runtime image is pinned to
`ghcr.io/the-answerai/answer-engine:1.1.0`.
Installer containers and volumes use the isolated `answer-engine-local`
Compose namespace so legacy enterprise state is never adopted implicitly.

## Important options

```text
--home <directory>
--agents <list-or-none>
--models chat=<id>,embedding=<id>
--lm-studio-url <url>
--llm-provider <anthropic|openai>
--embedding-provider <openai>
--api-key <existing-local-key>
--uninstall
--purge
```

The API listens on `127.0.0.1:5050`.

## Uninstall

```bash
npx @answer-engine/create@1.1.0 --uninstall
npx @answer-engine/create@1.1.0 --uninstall --purge
```

Without `--purge`, local configuration and data remain in `AE_HOME`.

## License

Apache-2.0
