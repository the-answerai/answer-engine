# Issue #74 acceptance record

## Outcome

The stable local installer credential was rotated on 2026-08-17 with a verified
overlap token. Claude Code and Codex legacy MCP entries were migrated from raw
environment credentials to keyless installer-managed Docker launchers before
the exposed credential was revoked. No token material was printed, logged, or
committed.

## Live verification

- The replacement token authenticated before cutover.
- The old protected token was revoked only after private runtime and CLI files
  contained the replacement.
- The replacement is the current protected local installer token.
- The API container received the replacement and returned healthy on
  `127.0.0.1:5050` after its controlled recreation.
- The launchd sync service restarted automatically and imported Claude, Codex,
  and Cowork changes with zero failures and zero parse errors.
- Active Claude and Codex config files contain no raw Answer Engine key and are
  mode `0600`; private backups contain only the now-revoked legacy value.
- The rotation wrote an `access_token.rotate` audit record associated with
  issue #74.
- The temporary overlap-token staging file was removed after verification.

## Disk safety

The raw archive remained below the existing 10 GiB hard ceiling, with the
per-bundle ceiling and minimum-free-space guard enabled. At final verification
the archive was under 1 GiB and the host retained approximately 1.1 TiB free.

## Regression coverage

`packages/create/src/__tests__/integrations.test.ts` proves that migration:

- removes raw keys from Claude and Codex Answer Engine entries;
- preserves unrelated MCP configuration;
- installs the keyless managed Docker launcher; and
- keeps rewritten files and backups mode `0600`.

Graphify, enterprise-only capabilities, npm publication, and stable memory
mutation were excluded.
