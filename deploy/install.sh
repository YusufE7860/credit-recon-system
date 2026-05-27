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

prompt REPO_URL    "GitHub repo URL (https or ssh)" "https://github.com/yourorg/credit-recon-system.git"
prompt SERVER_HOST "Public IP or domain (no http://, no trailing slash)" "${DETECTED_IP:-127.0.0.1}"
prompt ADMIN_EMAIL "First admin email" "admin@example.com"
prompt ADMIN_PASS  "First admin password (will be hashed)" "" hidden
echo
prompt DB_PASS     "Postgres password for the recon user (Enter = auto-generate)" "" hidden
echo
prompt ANTHROPIC_KEY "Anthropic API key for AI OCR (Enter = skip, OCR falls back to Tesseract)" "" hidden
echo

# Auto-generate the DB password if blank.
if [[ -z "$DB_PASS" ]]; then
  DB_PASS=$(openssl rand -hex 16)
  echo "  → generated DB password: $DB_PASS  (save this somewhere safe)"
fi

# JWT secret is always auto-generated.
JWT_SECRET=$(openssl rand -hex 64)

# Decide whether the URL we'll bake into the frontend uses http or https.
# Plain IP = http (no HTTPS without a domain). Anything else = https assumed.
if [[ "$SERVER_HOST" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
  PUBLIC_URL="http://$SERVER_HOST"
  COOKIE_SECURE="false"
  echo "  → detected raw IP; using http:// and COOKIE_SECURE=false"
else
  PUBLIC_URL="https://$SERVER_HOST"
  COOKIE_SECURE="true"
  echo "  → detected hostname; using https:// (you'll set up certbot after)"
fi

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

# Make sure local connections use md5 (password) instead of peer. On
# fresh Ubuntu it's already md5/scram for non-postgres users, but
# defensive belts-and-braces here.
PG_HBA=$(ls /etc/postgresql/*/main/pg_hba.conf 2>/dev/null | head -1)
if [[ -n "$PG_HBA" ]] && grep -qE '^local\s+all\s+all\s+peer' "$PG_HBA"; then
  sed -i 's/^\(local\s\+all\s\+all\s\+\)peer$/\1md5/' "$PG_HBA"
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
# --- Database ---
DATABASE_URL="postgresql://recon:$DB_PASS@127.0.0.1:5432/recon?schema=public"

# --- JWT ---
JWT_SECRET="$JWT_SECRET"
JWT_EXPIRES_IN="1d"

# --- Session ---
SESSION_INACTIVITY_MINUTES=10
COOKIE_SECURE=$COOKIE_SECURE

# --- Production ---
NODE_ENV=production
PORT=3000

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
NEXT_PUBLIC_API_URL=$PUBLIC_URL/api
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

echo "==> Writing Nginx site config"
cat > /etc/nginx/sites-available/recon <<NGINX
server {
  listen 80 default_server;
  server_name _;

  # Allow large invoice uploads (PDFs can run 5+ MB).
  client_max_body_size 20M;

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

echo "==> Configuring UFW"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
# Allow 443 too so when you add HTTPS later it just works.
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

# ---------- 12. Done ----------

# Give PM2 a couple of seconds to boot before we sanity-check the URL.
sleep 3

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
