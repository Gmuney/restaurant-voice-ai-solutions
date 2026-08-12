#!/usr/bin/env bash
# Install America/Chicago cron jobs for chalkboard snapshots.
set -euo pipefail
ROOT="/root/fish-city-sms"
NODE="$(command -v node)"
LOG="$ROOT/data/snapshot.log"
CRON_FILE="/etc/cron.d/fish-city-board-snapshots"

mkdir -p "$ROOT/data"

cat >"$CRON_FILE" <<EOF
# Fish City Culebra — chalkboard snapshots (lunch 11:00, dinner 16:30)
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
TZ=America/Chicago

5 11 * * * root cd $ROOT && $NODE src/snapshot-board.js lunch >> $LOG 2>&1
35 16 * * * root cd $ROOT && $NODE src/snapshot-board.js evening >> $LOG 2>&1
EOF

chmod 644 "$CRON_FILE"
echo "Installed $CRON_FILE"
echo "Lunch snapshot: 11:05am Chicago | Dinner snapshot: 4:35pm Chicago"
echo "Manual: cd $ROOT && npm run snapshot-board -- lunch"
