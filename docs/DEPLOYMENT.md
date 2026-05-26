# Test Deployment Guide

Step-by-step walkthrough for deploying FFG Recon to a fresh VPS
provisioned via HyperVM (or any other panel). Targets a single-node
Ubuntu 22.04 LTS server. Time to first working URL: ~30 minutes.

Everything you'll install lives on this one server: PostgreSQL, the
NestJS API, the Next.js frontend, and Nginx as the reverse proxy.
That's plenty for a test / pilot deployment.

---

## 0. Before you start

**You need:**

- A VPS provisioned through HyperVM. Choose:
  - **OS template:** Ubuntu 22.04 LTS (or Debian 12). If you can't get
    22.04, 20.04 also works. Avoid anything older.
  - **RAM:** minimum 2 GB. 1 GB will swap badly with Node × 2 plus
    Postgres. 4 GB is comfortable.
  - **Storage:** 20 GB is plenty for a test.
- A domain (or subdomain) you can point at the server's public IP.
  Something like `recon.yourcompany.co.za`. HTTPS won't work without
  a real DNS name resolving to the box.
- Your Anthropic API key (the app uses Claude for OCR). If you don't
  have one yet, sign up at console.anthropic.com — the OCR pipeline
  has a Tesseract fallback so it'll still work without a key, just less
  accurately.

**HyperVM-specific gotchas:**

- Some HyperVM VPSes are OpenVZ containers, not full KVM VMs. OpenVZ
  has limitations on iptables, kernel modules, and sometimes Docker.
  None of those matter for this stack (no Docker, no custom kernel
  modules, standard outbound networking only).
- The default firewall on HyperVM-provided boxes varies by host. If
  you can't reach port 80/443 from the public internet after Nginx is
  running, the firewall is probably the cause — see the troubleshooting
  section at the end.

---

## 1. Provision the VM via HyperVM

In the HyperVM panel:

1. **Create VPS** → pick your Ubuntu 22.04 template, RAM, disk, IPs.
2. Boot it up and note the **public IPv4 address** and the **root
   password** (or set an SSH key if HyperVM lets you).
3. **Point your domain** at the public IP via your DNS provider:

   ```
   recon.yourcompany.co.za.   A   1h   123.45.67.89
   ```

   Wait a few minutes for propagation. Verify with:
   `dig +short recon.yourcompany.co.za`

That's all HyperVM is doing for us. Everything from here is standard
Ubuntu work via SSH.

---

## 2. SSH in and harden the basics

```bash
ssh root@<your-server-ip>
```

```bash
# Update everything
apt update && apt upgrade -y

# Create a non-root deploy user (we'll run the app as this user, not root)
adduser --disabled-password --gecos "" recon
usermod -aG sudo recon

# Copy your SSH key over so you can log in as the new user
mkdir -p /home/recon/.ssh
cp ~/.ssh/authorized_keys /home/recon/.ssh/   # if you used a key
chown -R recon:recon /home/recon/.ssh
chmod 700 /home/recon/.ssh
chmod 600 /home/recon/.ssh/authorized_keys

# Basic firewall — open SSH, HTTP, HTTPS
apt install -y ufw
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

From here on, log out and back in as `recon`:

```bash
exit
ssh recon@<your-server-ip>
```

---

## 3. Install the runtime stack

All on one apt-get session:

```bash
# Node 20 from NodeSource (Ubuntu's default is too old)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node -v   # should print v20.x.x
npm -v

# pnpm (faster + the lockfile is committed as pnpm-lock.yaml)
sudo npm install -g pnpm

# PM2 — keeps Node processes alive + auto-restarts on crash / reboot
sudo npm install -g pm2

# PostgreSQL 14 (ships with Ubuntu 22.04)
sudo apt install -y postgresql postgresql-contrib

# Nginx as our reverse proxy
sudo apt install -y nginx

# Build tools — Prisma sometimes needs them on a fresh box
sudo apt install -y build-essential git
```

---

## 4. Create the Postgres database

```bash
sudo -u postgres psql
```

In the `psql` prompt:

```sql
CREATE USER recon WITH PASSWORD 'replace-with-a-strong-password';
CREATE DATABASE recon OWNER recon;
\q
```

Quick sanity check that it works:

```bash
PGPASSWORD='replace-with-a-strong-password' psql -h 127.0.0.1 -U recon -d recon -c "SELECT version();"
```

You should see Postgres' version string. If it errors with
`peer authentication failed`, edit `/etc/postgresql/14/main/pg_hba.conf`
and change `local all all peer` to `local all all md5`, then
`sudo systemctl restart postgresql`.

---

## 5. Clone the repo

We'll deploy out of `/opt/recon` to match what `deploy/deploy.sh`
expects.

```bash
sudo mkdir -p /opt/recon /var/log/recon /opt/recon/backend/api/uploads
sudo chown -R recon:recon /opt/recon /var/log/recon

cd /opt
git clone https://github.com/yourorg/credit-recon-system.git recon
# OR if it's a private repo, use a deploy key — see GitHub docs.
```

---

## 6. Configure environment variables

### Backend (`/opt/recon/backend/api/.env`)

```bash
nano /opt/recon/backend/api/.env
```

Paste this, **replacing every placeholder**:

```dotenv
# Database (matches the user + password you created in step 4)
DATABASE_URL="postgresql://recon:replace-with-a-strong-password@127.0.0.1:5432/recon?schema=public"

# JWT secret — generate a long random string. The app refuses to start
# without this in production.
JWT_SECRET="paste-a-long-random-hex-string-here"
JWT_EXPIRES_IN="1d"

# Session inactivity window in minutes (added in task #56). Cookie
# resets on every authenticated request. 10 is the default.
SESSION_INACTIVITY_MINUTES=10

# Production flag — gates secure-cookie behaviour, throttling, etc.
NODE_ENV=production

# Port the backend listens on (Nginx proxies /api/ here)
PORT=3000

# Anthropic API for AI OCR (optional but strongly recommended)
ANTHROPIC_API_KEY="sk-ant-..."
# Fallback to Sonnet when confidence is below this:
AI_FALLBACK_THRESHOLD=0.65

# Mail — for password resets + notifications. Use any SMTP relay.
# AWS SES, SendGrid, Mailgun, or your own server all work.
MAIL_HOST="smtp.yourprovider.com"
MAIL_PORT=587
MAIL_USER="your-smtp-username"
MAIL_PASS="your-smtp-password"
MAIL_FROM="FFG Recon <noreply@yourdomain.co.za>"

# Public origin for absolute URLs in emails
PUBLIC_BASE_URL="https://recon.yourcompany.co.za"
```

Generate a JWT secret in one line:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### Frontend (`/opt/recon/frontend/.env.local`)

```bash
nano /opt/recon/frontend/.env.local
```

```dotenv
# In production the frontend makes API calls to the same origin, with
# Nginx routing /api/* to the backend. So we point NEXT_PUBLIC_API_URL
# at the public URL with /api on the end.
NEXT_PUBLIC_API_URL="https://recon.yourcompany.co.za/api"
```

Lock down the secret files:

```bash
chmod 600 /opt/recon/backend/api/.env /opt/recon/frontend/.env.local
```

---

## 7. Install + build the app

```bash
cd /opt/recon

# Backend
cd backend/api
pnpm install --frozen-lockfile
npx prisma generate
npx prisma migrate deploy   # applies all migrations to the empty DB
# (or `npx prisma db push` if you're in flux and migrations aren't versioned)
pnpm build

# Frontend
cd ../../frontend
pnpm install --frozen-lockfile
pnpm build
```

The first `pnpm install` will take 2–5 minutes. Subsequent runs are
much faster because pnpm hardlinks shared deps.

---

## 8. Create the first admin user

Until you have an admin you can't log in to create more users. There's
a helper script for exactly this:

```bash
cd /opt/recon/backend/api
node scripts/create-admin.ts   # interactive — asks for email + password
```

If that script isn't there, do it from `prisma studio` instead:

```bash
npx prisma studio
# → opens a web UI you can SSH-tunnel to, or use a one-off:
```

Or just `psql` it directly — the password is bcrypt-hashed, so:

```bash
HASH=$(node -e "console.log(require('bcrypt').hashSync('your-admin-password', 10))")
PGPASSWORD='your-db-password' psql -h 127.0.0.1 -U recon -d recon <<EOF
INSERT INTO "User" (id, name, email, password, role, active, "createdAt", "updatedAt")
VALUES (gen_random_uuid(), 'Admin', 'admin@yourcompany.co.za', '$HASH', 'ADMIN', true, NOW(), NOW());
EOF
```

---

## 9. Start the apps under PM2

```bash
cd /opt/recon
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup
```

`pm2 startup` prints a `sudo` command — copy and run it. That registers
PM2 to restart on system boot.

Verify both processes are running:

```bash
pm2 status
# Should show recon-api (port 3000) and recon-web (port 3001), both online.

# Tail the logs if something's not right
pm2 logs --lines 50
```

Quick local sanity check from the server itself:

```bash
curl -s http://127.0.0.1:3000/auth/me   # expect 401 (no cookie) — backend is up
curl -sI http://127.0.0.1:3001          # expect HTTP 200 — frontend is up
```

---

## 10. Configure Nginx

```bash
# Drop the site config into Nginx's sites-available
sudo cp /opt/recon/deploy/nginx-recon.conf /etc/nginx/sites-available/recon

# Edit it to use YOUR hostname
sudo nano /etc/nginx/sites-available/recon
# Change `server_name recon.yourdomain.co.za;` to your real hostname.

# Enable the site
sudo ln -s /etc/nginx/sites-available/recon /etc/nginx/sites-enabled/

# Disable the default "Welcome to Nginx" site so it doesn't shadow ours
sudo rm -f /etc/nginx/sites-enabled/default

# Test the config + reload
sudo nginx -t
sudo systemctl reload nginx
```

Now hit your domain in a browser over plain HTTP:

```
http://recon.yourcompany.co.za
```

You should see the login screen. **Don't try to log in yet** — the auth
cookie is set with `secure: true` in production, which means it won't be
sent back over plain HTTP. Get HTTPS working first.

---

## 11. Enable HTTPS via Let's Encrypt

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d recon.yourcompany.co.za
```

Certbot will:

1. Verify domain ownership over HTTP-01.
2. Rewrite `/etc/nginx/sites-available/recon` to add the SSL block.
3. Schedule auto-renewal via a systemd timer (`systemctl list-timers
   | grep certbot` to confirm).

Reload Nginx if certbot didn't already:

```bash
sudo systemctl reload nginx
```

Now visit `https://recon.yourcompany.co.za` — green padlock, log in,
you're live.

---

## 12. Smoke test

Run this checklist after first login:

- [ ] **Log in as admin** — should land on the Dashboard.
- [ ] **Sidebar logout button** — sticky to the bottom of the viewport.
- [ ] **Create a USER** under Admin → Users.
- [ ] **Upload a test invoice** as that USER.
- [ ] **Upload a test bank statement** (CSV or FNB-style PDF).
- [ ] **Reports → Recon tab → Generate XLSX** — downloads successfully.
- [ ] **Notifications bell** opens to the right of the bell, not over
      the logo.
- [ ] **PWA install** — on a phone, visit the URL and tap "Add to
      Home Screen" on the login page. On Android it should install
      one-tap; on iOS Safari it shows the instructions modal.
- [ ] **Inactivity** — leave the tab closed for 11 minutes, reopen.
      You should land on `/login`, not the last page you visited.

---

## 13. Optional: wire GitHub Actions for auto-deploy on push

The repo already has `.github/workflows/deploy.yml` set up. To activate
it:

1. On the server, generate an SSH key pair for the deploy user:

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/github-deploy -N ""
   cat ~/.ssh/github-deploy.pub >> ~/.ssh/authorized_keys
   cat ~/.ssh/github-deploy   # ← copy this private key
   ```

2. In GitHub → repo → Settings → Secrets and variables → Actions,
   add three secrets:

   - `DEPLOY_HOST` = `recon.yourcompany.co.za` (or the public IP)
   - `DEPLOY_USER` = `recon`
   - `DEPLOY_SSH_KEY` = paste the private key contents from step 1

3. Push to `main`. The action will SSH into the server and run
   `deploy/deploy.sh` which pulls latest, rebuilds, and reloads PM2.
   On failure it rolls back to the previous commit automatically.

---

## Troubleshooting

**Login works in dev but fails over HTTPS in production.**
Cookie is `secure: true` and needs HTTPS. Verify you're hitting the
`https://` URL, not `http://`. Check the Network tab — the
`Set-Cookie` response from `/auth/login` should be present.

**"502 Bad Gateway" from Nginx.**
PM2 process isn't running or is on the wrong port. Check
`pm2 status` and `pm2 logs`. Verify ports 3000 (api) and 3001 (web)
are listening: `ss -tlnp | grep -E '3000|3001'`.

**OCR uploads return "AI extraction failed".**
Check `ANTHROPIC_API_KEY` in the backend `.env`, and verify the server
can reach `api.anthropic.com`: `curl -I https://api.anthropic.com`.
The Tesseract fallback should still produce a result, just lower
quality — if even that fails, check disk space (`df -h`) and
`/opt/recon/backend/api/uploads` directory permissions.

**Can't reach the site from the public internet.**
1. `sudo ufw status` — make sure ports 80 and 443 are allowed.
2. Check the HyperVM panel for a host-level firewall blocking those
   ports — common on OpenVZ VPSes.
3. `curl -v http://localhost` from the server should return the login
   page. If yes, the issue is networking/firewall, not the app.

**Out of memory / process restart loops.**
`pm2 status` shows `restarts` climbing. The `max_memory_restart: 512M`
limit in `ecosystem.config.js` is conservative — if your VPS has more
RAM available, bump it. Run `free -h` to see what's actually free.

**Prisma migrations fail.**
If `migrate deploy` complains about a non-empty database, you're in
the mid-development state where schema changes use `db push`. Run
`npx prisma db push --accept-data-loss=false` instead. Once you're
stable, generate proper migrations with
`npx prisma migrate dev --name your-change-name` locally and commit
the migration files.

**Postgres "too many connections".**
Default max_connections is 100. The Prisma client pools connections —
default pool size is 10 per process. With 2 PM2 processes that's 20
connections, well under the limit. If you scale up PM2 instances, also
bump `max_connections` in `postgresql.conf` proportionally.

---

## Updating later

Two ways to push new code:

1. **GitHub Actions** (if you wired step 13) — push to `main`, the
   action runs `deploy.sh`, you watch the logs in the Actions tab.

2. **Manual** — SSH in and run:

   ```bash
   cd /opt/recon
   bash deploy/deploy.sh
   ```

   The script pulls latest, rebuilds backend + frontend, runs any
   pending Prisma migrations, and gracefully reloads PM2. If the
   reload fails it rolls back to the previous commit automatically.
