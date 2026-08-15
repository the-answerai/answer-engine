# First agent-history import

Run this only after the stable installer has completed client wiring and local
API authentication:

```bash
ae sync first-import
```

Discovery invokes the Claude Code, Codex, and Cowork adapters for file paths,
identity/stat metadata, and a metadata fingerprint only. For a history bundle,
the displayed size and fingerprint cover every subagent, audit, metadata, and
artifact file that the approved import will read. It does not read transcript
bodies, create raw archives, import content, scan arbitrary folders, or change
tags and libraries. Optional Claude Desktop launch metadata is excluded because
mapping it would require reading JSON before consent. The owner-readable
discovery manifest is stored under `$AE_HOME/data/first-import` for the selected
runtime channel. Inaccessible sources appear as unavailable with a permission
recovery action; raw filesystem errors are not exposed.

On every new or resumed run, the CLI requires that owner-readable local
manifest to remain inside the selected channel home and match the server's
session ID, source metadata, and complete item inventory. A server record alone
cannot direct the CLI to read an unmanifested local path.

Open `http://127.0.0.1:3200/import`. Review each source's paths, estimated
conversation count, byte size, privacy posture, and expected exclusions. Select
any non-empty subset and check the consent statement. The API rejects progress
events until this explicit approval has been recorded.

After approval, the CLI atomically adds only missing approved transcript source
entries to `$AE_HOME/config.yaml`, preserving other source and model settings.
Before reading each history, it verifies that the complete metadata inventory
still matches the approved fingerprint. A changed bundle is not read or
imported; the user is asked to run a fresh discovery and approve its current
inventory. The CLI then imports one discovered history at a time through the
authenticated sync client. Each source fingerprint receives a deterministic
immutable raw archive; a complete archive is hash-verified and reused on retry.
The content cursor advances only after the synchronous import result is durable.

The page can request cancellation at the next item boundary. Closing the page
does not stop the local process, and closing the terminal does not corrupt
completed archives or cursors. Resume with:

```bash
ae sync first-import --resume <session-id>
```

For a failed or canceled session, choose Retry on `/import` first, then run the
same resume command. Errors contain a source label, safe error code, and recovery
action; transcript text and provider secrets are not logged. Completion requires
every discovered history to be imported, duplicate, failed, or skipped. Every
imported chat row must have a non-empty summary and the same raw-manifest path
reported by its source item.

Staging remains disabled unless both `history_sync.enabled: true` is persisted
in the staging config and `--confirm-staging-history-sync` is supplied. Stable
and staging manifests, cursors, configs, and archives remain isolated. Folder
ingestion, automatic organization, Graphify, and npm publication are outside
this workflow.
