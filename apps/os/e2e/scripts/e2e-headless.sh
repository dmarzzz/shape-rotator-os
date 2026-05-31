#!/usr/bin/env bash
# e2e-headless.sh — run the WebdriverIO suite under a virtual framebuffer when
# one is available.
#
#   • Linux / CI: wraps the run in `xvfb-run` so the Tauri (WebKitGTK) window
#     renders offscreen with no real display attached.
#   • macOS: there is no Xvfb — Apple's window server has no detachable
#     framebuffer. The app window is created hidden (tauri.conf visible:false)
#     and shown for the session; CI runners must have a logged-in GUI session
#     (or a tool like `Xvfb`-equivalent is not applicable). We just run directly.
#
# Usage:  bash scripts/e2e-headless.sh            # run prebuilt binary
#         BUILD=1 bash scripts/e2e-headless.sh    # build the binary first
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${BUILD:-0}" == "1" ]]; then
  npm run build:app
fi

RUN=(npm run test:nobuild)

if command -v xvfb-run >/dev/null 2>&1; then
  echo "[e2e] xvfb-run found — running headless under a virtual framebuffer." >&2
  exec xvfb-run -a --server-args="-screen 0 1600x1000x24" "${RUN[@]}"
else
  case "$(uname -s)" in
    Darwin)
      echo "[e2e] macOS: Xvfb is not applicable; running against the window server." >&2
      ;;
    *)
      echo "[e2e] xvfb-run not installed. Install it for headless runs:" >&2
      echo "        sudo apt-get install -y xvfb            # Debian/Ubuntu" >&2
      echo "      Running directly (a display must be attached)." >&2
      ;;
  esac
  exec "${RUN[@]}"
fi
