#!/usr/bin/env bash
#
# Regenerate the favicon and app icons from the official logo.
#
#   1. put the artwork at  public/img/logo.png
#   2. bash scripts/build-icons.sh
#   3. deploy
#
# Uses `sips`, which ships with macOS — nothing to install.

set -euo pipefail

green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[0;33m%s\033[0m\n' "$*"; }
err()   { printf '\033[0;31m%s\033[0m\n' "$*"; }

cd "$(dirname "$0")/.."
SRC=public/img/logo.png

if [ ! -f "$SRC" ]; then
  err "public/img/logo.png not found."
  echo
  echo "  Copy your logo there first, e.g.:"
  echo "    cp ~/Downloads/your-logo.png ~/SRC/public/img/logo.png"
  echo
  echo "  The filename must be exactly 'logo.png', all lowercase."
  exit 1
fi

if ! command -v sips >/dev/null 2>&1; then
  err "This script needs 'sips', which is macOS-only."
  echo "  On another OS, resize public/img/logo.png by hand into:"
  echo "    public/img/favicon.png        64x64"
  echo "    public/img/icon-192.png       192x192"
  echo "    public/img/icon-512.png       512x512"
  echo "    public/img/apple-touch-icon.png 180x180, no transparency"
  exit 1
fi

DIMS=$(sips -g pixelWidth -g pixelHeight "$SRC" | awk '/pixel/ {printf "%s ", $2}')
green "Source: $SRC (${DIMS}px)"

# A flat white box behind a round badge looks wrong on the page and terrible
# in dark mode, so strip it. Safe to re-run: it detects an already
# transparent background and does nothing. Keeps logo-original.png.
if command -v node >/dev/null 2>&1; then
  echo
  node scripts/remove-bg.mjs "$SRC" || warn "Background removal skipped."
  echo
else
  warn "node not found — skipping background removal."
fi

gen() { # size, outfile
  sips -s format png -Z "$1" "$SRC" --out "$2" >/dev/null 2>&1
  green "  wrote $2 (${1}px)"
}

echo "Generating…"
gen 512 public/img/icon-512.png
gen 192 public/img/icon-192.png
gen 64  public/img/favicon.png

# iOS home-screen icons cannot be transparent — iOS fills any alpha with
# BLACK, which looks broken behind a round badge. Pad onto white instead.
sips -s format png -Z 164 "$SRC" --out public/img/apple-touch-icon.png >/dev/null 2>&1
sips -p 180 180 --padColor FFFFFF public/img/apple-touch-icon.png \
  --out public/img/apple-touch-icon.png >/dev/null 2>&1
green "  wrote public/img/apple-touch-icon.png (180px, white background)"

echo
green "Done. Now deploy:"
echo "  npx --yes firebase-tools deploy --only hosting --project src-uhs"
echo
warn "Then hard-refresh the site (Cmd+Shift+R). Browsers cache favicons hard —"
warn "if the tab icon looks stale, close the tab and open it again."
