#!/usr/bin/env bash
# ---- AMP packaged launcher (macOS) ----
# Run this to start AMP. First run builds the packaged app; later runs launch instantly.
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--rebuild" ]]; then
  rm -rf "$ROOT/apps/desktop/dist"
fi

if [[ "$OSTYPE" == darwin* ]]; then
  APP_PATH="$ROOT/apps/desktop/dist/mac/AMP.app"
  if [ ! -d "$APP_PATH" ]; then
    echo "Building packaged AMP with castLabs VMP signing. This can take a few minutes..."
    cd "$ROOT"
    corepack pnpm install
    corepack pnpm dist
  fi
  echo "Starting AMP..."
  open "$APP_PATH"
else
  echo "Packaged AMP launching is only wired for Windows and macOS."
  echo "For Linux development, run: corepack pnpm dev"
  exit 1
fi
