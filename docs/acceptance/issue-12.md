# Issue #12 integrated acceptance record

Execution date: 2026-08-13 (America/Los_Angeles)

This is the final integrated acceptance record for epic #6. It uses the local
installer stack, the live append-only Claude Code, Codex, and Cowork corpus, the
configured LM Studio models, the repository-owned browser profile, and the
merged enterprise composition. Secrets, raw content, and private record titles
are intentionally omitted.

## Clean installer and database

The local create package was built from this checkout. A separate home and
Compose project under `/tmp/answer-engine-issue12-acceptance` was installed
twice with the same command and frozen local image, without Auth0, billing
credentials, a supplied API key, or agent configuration:

```text
COMPOSE_PROJECT_NAME=answer-engine-issue12-acceptance \
ANSWER_ENGINE_IMAGE=answer-engine-oss:local \
node packages/create/dist/index.js --yes \
  --home /tmp/answer-engine-issue12-acceptance \
  --models chat=qwen/qwen3.5-9b,embedding=text-embedding-nomic-embed-text-v1.5 \
  --agents none
```

Both invocations passed preflight, model checks, scaffold/start, health, and the
installer `remember -> recall -> inspect_memory` verification. The second run
left each migration, the local tenant, and the protected Personal Memory
library present exactly once. The isolated project, volumes, and temporary
installer credential were removed after verification. The real installer home
was then migrated and initialized again, and its API was recreated from the
review image; migration/init and health remained idempotent.

## Background sync, models, and real history

The installed macOS service `ai.answer-engine.sync` was running from
`~/Library/LaunchAgents/ai.answer-engine.sync.plist`. A fresh complete cycle
after `2026-08-13T08:20:00.000Z` reported zero failed rows and zero parse errors
for all sources. The final read-only verifier command was:

```text
pnpm acceptance:real-history \
  --installer-home /Users/bradtaylor/.answer-engine \
  --sync-log /Users/bradtaylor/.answer-engine/logs/sync.out.log \
  --sync-after 2026-08-13T08:20:00.000Z \
  --sample-size 3
```

It passed with this result:

| Source | Latest scan | Stored rows | Valid manifests | Archives sampled | Files hashed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude Code | 854 | 1,267 | 1,267 | 3 | 3 |
| Codex | 4,143 | 4,143 | 4,143 | 3 | 3 |
| Cowork | 112 | 164 | 164 | 3 | 15,724 |

The latest successful source completions were `08:25:11Z`, `08:25:17Z`, and
`08:24:55Z`, respectively. Claude Code and Codex exceed the frozen 848/4105
baseline because the corpus is append-only and continued to grow during
acceptance. The verifier requires those baselines as minimums while comparing
the database to the current scan inventory.

LM Studio advertised both configured models. A direct embedding request to
`text-embedding-nomic-embed-text-v1.5` returned 768 finite numeric dimensions.
The grounded ask checks below used `qwen/qwen3.5-9b` through the configured
`lmstudio` provider.

## REST and MCP grounding

The REST probe selected one real record from each source without printing its
contents. Full-text query returned the selected record, and lineage returned
`claude-code`, `codex`, and `cowork` with one current artifact apiece. A cited
ask restricted to the three selected UUIDs returned exactly three citations,
cited all selected records, included inline citation markers, and reported
`lmstudio / qwen/qwen3.5-9b`.

The built MCP server was then exercised through its actual stdio transport with
the MCP SDK. `search_content`, `ask`, and `inspect_memory` were registered;
search returned the selected real record, inspection covered all three source
labels, and the grounded answer cited all three selected UUIDs.

## Browser workflows

All checks used `pnpm browser:ui` and the repository's prepared shared profile
against the installer API at `http://127.0.0.1:5050`. The desktop pass used
1440x900. The mobile pass used 375x812 with reduced motion enabled.

The following routes rendered their expected heading with no application error
notice at both widths: content, import, tags, libraries, answers, batch jobs,
settings, library members, overview/filter, recipes, reports, dashboards, and
library audit. At 375px every route had no horizontal document overflow and the
mobile header was active.

The desktop mutation pass exercised:

- invalid JSON handling and successful preview/import;
- tag create, edit, and delete;
- library create, include/exclude membership, filter preview/save, and delete;
- grounded ask, citations, content inspector, lineage, artifacts, and archive;
- recipe create, preview, run, and deactivate;
- report create, generate/cancel, and delete;
- dashboard create and delete;
- batch create, terminal success, export controls, and terminal-state error handling;
- settings update/restore, access-token mint/edit/revoke, and audit filtering.

The temporary browser records and credential were deleted or revoked. Their
audit events remain, as required for local audit integrity.

The mobile navigation moved focus to its first link, trapped keyboard
navigation, closed on Escape, and restored focus to the menu button. The browser
confirmed `prefers-reduced-motion: reduce`. An axe WCAG 2 A/AA audit initially
found the shared metadata color at 4.39:1; the token was corrected to 4.74:1,
the review image was rebuilt, and the repeated audit reported zero violations
and zero incomplete checks. Browser page captures were retained in the
temporary acceptance directory during visual review; the DOM assertions above
are the durable, content-redacted record.

## Enterprise parity and project gates

Enterprise issue #964 was closed by merged PR #966. The enterprise checkout was
at `f9e976b86965f801083f8449cfe98d986b1be567` and its OSS submodule and reviewed
manifest both pinned `2cc52e9c53ab7641a8221df7d8b356d1ccfaab15`.

That pin was authoritative for the initial enterprise composition gate. Issue
#12 subsequently landed the shared accessibility token correction and final
acceptance tooling. After this record reaches OSS `master`, enterprise #964 is
reopened once to advance both pin locations to this final OSS revision; the
resulting enterprise PR and exact pin are recorded on #12 before the final
verify-only invocation.

The enterprise verifier ran from a clean writable copy after frozen root and
nested OSS installs. Its composition boundary check reported 17 core surfaces
and exactly five private families; the pinned OSS verifier passed; enterprise
lint and type-check passed; all 15 composition tests passed; and the composed
server/web build passed. A sandbox-safe test `ps` fixture was placed first on
`PATH` because this managed macOS sandbox denies `/bin/ps`; production process
inspection was not bypassed.

The final OSS `pnpm verify` passed: public-boundary check, lint, type-check, 79
server/repository tests (one database integration test intentionally skipped),
138 CLI tests, 62 MCP tests, 27 installer tests, 33 web tests, and every package
build.

The epic-level gate was run from clean commit `75bae18`:

```text
node ../../../alpha-loop/dist/cli.js run --verify-only 6
```

Alpha Loop found all six children for evaluation, but its nested Codex process
could not initialize inside the already managed Codex sandbox: the parent
sandbox made `~/.codex/state_5.sqlite` read-only and rejected the nested
in-process app-server client with `Operation not permitted`. Alpha Loop therefore
returned `verdict=partial`, posted an unparsed-output comment, and added
`needs-human-input` to epic #6. No product assertion or repository test failed.

That nested partial result is retained as evidence of the rejected worker
attempt, not as the authoritative epic verdict. After session PR #35 reached
the default branch, the host orchestrator ran the exact command from the OSS
root. It reached 6/6 merged children but returned `partial` for two engine
reasons: fuzzy `closes:#N` search selected unrelated later PRs for #7-#9, and
the verifier circularly required a prior successful invocation of the command
it was currently executing. No product assertion failed.

Those defects were fixed in Alpha Loop issue #398 and merged PR #399 at
`613d6415e7812ae41c5ac9f5b138bd80eff0d617`. Regression coverage now resolves
exact merged timeline cross-references, supplies bounded PR checks/bodies and
issue verification comments as untrusted evidence, and treats the current
verify-only invocation as the evidence-producing gate. Its focused 76-test
suite, complete 1,528-test suite, TypeScript build, and GitHub CI passed. The
post-merge workflow explicitly skipped all npm publish/tag/release steps
because package version `2.4.0` still matched tag `v2.4.0`.

The host orchestrator performs one final exact verify-only invocation after
this correction record reaches the default branch. Alpha Loop records that
authoritative verdict directly on epic #6; npm publication remains out of
scope.
