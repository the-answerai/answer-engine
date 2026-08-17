# @answer-engine/create

One-command local installer for Answer Engine 1.1.0.

## One-prompt guided install

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

## Requirements

- Node.js 22.16 or newer
- Docker with Compose
- Either LM Studio models or configured cloud model credentials

## Verified release install

This package is shipped inside the versioned installer archive and is not
fetched from npm. Run the checksum-first Apple Silicon Bash or Windows 11/WSL2
PowerShell bootstrap in the repository's `INSTALL_AGENT.md`; it installs the
`create-answer-engine` and `ae` launchers in `~/.local/bin`. Then run:

```bash
create-answer-engine
```

For a non-interactive LM Studio install:

```bash
create-answer-engine --yes \
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
create-answer-engine remove-integrations --channel stable
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
client starts. The published release manifest pins the runtime as
`ghcr.io/the-answerai/answer-engine@sha256:<release-digest>`; mutable tags are
never written to a fresh installation.
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
--image <name@sha256:digest>  # upgrade only; tags are rejected
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
create-answer-engine uninstall --channel stable
create-answer-engine uninstall --channel stable --purge
```

Without `--purge`, local configuration and data remain in `AE_HOME`.

## License

Apache-2.0
