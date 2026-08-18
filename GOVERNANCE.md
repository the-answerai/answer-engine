# Governance

Answer Engine uses maintainer-led governance. TheAnswer.ai, Inc. stewards the
project and designates maintainers with merge and release authority.

## Decisions

Routine fixes and small features are decided through issue and pull-request
review. Changes to public APIs, storage formats, security boundaries, licensing,
supported platforms, release policy, or the OSS/enterprise boundary require an
issue that records alternatives, tradeoffs, and the maintainer decision before
implementation.

Maintainers seek useful community input but may decline changes that expand
the security surface, weaken local-first defaults, create migration risk, or
conflict with the project's scope. When consensus is unavailable, the
designated maintainer makes and documents the decision.

## Maintainer responsibilities

Maintainers are expected to apply the Code of Conduct, review changes on their
merits, disclose conflicts of interest, protect private reports and release
credentials, and avoid merging their own high-risk changes without independent
verification when another maintainer is available.

Release tags and assets must come from reviewed source, pass required checks,
and follow the documented release process. Repository settings and maintainer
access are reviewed when the project changes ownership or security posture.

## Scope boundary

The OSS project owns the complete single-user product, local operations,
deployment, audit, workspaces, and neutral extension interfaces. Roles, RBAC,
teams, billing, and permissions are maintained exclusively in the separate
enterprise repository. A capability does not become enterprise-only merely
because a hosted or commercial application uses it.

## Changes to governance

Governance changes use a public issue and pull request. Material changes are
called out in release notes or a repository announcement before taking effect.
