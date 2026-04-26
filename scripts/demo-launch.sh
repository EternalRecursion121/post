#!/usr/bin/env bash
# PearPost demo launcher — macOS, single command.
#
# Usage:
#   scripts/demo-launch.sh            # demo 1 (pears) by default
#   scripts/demo-launch.sh 1          # 1 = pears
#   scripts/demo-launch.sh 2          # 2 = spoons
#   scripts/demo-launch.sh 3          # 3 = skyscanner
#   scripts/demo-launch.sh 4          # 4 = jetbrains
#   scripts/demo-launch.sh 3 --scripted   # narration mode (no real DHT)
#
# What it does:
#   1. Starts the PearPost app server (skipped if already running).
#   2. Waits for it to be reachable.
#   3. Opens the browser to http://127.0.0.1:$PORT.
#   4. Snaps the browser window to the right half of the main display.
#   5. Snaps the frontmost Terminal/iTerm2 window to the left half.
#   6. Launches the tmux demo session for the chosen scenario in this
#      terminal (real-process mode unless --scripted is passed).
#
# Env:
#   PEARPOST_PORT   default 7777
#   BROWSER_APP     macOS app name; default 'Google Chrome', falls back to
#                   'Safari' if not installed
#
# This script is macOS-only. On other platforms, run scripts/demo-tmux.sh
# directly.

set -u

if [[ "$(uname)" != "Darwin" ]]; then
  echo "demo-launch.sh is macOS-only. On Linux, run scripts/demo-tmux.sh directly." >&2
  exit 1
fi

PORT="${PEARPOST_PORT:-7777}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL="http://127.0.0.1:${PORT}/"

# ---- parse args ----
NUM=""
PASS_THROUGH=()
for arg in "$@"; do
  case "$arg" in
    1|2|3|4) NUM="$arg" ;;
    *)       PASS_THROUGH+=("$arg") ;;
  esac
done
NUM="${NUM:-1}"

case "$NUM" in
  1) SCENARIO="pears" ;;
  2) SCENARIO="spoons" ;;
  3) SCENARIO="skyscanner" ;;
  4) SCENARIO="jetbrains" ;;
esac

echo "▶ launching demo $NUM ($SCENARIO)"

# ---- 1. start app server if needed ----
if curl -fsS "$URL" >/dev/null 2>&1; then
  echo "✓ app server already running on $URL"
else
  echo "  starting app server in background…"
  ( cd "$ROOT" && PEARPOST_PORT="$PORT" nohup node app/app.js \
      >/tmp/pearpost-app.log 2>&1 & echo $! > /tmp/pearpost-app.pid )
  # wait up to 30s for it to come up
  for _ in $(seq 1 60); do
    if curl -fsS "$URL" >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  if ! curl -fsS "$URL" >/dev/null 2>&1; then
    echo "! app server did not respond — see /tmp/pearpost-app.log" >&2
    exit 1
  fi
  echo "✓ app server up (pid $(cat /tmp/pearpost-app.pid 2>/dev/null))"
fi

# ---- 2. pick browser ----
BROWSER_APP="${BROWSER_APP:-Google Chrome}"
if ! osascript -e "tell application \"System Events\" to exists application \"$BROWSER_APP\"" 2>/dev/null | grep -q true; then
  if [[ -d "/Applications/Google Chrome.app" ]]; then BROWSER_APP="Google Chrome"
  elif [[ -d "/Applications/Safari.app" ]]; then BROWSER_APP="Safari"
  elif [[ -d "/Applications/Firefox.app" ]]; then BROWSER_APP="Firefox"
  else echo "! no supported browser found" >&2; exit 1
  fi
fi

# ---- 3. open URL + position browser to right half ----
osascript <<APPLESCRIPT
-- Get the bounds of the main display (excluding the menu bar).
tell application "Finder"
    set screenBounds to bounds of window of desktop
end tell
set sx to item 1 of screenBounds
set sy to item 2 of screenBounds
set sw to (item 3 of screenBounds) - sx
set sh to (item 4 of screenBounds) - sy

set halfW to sw / 2
set rightX to sx + halfW

-- Open browser at URL and place it on the right half.
tell application "$BROWSER_APP"
    activate
    if "$BROWSER_APP" is "Safari" then
        if (count of windows) = 0 then make new document
        set URL of front document to "$URL"
    else if "$BROWSER_APP" is "Google Chrome" then
        if (count of windows) = 0 then make new window
        set URL of active tab of front window to "$URL"
    else
        open location "$URL"
    end if
    delay 0.4
    try
        set bounds of front window to {rightX, sy, sx + sw, sy + sh}
    end try
end tell

-- Snap the calling terminal to the left half. We try Terminal then iTerm2.
set termSnapped to false
tell application "System Events"
    if exists application process "iTerm2" then
        tell application "iTerm2" to activate
        delay 0.2
        try
            tell application "iTerm2"
                set bounds of front window to {sx, sy, rightX, sy + sh}
            end tell
            set termSnapped to true
        end try
    end if
end tell
if termSnapped is false then
    try
        tell application "Terminal"
            activate
            delay 0.2
            set bounds of front window to {sx, sy, rightX, sy + sh}
        end tell
        set termSnapped to true
    end try
end if
APPLESCRIPT

echo "✓ browser opened at $URL (right half)"
echo "  (terminal positioning best-effort — fallback: snap with Cmd-Ctrl-←)"

# ---- 4. launch tmux demo in current terminal ----
echo "▶ starting demo: $SCENARIO"
exec "$ROOT/scripts/demo-tmux.sh" "$SCENARIO" ${PASS_THROUGH[@]+"${PASS_THROUGH[@]}"}
