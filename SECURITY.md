# Security Policy

## Supported versions

Security fixes target the latest published release and the `master` branch.
Older releases may receive a fix when a maintainer determines that a safe
backport is practical. The release notes identify supported upgrade and
rollback paths.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/the-answerai/answer-engine/security/advisories/new).
Do not open a public issue for a suspected vulnerability and do not include
real API keys, personal memory, transcripts, raw archives, or third-party data
in a report. Use minimal synthetic reproduction data.

Include the affected version or commit, impact, prerequisites, reproduction
steps, and any suggested mitigation. Maintainers aim to acknowledge a report
within five business days. Remediation and disclosure timing depend on impact,
exploitability, and the availability of a safe fix; the reporter will receive
status updates through the private advisory.

If private reporting is temporarily unavailable, use the private contact
method on [the-answerai organization profile](https://github.com/the-answerai)
and ask for a secure reporting channel without including vulnerability details
in the initial message.

## Security model and scope

Answer Engine is local-first and binds its default services to loopback. Treat
local API keys, provider credentials, archives, database volumes, release
signing material, and CI secrets as sensitive. Useful reports include
authentication or tenant-isolation bypasses, unsafe file ingestion, command or
SQL injection, secret disclosure, release/update-chain compromise, and unsafe
default network exposure.

Reports that only describe unsupported deployment configurations, require an
already fully trusted local administrator, or concern roles, RBAC, teams,
billing, or permissions in the separate enterprise product may be redirected
to the appropriate project.
