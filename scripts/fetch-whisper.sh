#!/usr/bin/env bash
# fetch-whisper.sh
#
# CI helper: stage the cross-platform voice backend for ONE target arch into
#   apps/os/build-resources/_staging/whisper/<arch>/
#     ggml-base.en.bin      (model — cross-platform)
#     whisper-cli[.exe]     (whisper.cpp binary — per platform/arch)
#     ffmpeg[.exe]          (transcode webm->wav — per platform/arch)
# The beforePack hook (apps/os/scripts/before-pack-stage-binaries.cjs, BUNDLES
# includes "whisper") flattens the matching arch into build-resources/whisper/,
# and extraResources copies it into Resources/whisper/. daybook-whisper.js +
# daybook-main.js resolve the binaries there.
#
# Convention mirrors scripts/fetch-swf-node.sh: detect platform/arch (override
# via WHISPER_PLATFORM / WHISPER_ARCH so one runner can stage both arches), and
# DEGRADE GRACEFULLY — any artifact we can't obtain is simply omitted, and the
# app falls back to MLX (Apple Silicon) or type-only on that target. The build
# never fails because of a missing voice binary.
#
# Reliability, honestly: the MODEL fetch is solid everywhere. whisper-cli is
# built from source (mac/linux, host arch) or downloaded from the whisper.cpp
# release (Windows); cross-arch + uncommon targets degrade. ffmpeg is pulled
# from static-build sources where known. Per-platform binary sourcing needs CI
# validation on each OS — this script is structured for that, not yet proven on
# win/linux.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGING_BASE="$REPO_ROOT/apps/os/build-resources/_staging/whisper"

MODEL="ggml-base.en.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL}"
WHISPER_REPO="https://github.com/ggml-org/whisper.cpp"

case "$(uname -s)" in
  Darwin) PLATFORM="mac" ;;
  Linux)  PLATFORM="linux" ;;
  MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
  *) echo "[fetch-whisper] unknown OS '$(uname -s)' — skipping"; exit 0 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) HOST_ARCH="arm64" ;;
  x86_64|amd64)  HOST_ARCH="x64" ;;
  *) HOST_ARCH="x64" ;;
esac
PLATFORM="${WHISPER_PLATFORM:-$PLATFORM}"
ARCH="${WHISPER_ARCH:-$HOST_ARCH}"

DEST="$STAGING_BASE/$ARCH"
mkdir -p "$DEST"
EXE=""; [ "$PLATFORM" = "windows" ] && EXE=".exe"

note() { echo "[fetch-whisper] $*"; }

# ── 1. model (reliable everywhere) ──────────────────────────────────
if [ -f "$DEST/$MODEL" ]; then
  note "model present ($ARCH)"
else
  note "fetching model $MODEL ($ARCH)…"
  curl -fL --retry 3 -o "$DEST/$MODEL" "$MODEL_URL" || { note "model fetch FAILED — voice will degrade to type-only"; rm -f "$DEST/$MODEL"; }
fi

# ── 2. whisper-cli (per platform/arch) ──────────────────────────────
stage_whisper_cli() {
  if [ -f "$DEST/whisper-cli$EXE" ]; then note "whisper-cli present ($PLATFORM-$ARCH)"; return; fi
  case "$PLATFORM" in
    mac|linux)
      # Build from source for the target arch. macOS can cross-compile via
      # CMAKE_OSX_ARCHITECTURES; linux cross-arch needs a cross-toolchain and is
      # skipped (degrade) when ARCH != host.
      local osx_arch=""
      if [ "$PLATFORM" = "mac" ]; then
        [ "$ARCH" = "arm64" ] && osx_arch="arm64" || osx_arch="x86_64"
      elif [ "$ARCH" != "$HOST_ARCH" ]; then
        note "linux cross-arch whisper-cli ($ARCH on $HOST_ARCH) not built — degrade"; return
      fi
      command -v cmake >/dev/null 2>&1 || { note "cmake not found — can't build whisper-cli ($PLATFORM-$ARCH), degrade"; return; }
      local src="${RUNNER_TEMP:-/tmp}/whisper.cpp"
      rm -rf "$src"; git clone --depth 1 "$WHISPER_REPO" "$src" >/dev/null 2>&1 || { note "clone whisper.cpp FAILED — degrade"; return; }
      local cmflags="-DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_EXAMPLES=ON"
      [ -n "$osx_arch" ] && cmflags="$cmflags -DCMAKE_OSX_ARCHITECTURES=$osx_arch"
      cmake -S "$src" -B "$src/build" $cmflags >/dev/null 2>&1 \
        && cmake --build "$src/build" -j --config Release --target whisper-cli >/dev/null 2>&1 \
        || { note "build whisper-cli FAILED ($PLATFORM-$ARCH) — degrade"; return; }
      local built
      built="$(find "$src/build" -name 'whisper-cli' -type f 2>/dev/null | head -1)"
      [ -n "$built" ] && cp "$built" "$DEST/whisper-cli" && chmod +x "$DEST/whisper-cli" && note "built whisper-cli ($PLATFORM-$ARCH)" || note "whisper-cli binary not found post-build — degrade"
      ;;
    windows)
      if [ "$ARCH" != "x64" ]; then note "windows-$ARCH whisper-cli: no prebuilt — degrade"; return; fi
      # whisper.cpp ships Windows zips on its releases. Asset names vary by
      # release; try the common cpu x64 bin and guard.
      local zip="${RUNNER_TEMP:-/tmp}/whisper-win.zip"
      local url="https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip"
      curl -fL --retry 3 -o "$zip" "$url" 2>/dev/null \
        && (cd "$DEST" && unzip -o -j "$zip" '*whisper-cli.exe' >/dev/null 2>&1 || unzip -o -j "$zip" '*main.exe' >/dev/null 2>&1) \
        && ( [ -f "$DEST/whisper-cli.exe" ] || { [ -f "$DEST/main.exe" ] && mv "$DEST/main.exe" "$DEST/whisper-cli.exe"; } ) \
        && note "downloaded whisper-cli.exe (win-x64)" || note "win whisper-cli download/extract FAILED — degrade"
      ;;
  esac
}
stage_whisper_cli

# ── 3. ffmpeg (per platform/arch static build) ──────────────────────
stage_ffmpeg() {
  if [ -f "$DEST/ffmpeg$EXE" ]; then note "ffmpeg present ($PLATFORM-$ARCH)"; return; fi
  local tmp="${RUNNER_TEMP:-/tmp}/ffmpeg-dl"
  rm -rf "$tmp"; mkdir -p "$tmp"
  case "$PLATFORM" in
    linux)
      local triplet="amd64"; [ "$ARCH" = "arm64" ] && triplet="arm64"
      curl -fL --retry 3 -o "$tmp/f.tar.xz" "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${triplet}-static.tar.xz" 2>/dev/null \
        && tar -xf "$tmp/f.tar.xz" -C "$tmp" 2>/dev/null \
        && cp "$(find "$tmp" -name ffmpeg -type f | head -1)" "$DEST/ffmpeg" && chmod +x "$DEST/ffmpeg" && note "staged ffmpeg (linux-$ARCH)" || note "linux ffmpeg fetch FAILED — degrade"
      ;;
    mac)
      if [ "$ARCH" = "$HOST_ARCH" ] && command -v ffmpeg >/dev/null 2>&1; then
        cp "$(command -v ffmpeg)" "$DEST/ffmpeg" && chmod +x "$DEST/ffmpeg" && note "staged host ffmpeg (mac-$ARCH; note: may link Homebrew dylibs — vendor a static build for distribution)"
      else
        note "mac-$ARCH ffmpeg: no static source wired (cross-arch) — degrade; provide a static ffmpeg at $DEST/ffmpeg"
      fi
      ;;
    windows)
      [ "$ARCH" != "x64" ] && { note "win-$ARCH ffmpeg: degrade"; return; }
      curl -fL --retry 3 -o "$tmp/f.zip" "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" 2>/dev/null \
        && (cd "$tmp" && unzip -o -j f.zip '*/bin/ffmpeg.exe' >/dev/null 2>&1) \
        && cp "$tmp/ffmpeg.exe" "$DEST/ffmpeg.exe" && note "staged ffmpeg.exe (win-x64)" || note "win ffmpeg fetch FAILED — degrade"
      ;;
  esac
}
stage_ffmpeg

note "staged for $PLATFORM-$ARCH:"; ls -la "$DEST" 2>/dev/null || true
exit 0
