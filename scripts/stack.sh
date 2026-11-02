#!/usr/bin/env bash
# The local ARL lab under podman (Planning Docs/52 §4.1).
#
#   scripts/stack.sh up [svc...]     recreate the whole stack with the current ARL_* settings
#   scripts/stack.sh infra           recreate only the broker and the API (no simulator yet)
#   scripts/stack.sh start <svc...>  add simulators to a running infra, same ARL_* settings
#   scripts/stack.sh down            stop and remove the containers; the Postgres volume is kept
#   scripts/stack.sh reset           down, then delete the volume (fresh researcher seed, no backlog)
#   scripts/stack.sh ps | status     what is running, the API's health, each service's clock
#   scripts/stack.sh logs <svc>      one container's log
#
# Simulator settings are read from the environment and passed through by compose:
# ARL_SEED, ARL_SPEEDUP, ARL_START_TIME, ARL_SCENARIO (a path inside the container, /scenarios/...).
# The platform is not part of this stack; scripts/drill.sh starts one on DRILL_PORT.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIM="$ROOT/Services/arl-sim"
PROJECT="${ARL_STACK_PROJECT:-arl-harness}"
COMPOSE=(podman-compose -p "$PROJECT" -f "$SIM/arl-test.yaml")
LOGDIR="$ROOT/.logs/harness"
DEFAULT_SERVICES=(rta mhe opg)
API_URL="http://localhost:8080"

mkdir -p "$LOGDIR"

say() { printf '[stack] %s\n' "$*"; }
die() { printf '[stack] error: %s\n' "$*" >&2; exit 1; }

compose() {
  # podman-compose 1.0.6 echoes every podman call; keep that out of the terminal but on disk.
  (cd "$SIM" && "${COMPOSE[@]}" "$@") >>"$LOGDIR/compose.log" 2>&1
}

container() { echo "${PROJECT}_$1_1"; }

# `podman-compose down` stops one container at a time with a 10 s grace each, and the simulators
# do not exit on SIGTERM quickly: ~40 s for six. Removing them per tier takes a few seconds; the
# order matters because compose created them with `--requires`, and podman refuses to remove a
# container that another still requires.
remove_all() {
  local tier ids svc
  for tier in "rta mhe opg lwm owt" "api" "postgres mosquitto"; do
    ids=""
    for svc in $tier; do
      ids+=" $(podman ps -aq --filter "label=io.podman.compose.project=$PROJECT" \
        --filter "label=com.docker.compose.service=$svc")"
    done
    [[ -z "${ids// /}" ]] || podman rm -f -t 2 $ids >/dev/null 2>&1
  done
}

preflight() {
  command -v podman >/dev/null || die "podman is not on PATH (this harness does not use docker)"
  command -v podman-compose >/dev/null || die "podman-compose is not on PATH (pip install podman-compose)"
  [[ -f "$SIM/arl-test.yaml" ]] || die "missing $SIM/arl-test.yaml (extract Services/arl-sim.tar.gz)"
  local port holder
  for port in 1883 8080; do
    holder="$(podman ps --format '{{.Names}} {{.Ports}}' | grep -E ":${port}->" | awk '{print $1}' | grep -v "^${PROJECT}_" || true)"
    if [[ -n "$holder" ]]; then
      die "port $port is held by container '$holder' (not ours). Stop it first: podman stop $holder"
    fi
    if ss -ltn "( sport = :$port )" 2>/dev/null | grep -q LISTEN \
      && ! podman ps --format '{{.Names}}' | grep -q "^${PROJECT}_"; then
      die "port $port is held by: $(ss -ltnp "( sport = :$port )" 2>/dev/null | tail -n +2 | awk '{print $NF}')"
    fi
  done
}

load_images() {
  local svc tar
  for svc in api "$@"; do
    if ! podman image exists "arl/$svc:0.1.0"; then
      tar="$SIM/images/arl-$svc.tar"
      [[ -f "$tar" ]] || die "image arl/$svc:0.1.0 is not loaded and $tar does not exist"
      say "loading $tar"
      podman load -q -i "$tar" >/dev/null
    fi
  done
}

wait_api() {
  local deadline=$((SECONDS + ${1:-60})) body
  while ((SECONDS < deadline)); do
    body="$(curl -fsS -m 2 "$API_URL/healthz" 2>/dev/null || true)"
    if [[ "$body" == *'"database":true'* && "$body" == *'"broker":true'* ]]; then
      say "api ready: $body"
      return 0
    fi
    sleep 1
  done
  die "ARL API did not report database+broker within ${1:-60}s (see: scripts/stack.sh logs api)"
}

# Each service logs one "running" line with its start time and effective (clamped) speedup.
clock() {
  local svc="$1" line
  line="$(podman logs "$(container "$svc")" 2>&1 | grep -m1 '"message":"running"' || true)"
  [[ -n "$line" ]] || { echo "$svc: not running yet"; return 1; }
  node -e '
    const f = JSON.parse(process.argv[1]).fields;
    console.log(`${f.service}: start ${f.start}, effective speedup ${f.speedup}x`);
  ' "$line"
}

wait_clocks() {
  local svc deadline
  for svc in "$@"; do
    deadline=$((SECONDS + 30))
    until clock "$svc" >/dev/null 2>&1; do
      ((SECONDS < deadline)) || die "$svc did not start its clock within 30s (scripts/stack.sh logs $svc)"
      sleep 0.5
    done
    say "$(clock "$svc")"
  done
}

cmd="${1:-status}"
shift || true

case "$cmd" in
  up | infra)
    services=("$@")
    ((${#services[@]})) || services=("${DEFAULT_SERVICES[@]}")
    [[ "$cmd" == up ]] || services=()
    preflight
    load_images "${services[@]}"
    if [[ -n "${ARL_SCENARIO:-}" ]]; then
      [[ "$ARL_SCENARIO" == /scenarios/* ]] || die "ARL_SCENARIO must be a container path under /scenarios/"
      [[ -f "$SIM/scenarios/${ARL_SCENARIO#/scenarios/}" ]] || die "no such scenario: $SIM/scenarios/${ARL_SCENARIO#/scenarios/}"
    fi
    say "seed=${ARL_SEED:-1} speedup=${ARL_SPEEDUP:-1} start=${ARL_START_TIME:-now} scenario=${ARL_SCENARIO:-none}"
    # One project-wide config hash: recreate everything together or not at all (52 §4.1.1).
    remove_all
    compose up -d mosquitto api "${services[@]}" || die "compose up failed (see $LOGDIR/compose.log)"
    wait_api 90
    ((${#services[@]} == 0)) || wait_clocks "${services[@]}"
    ;;
  start)
    # The drill runner's second half: its platform is subscribed before the first message is
    # published, so nothing a service says in its first simulated minutes is lost. The ARL_*
    # settings must be the ones `infra` saw, or compose's config hash recreates the broker.
    (($#)) || die "usage: stack.sh start <svc...>"
    load_images "$@"
    curl -fsS -m 2 "$API_URL/healthz" >/dev/null 2>&1 || die "the API is not up (scripts/stack.sh infra first)"
    compose up -d "$@" || die "compose up failed (see $LOGDIR/compose.log)"
    wait_clocks "$@"
    ;;
  down)
    remove_all
    say "down (volume ${PROJECT}_pgdata kept)"
    ;;
  reset)
    remove_all
    podman volume rm -f "${PROJECT}_pgdata" >/dev/null 2>&1 || true
    say "reset: containers and ${PROJECT}_pgdata removed; the next up re-seeds the API"
    ;;
  ps)
    podman ps -a --filter "label=io.podman.compose.project=$PROJECT" --format '{{.Names}}\t{{.Status}}'
    ;;
  status)
    podman ps -a --filter "label=io.podman.compose.project=$PROJECT" --format '{{.Names}}\t{{.Status}}'
    printf 'api /healthz: %s\n' "$(curl -fsS -m 2 "$API_URL/healthz" 2>/dev/null || echo unreachable)"
    for svc in "${DEFAULT_SERVICES[@]}"; do clock "$svc" 2>/dev/null || true; done
    port="${DRILL_PORT:-3100}"
    if body="$(curl -fsS -m 2 "http://localhost:$port/api/services" 2>/dev/null)"; then
      node -e '
        for (const s of JSON.parse(process.argv[1]))
          console.log(`platform :${process.argv[2]} ${s.code}: topology ${s.topology ? "yes" : "no"}, online ${s.online}`);
      ' "$body" "$port"
    fi
    ;;
  logs)
    [[ $# -ge 1 ]] || die "usage: stack.sh logs <svc>"
    podman logs "$(container "$1")"
    ;;
  *)
    die "unknown command '$cmd' (up|infra|start|down|reset|ps|status|logs)"
    ;;
esac
