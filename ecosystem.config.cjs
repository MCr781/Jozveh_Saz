/**
 * PM2 production process configuration for Jozveh Saz (جزوه‌ساز).
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup
 *
 * The application uses a single file-based JSON database, so it MUST run as a
 * single fork instance (no cluster mode) to keep writes consistent.
 */
module.exports = {
  apps: [
    {
      name: 'jozveh-saz',
      script: './server/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      restart_delay: 3000,
      max_memory_restart: '300M',
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      }
    }
  ]
};
