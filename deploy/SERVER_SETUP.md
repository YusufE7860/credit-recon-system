# FFG Recon — Server Bootstrap Guide

One-time setup for a fresh Ubuntu 22.04 LTS VM. After this completes,
every push to `main` on GitHub auto-deploys.

---

## 0. Provision the VM

- Ubuntu 22.04 LTS (Server, no GUI).
- Minimum: 2 vCPU, 4 GB RAM, 40 GB disk.
- Static IP on your network. Forward ports 80 and 443 from your router
  to this VM if you want public access.
- Hostname suggestion: `recon-prod`.

---

## 1. Initial server hardening

SSH in as the user your provisioning gave you (often `ubuntu` or `root`).

```bash
# Create a deploy user (used by GitHub Actions). NOT root.
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG sudo deploy

# Allow deploy user to sudo without a password (only for `pm2`)
# — needed because the GitHub Action can't type a sudo password.
echo "deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl, /usr/sbin/nginx" \
  | sudo tee /etc/sudoers.d/deploy
sudo chmod 440 /etc/sudoers.d/deploy

# Firewall: only allow SSH + HTTP/S inbound.
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable

# Optional but recommended:
sudo apt update && sudo apt upgrade -y
sudo apt install -y fail2ban  # blocks SSH brute force
```

---

## 2. Install runtimes

```bash
# Node.js 20 (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# pnpm (matching what we use in dev)
sudo npm install -g pnpm@9 pm2

# Postgres 16
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql

# Nginx
sudo apt install -y nginx
sudo systemctl enable --now nginx

# Build tools for native deps (bcrypt etc.)
sudo apt install -y build-essential python3 git
```

---

## 3. Create the database

```bash
sudo -u postgres psql <<'SQL'
CREATE USER recon_admin WITH PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
CREATE DATABASE credit_recon OWNER recon_admin;
GRANT ALL PRIVILEGES ON DATABASE credit_recon TO recon_admin;
SQL
```

Update `pg_hba.conf` if you want network access (only do this if you
need to connect from outside the VM):

```bash
sudo nano /etc/postgresql/16/main/pg_hba.conf
# Add a line for your management host, then:
sudo systemctl restart postgresql
```

---

## 4. Clone the repo

We deploy as the `deploy` user so the GitHub Action's SSH key matches.

```bash
sudo mkdir -p /opt/recon
sudo chown -R deploy:deploy /opt/recon
sudo -iu deploy

# Generate a deploy key to read from the GitHub repo.
ssh-keygen -t ed25519 -C "recon-deploy@hq" -f ~/.ssh/github_deploy -N ""
cat ~/.ssh/github_deploy.pub
# ↑ copy this output → add as a Deploy Key in GitHub repo settings
#   (Settings → Deploy keys → Add deploy key, read-only)

# Configure SSH to use this key for github.com.
cat >> ~/.ssh/config <<'SSH'
Host github.com
  IdentityFile ~/.ssh/github_deploy
  StrictHostKeyChecking accept-new
SSH

cd /opt/recon
git clone git@github.com:YOUR_ORG/YOUR_REPO.git .
```

---

## 5. Place .env files

The deploy script does NOT manage secrets. Create them once by hand.

```bash
# Backend
nano /opt/recon/backend/api/.env
# Paste your production values:
#   DATABASE_URL=postgresql://recon_admin:STRONG@localhost:5432/credit_recon
#   JWT_SECRET=<openssl rand -hex 32>
#   JWT_EXPIRES_IN=1d
#   FRONTEND_URL=https://recon.yourdomain.co.za
#   SMTP_* settings
#   FX_*_ZAR rates

# Frontend
nano /opt/recon/frontend/.env.local
# Paste:
#   JWT_SECRET=<same as backend>
#   NEXT_PUBLIC_API_URL=https://recon.yourdomain.co.za/api
```

---

## 6. First build + start

```bash
cd /opt/recon
sudo mkdir -p /var/log/recon && sudo chown -R deploy:deploy /var/log/recon

cd /opt/recon/backend/api
pnpm install
npx prisma generate
npx prisma db push
pnpm build

cd /opt/recon/frontend
pnpm install
pnpm build

cd /opt/recon
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup systemd -u deploy --hp /home/deploy
# ↑ run the command pm2 prints (it sets up systemd auto-start)
```

Check that both processes are running:

```bash
pm2 list
pm2 logs recon-api
pm2 logs recon-web
```

---

## 7. Nginx + DNS

```bash
sudo cp /opt/recon/deploy/nginx-recon.conf /etc/nginx/sites-available/recon
sudo nano /etc/nginx/sites-available/recon
# ↑ change `server_name` to your actual hostname

sudo ln -s /etc/nginx/sites-available/recon /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Visit `http://your-server-ip` — you should see the login page.

---

## 8. SSL via Let's Encrypt

Only after step 7 works.

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d recon.yourdomain.co.za
# Follow the prompts. Certbot rewrites the nginx config to add SSL.
# Auto-renewal is set up by certbot automatically.
```

---

## 9. Set up GitHub Action secrets

In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**.

Add:

| Secret name      | Value                                                   |
|------------------|---------------------------------------------------------|
| `DEPLOY_HOST`    | Public IP or hostname of your VM                        |
| `DEPLOY_USER`    | `deploy`                                                |
| `DEPLOY_PORT`    | `22` (or whatever SSH port you use)                     |
| `DEPLOY_SSH_KEY` | Contents of an SSH **private** key that has access to the `deploy` user |

To generate the action's SSH key pair:

```bash
# Run locally on your laptop or in a sandbox.
ssh-keygen -t ed25519 -f ~/.ssh/recon_deploy -N "" -C "github-actions"
cat ~/.ssh/recon_deploy.pub   # paste into the deploy user's authorized_keys
cat ~/.ssh/recon_deploy       # paste full content (incl BEGIN/END) into DEPLOY_SSH_KEY
```

On the server:

```bash
sudo -iu deploy
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "ssh-ed25519 AAAA... github-actions" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

---

## 10. Test the auto-deploy

Push a small change to `main` (e.g. a comment in a README). Watch the
**Actions** tab in GitHub — you should see "Deploy to production" run,
SSH into the server, and report success in ~1-2 minutes.

If it fails, the deploy.sh rollback fires automatically — the server
keeps running the previous code.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `pm2 reload` fails | New code has a build error | Check `pm2 logs`; deploy.sh auto-rolls back |
| 502 Bad Gateway from Nginx | Backend or frontend not running | `pm2 list` → restart with `pm2 restart all` |
| `prisma db push` complains | Migration would lose data | Edit schema to be additive, or run a manual data migration first |
| Action says "Permission denied (publickey)" | SSH key not authorized | Check the public key is in `deploy`'s `~/.ssh/authorized_keys` |
| Action says "Host key verification failed" | First connection to server | Action's `ssh-action` accepts new host keys by default; if you locked it down, add the server's host key to known hosts |

---

## What's NOT automated

- DB backups (set up `pg_dump` to cron + offsite copy)
- Log rotation (PM2 has `pm2 install pm2-logrotate`)
- Monitoring (consider Uptime Kuma, self-hosted)
- Secret rotation (rotate JWT_SECRET periodically; revokes all sessions)
