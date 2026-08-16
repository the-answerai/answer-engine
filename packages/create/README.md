# @answer-engine/create

One-command local installer for Answer Engine 1.1.0.

## One-prompt guided install

<!-- INSTALL_PROMPT:START -->
```text
Install Answer Engine stable 1.1.0 on this computer. Follow only the immutable
v1.1.0 instructions at:
https://raw.githubusercontent.com/the-answerai/answer-engine/v1.1.0/INSTALL_AGENT.md

First explain that preflight is read-only and ask permission to run it. Then run:
npx @answer-engine/create@1.1.0 preflight --json --channel stable

Translate every pass, warning, or unsupported result into plain language. Never
install Docker, WSL2, LM Studio, drivers, or another privileged prerequisite
without asking me. Recommend full-local only for supported hardware,
reduced-local for constrained Apple Silicon, or cloud-backed only after explicit
opt-in. Ask me in one short interview for the install folder, model route, every
agent client surface I use, and whether Cowork sessions are local or remote.
Never ask me to paste a secret into chat.

Before executing the installer, verify the bundled release manifest, immutable
version/tag, and SHA-256 checksums. Show the exact runtime, plugin, skill, MCP,
CLI, ledger, and backup paths plus every unsupported client limitation, then ask
for one confirmation. Cancel without changing files if I decline. Use the stable
channel, preserve existing data and unrelated client configuration, and retry
safely if setup is partial. Do not ask me to create or copy a local Answer Engine
API key; the installer must capture and store it automatically.

Finish only when health, the local UI, the direct memory round trip, and a real
Answer Engine recall in every selected supported client pass. Explain that
ChatGPT web/Work and remote Cowork cannot connect directly to localhost; do not
claim or create a remote relay. Report no-op, repair, removal, and rollback paths
clearly. History import, folder ingestion, organization mutation, and the
cross-chat tutorial remain separate consented handoffs.
```
<!-- INSTALL_PROMPT:END -->

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
  --clients codex,claude-code
```

The installer writes configuration beneath `~/.answer-engine`, starts the
local Compose stack, waits for health, captures the local API key, connects selected
client surfaces, and verifies remember, recall, lineage, and real Codex/Claude Code
tool calls. The bundled
loopback web interface opens already connected through an HttpOnly local session;
users do not copy the API key into the browser. The completion checkpoint is
written only after all six stages pass, so a retry resumes failed integration or
verification instead of mistaking a healthy container for a completed install.

Use `--channel staging --clients none` for the isolated development runtime at
`~/.answer-engine-staging`. Staging cannot write global client configuration and
history sync is disabled by default.

The installer writes a private, redacted ownership ledger under
`AE_HOME/integrations/ledger.json`, stores original configuration backups under
`AE_HOME/integrations/backups`, and configures the selected channel's CLI file at
`~/.config/answer-engine/config.yml`. Re-running with the same selection is a
byte-stable no-op. Remove only installer-managed entries with:

```bash
npx @answer-engine/create@1.1.0 remove-integrations --channel stable
```

ChatGPT Desktop Codex shares the Personal plugin marketplace and receives MCP
through the plugin, then requires guided plugin install/restart confirmation.
An existing Codex marketplace name is preserved and used for install/removal.
Hosted ChatGPT Chat/Work/web require remote MCP and cannot use this localhost
installation directly. Cowork uses account-synced skills and policy-approved
connectors, so the installer explains its limitation instead of claiming local
plugin support. Guided clients are never auto-selected by `--yes`; select them
explicitly only when the interactive check can be completed.
Inside WSL2, Windows-host ChatGPT Desktop and Claude Desktop are reported as
unavailable instead of receiving unusable Linux-home paths; terminal clients remain supported.

Generated client entries launch the MCP server already built into the
installer-managed runtime, so they do not fetch an unpublished package when a
client starts. The runtime image is pinned to
`ghcr.io/the-answerai/answer-engine:1.1.0`.
Installer containers and volumes use the isolated `answer-engine-local`
Compose namespace so legacy enterprise state is never adopted implicitly.

## Important options

```text
install|start|stop|status|repair|upgrade|rollback|uninstall|remove-integrations
preflight [--json]
--channel <stable|staging>
--home <directory>
--clients <list-or-none>
--agents <list-or-none>  # legacy alias for --clients
--cowork-mode <local|remote|unknown>
--models chat=<id>,embedding=<id>
--lm-studio-url <url>
--llm-provider <anthropic|openai>
--embedding-provider <openai>
--api-key <existing-local-key>
--image <pinned-reference>  # upgrade only
--uninstall
--purge
```

Stable listens on API port 5050; staging listens on 5150. Lifecycle actions are
channel-aware and destructive actions require the selected home's ownership
marker. See `docs/local-runtime-channels.md` in the repository for the complete
resource table, existing-install adoption, and rollback behavior.

A complete pre-channel stable home is adopted before Docker, model-runtime, or
reserved-port readiness checks. Adoption validates regular non-symlink files,
the stable Compose project and channel, the known Answer Engine service/image/
command/loopback-port/volume topology, configuration syntax, and channel
isolation. It rejects extra services, host mounts, and privileged container
options before writing only `AE_CHANNEL=stable` and the private ownership
marker. It does not start services or change database, blob, volume, archive,
or memory bytes. Invalid or conflicting homes fail closed.

## Uninstall

```bash
npx @answer-engine/create@1.1.0 uninstall --channel stable
npx @answer-engine/create@1.1.0 uninstall --channel stable --purge
```

Without `--purge`, local configuration and data remain in `AE_HOME`.

## License

Apache-2.0
