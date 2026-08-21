#!/usr/bin/env bash
set -eu

VERSION=1.1.2
TAG="v${VERSION}"
RELEASE_BASE="https://github.com/the-answerai/answer-engine/releases/download/${TAG}"
INSTALLER_ASSET="answer-engine-installer-v${VERSION}.tgz"
CLI_ASSET="answer-engine-cli-v${VERSION}.tgz"
BASH_ASSET="answer-engine-bootstrap-v${VERSION}.sh"
POWERSHELL_ASSET="answer-engine-bootstrap-v${VERSION}.ps1"
NODE_VERSION=22.23.2
NODE_DESTINATION="${HOME}/.local/share/answer-engine/node-v${NODE_VERSION}"
MODE=install
APPROVE_NODE=false
for argument in "$@"; do
  case "$argument" in
    --preflight) MODE=preflight ;;
    --approve-node) APPROVE_NODE=true ;;
    *) printf 'Unknown bootstrap option: %s\n' "$argument" >&2; exit 1 ;;
  esac
done

case "$RELEASE_BASE" in
  *'/latest/'*|*'/heads/'*|*'/master/'*|*'/main/'*)
    printf '%s\n' 'Refusing a floating release input.' >&2
    exit 1
    ;;
esac

umask 077
STAGING_DIRECTORY="$(mktemp -d "${TMPDIR:-/tmp}/answer-engine-bootstrap.XXXXXX")"
NODE_INSTALL_STAGING=
INSTALL_STAGING=
cleanup() {
  rm -rf "$STAGING_DIRECTORY"
  [ -z "$NODE_INSTALL_STAGING" ] || rm -rf "$NODE_INSTALL_STAGING"
  [ -z "$INSTALL_STAGING" ] || rm -rf "$INSTALL_STAGING"
}
trap cleanup EXIT HUP INT TERM

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}

verify_checksum() {
  expected="$1"
  path="$2"
  actual="$(sha256_file "$path")"
  if [ "$actual" != "$expected" ]; then
    printf 'Checksum mismatch for %s. Refusing to execute or install it.\n' "$(basename "$path")" >&2
    exit 1
  fi
}

verify_from_sums() {
  name="$1"
  expected="$(awk -v name="$name" '$2 == name || $2 == "*" name { print $1 }' "$STAGING_DIRECTORY/SHA256SUMS")"
  [ -n "$expected" ] || { printf 'Missing checksum for %s.\n' "$name" >&2; exit 1; }
  verify_checksum "$expected" "$STAGING_DIRECTORY/$name"
}

node_supported() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&(b>23||(b===23&&c>=2)))?0:1)'
}

if [ -x "$NODE_DESTINATION/bin/node" ]; then
  PATH="$NODE_DESTINATION/bin:$PATH"
  export PATH
fi

OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS" = Darwin ] && [ "$ARCH" = arm64 ]; then
  RELEASE_PLATFORM=macos
  RELEASE_ARCHITECTURE=arm64
  NODE_ARCHIVE="node-v${NODE_VERSION}-darwin-arm64.tar.xz"
  NODE_SHA256=5eff7a9011895aae3f29d06f167b84a62b028a591370c7cafb59103559fd26e1
elif [ "$OS" = Linux ] && [ "$ARCH" = x86_64 ] && grep -qiE 'microsoft-standard|wsl2' /proc/sys/kernel/osrelease; then
  RELEASE_PLATFORM=windows-wsl2
  RELEASE_ARCHITECTURE=x64
  NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
  NODE_SHA256=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307
else
  printf '%s\n' 'Supported bootstrap systems are Apple Silicon macOS and x64 Windows 11 WSL2.' >&2
  exit 1
fi

REQUIRED_READY=true
if docker info >/dev/null 2>&1; then
  printf '%s\n' '[READY|required|reuse] Docker daemon is reachable.'
else
  printf '%s\n' '[MISSING|required|privileged] Install or start Docker Desktop manually; it is never installed silently.'
  REQUIRED_READY=false
fi
COMPOSE_VERSION="$(docker compose version --short 2>/dev/null || true)"
case "$COMPOSE_VERSION" in
  v1.*|1.*|'')
    printf '%s\n' '[MISSING|required|privileged] Install Docker Compose v2 manually.'
    REQUIRED_READY=false
    ;;
  *) printf '[READY|required|reuse] Docker Compose %s\n' "$COMPOSE_VERSION" ;;
esac
if [ "$MODE" = install ] && [ "$REQUIRED_READY" != true ]; then exit 2; fi

if ! node_supported; then
  NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
  printf 'Missing required dependency: Node.js %s+\n' "$NODE_VERSION"
  printf 'Source: %s\nVersion: %s\nDestination: %s\n' "$NODE_URL" "$NODE_VERSION" "$NODE_DESTINATION"
  printf 'Command: download, verify SHA-256 %s, and extract the official archive.\n' "$NODE_SHA256"
  if [ "$MODE" = preflight ]; then
    printf '%s\n' '[MISSING|required|user-consent] Node.js 22.23.2 can be installed from the displayed verified user-scoped archive.'
    NODE_READY=false
  elif [ "$APPROVE_NODE" != true ]; then
    printf 'Install this user-scoped dependency? [y/N] '
    IFS= read -r approved
    case "$approved" in y|Y|yes|YES) ;; *) printf '%s\n' 'Cancelled before system or Answer Engine changes.'; exit 2 ;; esac
  else
    NODE_READY=true
  fi
  if [ "$MODE" != preflight ]; then
    curl --fail --location --proto '=https' --tlsv1.2 "$NODE_URL" -o "$STAGING_DIRECTORY/$NODE_ARCHIVE"
    verify_checksum "$NODE_SHA256" "$STAGING_DIRECTORY/$NODE_ARCHIVE"
    if [ -e "$NODE_DESTINATION" ]; then
      printf 'Refusing to replace existing Node destination: %s\n' "$NODE_DESTINATION" >&2
      exit 1
    fi
    mkdir -p "$(dirname "$NODE_DESTINATION")"
    NODE_INSTALL_STAGING="${NODE_DESTINATION}.tmp.$$"
    mkdir "$NODE_INSTALL_STAGING"
    tar -xJf "$STAGING_DIRECTORY/$NODE_ARCHIVE" --strip-components=1 -C "$NODE_INSTALL_STAGING"
    PATH="$NODE_INSTALL_STAGING/bin:$PATH"
    export PATH
    node_supported || { printf '%s\n' 'Node.js readiness did not pass after installation.' >&2; exit 1; }
    mv "$NODE_INSTALL_STAGING" "$NODE_DESTINATION"
    NODE_INSTALL_STAGING=
    PATH="$NODE_DESTINATION/bin:$PATH"
    export PATH
    printf '%s\n' 'Node.js readiness passed after installation.'
  fi
else
  NODE_READY=true
  printf '[READY|required|reuse] Node.js %s\n' "$(node --version)"
fi

if command -v nvidia-smi >/dev/null 2>&1 || [ "$OS" = Darwin ]; then
  printf '%s\n' '[READY|optional|reuse] Supported GPU capability is visible.'
else
  printf '%s\n' '[MISSING|optional|privileged] GPU drivers are manual; reduced-local or cloud-backed remains available.'
fi
if command -v lms >/dev/null 2>&1; then
  printf '%s\n' '[READY|optional|reuse] A model runtime is configured.'
else
  printf '%s\n' '[MISSING|optional|manual] Install a model runtime manually or explicitly choose cloud-backed models.'
fi
if [ "$MODE" = preflight ]; then
  [ "$NODE_READY" = true ] && [ "$REQUIRED_READY" = true ] || exit 2
  exit 0
fi
[ "$REQUIRED_READY" = true ] || exit 2

NODE_EXECUTABLE="$(command -v node)"
[ -n "$NODE_EXECUTABLE" ] && [ -x "$NODE_EXECUTABLE" ] || {
  printf '%s\n' 'A compatible Node.js executable was not available for release verification.' >&2
  exit 1
}

for asset in SHA256SUMS release-manifest.json provenance.json "$INSTALLER_ASSET" "$CLI_ASSET" "$BASH_ASSET" "$POWERSHELL_ASSET" INSTALL_AGENT.md; do
  curl --fail --location --proto '=https' --tlsv1.2 "$RELEASE_BASE/$asset" -o "$STAGING_DIRECTORY/$asset"
done
for asset in release-manifest.json provenance.json "$INSTALLER_ASSET" "$CLI_ASSET" "$BASH_ASSET" "$POWERSHELL_ASSET" INSTALL_AGENT.md; do verify_from_sums "$asset"; done

VERIFY_ROOT="$STAGING_DIRECTORY/installer-verify"
mkdir "$VERIFY_ROOT"
tar -xzf "$STAGING_DIRECTORY/$INSTALLER_ASSET" -C "$VERIFY_ROOT"
"$NODE_EXECUTABLE" "$VERIFY_ROOT/dist/verify-release-download.js" \
  "$STAGING_DIRECTORY" "$RELEASE_PLATFORM" "$RELEASE_ARCHITECTURE"

INSTALL_ROOT="${HOME}/.local/share/answer-engine/releases/${VERSION}"
BIN_ROOT="${HOME}/.local/bin"
if [ -e "$INSTALL_ROOT" ]; then
  verify_checksum "$(awk -v name="$INSTALLER_ASSET" '$2 == name { print $1 }' "$STAGING_DIRECTORY/SHA256SUMS")" "$INSTALL_ROOT/.installer-archive"
  verify_checksum "$(awk -v name="$CLI_ASSET" '$2 == name { print $1 }' "$STAGING_DIRECTORY/SHA256SUMS")" "$INSTALL_ROOT/.cli-archive"
else
  mkdir -p "$(dirname "$INSTALL_ROOT")"
  INSTALL_STAGING="${INSTALL_ROOT}.tmp.$$"
  mkdir -p "$INSTALL_STAGING/installer" "$INSTALL_STAGING/cli"
  tar -xzf "$STAGING_DIRECTORY/$INSTALLER_ASSET" -C "$INSTALL_STAGING/installer"
  tar -xzf "$STAGING_DIRECTORY/$CLI_ASSET" -C "$INSTALL_STAGING/cli"
  cp "$STAGING_DIRECTORY/$INSTALLER_ASSET" "$INSTALL_STAGING/.installer-archive"
  cp "$STAGING_DIRECTORY/$CLI_ASSET" "$INSTALL_STAGING/.cli-archive"
  mv "$INSTALL_STAGING" "$INSTALL_ROOT"
  INSTALL_STAGING=
fi
mkdir -p "$BIN_ROOT"
shell_literal() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}
install_launcher() {
  target="$1"
  launcher="$2"
  temporary_launcher="${launcher}.tmp.$$"
  # shellcheck disable=SC2016 -- these variables expand when the generated launcher runs.
  printf '#!/bin/sh\nNODE_EXECUTABLE=%s\ntarget=%s\nexec "$NODE_EXECUTABLE" "$target" "$@"\n' \
    "$(shell_literal "$NODE_EXECUTABLE")" "$(shell_literal "$target")" > "$temporary_launcher"
  chmod 700 "$temporary_launcher"
  if [ -L "$launcher" ]; then
    [ "$(readlink "$launcher")" = "$target" ] || {
      rm -f "$temporary_launcher"
      printf 'Refusing to replace an existing launcher: %s\n' "$launcher" >&2
      exit 1
    }
    rm "$launcher"
  elif [ -e "$launcher" ]; then
    if cmp -s "$temporary_launcher" "$launcher"; then
      rm "$temporary_launcher"
      return
    fi
    rm -f "$temporary_launcher"
    printf 'Refusing to replace an existing launcher: %s\n' "$launcher" >&2
    exit 1
  fi
  mv "$temporary_launcher" "$launcher"
}
install_launcher "$INSTALL_ROOT/installer/dist/index.js" "$BIN_ROOT/create-answer-engine"
install_launcher "$INSTALL_ROOT/cli/dist/index.js" "$BIN_ROOT/ae"
"$BIN_ROOT/create-answer-engine" preflight --channel stable
