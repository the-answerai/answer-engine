# Immutable installer releases

Answer Engine onboarding uses versioned GitHub Release assets and does not
publish or fetch `@answer-engine/create` or `@answer-engine/cli` from npm. The
canonical copy-paste commands live in [INSTALL_AGENT.md](../INSTALL_AGENT.md).
They pin `v1.1.0` plus the published bootstrap SHA-256, download `SHA256SUMS`
and the platform bootstrap, require the release checksum to match the pinned
value, verify the bootstrap before execution, and reject branch or `/latest`
inputs. The bootstrap then verifies the manifest, provenance, installer archive,
and CLI archive before installing user-owned launchers.

## Supported baseline and dependency policy

- Apple Silicon macOS (`arm64`) with 16 GB RAM is the full-local macOS baseline.
- Windows 11 x64 build 22000+ runs the verified PowerShell handoff through WSL2;
  the native Windows process never configures a separate runtime.
- Node.js 22.16+, a reachable Docker daemon, and Docker Compose v2 are required.
  Compatible installed versions are reused.
- The official Node.js 22.16.0 archive is the only dependency the bootstrap can
  add. It shows the nodejs.org source, version, fixed SHA-256, user-owned
  destination, and exact operation, then requires explicit consent. Readiness is
  rerun afterward.
- Docker Desktop/daemon, Compose system packages, WSL2, GPU drivers, privileged
  OS components, and LM Studio or another model runtime are never silently
  installed. Missing required items stop before Answer Engine mutation and show
  platform-specific manual instructions. GPU and model runtime gaps are marked
  optional when reduced-local or an explicitly opted-in cloud route is viable.
- Declining dependency or installation consent leaves the Answer Engine home,
  runtime, clients, and system configuration unchanged. Temporary downloads are
  removed on exit.

## Release contents and reproducibility

The manually dispatched `Installer release assets` workflow checks out a full
40-character commit, validates the semantic tag and content-addressed
`ghcr.io/the-answerai/answer-engine@sha256:...` image, runs `pnpm verify`, and
creates deterministic installer and CLI archives. It emits `SHA256SUMS`, a Zod-
validated download manifest, and SLSA-format provenance recording the commit,
lockfile, package-manager version, runtime digest, and output subjects. It never
runs an npm publish step.

Every dispatch first uploads a candidate artifact. GitHub Release publication
is a separate `publish_release=true` job protected by the `production-release`
environment and rechecks all hashes. Publication refuses to replace any existing
asset at the exact tag; corrections require a new version and tag. An unattended
implementation run must stop at the candidate. Signing, publication, and clean-
machine macOS/Windows execution remain explicit release acceptance in issue #49.

To reproduce a candidate after package builds:

```bash
node scripts/build-release-assets.mjs \
  --tag v1.1.0 \
  --commit <full-40-character-commit> \
  --image ghcr.io/the-answerai/answer-engine@sha256:<64-hex-digest> \
  --output tmp/release-candidate
(cd tmp/release-candidate && shasum -a 256 -c SHA256SUMS)
```

## Runtime immutability and fallback

Fresh install scaffolding has no mutable image fallback. It writes the verified
manifest digest to `.env.compose` and `.release-state.json` before Docker starts.
The checked-in manifest is deliberately non-runnable: its source commit and
Answer Engine image are explicit template markers. Only the exact-commit release
builder replaces them, and it runs the strict runtime manifest verifier before
creating an archive. A source checkout therefore cannot invent or silently trust
a plausible digest.
An install retry must match that recorded digest; changing versions through the
install path fails closed and directs the user to guarded upgrade instead.
Upgrade accepts only `@sha256:` references; rollback selects only a previously
verified digest. A legacy stable install remains inspectable and adoptable, but
its old mutable tag is not recorded as a rollback target. Its first upgrade must
move to a verified digest.

If automated dependency installation is unavailable, install Node.js 22.16+
manually from nodejs.org and rerun bootstrap preflight. Install Docker Desktop,
WSL2, GPU support, or a model runtime only from the vendor's platform
instructions, then rerun readiness. Never bypass checksum failures: remove the
temporary download and obtain the exact release asset again.
