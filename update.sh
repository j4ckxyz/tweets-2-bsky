#!/usr/bin/env bash

set -euo pipefail

APP_NAME="tweets-2-bsky"
LEGACY_APP_NAME="twitter-mirror"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RUNTIME_DIR="$SCRIPT_DIR/data/runtime"
PID_FILE="$RUNTIME_DIR/${APP_NAME}.pid"
LOCK_DIR="$RUNTIME_DIR/.update.lock"

CONFIG_FILE="$SCRIPT_DIR/config.json"
ENV_FILE="$SCRIPT_DIR/.env"

DO_INSTALL=1
DO_BUILD=1
DO_NATIVE_REBUILD=1
DO_RESTART=1
REMOTE_OVERRIDE=""
BRANCH_OVERRIDE=""
ORIGINAL_ARGS=("$@")
UPDATE_SH_REEXECED="${UPDATE_SH_REEXECED:-0}"

STASH_REF=""
STASH_CREATED=0
STASH_RESTORED=0
UNTRACKED_COUNT=0

BACKUP_SOURCES=()
BACKUP_PATHS=()
BUN_BIN=""
ORIGINAL_SCRIPT_CHECKSUM=""

usage() {
  cat <<'USAGE'
Usage: ./update.sh [options]

Default behavior:
  - Pull latest git changes safely
  - Install dependencies
  - Rebuild native modules if needed
  - Build server + web dashboard
  - Restart existing runtime (PM2 or nohup) when possible

Options:
  --remote <name>         Git remote to pull from (default: origin or first remote)
  --branch <name>         Git branch to pull (default: current branch or remote HEAD)
  --skip-install          Skip bun install
  --skip-build            Skip bun run build
  --skip-native-rebuild   Skip native-module rebuild checks
  --no-restart            Do not restart process after update
  -h, --help              Show this help
USAGE
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "❌ Required command not found: $command_name"
    exit 1
  fi
}

ensure_bun_runtime() {
  install_latest_bun() {
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL https://bun.sh/install | bash >/dev/null
      return 0
    fi
    if command -v wget >/dev/null 2>&1; then
      wget -qO- https://bun.sh/install | bash >/dev/null
      return 0
    fi

    echo "❌ Bun is required, and curl/wget is unavailable for auto-install."
    echo "   Install Bun manually: https://bun.com/docs/installation"
    exit 1
  }

  resolve_bun_bin() {
    if command -v bun >/dev/null 2>&1; then
      command -v bun
      return 0
    fi
    if [[ -x "${HOME}/.bun/bin/bun" ]]; then
      printf '%s\n' "${HOME}/.bun/bin/bun"
      return 0
    fi
    return 1
  }

  if ! BUN_BIN="$(resolve_bun_bin)"; then
    echo "📦 Bun not found. Installing latest Bun..."
    install_latest_bun
    BUN_BIN="$(resolve_bun_bin || true)"
  fi

  if [[ -z "$BUN_BIN" || ! -x "$BUN_BIN" ]]; then
    echo "❌ Bun could not be resolved."
    echo "   Install Bun manually: https://bun.com/docs/installation"
    exit 1
  fi

  export PATH="$(dirname "$BUN_BIN"):$PATH"

  if ! "$BUN_BIN" upgrade >/dev/null 2>&1; then
    echo "⚠️  Bun auto-upgrade failed. Reinstalling latest Bun..."
    install_latest_bun
    BUN_BIN="$(resolve_bun_bin || true)"
  fi

  if [[ -z "$BUN_BIN" || ! -x "$BUN_BIN" ]]; then
    echo "❌ Bun could not be resolved after auto-upgrade."
    echo "   Install Bun manually: https://bun.com/docs/installation"
    exit 1
  fi

  export PATH="$(dirname "$BUN_BIN"):$PATH"

  local bun_major
  bun_major="$($BUN_BIN --version | awk -F. '{print $1}' 2>/dev/null || echo 0)"
  if [[ "$bun_major" -lt 1 ]]; then
    echo "❌ Bun 1.x+ is required. Current: $($BUN_BIN --version 2>/dev/null || echo 'unknown')"
    exit 1
  fi
}

run_bun() {
  "$BUN_BIN" "$@"
}

compute_file_checksum() {
  local file="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return 0
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return 0
  fi

  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
    return 0
  fi

  return 1
}

acquire_lock() {
  mkdir -p "$RUNTIME_DIR"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "❌ Another update appears to be running."
    echo "   If this is stale, remove: $LOCK_DIR"
    exit 1
  fi
}

release_lock() {
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
}

backup_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    return 0
  fi

  local base
  base="$(basename "$file")"
  local backup_path
  backup_path="$(mktemp_file "tweets2bsky-${base}")"
  cp "$file" "$backup_path"
  BACKUP_SOURCES+=("$file")
  BACKUP_PATHS+=("$backup_path")
}

restore_backups() {
  local idx
  for idx in "${!BACKUP_SOURCES[@]}"; do
    local src="${BACKUP_SOURCES[$idx]}"
    local bak="${BACKUP_PATHS[$idx]}"
    if [[ -f "$bak" ]]; then
      cp "$bak" "$src"
      rm -f "$bak"
    fi
  done
}

cleanup() {
  restore_backups
  release_lock
}

mktemp_file() {
  local prefix="$1"

  if mktemp --version >/dev/null 2>&1; then
    mktemp "${TMPDIR:-/tmp}/${prefix}.XXXXXX"
    return 0
  fi

  local tmp_root
  tmp_root="${TMPDIR:-/tmp}"
  mktemp -t "${prefix}.XXXXXX" 2>/dev/null || mktemp "${tmp_root}/${prefix}.XXXXXX"
}

ensure_git_repo() {
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "❌ This directory is not a git repository: $SCRIPT_DIR"
    exit 1
  fi
}

resolve_remote() {
  if [[ -n "$REMOTE_OVERRIDE" ]]; then
    if ! git remote | grep -qx "$REMOTE_OVERRIDE"; then
      echo "❌ Remote '$REMOTE_OVERRIDE' does not exist."
      exit 1
    fi
    printf '%s\n' "$REMOTE_OVERRIDE"
    return 0
  fi

  if git remote | grep -qx "origin"; then
    printf '%s\n' "origin"
    return 0
  fi

  local first_remote
  first_remote="$(git remote | head -n 1)"
  if [[ -z "$first_remote" ]]; then
    echo "❌ No git remote configured."
    exit 1
  fi

  printf '%s\n' "$first_remote"
}

resolve_branch() {
  local remote="$1"

  if [[ -n "$BRANCH_OVERRIDE" ]]; then
    printf '%s\n' "$BRANCH_OVERRIDE"
    return 0
  fi

  local current_branch
  current_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [[ -n "$current_branch" ]] && git show-ref --verify --quiet "refs/remotes/${remote}/${current_branch}"; then
    printf '%s\n' "$current_branch"
    return 0
  fi

  local remote_head
  remote_head="$(git symbolic-ref --quiet --short "refs/remotes/${remote}/HEAD" 2>/dev/null || true)"
  if [[ -n "$remote_head" ]]; then
    printf '%s\n' "${remote_head#${remote}/}"
    return 0
  fi

  if git show-ref --verify --quiet "refs/remotes/${remote}/main"; then
    printf '%s\n' "main"
    return 0
  fi

  if git show-ref --verify --quiet "refs/remotes/${remote}/master"; then
    printf '%s\n' "master"
    return 0
  fi

  if [[ -n "$current_branch" ]]; then
    printf '%s\n' "$current_branch"
    return 0
  fi

  echo "❌ Could not determine target branch for remote '$remote'."
  exit 1
}

tracked_tree_dirty() {
  [[ -n "$(git status --porcelain --untracked-files=no)" ]]
}

stash_local_changes() {
  if ! tracked_tree_dirty; then
    return 0
  fi

  echo "🧳 Stashing local changes before update..."

  local before after message
  before="$(git stash list -n 1 --format=%gd || true)"
  message="tweets-2-bsky-update-autostash-$(date -u +%Y%m%d-%H%M%S)"
  git stash push -m "$message" >/dev/null
  after="$(git stash list -n 1 --format=%gd || true)"

  if [[ -n "$after" && "$after" != "$before" ]]; then
    STASH_REF="$after"
    STASH_CREATED=1
    echo "✅ Saved local changes to $STASH_REF"
  fi
}

print_untracked_notice() {
  local count
  count="$(git ls-files --others --exclude-standard | wc -l | tr -d '[:space:]')"
  UNTRACKED_COUNT="$count"

  if [[ "$count" -gt 0 ]]; then
    echo "ℹ️  Leaving $count untracked file(s) untouched (not stashed)."
    echo "   This avoids slow/hanging updates on large data directories."
  fi
}

restore_stash_if_needed() {
  if [[ "$STASH_CREATED" -ne 1 || -z "$STASH_REF" ]]; then
    return 0
  fi

  echo "🔁 Restoring stashed local changes ($STASH_REF)..."
  if git stash apply --index "$STASH_REF" >/dev/null 2>&1; then
    git stash drop "$STASH_REF" >/dev/null 2>&1 || true
    STASH_RESTORED=1
    echo "✅ Restored local changes from stash."
  else
    echo "⚠️  Could not auto-apply $STASH_REF cleanly."
    echo "   Your changes are still preserved in stash."
    echo "   Review manually with: git stash show -p $STASH_REF"
  fi
}

checkout_branch() {
  local remote="$1"
  local target_branch="$2"

  if ! git show-ref --verify --quiet "refs/remotes/${remote}/${target_branch}"; then
    echo "❌ Remote branch not found: ${remote}/${target_branch}"
    exit 1
  fi

  local current_branch
  current_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"

  if [[ "$current_branch" == "$target_branch" ]]; then
    return 0
  fi

  if git show-ref --verify --quiet "refs/heads/${target_branch}"; then
    git switch "$target_branch" >/dev/null 2>&1 || git checkout "$target_branch" >/dev/null 2>&1
  else
    git switch -c "$target_branch" --track "${remote}/${target_branch}" >/dev/null 2>&1 || \
      git checkout -b "$target_branch" --track "${remote}/${target_branch}" >/dev/null 2>&1
  fi
}

pull_latest() {
  local remote="$1"
  local branch="$2"

  echo "⬇️  Fetching latest changes from $remote..."
  git fetch "$remote" --prune

  checkout_branch "$remote" "$branch"
  git branch --set-upstream-to="${remote}/${branch}" "$branch" >/dev/null 2>&1 || true

  echo "🔄 Pulling latest changes from ${remote}/${branch}..."
  if ! git pull --ff-only "$remote" "$branch"; then
    echo "ℹ️  Fast-forward pull failed, retrying with rebase..."
    git pull --rebase "$remote" "$branch"
  fi
}

reexec_with_latest_updater_if_changed() {
  if [[ "$UPDATE_SH_REEXECED" == "1" ]]; then
    return 0
  fi

  if [[ -z "$ORIGINAL_SCRIPT_CHECKSUM" ]]; then
    return 0
  fi

  local current_checksum
  current_checksum="$(compute_file_checksum "$SCRIPT_DIR/update.sh" 2>/dev/null || true)"
  if [[ -z "$current_checksum" || "$current_checksum" == "$ORIGINAL_SCRIPT_CHECKSUM" ]]; then
    return 0
  fi

  echo "♻️  update.sh was updated during pull. Restarting updater with newest logic..."

  restore_stash_if_needed
  trap - EXIT
  cleanup

  UPDATE_SH_REEXECED=1 exec bash "$SCRIPT_DIR/update.sh" "${ORIGINAL_ARGS[@]}"
}

native_module_compatible() {
  run_bun -e "try{require('better-sqlite3');process.exit(0)}catch(e){console.error(e && e.message ? e.message : e);process.exit(1)}" >/dev/null 2>&1
}

rebuild_native_modules() {
  if [[ "$DO_NATIVE_REBUILD" -eq 0 ]]; then
    return 0
  fi

  if native_module_compatible; then
    return 0
  fi

  echo "🔧 Native module mismatch detected, rebuilding..."
  if run_bun run rebuild:native; then
    return 0
  fi

  echo "⚠️  rebuild:native failed, forcing fresh Bun install..."
  run_bun install --force
}

install_dependencies() {
  if [[ "$DO_INSTALL" -ne 1 ]]; then
    return 0
  fi

  echo "📦 Installing dependencies..."
  run_bun install

  # The built-in PDS keeps its own npm-installed node_modules (it runs under Node,
  # not bun). Only refresh it when it already exists — a first install happens on
  # demand in setup-pds, so non-PDS users never pay for it.
  if [[ -d "$SCRIPT_DIR/pds-service/node_modules" ]]; then
    echo "📦 Updating built-in PDS dependencies..."
    (cd "$SCRIPT_DIR/pds-service" && npm install --no-audit --no-fund) ||
      echo "⚠️  Could not update built-in PDS dependencies; run 'npm install' in pds-service/ manually."
  fi
}

build_project() {
  if [[ "$DO_BUILD" -ne 1 ]]; then
    return 0
  fi

  echo "🏗️  Building server + web dashboard..."
  run_bun run build
}

pm2_has_process() {
  local name="$1"
  command -v pm2 >/dev/null 2>&1 && pm2 describe "$name" >/dev/null 2>&1
}

start_pm2_process_with_bun() {
  local name="$1"
  pm2 delete "$name" >/dev/null 2>&1 || true
  pm2 start "$BUN_BIN" --name "$name" --cwd "$SCRIPT_DIR" --update-env -- dist/index.js
}

nohup_process_running() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi

  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    return 1
  fi

  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return 1
  fi

  local cmd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$cmd" == *"dist/index.js"* || "$cmd" == *"bun run start"* || "$cmd" == *"bun dist/index.js"* || "$cmd" == *"$APP_NAME"* ]]
}

restart_runtime() {
  if [[ "$DO_RESTART" -ne 1 ]]; then
    echo "⏭️  Skipping restart (--no-restart)."
    return 0
  fi

  echo "🔄 Restarting runtime..."

  if command -v pm2 >/dev/null 2>&1; then
    local has_app=0
    local has_legacy=0

    if pm2_has_process "$APP_NAME"; then
      has_app=1
    fi
    if pm2_has_process "$LEGACY_APP_NAME"; then
      has_legacy=1
    fi

    if [[ "$has_app" -eq 1 && "$has_legacy" -eq 1 ]]; then
      echo "ℹ️  Found both PM2 processes ($APP_NAME and $LEGACY_APP_NAME). Consolidating to $APP_NAME..."
      echo "[pm2] Recreating $APP_NAME with Bun binary launcher"
      start_pm2_process_with_bun "$APP_NAME"
      echo "[pm2] Removing duplicate legacy process $LEGACY_APP_NAME"
      pm2 delete "$LEGACY_APP_NAME" || true
      echo "[pm2] Saving PM2 process list"
      pm2 save || true
      echo "✅ Restarted PM2 process: $APP_NAME"
      return 0
    fi

    if [[ "$has_app" -eq 1 ]]; then
      echo "[pm2] Recreating $APP_NAME with Bun binary launcher"
      start_pm2_process_with_bun "$APP_NAME"
      echo "[pm2] Saving PM2 process list"
      pm2 save || true
      echo "✅ Restarted PM2 process: $APP_NAME"
      return 0
    fi

    if [[ "$has_legacy" -eq 1 ]]; then
      echo "[pm2] Recreating legacy process $LEGACY_APP_NAME with Bun binary launcher"
      start_pm2_process_with_bun "$LEGACY_APP_NAME"
      echo "[pm2] Saving PM2 process list"
      pm2 save || true
      echo "✅ Restarted PM2 process: $LEGACY_APP_NAME"
      return 0
    fi
  fi

  if nohup_process_running; then
    bash "$SCRIPT_DIR/install.sh" --start-only --nohup --skip-native-rebuild >/dev/null
    echo "✅ Restarted nohup runtime."
    return 0
  fi

  if command -v pm2 >/dev/null 2>&1; then
    bash "$SCRIPT_DIR/install.sh" --start-only --pm2 --skip-native-rebuild >/dev/null
    echo "✅ Started PM2 runtime (was not running)."
    return 0
  fi

  bash "$SCRIPT_DIR/install.sh" --start-only --nohup --skip-native-rebuild >/dev/null
  echo "✅ Started nohup runtime (was not running)."
}

print_summary() {
  echo ""
  echo "✅ Update complete!"
  echo ""
  echo "Current commit: $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
  echo "Current branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"

  if [[ "$STASH_CREATED" -eq 1 ]]; then
    if [[ "$STASH_RESTORED" -eq 1 ]]; then
      echo "Stash restore: restored"
    else
      echo "Stash restore: pending manual apply ($STASH_REF)"
    fi
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --remote"
        exit 1
      fi
      REMOTE_OVERRIDE="$2"
      shift
      ;;
    --branch)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --branch"
        exit 1
      fi
      BRANCH_OVERRIDE="$2"
      shift
      ;;
    --skip-install)
      DO_INSTALL=0
      ;;
    --skip-build)
      DO_BUILD=0
      ;;
    --skip-native-rebuild)
      DO_NATIVE_REBUILD=0
      ;;
    --no-restart)
      DO_RESTART=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
  shift
done

echo "🔄 Tweets-2-Bsky Updater"
echo "========================="

require_command git
ensure_bun_runtime
ensure_git_repo

ORIGINAL_SCRIPT_CHECKSUM="$(compute_file_checksum "$SCRIPT_DIR/update.sh" 2>/dev/null || true)"

acquire_lock
trap cleanup EXIT

backup_file "$CONFIG_FILE"
backup_file "$ENV_FILE"

stash_local_changes
print_untracked_notice

remote="$(resolve_remote)"
branch="$(resolve_branch "$remote")"

pull_latest "$remote" "$branch"
reexec_with_latest_updater_if_changed
install_dependencies
rebuild_native_modules
build_project
restart_runtime
restore_stash_if_needed
print_summary
