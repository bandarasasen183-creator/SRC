#!/usr/bin/env bash
#
# Regenerate the favicon and app icons from the official logo.
#
#   1. put the artwork at  public/img/logo.png
#   2. bash scripts/build-icons.sh
#   3. deploy
#
# Thin wrapper around two pure-JS steps, so this behaves identically on
# macOS, Linux and CI. Safe to re-run.

set -euo pipefail

green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[0;33m%s\033[0m\n' "$*"; }
err()   { printf '\033[0;31m%s\033[0m\n' "$*"; }

cd "$(dirname "$0")/.."

if [ ! -f public/img/logo.png ]; then
  err "public/img/logo.png not found."
  echo
  echo "  Copy your artwork there first, e.g.:"
  echo "    cp ~/Downloads/your-logo.png public/img/logo.png"
  echo
  echo "  The filename must be exactly 'logo.png', all lowercase."
  exit 1
fi

if [ ! -d node_modules/pngjs ]; then
  warn "Installing image dependency…"
  npm install --silent
fi

# 1. Strip the flat background. A round badge on an opaque white square
#    shows a white box on the page and looks wrong in dark mode.
#    No-ops if the background is already transparent.
node scripts/remove-bg.mjs
echo

# 2. Resize into every icon the app references, and cap the display copy.
node scripts/build-icons.mjs

echo
green "Now deploy:"
echo "  npx --yes firebase-tools deploy --only hosting --project src-uhs"
echo
warn "Then hard-refresh (Cmd+Shift+R). Browsers cache favicons hard — if the"
warn "tab icon looks stale, close the tab and open it again."
