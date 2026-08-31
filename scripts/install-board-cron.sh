#!/usr/bin/env bash
# Install America/Chicago cron jobs for chalkboard snapshots (backup to in-bot scheduler).
set -euo pipefail
ROOT="/root/fish-city-sms"
NODE="$(command -v node)"
LOG="$ROOT/data/snapshot.log"
CRON_FILE="/etc/cron.d/fish-city-board-snapshots"

mkdir -p "$ROOT/data"

cat >"$CRON_FILE" <<EOF
# Fish City Culebra — chalkboard snapshots (lunch 11:00, dinner 16:30)
# Primary scheduler also runs inside the Telegram bot process.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
TZ=America/Chicago

0 11 * * * root cd $ROOT && $NODE src/board/snapshot-board.js lunch >> $LOG 2>&1
30 16 * * * root cd $ROOT && $NODE src/board/snapshot-board.js evening >> $LOG 2>&1
EOF

chmod 644 "$CRON_FILE"
echo "Installed $CRON_FILE"
echo "Lunch snapshot: 11:00am Chicago | Dinner snapshot: 4:30pm Chicago"
echo "Manual: cd $ROOT && npm run snapshot-board -- lunch"
