# Enterprise composition contract

The OSS repository is the canonical implementation of every single-user page,
route, and workflow. A private consumer may add only the extension families in
[`product-boundary.json`](../product-boundary.json): roles, RBAC, teams,
billing, and permissions. Those additions compose around the public server and
web entry points; they do not replace or copy an OSS page.

## Stable entry points

- `@answer-engine/server` exports `createApp()` for composing the Express app.
- `@answer-engine/server/composition` exports server capability, route,
  authentication, registrar, and configuration contracts.
- `@answer-engine/web-ui` exports `App`, `createWebComposition()`, the identity,
  authorization, route, navigation, and settings contracts, and the complete
  core web manifest.

The web package remains private and is not published by this change. Its build
produces the standalone application in `packages/web-ui/dist` and a library
entry in `packages/web-ui/dist/lib` with React and the other UI runtime
dependencies externalized. A repository consumer must supply those peer
runtime dependencies from its own application bundle.

Server route registrars receive the configured Express app and a typed
composition context. The route metadata beside each registrar is required so
contract tests can identify the capability and access boundary without
inspecting private code. A custom authentication extension supplies both its
middleware and a request-context resolver. The resolver must return the OSS
`tenantId`, `apiKeyId`, optional `libraryId`, and explicit `read`/`write`
capabilities; `createApp()` validates and installs that context before any
authenticated extension or core route runs. Web contributions declare a paid
capability and are validated before rendering. Navigation and settings
contributions denied by the injected authorization adapter are hidden; denied
extension routes are not registered. Core routes are never passed through the
extension policy.

With no extensions, `createApp()` retains local API-key authentication and
`App` uses the no-login local identity bootstrap. That standalone path is the
reference behavior that private composition must preserve.

## Pin and update workflow

The private repository must consume an exact, full OSS Git commit rather than
a branch, moving tag, copied directory, or independently maintained page set.
Use a workspace/submodule or equivalent source pin that resolves both the
server and web packages from that one commit.

For every pin update:

1. Open a dedicated enterprise pull request that changes the OSS commit pin.
2. Review changes to `product-boundary.json`, the exported composition types,
   and `coreWebManifest` before changing private adapters.
3. Build the pinned OSS server and web library; do not publish either package
   as part of this workflow.
4. Run the enterprise fixture/contract suite against the new exports and prove
   every private route, navigation item, identity presentation, authorization
   decision, and settings section composes through the typed contracts.
5. Run `pnpm verify` in the pinned OSS checkout and the private repository's
   full test/build suite. Exercise the composed application at desktop and
   375px mobile width.
6. Merge only after the private application exposes the entire pinned
   `coreWebManifest` and no OSS page has been copied, shadowed, or removed.

If a new non-paid surface is needed, add it to OSS first and bump the pin after
the OSS change merges. If a new paid family is proposed, change the canonical
allowlist explicitly with product-boundary review; extension code must not
silently expand that boundary.
