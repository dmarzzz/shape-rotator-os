#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

PRODUCT_ALIASES="${PRODUCT_ALIASES:-swf-node,swf,node}" \
  bash "$script_dir/fetch-github-release-binary.sh" \
  "dmarzzz/searxng-wth-frnds" \
  "swf-node" \
  "swf-node" \
  "${SWF_NODE_VERSION:-}"
