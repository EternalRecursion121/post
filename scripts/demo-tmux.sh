#!/usr/bin/env bash
# PearPost demo tmux harness — real processes, all the way through.
#
# Lays out a left-half-of-screen tmux session designed to sit next to a
# browser tab on http://127.0.0.1:7777.  Every visible pane runs a real
# `pearpost` Agent process (own keypair, own home, real DHT). The
# orchestrator pane drives the scenario step-by-step against those real
# processes — every envelope on the wire is genuine.
#
# Roles that don't fit in a visible pane still run as real background
# processes (logged to /tmp/pearpost-demo/<scenario>/<role>.log). The graph
# in the browser visualizes the actual envelope traffic.
#
# Usage:
#   scripts/demo-tmux.sh                            # default: pears, real, attach
#   scripts/demo-tmux.sh skyscanner                 # any of: pears spoons skyscanner jetbrains
#   scripts/demo-tmux.sh skyscanner --manual        # press <enter> between steps
#   scripts/demo-tmux.sh --scripted skyscanner      # narration-only fallback
#   scripts/demo-tmux.sh --kill                     # tear down the session + bg agents
#   scripts/demo-tmux.sh --no-attach skyscanner     # start, don't attach
#
# Env:
#   PEARPOST_PORT   default 7777
#   SESSION         tmux session name, default 'pearpost-demo'

set -u

SESSION="${SESSION:-pearpost-demo}"
PORT="${PEARPOST_PORT:-7777}"
BASE="http://127.0.0.1:${PORT}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="$ROOT/scripts/demo-runner.mjs"
AGENT="$ROOT/scripts/demo-agent.mjs"
ORCH="$ROOT/scripts/demo-orchestrator.mjs"
DEMO_ROOT="${DEMO_ROOT:-/tmp/pearpost-demo}"

REAL=1
ATTACH=1
MANUAL=""
SCENARIO=""
for arg in "$@"; do
  case "$arg" in
    --scripted)   REAL=0 ;;
    --real)       REAL=1 ;;
    --no-attach)  ATTACH=0 ;;
    --manual)     MANUAL="--manual" ;;
    --kill)
      tmux kill-session -t "$SESSION" 2>/dev/null && echo "killed tmux session $SESSION" || true
      # Match the actual node process line, not any shell that happens to
      # contain the string (otherwise this kills its own invocation).
      pkill -f 'node .*/scripts/demo-agent\.mjs' 2>/dev/null && echo "killed background demo-agent processes" || true
      exit 0
      ;;
    -h|--help)
      sed -n '1,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    pears|spoons|skyscanner|jetbrains)
      SCENARIO="$arg"
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

SCENARIO="${SCENARIO:-pears}"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is not installed. install it: apt install tmux  (or: brew install tmux)" >&2
  exit 1
fi

if ! curl -fsS "$BASE/demo/scenarios" >/dev/null 2>&1; then
  echo "warning: app server not responding on $BASE — start it with: node app/app.js" >&2
fi

# Pane assignment per scenario. Visible panes (1,2,3) get the most relevant
# real processes. Remaining roles run as real background agents.
case "$SCENARIO" in
  pears)
    VISIBLE=("alice" "bob" "contacts")
    HEADLESS=("dht")
    ;;
  spoons)
    VISIBLE=("alice-delegate" "bob-delegate" "calendar")
    HEADLESS=("alice" "bob")
    ;;
  skyscanner)
    VISIBLE=("alice-claw" "travel-agent" "maya-claw")
    HEADLESS=("alice" "bob-claw")
    ;;
  jetbrains)
    VISIBLE=("alice-ide" "test-runner" "bob-ide")
    HEADLESS=("repo-inspector" "patch-proposer")
    ;;
esac

SCEN_DIR="$DEMO_ROOT/$SCENARIO"
mkdir -p "$SCEN_DIR"
# Clear stale roster from a prior run; demo-agent processes will repopulate.
rm -f "$SCEN_DIR/roster.json"

tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION"
# Best-effort: kill any stragglers from a previous demo (match node process,
# not the shell that contains this script's invocation)
pkill -f 'node .*/scripts/demo-agent\.mjs' 2>/dev/null || true
sleep 0.3

tmux new-session -d -s "$SESSION" -n demo -x 200 -y 60 -c "$ROOT"

# Layout (4 panes total):
#   pane 0 : controller (top, full width)
#   pane 1 : visible role A (bottom-left)
#   pane 2 : visible role B (bottom-middle)
#   pane 3 : visible role C (bottom-right)
tmux split-window -v -t "$SESSION:demo.0" -c "$ROOT"
tmux split-window -h -t "$SESSION:demo.1" -c "$ROOT"
tmux split-window -h -t "$SESSION:demo.2" -c "$ROOT"

# pane 0: controller
tmux send-keys -t "$SESSION:demo.0" "clear; printf '\\033[1;32m▶ PearPost demo controller\\033[0m  ($BASE)  scenario=$SCENARIO  mode=$([ $REAL = 1 ] && echo real-processes || echo scripted)\\n\\n'" C-m

# Spawn visible agents in panes 1..3
if [[ "$REAL" == "1" ]]; then
  # Stagger boots: simultaneous Hyperswarm bootstraps in 4+ agents create
  # contention and DHT lookups can take much longer to settle. A 2s gap
  # between starts costs us a few seconds total but produces reliable
  # agent.start() returns.
  IDX=1
  STAGGER=0
  for ROLE in "${VISIBLE[@]}"; do
    [[ -z "${ROLE:-}" ]] && { IDX=$((IDX + 1)); continue; }
    tmux send-keys -t "$SESSION:demo.$IDX" \
      "clear; printf '\\033[1;33m[$ROLE] real pearpost agent\\033[0m  (waiting ${STAGGER}s for stagger)\\n'; sleep $STAGGER; APP_BASE=$BASE DEMO_ROOT=$DEMO_ROOT node $AGENT $ROLE --scenario $SCENARIO --app-base $BASE" C-m
    IDX=$((IDX + 1))
    STAGGER=$((STAGGER + 2))
  done

  # Spawn headless agents in the background from the controller pane,
  # also staggered.
  HEADLESS_CMD=""
  H_STAGGER=$STAGGER
  for ROLE in "${HEADLESS[@]}"; do
    [[ -z "${ROLE:-}" ]] && continue
    LOG="$SCEN_DIR/$ROLE.log"
    HEADLESS_CMD+="(sleep $H_STAGGER && APP_BASE=$BASE DEMO_ROOT=$DEMO_ROOT node $AGENT $ROLE --scenario $SCENARIO --app-base $BASE >$LOG 2>&1) & "
    H_STAGGER=$((H_STAGGER + 2))
  done
  if [[ -n "$HEADLESS_CMD" ]]; then
    tmux send-keys -t "$SESSION:demo.0" "echo 'spawning headless agents (staggered): ${HEADLESS[*]}' && $HEADLESS_CMD" C-m
  fi

  # Wait briefly, then run the orchestrator. The orchestrator itself waits
  # for the roster (up to ~45s), so the exact sleep is not critical — we
  # just want the controller pane to look composed.
  # Allow time for staggered boot + DHT bootstrap. Each visible agent has a
  # 0/2/4s stagger; headless agents follow. Real Hyperswarm bootstrap of the
  # last agent typically settles in ~25-40s after its sleep.
  TOTAL_BOOT=$((STAGGER + 25))
  tmux send-keys -t "$SESSION:demo.0" \
    "echo 'agents booting (real Hyperswarm — staggered, ~${TOTAL_BOOT}s total)…' && sleep $TOTAL_BOOT && DEMO_ROOT=$DEMO_ROOT APP_BASE=$BASE node $ORCH $SCENARIO $MANUAL" C-m
else
  # Scripted fallback: narration-only via demo-runner.
  IDX=1
  for ROLE in "${VISIBLE[@]}"; do
    [[ -z "${ROLE:-}" ]] && { IDX=$((IDX + 1)); continue; }
    tmux send-keys -t "$SESSION:demo.$IDX" \
      "clear; printf '\\033[1;33m[$ROLE] scripted narration\\033[0m\\n'; node $RUNNER follow $ROLE" C-m
    IDX=$((IDX + 1))
  done
  tmux send-keys -t "$SESSION:demo.0" \
    "node $RUNNER list && echo && echo '▶ starting scripted scenario: $SCENARIO' && node $RUNNER run $SCENARIO" C-m
fi

# Pane titles
tmux set -g pane-border-status top
tmux set -g pane-border-format ' #{pane_index} · #{pane_title} '
tmux select-pane -t "$SESSION:demo.0" -T "controller · $SCENARIO"
[[ -n "${VISIBLE[0]:-}" ]] && tmux select-pane -t "$SESSION:demo.1" -T "${VISIBLE[0]}"
[[ -n "${VISIBLE[1]:-}" ]] && tmux select-pane -t "$SESSION:demo.2" -T "${VISIBLE[1]}"
[[ -n "${VISIBLE[2]:-}" ]] && tmux select-pane -t "$SESSION:demo.3" -T "${VISIBLE[2]}"

tmux select-pane -t "$SESSION:demo.0"

if [[ "$ATTACH" == "1" ]]; then
  if [[ -n "${TMUX-}" ]]; then
    tmux switch-client -t "$SESSION"
  else
    tmux attach -t "$SESSION"
  fi
else
  echo "session '$SESSION' ready. attach with: tmux attach -t $SESSION"
fi
