#!/bin/bash
# In-app update script — spawned by the API when an admin clicks
# "Update" in the System page. Runs detached so it survives the
# pm2 restart at the end.
#
# Behavior:
#   - Lock file at /tmp/recon-update.lock prevents concurrent runs.
#   - All output → /var/log/recon/update.log (tailable from the UI).
#   - If git pull yields no new commits, exits cleanly with no rebuild.
#   - If the build fails AFTER a successful git pull, the script does
#     NOT auto-rollback — we'd rather the operator see the failure and
#     decide. The pre-pull SHA is logged so they can roll back manually:
#       cd /opt/recon && sudo -u recon git reset --hard <SHA>
#
# Designed to run as the `recon` user. The API spawns it without sudo;
# the API process itself is owned by `recon` so file ownership matches.

set -o pipefail
APP_DIR="${APP_DIR:-/opt/recon}"
LOCK="/tmp/recon-update.lock"
LOG_DIR="/var/log/recon"
LOG="$LOG_DIR/update.log"

# Make sure pnpm / pm2 / node are found regardless of how PATH was
# stitched together for the API process. The pnpm dir is the standard
# global-install location for the 'recon' user; /usr/local/bin and
# /usr/bin cover the system-wide tools.
export PATH="$HOME/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin:$PATH"

mkdir -p "$LOG_DIR"

# Lock — bail out cleanly if another update is already running. The
# trap removes the lock on every exit path (success, failure, signal).
if [ -e "$LOCK" ]; then
  echo "$(date '+%F %T')  update already running (lock $LOCK present)" >> "$LOG"
  exit 1
fi
touch "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# Everything from here on goes to the log file. Append so the UI can
# tail across multiple updates without losing history. Stderr → stdout
# so build failures are captured too.
exec >> "$LOG" 2>&1

echo ""
echo "==============================================================="
echo "  Recon update starting at $(date)"
echo "==============================================================="

cd "$APP_DIR" || { echo "ERROR: $APP_DIR does not exist"; exit 2; }

# Capture the SHA so we can report what changed (and so the operator
# can roll back manually if the build fails further down).
BEFORE=$(git rev-parse HEAD)
echo "Current SHA: $BEFORE"

echo ""
echo "==> Fetching from origin"
git fetch origin

# Compare HEAD against the upstream branch's tip. If they're the same
# there's nothing to do — quick exit, no rebuild churn.
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ]; then
  echo ""
  echo "Already up to date. Nothing to install."
  echo "==============================================================="
  echo "  Done at $(date) — no changes"
  echo "==============================================================="
  exit 0
fi

echo "Pulling from origin/main..."
git reset --hard origin/main
AFTER=$(git rev-parse HEAD)
echo "New SHA: $AFTER"

echo ""
echo "==> Listing changed commits"
git log --oneline "$BEFORE..$AFTER" || true

echo ""
echo "==> Backend: install + prisma + build"
cd "$APP_DIR/backend/api"
pnpm install --frozen-lockfile
# --accept-data-loss is safe for non-destructive schema changes; if
# you're worried about a particular release, run prisma migrations
# manually first and skip this script for that one.
npx prisma db push --accept-data-loss
pnpm build

echo ""
echo "==> Frontend: install + build"
cd "$APP_DIR/frontend"
pnpm install --frozen-lockfile
pnpm build

echo ""
echo "==> Restarting PM2 processes"
# --update-env picks up any new env vars the release introduced.
# Reload (graceful) for the web, restart (hard) for the api — restart
# is safer for backend code changes since reload can keep stale modules
# in cluster mode workers.
pm2 restart all --update-env

echo ""
echo "==============================================================="
echo "  Update complete at $(date)"
echo "  Was: $BEFORE"
echo "  Now: $AFTER"
echo "==============================================================="
