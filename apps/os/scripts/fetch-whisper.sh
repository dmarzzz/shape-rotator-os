#!/usr/bin/env bash
set -euo pipefail

# Optional voice backend stager. Release builds may ship without whisper assets;
# the router falls back to MLX on supported Apple Silicon hosts or type-only UI.
# This script exists so clean builders do not require a developer-local
# build-resources/whisper folder.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd -- "$script_dir/.." && pwd)"
arch="${WHISPER_ARCH:-${BINARY_ARCH:-$(uname -m)}}"
case "$(printf '%s' "$arch" | tr '[:upper:]' '[:lower:]')" in
  amd64|x86_64) arch="x64" ;;
  aarch64) arch="arm64" ;;
esac

staging_dir="$app_dir/build-resources/_staging/whisper/$arch"
mkdir -p "$staging_dir"

copied=0
copy_if_set() {
  local value="${1:-}"
  if [ -n "$value" ] && [ -f "$value" ]; then
    cp "$value" "$staging_dir/$(basename "$value")"
    chmod 755 "$staging_dir/$(basename "$value")" 2>/dev/null || true
    copied=$((copied + 1))
  fi
}

copy_if_set "${WHISPER_CLI_BIN:-}"
copy_if_set "${WHISPER_MODEL:-}"
copy_if_set "${FFMPEG_BIN:-}"

if [ "$copied" -eq 0 ]; then
  echo "[fetch-whisper] no WHISPER_CLI_BIN/WHISPER_MODEL/FFMPEG_BIN provided for $arch; leaving $staging_dir empty"
else
  echo "[fetch-whisper] staged $copied file(s) in $staging_dir"
fi
