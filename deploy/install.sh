#!/usr/bin/env bash
#
# install.sh — one-shot installer for the FFG Recon app.
#
# Run on a FRESH Ubuntu 22.04 / 24.04 VM as root.
# It will:
#   - Install Node 20, pnpm, PM2, PostgreSQL, Nginx
#   - Create a `recon` system user and Postgres DB
#   - Clone the repo to /opt/recon (or update an existing checkout)
#   - Write backend + frontend env files with sensible defaults
#   - Build both apps
#   - Create your first admin user
#   - Configure PM2 + Nginx + UFW
#   - Print the URL to visit when done
#
# Usage:
#   curl -fsSL https://your-repo/deploy/install.sh | sudo bash
#   OR
#   sudo bash install.sh
#
# Re-running is safe: existing pieces get reused, missing pieces created.

set -euo pipefail

# ---------- 0. Sanity checks ----------

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: this script must be run as root. Try: sudo bash install.sh"
  exit 1
fi

if ! grep -qiE 'ubuntu|debian' /etc/os-release; then
  echo "WARNING: only tested on Ubuntu / Debian. Continuing anyway in 5s..."
  sleep 5
fi

# ---------- 1. Gather inputs ----------

echo
echo "================================================================"
echo "  FFG Recon — one-shot installer"
echo "================================================================"
echo

# Helper: prompt with default value, support hidden input for passwords.
prompt() {
  local var="$1" label="$2" default="${3:-}" hidden="${4:-}"
  local val
  if [[ -n "$hidden" ]]; then
    read -r -s -p "$label: " val
    echo
  elif [[ -n "$default" ]]; then
    read -r -p "$label [$default]: " val
    val="${val:-$default}"
  else
    read -r -p "$label: " val
  fi
  printf -v "$var" '%s' "$val"
}

# Auto-detect a sensible default public IP. Falls back to "" — the user
# can override at the prompt anyway.
DETECTED_IP=$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{print $2}' | head -1 | cut -d/ -f1 || true)

prompt REPO_URL    "GitHub repo URL (https or ssh)" "https://github.com/YusufE7860/credit-recon-system.git"
prompt SERVER_HOST "Public IP, LAN IP, or domain (no http://, no trailing slash)" "${DETECTED_IP:-127.0.0.1}"
prompt SERVER_PORT "Public port to serve on (80 = standard, anything else = obscurity)" "80"
prompt ADMIN_EMAIL "First admin email" "admin@example.com"
prompt ADMIN_PASS  "First admin password (will be hashed)" "" hidden
echo
prompt DB_PASS     "Postgres password for the recon user (Enter = auto-generate)" "" hidden
echo
prompt ANTHROPIC_KEY "Anthropic API key for AI OCR (Enter = skip, OCR falls back to Tesseract)" "" hidden
echo

# Auto-generate the DB password if blank. We always go hex so we never
# have to URL-encode special characters in the DATABASE_URL — that
# bit-us-once class of bug (`@` in the password breaks postgresql://
# parsing) is impossible by construction.
if [[ -z "$DB_PASS" ]]; then
  DB_PASS=$(openssl rand -hex 16)
  echo "  → generated DB password: $DB_PASS  (save this somewhere safe)"
fi

# If the operator typed their own DB password and it has URL-unsafe
# characters, percent-encode them for the DATABASE_URL. Postgres still
# stores the literal password — only the URL representation needs encoding.
urlencode() {
  local s="$1" out=""
  local i c
  for ((i=0; i<${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9._~-]) out+="$c" ;;
      *) out+=$(printf '%%%02X' "'$c") ;;
    esac
  done
  printf '%s' "$out"
}
DB_PASS_URL=$(urlencode "$DB_PASS")

# JWT secret is always auto-generated. Same secret goes into both the
# backend (for signing) and the frontend (Next.js middleware verifies
# the cookie at the edge before the page renders).
JWT_SECRET=$(openssl rand -hex 64)

# Decide scheme + port suffix for the URL we bake into the frontend.
# Plain IP = http (no HTTPS without a domain). Anything else = https assumed.
# Port 80 (http) / 443 (https) are stripped from the URL since browsers
# default to them — anything else gets appended.
if [[ "$SERVER_HOST" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
  SCHEME="http"
  COOKIE_SECURE="false"
  DEFAULT_PORT="80"
else
  SCHEME="https"
  COOKIE_SECURE="true"
  DEFAULT_PORT="443"
fi

if [[ "$SERVER_PORT" == "$DEFAULT_PORT" ]]; then
  PUBLIC_URL="$SCHEME://$SERVER_HOST"
else
  PUBLIC_URL="$SCHEME://$SERVER_HOST:$SERVER_PORT"
fi

echo "  → final public URL: $PUBLIC_URL (COOKIE_SECURE=$COOKIE_SECURE)"

echo
echo "Installing — this takes 3–10 minutes depending on your VM..."
echo

# ---------- 2. System packages ----------

echo "==> Updating apt and installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt update
apt install -y curl git build-essential ufw nginx postgresql postgresql-contrib openssl

# Node 20 from NodeSource.
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v20\.'; then
  echo "==> Installing Node 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi

# pnpm + PM2 globally. -g + npm is fine for a single VM.
echo "==> Installing pnpm + PM2"
npm install -g pnpm pm2 >/dev/null 2>&1 || npm install -g pnpm pm2

# ---------- 3. recon user + dirs ----------

if ! id recon >/dev/null 2>&1; then
  echo "==> Creating recon system user"
  adduser --disabled-password --gecos "" recon
  usermod -aG sudo recon
fi

mkdir -p /opt/recon /var/log/recon
mkdir -p /opt/recon/backend/api/uploads
# Ownership fixed at the end after the whole tree exists.

# ---------- 4. Postgres database ----------

echo "==> Configuring PostgreSQL"
systemctl enable --now postgresql

# Create or update the recon DB user with the (possibly fresh) password.
# Wrapped in DO so re-runs don't fail with "role already exists".
sudo -u postgres psql <<EOF
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'recon') THEN
    CREATE ROLE recon LOGIN PASSWORD '$DB_PASS';
  ELSE
    ALTER ROLE recon WITH PASSWORD '$DB_PASS';
  END IF;
END
\$\$;
EOF

# Create the database if missing.
if ! sudo -u postgres psql -lqt | cut -d \| -f 1 | grep -qw recon; then
  sudo -u postgres createdb -O recon recon
fi

# Make sure local connections accept passwords. Fresh Postgres
# installs on Ubuntu use `peer` for local + scram-sha-256 for host —
# we connect via 127.0.0.1 (host), but we still flip `peer` to
# scram-sha-256 in case any code path falls back to local sockets.
PG_HBA=$(ls /etc/postgresql/*/main/pg_hba.conf 2>/dev/null | head -1)
if [[ -n "$PG_HBA" ]] && grep -qE '^local\s+all\s+all\s+peer' "$PG_HBA"; then
  sed -i 's/^\(local\s\+all\s\+all\s\+\)peer$/\1scram-sha-256/' "$PG_HBA"
  systemctl restart postgresql
fi

# Quick sanity check the password actually works.
if ! PGPASSWORD="$DB_PASS" psql -h 127.0.0.1 -U recon -d recon -c "SELECT 1;" >/dev/null 2>&1; then
  echo "ERROR: Postgres connection check failed. Edit /etc/postgresql/*/main/pg_hba.conf and ensure 'local all all md5'."
  exit 1
fi

# ---------- 5. Clone or update the repo ----------

if [[ -d /opt/recon/.git ]]; then
  echo "==> Updating existing checkout at /opt/recon"
  cd /opt/recon
  sudo -u recon git fetch origin
  sudo -u recon git reset --hard origin/main
else
  echo "==> Cloning $REPO_URL into /opt/recon"
  # Move aside any pre-created /opt/recon dirs that aren't a git repo.
  if [[ -e /opt/recon ]] && [[ ! -d /opt/recon/.git ]]; then
    mv /opt/recon "/opt/recon.bak.$(date +%s)" || true
    mkdir -p /opt/recon
  fi
  # Clone as root then chown — handles both ssh + https. If the repo is
  # private + ssh, the operator needs to have an SSH key set up first.
  git clone "$REPO_URL" /opt/recon
fi

# Fix ownership for everything we just dropped on disk.
chown -R recon:recon /opt/recon /var/log/recon

# ---------- 6. Env files ----------

echo "==> Writing env files"

cat > /opt/recon/backend/api/.env <<EOF
# --- Database (DB_PASS_URL is the percent-encoded form for the URL;
#     Postgres stores and authenticates against the literal value) ---
DATABASE_URL="postgresql://recon:$DB_PASS_URL@127.0.0.1:5432/recon?schema=public"

# --- JWT ---
JWT_SECRET="$JWT_SECRET"
JWT_EXPIRES_IN="1d"

# --- Session ---
SESSION_INACTIVITY_MINUTES=10
COOKIE_SECURE=$COOKIE_SECURE

# --- CORS — origins allowed to call the API. Must match exactly the
#     scheme + host + port users type into their browser, or browsers
#     will block the call with a CORS error. ---
FRONTEND_URL=$PUBLIC_URL

# --- Production ---
NODE_ENV=production
PORT=3000
# Bind to loopback only — Nginx on :80 is the only public face.
HOST=127.0.0.1

# --- AI OCR (optional) ---
ANTHROPIC_API_KEY="$ANTHROPIC_KEY"
AI_FALLBACK_THRESHOLD=0.65

# --- Mail (fill in at /admin/settings or here later) ---
MAIL_HOST=""
MAIL_PORT=587
MAIL_USER=""
MAIL_PASS=""
MAIL_FROM="FFG Recon <noreply@example.com>"

# --- Public URL (used in email links) ---
PUBLIC_BASE_URL="$PUBLIC_URL"
EOF

cat > /opt/recon/frontend/.env.local <<EOF
# Browser-facing API base. Must match the URL users open in their
# browser, otherwise CORS will block login.
NEXT_PUBLIC_API_URL=$PUBLIC_URL/api

# Used by the Next.js middleware to verify the JWT cookie at the edge,
# before any page renders. MUST be identical to the backend's
# JWT_SECRET — same value signs and verifies the token.
JWT_SECRET=$JWT_SECRET
EOF

chown recon:recon /opt/recon/backend/api/.env /opt/recon/frontend/.env.local
chmod 600 /opt/recon/backend/api/.env /opt/recon/frontend/.env.local

# ---------- 7. Build ----------

echo "==> Installing backend dependencies + running migrations + building"
sudo -u recon bash -c "
  set -e
  cd /opt/recon/backend/api
  pnpm install --frozen-lockfile
  npx prisma generate
  # db push is safe when migrations aren't versioned. For a versioned
  # repo, switch to 'prisma migrate deploy'.
  npx prisma db push --accept-data-loss=false
  pnpm build
"

echo "==> Installing frontend dependencies + building"
sudo -u recon bash -c "
  set -e
  cd /opt/recon/frontend
  pnpm install --frozen-lockfile
  pnpm build
"

# ---------- 8. First admin user ----------

echo "==> Creating first admin user ($ADMIN_EMAIL)"
# Use the installed bcrypt to hash the password.
ADMIN_HASH=$(sudo -u recon bash -c "
  cd /opt/recon/backend/api
  node -e \"console.log(require('bcrypt').hashSync(process.argv[1], 10))\" '$ADMIN_PASS'
")

# Insert or update — re-running the installer with a different password
# updates the existing admin's password instead of failing on duplicate.
PGPASSWORD="$DB_PASS" psql -h 127.0.0.1 -U recon -d recon <<EOF
INSERT INTO "User" (id, name, email, password, role, active, "managedUserIds", "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Admin', '$ADMIN_EMAIL', '$ADMIN_HASH', 'ADMIN', true, '{}', NOW(), NOW())
ON CONFLICT (email) DO UPDATE
  SET password = EXCLUDED.password,
      role     = 'ADMIN',
      active   = true,
      "updatedAt" = NOW();
EOF

# ---------- 9. PM2 ----------

echo "==> Starting apps under PM2"
sudo -u recon bash -c "
  cd /opt/recon
  pm2 startOrReload deploy/ecosystem.config.js --update-env
  pm2 save
"

# Make PM2 boot with the system (only first time matters).
if ! systemctl list-unit-files | grep -q 'pm2-recon'; then
  pm2 startup systemd -u recon --hp /home/recon >/dev/null 2>&1 || true
  # The line above prints a command we need to actually run, then we
  # save again. Capture and run.
  STARTUP_CMD=$(pm2 startup systemd -u recon --hp /home/recon | tail -1)
  if [[ "$STARTUP_CMD" == sudo* ]]; then
    eval "$STARTUP_CMD"
  fi
  sudo -u recon pm2 save
fi

# ---------- 10. Nginx ----------

echo "==> Writing Nginx site config (listening on port $SERVER_PORT)"
cat > /etc/nginx/sites-available/recon <<NGINX
server {
  listen $SERVER_PORT default_server;
  server_name _;

  # Allow large invoice uploads. Phone photos and multi-page PDFs
  # can run 30+ MB; keep this in sync with MAX_INVOICE_FILE_SIZE and
  # MAX_STATEMENT_FILE_SIZE in the backend services.
  client_max_body_size 50M;

  # Backend API. Strip /api prefix.
  location /api/ {
    rewrite ^/api/(.*)\$ /\$1 break;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host              \$host;
    proxy_set_header X-Real-IP         \$remote_addr;
    proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 60s;
  }

  # Frontend (Next.js).
  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host              \$host;
    proxy_set_header X-Real-IP         \$remote_addr;
    proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header Upgrade           \$http_upgrade;
    proxy_set_header Connection        "upgrade";
  }
}
NGINX

ln -sf /etc/nginx/sites-available/recon /etc/nginx/sites-enabled/recon
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# ---------- 11. Firewall ----------

echo "==> Configuring UFW (allowing SSH + port $SERVER_PORT)"
ufw allow OpenSSH >/dev/null
ufw allow "$SERVER_PORT/tcp" >/dev/null
# Also allow 443 so a later certbot setup just works without re-running UFW.
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
echo "  Tip: lock this down to known subnets with"
echo "      sudo ufw delete allow $SERVER_PORT/tcp"
echo "      sudo ufw allow from 192.168.0.0/16 to any port $SERVER_PORT proto tcp"

# ---------- 12. Smoke test ----------

echo "==> Running smoke tests"
# Give PM2 + nginx a couple of seconds to settle.
sleep 4

FAIL_COUNT=0

# 1. Ports are bound on loopback (not all-interfaces).
if ! sudo ss -tlnp 2>/dev/null | grep -q '127\.0\.0\.1:3000'; then
  echo "  [WARN] Backend not bound to 127.0.0.1:3000 (or not listening)"
  FAIL_COUNT=$((FAIL_COUNT+1))
fi
if ! sudo ss -tlnp 2>/dev/null | grep -q '127\.0\.0\.1:3001'; then
  echo "  [WARN] Frontend not bound to 127.0.0.1:3001 (or not listening)"
  FAIL_COUNT=$((FAIL_COUNT+1))
fi

# 2. Backend responds through Nginx with the expected 401 for /auth/me.
if ! curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1/api/auth/me 2>/dev/null | grep -q '^401$'; then
  CODE=$(curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1/api/auth/me 2>/dev/null || echo "no-response")
  echo "  [WARN] Backend smoke test failed (expected 401, got $CODE)"
  FAIL_COUNT=$((FAIL_COUNT+1))
fi

# 3. Frontend renders.
if ! curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1/login 2>/dev/null | grep -q '^200$'; then
  CODE=$(curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1/login 2>/dev/null || echo "no-response")
  echo "  [WARN] Frontend smoke test failed (expected 200, got $CODE)"
  FAIL_COUNT=$((FAIL_COUNT+1))
fi

# 4. CORS preflight echoes back our chosen origin.
CORS_ORIGIN=$(curl -fsS -i -X OPTIONS http://127.0.0.1/api/auth/login \
  -H "Origin: $PUBLIC_URL" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type" 2>/dev/null \
  | grep -i '^Access-Control-Allow-Origin:' | tr -d '\r' | awk '{print $2}')
if [[ "$CORS_ORIGIN" != "$PUBLIC_URL" ]]; then
  echo "  [WARN] CORS allow-origin is '$CORS_ORIGIN', expected '$PUBLIC_URL'"
  FAIL_COUNT=$((FAIL_COUNT+1))
fi

# 5. The admin user actually exists.
ADMIN_COUNT=$(PGPASSWORD="$DB_PASS" psql -h 127.0.0.1 -U recon -d recon -tA -c \
  "SELECT COUNT(*) FROM \"User\" WHERE role = 'ADMIN' AND active = true;" 2>/dev/null)
if [[ "$ADMIN_COUNT" -lt 1 ]]; then
  echo "  [WARN] No active ADMIN user found in the database"
  FAIL_COUNT=$((FAIL_COUNT+1))
fi

if [[ $FAIL_COUNT -eq 0 ]]; then
  echo "  All smoke tests passed."
else
  echo "  $FAIL_COUNT smoke test(s) failed — see warnings above."
  echo "  Useful debugging:"
  echo "      sudo -u recon pm2 logs recon-api --lines 50"
  echo "      sudo -u recon pm2 logs recon-web --lines 50"
fi

# ---------- 13. Done ----------

echo
echo "================================================================"
echo "  Install complete"
echo "================================================================"
echo
echo "  Open this in your browser:"
echo "      $PUBLIC_URL"
echo
echo "  Login:"
echo "      email:    $ADMIN_EMAIL"
echo "      password: (the one you typed at the prompt)"
echo
echo "  Useful commands:"
echo "      sudo -u recon pm2 status            # see both processes"
echo "      sudo -u recon pm2 logs recon-api    # backend logs"
echo "      sudo -u recon pm2 logs recon-web    # frontend logs"
echo "      sudo -u recon pm2 restart all       # restart both"
echo
echo "  Updating later:"
echo "      sudo -u recon bash /opt/recon/deploy/deploy.sh"
echo
echo "  Adding a domain + HTTPS later:"
echo "      1. Point DNS A-record at this VM's IP"
echo "      2. sudo apt install -y certbot python3-certbot-nginx"
echo "      3. sudo certbot --nginx -d your.domain.com"
echo "      4. Edit /opt/recon/backend/api/.env: COOKIE_SECURE=true"
echo "      5. Edit /opt/recon/frontend/.env.local: NEXT_PUBLIC_API_URL=https://your.domain.com/api"
echo "      6. cd /opt/recon/frontend && sudo -u recon pnpm build"
echo "      7. sudo -u recon pm2 restart all"
echo
