#!/usr/bin/env bash
# fetch-swf-node.sh
#
# CI helper: download the swf-node single-file binary matching the
# current runner's platform/arch, drop it at
# `apps/os/build-resources/swf-node/swf-node`, and `chmod +x` it so
# electron-builder picks it up via `extraResources`.
#
# Naming convention (set upstream in dmarzzz/searxng-wth-frnds by the
# PyInstaller release pipeline):
#
#   swf-node-<version>-mac-arm64
#   swf-node-<version>-mac-x64
#   swf-node-<version>-linux-x64
#   swf-node-<version>-linux-arm64
#   swf-node-<version>-windows-x64.exe   ← v0.13.0+, only asset with extension
#
# Released at:
#   https://github.com/dmarzzz/searxng-wth-frnds/releases/download/v<version>/swf-node-<version>-<platform>-<arch>[.exe]
#
# Version selection:
#   - Honors `SWF_NODE_VERSION` env var (without the leading "v") if set.
#   - Otherwise resolves the latest release tag via the GitHub API.
#
# Falls back to a stub on:
#   - Windows arm64 (upstream pyrage doesn't publish a Windows arm64
#     wheel; only win_amd64 exists). The arm64 win installer ships the
#     stub; arm64-Windows hosts can still run the cohort viewer.
#   - Targets where upstream has no matching asset yet — leaves a stub
#     binary in place so electron-builder still has something to pack
#     and the spawn logic can be exercised end-to-end. Stub prints a
#     warning + sleeps so supervision sees it as "running".
#
# Windows file-name handling:
#   On Windows the upstream asset has a `.exe` extension and so does
#   the destination file (`build-resources/swf-node/swf-node.exe`).
#   The Electron supervisor (apps/os/swf-node.js) picks the same
#   filename via process.platform === "win32" → "swf-node.exe".
#
# Idempotent: re-running with the same version is a no-op if the
# binary already exists. Pass `--force` to redownload.

set -euo pipefail

REPO="dmarzzz/searxng-wth-frnds"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST_DIR="$REPO_ROOT/apps/os/build-resources/swf-node"
# DEST_BIN gets `.exe` appended once we detect a Windows runner below.
DEST_BIN="$DEST_DIR/swf-node"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
  esac
done

# ── platform / arch detection ───────────────────────────────────────
case "$(uname -s)" in
  Darwin)  PLATFORM="mac" ;;
  Linux)   PLATFORM="linux" ;;
  MINGW*|MSYS*|CYGWIN*)
    PLATFORM="windows"
    ;;
  *)
    echo "[fetch-swf-node] unknown uname -s='$(uname -s)' — skipping"
    exit 0
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64"   ;;
  *)
    echo "[fetch-swf-node] unsupported arch '$(uname -m)' — skipping"
    exit 0
    ;;
esac

# Override target via env vars when CI cross-targets a host it isn't running on
# (rare — electron-builder doesn't really cross-build native binaries, but
# documenting the seam in case Track A needs it).
PLATFORM="${SWF_NODE_PLATFORM:-$PLATFORM}"
ARCH="${SWF_NODE_ARCH:-$ARCH}"

# Windows asset is the only one with a file extension upstream
# (swf-node-<v>-windows-x64.exe). Mirror that locally so the supervisor
# in apps/os/swf-node.js finds it under the expected name.
ASSET_EXT=""
if [ "$PLATFORM" = "windows" ]; then
  ASSET_EXT=".exe"
  DEST_BIN="$DEST_BIN.exe"
fi

# Upstream pyrage publishes no Windows arm64 wheel today, so the
# PyInstaller release matrix doesn't ship a windows-arm64 asset. Don't
# install a stub on this combination — the bash-script stub heredoc
# below can't execute as a `.exe` on Windows anyway. Just create the
# (empty) dest dir so electron-builder's extraResources step succeeds,
# and exit 0. The Electron supervisor (apps/os/swf-node.js) sees the
# missing .exe and flips to "unsupported", which is exactly the right
# behavior on arm64-Windows.
if [ "$PLATFORM" = "windows" ] && [ "$ARCH" = "arm64" ]; then
  echo "[fetch-swf-node] windows-arm64 has no upstream asset (no pyrage Windows arm64 wheel) — installer will degrade to viewer-only on this arch"
  mkdir -p "$DEST_DIR"
  exit 0
fi

# ── version resolution ─────────────────────────────────────────────
VERSION="${SWF_NODE_VERSION:-}"
if [ -z "$VERSION" ]; then
  echo "[fetch-swf-node] resolving latest release of $REPO ..."
  # Use the GitHub API — no auth required for public repos, but pass
  # GITHUB_TOKEN through if present to dodge rate-limits in CI.
  # NB: arrays + `set -u` don't play nicely under bash 3.2 (macOS default
  # outside CI). Build the curl call with token expansion via parameter
  # default + `-H` only when token is set.
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    LATEST_JSON="$(curl -fsSL \
      -H "Authorization: Bearer $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null || true)"
  else
    LATEST_JSON="$(curl -fsSL \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null || true)"
  fi
  if [ -z "$LATEST_JSON" ] || echo "$LATEST_JSON" | grep -q '"message":'; then
    echo "[fetch-swf-node] no latest release available yet (Track A hasn't shipped) — installing stub"
    VERSION=""
  else
    # Cheap parse — `tag_name` is always a top-level scalar on a release object.
    VERSION="$(printf '%s' "$LATEST_JSON" \
      | tr ',' '\n' \
      | grep -E '"tag_name"' \
      | head -1 \
      | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v?([^"]+)".*/\1/')"
    if [ -z "$VERSION" ]; then
      echo "[fetch-swf-node] couldn't parse tag_name from API response — installing stub"
    fi
  fi
fi

mkdir -p "$DEST_DIR"

install_stub() {
  echo "[fetch-swf-node] installing stub at $DEST_BIN"
  cat > "$DEST_BIN" <<'STUB'
#!/usr/bin/env bash
# swf-node stub — generated by scripts/fetch-swf-node.sh when no
# upstream release was available at bundle time. Sleeps forever so
# the Electron supervisor sees a "running" process; logs a clear
# warning so debugging is obvious.
echo "[swf-node:stub] WARNING: this is a placeholder binary, not the real swf-node." >&2
echo "[swf-node:stub] Track A (dmarzzz/searxng-wth-frnds) hasn't shipped a release with PyInstaller artifacts yet." >&2
echo "[swf-node:stub] Args: $*" >&2
echo "[swf-node:stub] Env SWF_PORT=${SWF_PORT:-(unset, defaults 7777)} SWF_BIND=${SWF_BIND:-(unset, defaults 127.0.0.1)}" >&2
# Keep the process alive so the supervisor stays in 'running' rather than
# bouncing to 'crashed'. Trap signals so the parent can SIGTERM cleanly.
trap 'exit 0' TERM INT
sleep 99999 &
wait $!
STUB
  chmod +x "$DEST_BIN"
}

if [ -z "$VERSION" ]; then
  install_stub
  exit 0
fi

ASSET="swf-node-${VERSION}-${PLATFORM}-${ARCH}${ASSET_EXT}"
URL="https://github.com/$REPO/releases/download/v${VERSION}/${ASSET}"

if [ "$FORCE" -ne 1 ] && [ -f "$DEST_BIN" ] && [ -f "$DEST_DIR/.version" ] && [ "$(cat "$DEST_DIR/.version" 2>/dev/null)" = "$VERSION-$PLATFORM-$ARCH" ]; then
  echo "[fetch-swf-node] $ASSET already cached at $DEST_BIN — skipping"
  exit 0
fi

echo "[fetch-swf-node] downloading $ASSET"
echo "[fetch-swf-node]   from $URL"

TMP="$(mktemp -t swf-node-fetch.XXXXXX)"
trap 'rm -f "$TMP"' EXIT
HTTP_STATUS="$(curl -fSL -w '%{http_code}' -o "$TMP" "$URL" 2>/dev/null || echo "000")"

if [ ! -s "$TMP" ] || [ "${HTTP_STATUS:-000}" = "000" ] || [ "$(printf '%s' "$HTTP_STATUS" | tail -c 3)" = "404" ]; then
  echo "[fetch-swf-node] download failed (HTTP $HTTP_STATUS) — no asset for $PLATFORM-$ARCH at v$VERSION yet"
  echo "[fetch-swf-node] falling back to stub so the build pipeline still succeeds"
  install_stub
  exit 0
fi

mv "$TMP" "$DEST_BIN"
trap - EXIT
chmod +x "$DEST_BIN"
printf '%s-%s-%s' "$VERSION" "$PLATFORM" "$ARCH" > "$DEST_DIR/.version"
echo "[fetch-swf-node] installed swf-node v$VERSION ($PLATFORM-$ARCH) at $DEST_BIN"
