# Local runtime channels

Answer Engine has two explicit local channels. `stable` is personal memory;
`staging` is an isolated development runtime. Every lifecycle command validates
both profiles before invoking Docker. Destructive recovery and cleanup also
require a matching owner-only marker in the selected home. The marker pins the
generated Compose file, and lifecycle commands reject channel, project, port,
database, or sync-policy drift in `.env.compose` before invoking Docker.

| Resource | Stable | Staging |
|---|---|---|
| Home | `~/.answer-engine` | `~/.answer-engine-staging` |
| Compose project | `answer-engine-local` | `answer-engine-staging` |
| API / PostgreSQL / Redis | `5050` / `5433` / `6380` | `5150` / `5533` / `6480` |
| Web / MCP reservation | `3200` / `5051` | `3300` / `5151` |
| Database | `answerengine` | `answerengine_staging` |
| launchd sync label | `ai.answer-engine.sync` | `ai.answer-engine.staging.sync` |
| systemd sync unit | `answer-engine-sync.service` | `answer-engine-staging-sync.service` |
| History sync default | enabled | disabled |

Homes contain independent credentials, data, blobs, raw archives, logs, cursor
state, install-completion state, and release state. The installer writes
`.install-complete.json` only after agent wiring and the final memory round trip
succeed. A healthy retry is a no-op only when that checkpoint still matches the
selected home, channel, release, and ownership marker; otherwise it resumes the
unfinished stages. Named PostgreSQL, Redis, and blob volumes are also
channel-specific. `/health` and installer status always report the channel.

## Lifecycle

The no-action installer remains an alias for stable install. Every action also
accepts `--channel staging` and an optional channel-specific `--home`.

```bash
npx @answer-engine/create@1.1.0 install --channel stable
npx @answer-engine/create@1.1.0 install --channel staging --clients none
npx @answer-engine/create@1.1.0 start --channel staging
npx @answer-engine/create@1.1.0 stop --channel staging
npx @answer-engine/create@1.1.0 status --channel staging
npx @answer-engine/create@1.1.0 repair --channel staging
npx @answer-engine/create@1.1.0 upgrade --channel staging --image <pinned-image>
npx @answer-engine/create@1.1.0 rollback --channel staging
npx @answer-engine/create@1.1.0 uninstall --channel staging
npx @answer-engine/create@1.1.0 uninstall --channel staging --purge
```

Upgrade records the previous pinned image. Rollback swaps only that recorded
pair and refuses when no previous release exists. Repair and upgrade preserve
the selected channel's credentials and volumes. Purge deletes only the
ownership-verified selected home and volumes.

For non-default homes, set `AE_STABLE_HOME` or `AE_STAGING_HOME` when operating
the other channel. Validation canonicalizes both locations and rejects symlink
or path overlap, shared ports, projects, database/volume/service names,
credential paths, and equal credential fingerprints.

## Existing stable installation

An installer-managed `~/.answer-engine` remains stable. Adopt it without
restarting containers or touching database/archive bytes:

```bash
npx @answer-engine/create@1.1.0 install --channel stable
```

For an existing home, this verifies the legacy `answer-engine-local` project,
adds `AE_CHANNEL=stable` and the ownership marker, then exits. Back up the home
first as normal operational hygiene. Never move, copy, or point staging at the
stable directory.

## Staging history opt-in

Staging never wires global agent clients and cannot discover history by
default. Deliberate opt-in requires this in staging `config.yaml`:

```yaml
history_sync:
  enabled: true
```

Every one-shot sync, daemon run, or service installation also needs explicit
confirmation:

```bash
ae --channel staging sync once --confirm-staging-history-sync
ae --channel staging sync install-service --confirm-staging-history-sync
```

Removing the persisted opt-in makes later staging daemon starts fail closed.
Stable and staging CLI credentials live separately in `config.yml` and
`staging.yml`. Before any authenticated CLI request, the client verifies that
the target API's `/health` channel matches `--channel`; an overridden API URL
cannot silently redirect staging work into stable.
