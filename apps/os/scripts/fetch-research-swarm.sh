#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

PRODUCT_ALIASES="${PRODUCT_ALIASES:-research-agent,research-swarm,agent,swarm}" \
  bash "$script_dir/fetch-github-release-binary.sh" \
  "dmarzzz/research-swarm" \
  "research-swarm" \
  "research-agent" \
  "${RESEARCH_SWARM_VERSION:-}"
