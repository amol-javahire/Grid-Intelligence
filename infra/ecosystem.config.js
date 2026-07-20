// PM2 process config — Grid Intelligence Platform
// Start:   pm2 start infra/ecosystem.config.js
// Reload:  pm2 reload all
// Logs:    pm2 logs [api-server|pypsa-engine]

const APP_DIR = '/home/azureuser/grid-intelligence';

module.exports = {
  apps: [
    // ── Node API server (Express 5, port 8080) ──────────────────────────────
    {
      name:        'api-server',
      script:      `${APP_DIR}/artifacts/api-server/dist/index.mjs`,
      cwd:         APP_DIR,
      interpreter: 'node',
      interpreter_args: '--enable-source-maps --require dotenv/config',

      instances:   1,
      autorestart: true,
      watch:       false,

      // ~300MB headroom; restart before OOM kills it
      max_memory_restart: '350M',

      env: {
        NODE_ENV:           'production',
        PORT:               '8080',
        DOTENV_CONFIG_PATH: `${APP_DIR}/.env`,
      },

      error_file: '/var/log/grid-intelligence/api-error.log',
      out_file:   '/var/log/grid-intelligence/api-out.log',
      time:       true,   // prefix log lines with timestamp
    },

    // ── PyPSA FastAPI (Uvicorn, port 8083) ──────────────────────────────────
    // Long-running process — NOT Lambda-compatible.
    // Cold start is acceptable for OPF (rarely used in prod).
    // 4 GB Azure VM RAM handles memory spikes during OPF solve.
    {
      name: 'pypsa-engine',
      script: `${APP_DIR}/artifacts/pypsa-engine/.venv/bin/uvicorn`,
      args:   'main:app --host 127.0.0.1 --port 8083 --workers 1',
      cwd:    `${APP_DIR}/artifacts/pypsa-engine`,

      interpreter: 'none',

      instances:   1,
      autorestart: true,
      watch:       false,

      // PyPSA can spike to ~600MB during OPF; 4 GB RAM gives headroom but still restart before OOM
      max_memory_restart: '600M',

      env: {
        // FastAPI/Uvicorn don't read .env automatically; pass vars explicitly.
        // DATABASE_URL is not needed at runtime for PyPSA (it gets data from
        // the Node API call), but add it here if pypsa-engine queries RDS directly.
      },

      error_file: '/var/log/grid-intelligence/pypsa-error.log',
      out_file:   '/var/log/grid-intelligence/pypsa-out.log',
      time:       true,
    },
  ],
};
