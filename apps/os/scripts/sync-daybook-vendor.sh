#!/usr/bin/env bash
# Re-vendor router-daybook into shape-rotator-os.
#
# TWO targets:
#   1. The digest PIPELINE  -> apps/os/daybook/        (src/*.js, byte-verbatim)
#   2. The RENDERER + shim   -> apps/os/src/router/     (run verbatim in the pop-out window)
#
# The pipeline copy is denylist-based, so a NEW pipeline module upstream adds
# (e.g. draft.js) is picked up automatically; a require-graph load test then
# catches a missing dependency (the failure mode where reflect.js started
# `require('./postspec')`, or draft.js `require('./link')`, before they were
# vendored).
#
# Usage: apps/os/scripts/sync-daybook-vendor.sh [path-to-router-daybook]
#        (defaults to ~/router-daybook)
set -euo pipefail

SRC="${1:-$HOME/router-daybook}"
OS="$(cd "$(dirname "$0")/.." && pwd)"
PIPE="$OS/daybook"
WIN="$OS/src/router"
# Replaced by host integration: main.js -> daybook-main.js; preload.js is
# vendored separately into the window dir (the shim). link.js IS vendored
# (draft.js hard-requires ./link).
DENY=("main.js" "preload.js")

[ -d "$SRC/src" ] || { echo "error: no $SRC/src — pass a router-daybook checkout path"; exit 1; }

echo "1. pipeline: $SRC/src -> $PIPE"
for f in "$SRC"/src/*.js; do
  b="$(basename "$f")"
  skip=0; for d in "${DENY[@]}"; do [ "$b" = "$d" ] && skip=1; done
  if [ "$skip" = 1 ]; then echo "   skip     $b (host integration / shim)"; continue; fi
  cp "$f" "$PIPE/$b"; echo "   vendored $b"
done
# Non-.js pipeline asset: the MLX-Whisper voice sidecar.
cp "$SRC/src/whisper_server.py" "$PIPE/whisper_server.py"; echo "   vendored whisper_server.py"

echo "2. renderer + shim preload: $SRC/renderer + src/preload.js -> $WIN"
mkdir -p "$WIN"
for f in app.js index.html styles.css; do
  cp "$SRC/renderer/$f" "$WIN/$f"; echo "   vendored renderer/$f"
done
cp "$SRC/src/preload.js" "$WIN/preload.js"; echo "   vendored src/preload.js -> preload.js (shim; window.daybook bridge)"

echo "3. require-graph load test (pipeline)…"
node -e '
const fs = require("fs"), p = require("path");
const dir = process.argv[1];
let bad = 0;
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith(".js")) continue;
  try { require(p.join(dir, f)); }
  catch (e) { console.error("   LOAD FAIL " + f + " -> " + e.message); bad = 1; }
}
if (!bad) console.log("   ok — all vendored pipeline modules resolve");
process.exit(bad);
' "$PIPE"

echo "4. channel-coverage guard (shim invokes vs daybook-main.js handlers)…"
node "$OS/scripts/check-router-channels.cjs"

SHA="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo
echo "source commit: $SHA  (update the pin in apps/os/daybook/VENDOR.md)"
echo "review:  git diff -- apps/os/daybook apps/os/src/router"
echo "then:    (cd apps/os && npm run bundle:check && npm run smoke)"
