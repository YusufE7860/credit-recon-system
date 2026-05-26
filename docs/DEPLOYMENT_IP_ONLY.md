# IP-Only Test Deployment (Ubuntu 24.04, no domain)

Step-by-step for running FFG Recon on a fresh Ubuntu 24.04 VM,
accessed via raw public IP (no domain, no HTTPS yet). Good for an
internal pilot. Copy-paste each block in order.

**Heads up about the no-HTTPS choice.** Without a domain we can't get
a Let's Encrypt cert, and login over plain HTTP needs the auth cookie's
`secure` flag turned off. The guide sets `COOKIE_SECURE=false` to make
this work. **As soon as you have a domain, flip it back to true.**
Sending session cookies over HTTP on the public internet is sniffable.

---

## What you'll end up with

```
http://<your-vm-public-ip>/        → Login page (Next.js on :3001)
http://<your-vm-public-ip>/api/    → Backend API (NestJS on :3000)
```

Nginx routes both behind port 80. Postgres runs locally. PM2 keeps
both Node processes alive.

---

## 1. SSH into the VM

```bash
ssh root@<your-vm-public-ip>
```

(Or whatever user HyperVM gave you. If you can only get in as root,
that's fine — we'll create a regular user in step 2.)

Confirm you're on the right OS:

```bash
lsb_release -a
# Should say "Ubuntu 24.04.2 LTS"
```

---

## 2. Create a non-root deploy user

Don't run Node as root. Create `recon` once, then switch to it for
everything else.

```bash
# Run these as root
adduser --disabled-password --gecos "" recon
usermod -aG sudo recon

# Copy your SSH key over so you can log in as `recon` later
mkdir -p /home/recon/.ssh
cp ~/.ssh/authorized_keys /home/recon/.ssh/ 2>/dev/null || true
chown -R recon:recon /home/recon/.ssh
chmod 700 /home/recon/.ssh
test -f /home/recon/.ssh/authorized_keys && chmod 600 /home/recon/.ssh/authorized_keys

# Let `recon` use sudo without a password (saves typing on a test box)
echo 'recon ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/recon
```

If you didn't have an SSH key set up for root, set a password for
`recon` instead:

```bash
passwd recon
```

Now open a second SSH session as `recon` to verify it works:

```bash
ssh recon@<your-vm-public-ip>
```

Stay in the `recon` session for the rest. **Close the root session.**

---

## 3. Update + basic firewall

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential ufw

# Firewall: SSH + HTTP
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw --force enable
sudo ufw status
```

You should see `22/tcp ALLOW` and `80/tcp ALLOW`. We're skipping 443
because there's no HTTPS yet — add it later when you get a domain.

---

## 4. Install Node 20, pnpm, PM2

Ubuntu 24.04 ships with Node 18 — fine, but pinning to Node 20 matches
the production target.

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node -v   # should print v20.x.x
npm -v

sudo npm install -g pnpm pm2
```

---

## 5. Install PostgreSQL 16

Ubuntu 24.04's default Postgres is 16. Good.

```bash
sudo apt install -y postgresql postgresql-contrib

# Verify it's running
sudo systemctl status postgresql --no-pager
```

Create the database + user. **Pick a strong password and remember it
— you'll paste it into the `.env` file in step 8.**

```bash
sudo -u postgres psql <<EOF
CREATE USER recon WITH PASSWORD 'CHANGE-THIS-TO-A-STRONG-PASSWORD';
CREATE DATABASE recon OWNER recon;
EOF
```

Quick sanity check the new user can connect:

```bash
PGPASSWORD='CHANGE-THIS-TO-A-STRONG-PASSWORD' \
  psql -h 127.0.0.1 -U recon -d recon -c "SELECT 1;"
```

You should see `1` printed. If you get `peer authentication failed`:

```bash
# Find the file
sudo grep -l 'peer' /etc/postgresql/*/main/pg_hba.conf

# Edit it
sudo nano /etc/postgresql/16/main/pg_hba.conf
# Change the line:  local all all peer
# To:               local all all md5
# Save and restart:
sudo systemctl restart postgresql
```

Then re-run the sanity-check `psql` command.

---

## 6. Install Nginx

```bash
sudo apt install -y nginx
sudo systemctl enable --now nginx
```

Visit `http://<your-vm-public-ip>` in a browser — you should see the
default "Welcome to Nginx" page. If you don't:

- HyperVM might have a host-level firewall blocking port 80. Open the
  panel and check.
- `sudo ufw status` to confirm port 80 is allowed (step 3 above).

---

## 7. Clone the repo

```bash
sudo mkdir -p /opt/recon /var/log/recon
sudo chown -R recon:recon /opt/recon /var/log/recon

cd /opt
git clone https://github.com/yourorg/credit-recon-system.git recon

# If it's a PRIVATE repo, generate an SSH deploy key first:
#   ssh-keygen -t ed25519 -f ~/.ssh/github-deploy -N ""
#   cat ~/.ssh/github-deploy.pub   # paste this into GitHub > repo > Settings > Deploy keys
# Then clone with:
#   GIT_SSH_COMMAND='ssh -i ~/.ssh/github-deploy' git clone git@github.com:yourorg/credit-recon-system.git recon

mkdir -p /opt/recon/backend/api/uploads
```

---

## 8. Backend environment variables

```bash
nano /opt/recon/backend/api/.env
```

Paste this and **replace every CHANGE-ME placeholder**:

```dotenv
# --- Database ---
DATABASE_URL="postgresql://recon:CHANGE-THIS-TO-A-STRONG-PASSWORD@127.0.0.1:5432/recon?schema=public"

# --- JWT ---
# Generate with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET="CHANGE-ME-PASTE-A-LONG-RANDOM-HEX-STRING"
JWT_EXPIRES_IN="1d"

# --- Session ---
# Inactivity logout. The cookie resets on every authenticated request.
SESSION_INACTIVITY_MINUTES=10

# --- IP-only test mode ---
# The auth cookie's `secure` flag defaults to true in production, which
# means browsers refuse to send it over plain HTTP. Set this to false
# for IP-only access. FLIP BACK TO true ONCE YOU HAVE HTTPS.
COOKIE_SECURE=false

# --- Production ---
NODE_ENV=production
PORT=3000

# --- AI OCR (optional but recommended) ---
# Sign up at console.anthropic.com if you don't have a key yet.
# The Tesseract fallback works without it, just less accurately.
ANTHROPIC_API_KEY=""
AI_FALLBACK_THRESHOLD=0.65

# --- Mail (optional for first test — password resets won't work without it) ---
MAIL_HOST=""
MAIL_PORT=587
MAIL_USER=""
MAIL_PASS=""
MAIL_FROM="FFG Recon <noreply@example.com>"

# --- Public URL (used in email links) ---
PUBLIC_BASE_URL="http://<your-vm-public-ip>"
```

Generate the JWT secret in one line:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Paste the output into `JWT_SECRET`.

---

## 9. Frontend environment variables

The frontend has to know where the backend lives. Since Nginx will
route `/api/*` to the backend on the same host, we point it at
`http://<ip>/api`.

```bash
nano /opt/recon/frontend/.env.local
```

```dotenv
NEXT_PUBLIC_API_URL=http://<your-vm-public-ip>/api
```

Lock down both env files:

```bash
chmod 600 /opt/recon/backend/api/.env /opt/recon/frontend/.env.local
```

---

## 10. Install dependencies + build

This part takes 3–8 minutes the first time.

```bash
# Backend
cd /opt/recon/backend/api
pnpm install --frozen-lockfile
npx prisma generate
npx prisma migrate deploy
# (if migrate deploy errors with "No migration found", run `npx prisma db push` instead)
pnpm build

# Frontend
cd /opt/recon/frontend
pnpm install --frozen-lockfile
pnpm build
```

If a build fails, scroll up — the first error message is usually the
real problem. Common causes:

- Out of memory on a 1 GB VM (frontend build is the worst offender).
  Either resize the VM in HyperVM or build with reduced parallelism:
  `NODE_OPTIONS="--max-old-space-size=1024" pnpm build`.
- Missing build tools — run `sudo apt install -y build-essential` again.

---

## 11. Create the first admin user

The app has no users yet — without one you can't log in.

```bash
cd /opt/recon/backend/api

# Hash a password
HASH=$(node -e "console.log(require('bcrypt').hashSync('CHANGE-ME-ADMIN-PASSWORD', 10))")

# Insert directly into Postgres
PGPASSWORD='CHANGE-THIS-TO-A-STRONG-PASSWORD' \
  psql -h 127.0.0.1 -U recon -d recon <<EOF
INSERT INTO "User" (id, name, email, password, role, active, "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Admin', 'admin@example.com', '$HASH', 'ADMIN', true, NOW(), NOW());
EOF
```

Replace `admin@example.com` with the email you actually want to log
in as, and `CHANGE-ME-ADMIN-PASSWORD` with a real password.

---

## 12. Start the app under PM2

```bash
cd /opt/recon
pm2 start deploy/ecosystem.config.js
pm2 save

# Make PM2 start on system boot
pm2 startup
# It'll print a `sudo env PATH=...` line — COPY IT AND RUN IT.
```

Verify both processes are online:

```bash
pm2 status
# Should show recon-api (online) and recon-web (online), no restarts piling up

# If something looks wrong:
pm2 logs --lines 50
# Ctrl+C to stop tailing
```

Quick local sanity check before configuring Nginx:

```bash
curl -sI http://127.0.0.1:3000/auth/me   # 401 expected (no cookie) — backend up
curl -sI http://127.0.0.1:3001           # 200 expected — frontend up
```

---

## 13. Configure Nginx

The repo has a sample config — but it expects a domain name. We'll use
a simpler IP-only version.

```bash
sudo nano /etc/nginx/sites-available/recon
```

Paste this:

```nginx
server {
  listen 80 default_server;
  server_name _;

  # Allow large invoice uploads (PDFs can run 5+ MB).
  client_max_body_size 20M;

  # Backend API. Strip /api prefix so /api/auth/login reaches the
  # backend as /auth/login.
  location /api/ {
    rewrite ^/api/(.*)$ /$1 break;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
  }

  # Frontend (Next.js).
  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        "upgrade";
  }
}
```

Enable it + drop the default site:

```bash
sudo ln -sf /etc/nginx/sites-available/recon /etc/nginx/sites-enabled/recon
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

---

## 14. Open it in a browser

Visit `http://<your-vm-public-ip>` in any browser. You should see the
login page. Log in with the admin email + password from step 11.

If it works: you're live.

---

## Smoke test checklist

After logging in for the first time, click through:

- [ ] Dashboard loads, no JavaScript errors in browser console.
- [ ] Admin → Users → New user — create a test USER.
- [ ] Log out, log back in as that USER.
- [ ] Upload page accepts a test invoice (image or PDF).
- [ ] Switch back to admin → invoice appears under their name on the
      Invoices page.
- [ ] Admin → Cards → New card → manually add a card.
- [ ] Upload a CSV or PDF bank statement on the Upload page.
- [ ] Reports → Recon tab → "Generate XLSX" downloads a workbook.

---

## When something goes wrong

**Browser shows "502 Bad Gateway".** PM2 process is dead or wrong port:

```bash
pm2 status
pm2 logs --lines 100
sudo ss -tlnp | grep -E '3000|3001'
```

**Browser can't even reach the IP.**
1. `sudo ufw status` — port 80 must be allowed.
2. From the VM itself: `curl -I http://localhost` — if this returns 200
   but the public IP doesn't, it's a host-level firewall in HyperVM.
   Check the HyperVM panel for "Networking" / "Firewall" rules.

**Login button submits but page doesn't change / immediately bounces back to login.** Almost certainly the cookie isn't being saved.
1. Open browser devtools → Network → click Login → look at the response.
   The `Set-Cookie` header should be there.
2. If `Set-Cookie` has `Secure;` in it, your `COOKIE_SECURE` env var
   didn't get picked up. Verify:
   `grep COOKIE_SECURE /opt/recon/backend/api/.env`
   Then restart: `pm2 restart recon-api && pm2 logs recon-api --lines 20`

**OCR uploads fail.**
- No `ANTHROPIC_API_KEY` set? AI extraction is disabled — Tesseract
  fallback should still run, but very long PDFs can time out.
- Anthropic key invalid? Look at `pm2 logs recon-api` for the actual
  error message.
- Disk full? `df -h`. The `uploads/` directory grows with each invoice.

**`prisma migrate deploy` says "No migration found in prisma/migrations".**
This codebase uses `db push` rather than versioned migrations. Run:

```bash
cd /opt/recon/backend/api
npx prisma db push
```

**Need to restart everything cleanly.**

```bash
pm2 restart all
sudo systemctl restart nginx
sudo systemctl restart postgresql
```

---

## Updating to a new code version

```bash
cd /opt/recon
git pull origin main

cd backend/api && pnpm install --frozen-lockfile && npx prisma generate && npx prisma db push && pnpm build
cd ../../frontend && pnpm install --frozen-lockfile && pnpm build

pm2 reload deploy/ecosystem.config.js --update-env
```

Or just run the existing helper:

```bash
bash /opt/recon/deploy/deploy.sh
```

---

## When you DO get a domain (recommended next step)

The cookie-over-HTTP setup is fine for testing on a closed network or
short-term pilot, but don't run it long-term on the public internet.
Once you have a domain pointing at the VM:

1. Edit Nginx config and change `server_name _;` to your domain.
2. `sudo apt install -y certbot python3-certbot-nginx`
3. `sudo certbot --nginx -d recon.yourdomain.co.za` — rewrites the
   Nginx config to add SSL and schedules auto-renewal.
4. Open port 443: `sudo ufw allow 443/tcp`
5. Edit the backend `.env`:
   - Remove or set to `true`: `COOKIE_SECURE=true`
   - Update: `PUBLIC_BASE_URL=https://recon.yourdomain.co.za`
6. Edit the frontend `.env.local`:
   - `NEXT_PUBLIC_API_URL=https://recon.yourdomain.co.za/api`
7. Rebuild + restart:
   ```bash
   cd /opt/recon/frontend && pnpm build
   pm2 restart all
   ```
