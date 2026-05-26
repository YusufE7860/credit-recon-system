#!/usr/bin/env bash
#
# deploy.sh — runs on the production server, invoked by the GitHub Action.
#
# Safety design:
#   - Uses `set -e` so any failed step aborts the deploy.
#   - Captures the previous commit BEFORE pulling, so we can roll back
#     if pm2 reload fails to start the new code.
#   - Locks against concurrent runs via a flock.
#
# Prerequisites on the server (one-time bootstrap):
#   - Node 20, pnpm, Postgres, Nginx, PM2 installed
#   - Repo cloned to /opt/recon
#   - .env files placed in backend/api/.env and frontend/.env.local
#   - PM2 already started once via ecosystem.config.js
#
# Manual run on the server:  bash deploy/deploy.sh

set -e
set -u
set -o pipefail

LOCK_FILE=/tmp/recon-deploy.lock
APP_DIR=/opt/recon

# Prevent two deploys from racing.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "ERROR: another deploy is already running"
  exit 1
fi

cd "$APP_DIR"

echo "==> Snapshotting current commit for rollback"
PREV_COMMIT=$(git rev-parse HEAD)
echo "    Previous: $PREV_COMMIT"

echo "==> Pulling latest from origin/main"
git fetch origin main
git reset --hard origin/main
NEW_COMMIT=$(git rev-parse HEAD)
echo "    New:      $NEW_COMMIT"

if [ "$PREV_COMMIT" = "$NEW_COMMIT" ]; then
  echo "==> Already at latest commit, nothing to do"
  exit 0
fi

echo "==> Installing backend dependencies"
cd "$APP_DIR/backend/api"
pnpm install --frozen-lockfile --prod=false

echo "==> Running Prisma generate + db push"
npx prisma generate
# `db push` is fine for early-stage projects. Switch to
# `prisma migrate deploy` once you start versioning migrations.
npx prisma db push --accept-data-loss=false

echo "==> Building backend"
pnpm build

echo "==> Installing frontend dependencies"
cd "$APP_DIR/frontend"
pnpm install --frozen-lockfile --prod=false

echo "==> Building frontend"
pnpm build

echo "==> Reloading PM2 processes (graceful)"
cd "$APP_DIR"
if ! pm2 reload deploy/ecosystem.config.js --update-env; then
  echo "ERROR: pm2 reload failed — rolling back to $PREV_COMMIT"
  git reset --hard "$PREV_COMMIT"
  # Rebuild the previous version so processes have something to run.
  (cd backend/api && pnpm install --frozen-lockfile --prod=false && pnpm build)
  (cd frontend && pnpm install --frozen-lockfile --prod=false && pnpm build)
  pm2 reload deploy/ecosystem.config.js --update-env || true
  exit 1
fi

echo "==> Deploy complete: $PREV_COMMIT -> $NEW_COMMIT"
