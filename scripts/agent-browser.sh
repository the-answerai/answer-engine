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
  local checkout_root
  local common_dir
  local common_repository_root=""
  local trusted_root
  local project_daemon=false

  [[ -f "$pid_file" ]] || return 0

  daemon_pid="$(tr -d '[:space:]' < "$pid_file")"
  if [[ ! "$daemon_pid" =~ ^[0-9]+$ ]]; then
    echo "Refusing to reset agent-browser: invalid daemon PID in $pid_file" >&2
    return 1
  fi

  kill -0 "$daemon_pid" 2>/dev/null || return 0
  [[ "$(ps -p "$daemon_pid" -o stat=)" == Z* ]] && return 0

  checkout_root="$(git rev-parse --show-toplevel)"
  common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
  case "$common_dir" in
    */.git)
      common_repository_root="${common_dir%/.git}"
      ;;
    */.git/worktrees/*)
      # A submodule inside a superproject worktree stores its Git metadata
      # below .../.git/worktrees/<name>/modules/. That path belongs to the
      # consumer, not this OSS checkout, so only trust the checkout root.
      if [[ "$common_dir" != */modules/* ]]; then
        common_repository_root="${common_dir%%/.git/worktrees/*}"
      fi
      ;;
  esac
  daemon_command="$(ps -p "$daemon_pid" -o command=)"
  for trusted_root in "$checkout_root" "$common_repository_root"; do
    [[ -n "$trusted_root" ]] || continue
    case "$daemon_command" in
      "$trusted_root"/*/node_modules/agent-browser/bin/agent-browser-*)
        project_daemon=true
        break
        ;;
    esac
  done
  if [[ "$project_daemon" != true ]]; then
    echo "Refusing to stop PID $daemon_pid because it is not this repository's agent-browser daemon: $daemon_command" >&2
    return 1
  fi

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

if [[ "${1:-}" == "open" ]]; then
  if pnpm exec agent-browser "$@"; then
    exit 0
  fi
  echo "agent-browser open failed; resetting the validated project daemon and retrying once" >&2
  stop_project_daemon
fi

exec pnpm exec agent-browser "$@"
