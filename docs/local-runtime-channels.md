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
| Vite web-development / MCP reservation | `3200` / `5051` | `3300` / `5151` |
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
create-answer-engine install --channel stable
create-answer-engine install --channel staging --clients none
create-answer-engine start --channel staging
create-answer-engine stop --channel staging
create-answer-engine status --channel staging
create-answer-engine repair --channel staging
create-answer-engine upgrade --channel staging --image <name@sha256:64-hex-digest>
create-answer-engine rollback --channel staging
create-answer-engine uninstall --channel staging
create-answer-engine uninstall --channel staging --purge
```

Upgrade rejects tags and records only a verified content-addressed digest.
Rollback swaps only a previously recorded digest pair and refuses when no
verified previous release exists. A legacy mutable image remains readable but
does not become a rollback target. Repair and upgrade preserve
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
create-answer-engine install --channel stable
```

For an existing home, this validates that the home and required Compose,
environment, and configuration entries are regular files rather than symbolic
links; verifies the legacy `answer-engine-local` project, stable channel, valid
configuration mappings, the known Answer Engine services, images, commands,
loopback ports, named mounts and volumes, and stable/staging isolation; then
adds only `AE_CHANNEL=stable` and the private ownership marker. Extra services,
host mounts, privileged options, and unexpected runtime definitions fail
closed. Adoption exits without checking or binding reserved ports, starting
containers, migrating data, or changing database, blob, volume, or raw-archive
bytes. Invalid, wrong-project, channel-conflicting, or symlinked legacy homes
fail closed with an actionable error. Partial homes are not adopted and
continue through the normal resumable install path. Back up the home first as
normal operational hygiene. Never move, copy, or point staging at the stable
directory.

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
