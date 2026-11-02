#!/usr/bin/env bash
# scripts/drill.sh <name|all> [--keep] [--record] [--seed N]   (Planning Docs/52 §4.4)
# A thin wrapper: the runner is Node because the assertions are made of JSON.
set -euo pipefail
exec node "$(dirname "$0")/drill.mjs" "$@"
