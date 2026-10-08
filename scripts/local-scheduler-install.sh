#!/bin/bash
set -euo pipefail

LABEL="com.nodegetout.fundoverwatch.scheduler"
INSTALL_DIR="$HOME/.local/share/fundoverwatch-scheduler"
CONFIG_FILE="$INSTALL_DIR/scheduler-config.json"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/FundOverwatch"
STATE_DIR="$HOME/Library/Application Support/FundOverwatch"
DOMAIN="gui/$UID"
COMMAND="${1:-install}"

status() {
  echo "LaunchAgent: $PLIST"
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl print "$DOMAIN/$LABEL" | sed -n '1,45p'
  else
    echo "not loaded"
  fi
  if [[ -f "$CONFIG_FILE" && -f "$INSTALL_DIR/scheduler.mjs" ]]; then
    local node_path
    node_path="$(/usr/bin/sed -n 's/.*<string>\\(.*\\/node\\)<\\/string>.*/\\1/p' "$PLIST" | head -1)"
    FUNDOVERWATCH_SCHEDULER_CONFIG="$CONFIG_FILE" "$node_path" "$INSTALL_DIR/scheduler.mjs" --status
  else
    echo "runner not installed"
  fi
}

uninstall() {
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  /bin/rm -f "$PLIST"
  /bin/rm -rf "$INSTALL_DIR"
  echo "Uninstalled $LABEL. Logs and state were preserved:"
  echo "  $LOG_DIR"
  echo "  $STATE_DIR"
}

case "$COMMAND" in
  status)
    status
    exit 0
    ;;
  uninstall)
    uninstall
    exit 0
    ;;
  install)
    ;;
  *)
    echo "Usage: $0 [install|status|uninstall]" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_PATH="$(command -v node)"
GH_PATH="$(command -v gh)"
ESBUILD="$REPO_ROOT/node_modules/.bin/esbuild"
SOURCE_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"

if [[ ! -x "$NODE_PATH" || ! -x "$GH_PATH" ]]; then
  echo "node and gh must both be installed and executable." >&2
  exit 1
fi
if [[ ! -x "$ESBUILD" ]]; then
  echo "Missing esbuild; run npm ci in $REPO_ROOT first." >&2
  exit 1
fi
AUTH_READY=true
if ! env -u GH_TOKEN -u GITHUB_TOKEN "$GH_PATH" auth status --hostname github.com >/dev/null 2>&1; then
  AUTH_READY=false
  echo "WARNING: persistent gh authentication is not valid. The LaunchAgent will be installed but cannot dispatch until 'gh auth login' succeeds." >&2
elif ! env -u GH_TOKEN -u GITHUB_TOKEN "$GH_PATH" api repos/nodegetout/FundOverwatch/actions/permissions --jq '.enabled' | grep -qx true; then
  AUTH_READY=false
  echo "WARNING: GitHub Actions permission check failed. The LaunchAgent will be installed in degraded state." >&2
fi

/bin/mkdir -p "$INSTALL_DIR" "$HOME/Library/LaunchAgents" "$LOG_DIR" "$STATE_DIR"
"$ESBUILD" "$REPO_ROOT/scripts/local-scheduler.ts" \
  --bundle --platform=node --format=esm --target=node20 \
  --outfile="$INSTALL_DIR/scheduler.mjs"

/bin/cat > "$CONFIG_FILE" <<JSON
{
  "repository": "nodegetout/FundOverwatch",
  "workflow": "data-refresh.yml",
  "ref": "main",
  "ghPath": "$GH_PATH",
  "stateFile": "$STATE_DIR/scheduler-state.json",
  "lockDirectory": "$STATE_DIR/scheduler.lock",
  "graceMinutes": 15,
  "scanDays": 3,
  "maxBackfillDays": 7,
  "sourceCommit": "$SOURCE_COMMIT"
}
JSON
/bin/chmod 600 "$CONFIG_FILE"

/bin/cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$INSTALL_DIR/scheduler.mjs</string>
    <string>--once</string>
    <string>--config=$CONFIG_FILE</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$INSTALL_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>$(dirname "$NODE_PATH"):$(dirname "$GH_PATH"):/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/scheduler.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/scheduler-error.log</string>
</dict>
</plist>
PLIST

/usr/bin/plutil -lint "$PLIST"
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"
echo "Installed and started $LABEL from source commit $SOURCE_COMMIT."
echo "GitHub authentication ready: $AUTH_READY"
status
