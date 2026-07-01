#!/usr/bin/env bash
set -euo pipefail

# Fetch one release asset into build-resources/_staging/<bundle>/<arch>/.
# Missing assets are non-fatal: the Electron app has unsupported/fallback UI for
# absent sidecars, and clean release builders must not depend on a developer's
# local build-resources directory.

if [ "$#" -lt 3 ]; then
  echo "usage: $0 <owner/repo> <bundle-name> <binary-base-name> [version]" >&2
  exit 2
fi

repo="$1"
bundle="$2"
bin_base="$3"
version="${4:-}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd -- "$script_dir/.." && pwd)"
build_resources="$app_dir/build-resources"

arch="${SWF_NODE_ARCH:-${RESEARCH_SWARM_ARCH:-${BINARY_ARCH:-}}}"
if [ -z "$arch" ]; then
  arch="$(uname -m)"
fi
case "$(printf '%s' "$arch" | tr '[:upper:]' '[:lower:]')" in
  amd64|x86_64) arch="x64" ;;
  aarch64) arch="arm64" ;;
esac

raw_os="${RUNNER_OS:-$(uname -s)}"
case "$(printf '%s' "$raw_os" | tr '[:upper:]' '[:lower:]')" in
  macos|darwin*) platform="mac" ;;
  windows*|mingw*|msys*|cygwin*) platform="windows" ;;
  linux*) platform="linux" ;;
  *) platform="$(printf '%s' "$raw_os" | tr '[:upper:]' '[:lower:]')" ;;
esac

staging_dir="$build_resources/_staging/$bundle/$arch"
mkdir -p "$staging_dir"

product_aliases="${PRODUCT_ALIASES:-$bundle,$bin_base}"
case "$platform" in
  mac) platform_aliases="mac,macos,darwin,osx,apple" ;;
  windows) platform_aliases="windows,win" ;;
  linux) platform_aliases="linux" ;;
  *) platform_aliases="$platform" ;;
esac
case "$arch" in
  x64) arch_aliases="x64,amd64,x86_64" ;;
  arm64) arch_aliases="arm64,aarch64" ;;
  *) arch_aliases="$arch" ;;
esac

tmp_dir="$(mktemp -d)"
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT

api="https://api.github.com/repos/$repo/releases/latest"
if [ -n "$version" ]; then
  tag="$version"
  case "$tag" in v*) ;; *) tag="v$tag" ;; esac
  api="https://api.github.com/repos/$repo/releases/tags/$tag"
fi

auth_args=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  auth_args=(-H "Authorization: Bearer $GITHUB_TOKEN")
fi

release_json="$tmp_dir/release.json"
if ! curl -fsSL "${auth_args[@]}" -H "Accept: application/vnd.github+json" "$api" -o "$release_json"; then
  echo "[fetch-$bundle] no release metadata from $api; leaving $staging_dir empty" >&2
  exit 0
fi

asset_json="$tmp_dir/asset.json"
node - "$release_json" "$asset_json" "$product_aliases" "$platform_aliases" "$arch_aliases" <<'NODE'
const fs = require("node:fs");
const [releasePath, outPath, productCsv, platformCsv, archCsv] = process.argv.slice(2);
const release = JSON.parse(fs.readFileSync(releasePath, "utf8"));
const assets = Array.isArray(release.assets) ? release.assets : [];
const split = (csv) => String(csv || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const products = split(productCsv);
const platforms = split(platformCsv);
const arches = split(archCsv);
function hasAny(name, tokens) {
  return tokens.some((token) => name.includes(token));
}
function score(asset) {
  const name = String(asset.name || "").toLowerCase();
  if (!asset.browser_download_url) return -1;
  if (!hasAny(name, products)) return -1;
  if (!hasAny(name, platforms)) return -1;
  if (!hasAny(name, arches)) return -1;
  let s = 10;
  if (name.endsWith(".zip") || name.endsWith(".tar.gz") || name.endsWith(".tgz")) s += 2;
  if (!name.includes("debug")) s += 1;
  return s;
}
const best = assets
  .map((asset) => ({ asset, score: score(asset) }))
  .filter((x) => x.score >= 0)
  .sort((a, b) => b.score - a.score)[0];
fs.writeFileSync(outPath, JSON.stringify(best ? best.asset : null));
NODE

asset_name="$(node -p "const a=require(process.argv[1]); a && a.name || ''" "$asset_json")"
asset_url="$(node -p "const a=require(process.argv[1]); a && a.browser_download_url || ''" "$asset_json")"
if [ -z "$asset_url" ]; then
  echo "[fetch-$bundle] no release asset matched products={$product_aliases} platform=$platform arch=$arch; leaving $staging_dir empty"
  exit 0
fi

downloaded="$tmp_dir/$(printf '%s' "$asset_name" | tr -cd 'A-Za-z0-9._-')"
echo "[fetch-$bundle] downloading $asset_name"
if ! curl -fL "${auth_args[@]}" "$asset_url" -o "$downloaded"; then
  echo "[fetch-$bundle] download failed; leaving $staging_dir empty" >&2
  exit 0
fi

extract_dir="$tmp_dir/extract"
mkdir -p "$extract_dir"
lower_name="$(printf '%s' "$asset_name" | tr '[:upper:]' '[:lower:]')"
case "$lower_name" in
  *.zip)
    if ! command -v unzip >/dev/null 2>&1; then
      echo "[fetch-$bundle] unzip is not available on this runner; leaving $staging_dir empty" >&2
      exit 0
    fi
    if ! unzip -q "$downloaded" -d "$extract_dir"; then
      echo "[fetch-$bundle] unzip failed; leaving $staging_dir empty" >&2
      exit 0
    fi
    ;;
  *.tar.gz|*.tgz)
    if ! tar -xzf "$downloaded" -C "$extract_dir"; then
      echo "[fetch-$bundle] tar extraction failed; leaving $staging_dir empty" >&2
      exit 0
    fi
    ;;
  *)
    cp "$downloaded" "$extract_dir/$bin_base"
    ;;
esac

if [ "$platform" = "windows" ]; then
  bin_name="$bin_base.exe"
  found="$(find "$extract_dir" -type f \( -iname "$bin_base.exe" -o -iname "$bin_base" \) | head -n 1 || true)"
else
  bin_name="$bin_base"
  found="$(find "$extract_dir" -type f \( -name "$bin_base" -o -iname "$bin_base.exe" \) | head -n 1 || true)"
fi

if [ -z "$found" ]; then
  echo "[fetch-$bundle] downloaded asset did not contain $bin_base; leaving $staging_dir empty" >&2
  exit 0
fi

rm -f "$staging_dir"/*
cp "$found" "$staging_dir/$bin_name"
chmod 755 "$staging_dir/$bin_name" 2>/dev/null || true
echo "[fetch-$bundle] staged $staging_dir/$bin_name"
