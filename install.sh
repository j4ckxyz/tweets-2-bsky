#!/usr/bin/env bash

set -euo pipefail

APP_NAME="tweets-2-bsky"
LEGACY_APP_NAME="twitter-mirror"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE="$SCRIPT_DIR/.env"
RUNTIME_DIR="$SCRIPT_DIR/data/runtime"
PID_FILE="$RUNTIME_DIR/${APP_NAME}.pid"
LOG_FILE="$RUNTIME_DIR/${APP_NAME}.log"
LOCK_DIR="$RUNTIME_DIR/.install.lock"

ACTION="install"
DO_INSTALL=1
DO_BUILD=1
DO_START=1
DO_NATIVE_REBUILD=1
RUNNER="auto"
PORT_OVERRIDE=""
HOST_OVERRIDE=""
APP_PORT=""
APP_HOST=""
ACTIVE_RUNNER=""
CREATED_JWT_SECRET=0
BUN_BIN=""

usage() {
  cat <<'USAGE'
Usage: ./install.sh [options]

Default behavior:
  - Installs dependencies
  - Rebuilds native modules if needed
  - Builds server + web app
  - Starts in the background (PM2 if installed, otherwise nohup)
  - Prints local web URL

Options:
  --no-start               Install/build only (do not start background process)
  --start-only             Start background process only (skip install/build)
  --stop                   Stop background process (PM2 and/or nohup)
  --status                 Show background process status
  --pm2                    Force PM2 runner
  --nohup                  Force nohup runner
  --port <number>          Set or override PORT in .env
  --host <bind-host>       Set or override HOST in .env (for example 127.0.0.1)
  --skip-install           Skip bun install
  --skip-build             Skip bun run build
  --skip-native-rebuild    Skip native-module compatibility rebuild checks
  -h, --help               Show this help
USAGE
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name"
    exit 1
  fi
}

is_valid_port() {
  local candidate="$1"
  [[ "$candidate" =~ ^[0-9]+$ ]] || return 1
  (( candidate >= 1 && candidate <= 65535 ))
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

acquire_lock() {
  mkdir -p "$RUNTIME_DIR"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "Another install/update operation appears to be running."
    echo "If this is stale, remove: $LOCK_DIR"
    exit 1
  fi
}

release_lock() {
  rmdir "$LOCK_DIR" >/dev/null 2>&1 || true
}

cleanup() {
  release_lock
}

get_env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
  if [[ -z "$line" ]]; then
    return 0
  fi
  printf '%s\n' "${line#*=}"
}

upsert_env_value() {
  local key="$1"
  local value="$2"
  touch "$ENV_FILE"
  local tmp_file
  tmp_file="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { updated = 0 }
    $0 ~ ("^" key "=") {
      print key "=" value
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) {
        print key "=" value
      }
    }
  ' "$ENV_FILE" > "$tmp_file"
  mv "$tmp_file" "$ENV_FILE"
}

ensure_env_defaults() {
  local existing_port
  existing_port="$(get_env_value PORT)"
  if [[ -n "$PORT_OVERRIDE" ]]; then
    APP_PORT="$PORT_OVERRIDE"
  elif [[ -n "$existing_port" ]]; then
    APP_PORT="$existing_port"
  else
    APP_PORT="3000"
  fi

  if ! is_valid_port "$APP_PORT"; then
    echo "Invalid port: $APP_PORT"
    exit 1
  fi

  if [[ -z "$existing_port" || -n "$PORT_OVERRIDE" ]]; then
    upsert_env_value PORT "$APP_PORT"
  fi

  local existing_host
  existing_host="$(get_env_value HOST)"
  if [[ -n "$HOST_OVERRIDE" ]]; then
    APP_HOST="$HOST_OVERRIDE"
    upsert_env_value HOST "$APP_HOST"
  elif [[ -n "$existing_host" ]]; then
    APP_HOST="$existing_host"
  else
    APP_HOST="0.0.0.0"
  fi

  local existing_secret
  existing_secret="$(get_env_value JWT_SECRET)"
  if [[ -z "$existing_secret" ]]; then
    local generated_secret
    generated_secret="$(run_bun -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
    upsert_env_value JWT_SECRET "$generated_secret"
    CREATED_JWT_SECRET=1
  fi
}

ensure_node_modules_present() {
  if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
    echo "Dependencies not found. Run ./install.sh (without --start-only) first."
    exit 1
  fi
}

# Checks the database driver the app actually uses. Under Bun that is the
# built-in bun:sqlite, not better-sqlite3 — which is an optional fallback for
# plain Node and, at v13, aborts the process if Bun loads it. Probing the wrong
# module made every run look like a native-module mismatch and forced a
# pointless reinstall.
native_module_compatible() {
  run_bun -e "try{require('bun:sqlite');process.exit(0)}catch(e){console.error(e && e.message ? e.message : e);process.exit(1)}" >/dev/null 2>&1
}

run_native_rebuild() {
  echo "Verifying native modules for Bun $($BUN_BIN --version)..."

  if run_bun run rebuild:native; then
    return 0
  fi

  echo "rebuild:native failed. Forcing fresh Bun install..."
  run_bun install --force
}

ensure_native_compatibility() {
  if [[ "$DO_NATIVE_REBUILD" -eq 0 ]]; then
    return 0
  fi

  if native_module_compatible; then
    return 0
  fi

  echo "Detected native module mismatch (likely from runtime/dependency change)."
  run_native_rebuild

  if ! native_module_compatible; then
    echo "Native module validation still failed after rebuild."
    echo "Try reinstalling dependencies: rm -rf node_modules bun.lock && bun install"
    exit 1
  fi
}

ensure_build_artifacts() {
  if [[ ! -f "$SCRIPT_DIR/dist/index.js" ]]; then
    echo "Build output not found (dist/index.js). Running build now."
    run_bun run build
  fi
}

install_and_build() {
  if [[ "$DO_INSTALL" -eq 1 ]]; then
    echo "Installing dependencies"
    run_bun install
  fi

  ensure_node_modules_present
  ensure_native_compatibility

  if [[ "$DO_BUILD" -eq 1 ]]; then
    echo "Building server and web app"
    run_bun run build
  fi
}

pid_looks_like_app() {
  local pid="$1"
  local cmd
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$cmd" == *"dist/index.js"* || "$cmd" == *"bun run start"* || "$cmd" == *"bun dist/index.js"* || "$cmd" == *"$APP_NAME"* ]]
}

stop_pid_gracefully() {
  local pid="$1"

  if ! kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi

  kill "$pid" >/dev/null 2>&1 || true

  local attempt
  for attempt in $(seq 1 20); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done

  kill -9 "$pid" >/dev/null 2>&1 || true
}

stop_nohup_if_running() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi

  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    rm -f "$PID_FILE"
    return 1
  fi

  if ! kill -0 "$pid" >/dev/null 2>&1; then
    rm -f "$PID_FILE"
    return 1
  fi

  if ! pid_looks_like_app "$pid"; then
    echo "PID file points to a non-app process. Removing stale PID file: $PID_FILE"
    rm -f "$PID_FILE"
    return 1
  fi

  stop_pid_gracefully "$pid"
  rm -f "$PID_FILE"
  return 0
}

stop_pm2_if_running() {
  if ! command -v pm2 >/dev/null 2>&1; then
    return 1
  fi

  local stopped=0

  echo "[pm2] Inspecting existing PM2 processes..."

  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    echo "[pm2] Deleting existing process: $APP_NAME"
    pm2 delete "$APP_NAME" || true
    stopped=1
  fi

  if pm2 describe "$LEGACY_APP_NAME" >/dev/null 2>&1; then
    echo "[pm2] Deleting legacy process: $LEGACY_APP_NAME"
    pm2 delete "$LEGACY_APP_NAME" || true
    stopped=1
  fi

  if [[ "$stopped" -eq 1 ]]; then
    echo "[pm2] Saving PM2 process list"
    pm2 save || true
    return 0
  fi

  return 1
}

start_with_nohup() {
  mkdir -p "$RUNTIME_DIR"
  stop_nohup_if_running >/dev/null 2>&1 || true

  echo "Starting with nohup"
  nohup "$BUN_BIN" run start >> "$LOG_FILE" 2>&1 &
  echo "$!" > "$PID_FILE"

  local pid
  pid="$(cat "$PID_FILE")"
  sleep 1
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    echo "Failed to start background process with nohup."
    echo "Check logs: $LOG_FILE"
    tail -n 40 "$LOG_FILE" 2>/dev/null || true
    exit 1
  fi
}

start_with_pm2() {
  echo "Starting with PM2"

  if pm2 describe "$LEGACY_APP_NAME" >/dev/null 2>&1; then
    echo "[pm2] Removing legacy process before start: $LEGACY_APP_NAME"
    pm2 delete "$LEGACY_APP_NAME" || true
  fi

  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    echo "[pm2] Recreating existing process with Bun binary launcher: $APP_NAME"
    pm2 delete "$APP_NAME" || true
  else
    echo "[pm2] Starting new process: $APP_NAME (cwd=$SCRIPT_DIR, script=dist/index.js)"
  fi

  pm2 start "$BUN_BIN" --name "$APP_NAME" --cwd "$SCRIPT_DIR" --update-env -- dist/index.js

  echo "[pm2] Saving PM2 process list"
  pm2 save || true
}

start_background() {
  local resolved_runner="$RUNNER"
  if [[ "$resolved_runner" == "auto" ]]; then
    if command -v pm2 >/dev/null 2>&1; then
      resolved_runner="pm2"
    else
      resolved_runner="nohup"
    fi
  fi

  case "$resolved_runner" in
    pm2)
      require_command pm2
      start_with_pm2
      ACTIVE_RUNNER="pm2"
      ;;
    nohup)
      start_with_nohup
      ACTIVE_RUNNER="nohup"
      ;;
    *)
      echo "Unsupported runner: $resolved_runner"
      exit 1
      ;;
  esac
}

wait_for_web() {
  local url="http://127.0.0.1:${APP_PORT}"
  local attempt

  for attempt in $(seq 1 30); do
    if command -v curl >/dev/null 2>&1; then
      if curl -fsS "$url" >/dev/null 2>&1; then
        return 0
      fi
    else
      if run_bun -e "const http=require('http');const req=http.get('$url',res=>{process.exit(res.statusCode && res.statusCode < 500 ? 0 : 1)});req.setTimeout(1500,()=>{req.destroy();process.exit(1)});req.on('error',()=>process.exit(1));" >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 1
  done

  return 1
}

print_access_info() {
  echo ""
  echo "Setup complete."
  echo "Bind host: ${APP_HOST}"
  echo "Web app URL (local): http://localhost:${APP_PORT}"

  if [[ "$CREATED_JWT_SECRET" -eq 1 ]]; then
    echo "Generated JWT_SECRET in .env"
  fi

  if [[ "$APP_HOST" == "127.0.0.1" || "$APP_HOST" == "::1" || "$APP_HOST" == "localhost" ]]; then
    echo "Access scope: local-only bind (use reverse proxy or Tailscale for remote access)"
  else
    echo "Access scope: network-accessible bind"
  fi

  if [[ "$ACTIVE_RUNNER" == "pm2" ]]; then
    echo "Process manager: PM2"
    echo "Status: pm2 status $APP_NAME"
    echo "Logs: pm2 logs $APP_NAME"
    echo "Stop: ./install.sh --stop"
  elif [[ "$ACTIVE_RUNNER" == "nohup" ]]; then
    echo "Process manager: nohup"
    echo "PID file: $PID_FILE"
    echo "Logs: tail -f $LOG_FILE"
    echo "Stop: ./install.sh --stop"
  fi

  if wait_for_web; then
    echo "Health check: OK"
  else
    echo "Health check: not ready yet (service may still be starting)"
  fi
}

show_status() {
  local found=0
  local configured_port
  local configured_host
  configured_port="$(get_env_value PORT)"
  configured_host="$(get_env_value HOST)"

  if [[ -n "$configured_port" ]]; then
    echo "Configured PORT: $configured_port"
  fi
  if [[ -n "$configured_host" ]]; then
    echo "Configured HOST: $configured_host"
  fi

  if command -v pm2 >/dev/null 2>&1; then
    if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
      found=1
      echo "PM2 process is running: $APP_NAME"
      pm2 status "$APP_NAME"
    elif pm2 describe "$LEGACY_APP_NAME" >/dev/null 2>&1; then
      found=1
      echo "PM2 process is running: $LEGACY_APP_NAME"
      pm2 status "$LEGACY_APP_NAME"
    fi
  fi

  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      found=1
      echo "nohup process is running with PID $pid"
      echo "Logs: $LOG_FILE"
    else
      echo "Found stale PID file at $PID_FILE"
    fi
  fi

  if [[ "$found" -eq 0 ]]; then
    echo "No running background process found for $APP_NAME"
  fi
}

stop_all() {
  local stopped=0

  if stop_pm2_if_running; then
    stopped=1
    echo "Stopped PM2 process(es)."
  fi

  if stop_nohup_if_running; then
    stopped=1
    echo "Stopped nohup process from PID file"
  fi

  if [[ "$stopped" -eq 0 ]]; then
    echo "No running process found for $APP_NAME"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-start)
      DO_START=0
      ;;
    --start-only)
      ACTION="start"
      DO_INSTALL=0
      DO_BUILD=0
      DO_START=1
      ;;
    --stop)
      ACTION="stop"
      ;;
    --status)
      ACTION="status"
      ;;
    --pm2)
      RUNNER="pm2"
      ;;
    --nohup)
      RUNNER="nohup"
      ;;
    --port)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --port"
        exit 1
      fi
      PORT_OVERRIDE="$2"
      shift
      ;;
    --host)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --host"
        exit 1
      fi
      HOST_OVERRIDE="$2"
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

case "$ACTION" in
  stop)
    acquire_lock
    trap cleanup EXIT
    stop_all
    exit 0
    ;;
  status)
    show_status
    exit 0
    ;;
esac

ensure_bun_runtime

acquire_lock
trap cleanup EXIT

ensure_env_defaults

if [[ "$ACTION" == "install" ]]; then
  install_and_build
else
  ensure_node_modules_present
  ensure_native_compatibility
fi

if [[ "$DO_START" -eq 0 ]]; then
  echo "Install/build complete. Start later with: ./install.sh --start-only"
  echo "Configured web URL: http://localhost:${APP_PORT}"
  exit 0
fi

ensure_build_artifacts
start_background
print_access_info
