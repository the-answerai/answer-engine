#!/usr/bin/env bash
set -euo pipefail

# Codex linked-worktree sandboxes can connect to Unix sockets under /tmp, but
# macOS denies launching Chrome from inside the sandbox. Alpha Loop therefore
# runs `pnpm browser:prepare` before spawning the worker; later browser commands
# reuse the same host-side daemon through this short, project-scoped path.
browser_runtime_dir="${AE_AGENT_BROWSER_RUNTIME_DIR:-/tmp/answer-engine-oss-browser}"

mkdir -p "$browser_runtime_dir/socket" "$browser_runtime_dir/profile"

export AGENT_BROWSER_SOCKET_DIR="$browser_runtime_dir/socket"
export AGENT_BROWSER_PROFILE="$browser_runtime_dir/profile"
export AGENT_BROWSER_IDLE_TIMEOUT_MS="7200000"
# The long-lived daemon resolves relative output paths against the worktree that
# launched it. Pin screenshots to the current caller so issue artifacts never
# leak into a different worktree.
export AGENT_BROWSER_SCREENSHOT_DIR="$PWD"

exec pnpm exec agent-browser "$@"
