#!/usr/bin/env bash
set -euo pipefail

# Codex linked-worktree sandboxes can connect to Unix sockets under /tmp, but
# macOS denies launching Chrome from inside the sandbox. Alpha Loop therefore
# runs `pnpm browser:prepare` before spawning the worker; later browser commands
# reuse the same host-side daemon through this short, project-scoped path.
browser_runtime_dir="${AE_AGENT_BROWSER_RUNTIME_DIR:-/tmp/answer-engine-oss-browser}"
browser_session="answer-engine-oss"

mkdir -p "$browser_runtime_dir/socket" "$browser_runtime_dir/profile"

export AGENT_BROWSER_SOCKET_DIR="$browser_runtime_dir/socket"
export AGENT_BROWSER_PROFILE="$browser_runtime_dir/profile"
export AGENT_BROWSER_IDLE_TIMEOUT_MS="7200000"
# The long-lived daemon resolves relative output paths against the worktree that
# launched it. Pin screenshots to the current caller so issue artifacts never
# leak into a different worktree.
export AGENT_BROWSER_SCREENSHOT_DIR="$PWD"

stop_project_daemon() {
  local pid_file="$browser_runtime_dir/socket/$browser_session.pid"
  local daemon_pid
  local daemon_command
  local repository_root

  [[ -f "$pid_file" ]] || return 0

  daemon_pid="$(tr -d '[:space:]' < "$pid_file")"
  if [[ ! "$daemon_pid" =~ ^[0-9]+$ ]]; then
    echo "Refusing to reset agent-browser: invalid daemon PID in $pid_file" >&2
    return 1
  fi

  kill -0 "$daemon_pid" 2>/dev/null || return 0

  repository_root="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
  daemon_command="$(ps -p "$daemon_pid" -o command=)"
  case "$daemon_command" in
    "$repository_root"/*/node_modules/agent-browser/bin/agent-browser-*) ;;
    *)
      echo "Refusing to stop PID $daemon_pid because it is not this repository's agent-browser daemon: $daemon_command" >&2
      return 1
      ;;
  esac

  kill -TERM "$daemon_pid"
  for _ in {1..50}; do
    kill -0 "$daemon_pid" 2>/dev/null || return 0
    [[ "$(ps -p "$daemon_pid" -o stat=)" == Z* ]] && return 0
    sleep 0.1
  done

  echo "agent-browser daemon PID $daemon_pid did not stop within 5 seconds" >&2
  return 1
}

# `close` intentionally leaves agent-browser's daemon alive. Alpha Loop removes
# completed issue worktrees, so the next issue must replace that daemon before
# Chrome is launched again; otherwise its binary and CWD point at deleted paths.
if [[ "${1:-}" == "prepare" ]]; then
  stop_project_daemon
  shift
  set -- open about:blank "$@"
fi

exec pnpm exec agent-browser "$@"
