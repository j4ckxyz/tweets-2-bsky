#!/usr/bin/env bash

set -euo pipefail

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

BUN_BIN="$(resolve_bun_bin || true)"

if [[ -z "$BUN_BIN" || ! -x "$BUN_BIN" ]]; then
  echo "📦 Bun not found. Installing latest Bun..."
  install_latest_bun
  BUN_BIN="$(resolve_bun_bin || true)"
fi

if [[ -z "$BUN_BIN" || ! -x "$BUN_BIN" ]]; then
  echo "❌ Bun could not be resolved after install."
  echo "   Install Bun manually: https://bun.com/docs/installation"
  exit 1
fi

if ! "$BUN_BIN" upgrade >/dev/null 2>&1; then
  # The upgrade downloads from GitHub, which can fail transiently (rate limits
  # on shared CI runners). Reinstall when we can; otherwise keep the Bun we
  # have, which the version check below still validates. Docker's slim Bun
  # image has neither curl nor wget, and used to fail the whole build here.
  if command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1; then
    echo "⚠️  Bun auto-upgrade failed. Reinstalling latest Bun..."
    install_latest_bun
    BUN_BIN="$(resolve_bun_bin || true)"
  else
    echo "⚠️  Bun auto-upgrade failed and curl/wget are unavailable; continuing with Bun $("$BUN_BIN" --version 2>/dev/null || echo '?')."
  fi
fi

if [[ -z "$BUN_BIN" || ! -x "$BUN_BIN" ]]; then
  echo "❌ Bun could not be resolved after auto-upgrade."
  echo "   Install Bun manually: https://bun.com/docs/installation"
  exit 1
fi

bun_major="$($BUN_BIN --version | awk -F. '{print $1}' 2>/dev/null || echo 0)"
if [[ "$bun_major" -lt 1 ]]; then
  echo "❌ Bun 1.x+ is required. Current: $($BUN_BIN --version 2>/dev/null || echo 'unknown')"
  exit 1
fi

echo "✅ Bun $($BUN_BIN --version) ready"
