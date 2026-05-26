// PM2 process declarations. PM2 runs both the NestJS backend and the
// Next.js frontend as long-lived processes, restarts them if they crash,
// and supports zero-downtime reload (`pm2 reload all`) during deploys.
//
// Usage on the server:
//   pm2 start deploy/ecosystem.config.js
//   pm2 save                 # remember which apps are running
//   pm2 startup              # auto-start on system boot
//
// On every deploy the GitHub Action calls:
//   pm2 reload ecosystem.config.js --update-env
// which gracefully restarts both apps with the new code.

module.exports = {
  apps: [
    {
      name: 'recon-api',
      cwd: './backend/api',
      script: 'dist/main.js',     // built by `nest build`
      instances: 1,               // bump if you scale to multi-core
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      out_file: '/var/log/recon/api-out.log',
      error_file: '/var/log/recon/api-err.log',
      time: true,                 // timestamp log lines
    },
    {
      name: 'recon-web',
      cwd: './frontend',
      script: 'node_modules/next/dist/bin/next',
      args: 'start --port 3001',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        // Next.js reads NEXT_PUBLIC_* from .env.local + .env.production.
        // We don't put secrets here.
      },
      out_file: '/var/log/recon/web-out.log',
      error_file: '/var/log/recon/web-err.log',
      time: true,
    },
  ],
};
