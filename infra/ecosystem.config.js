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
      script:      `${APP_DIR}/infra/start-api.sh`,
      cwd:         APP_DIR,
      interpreter: 'bash',
      interpreter_args: '',

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

      // PyPSA spikes well past 600M on multi-period solves (battery = 24 hourly
      // periods, expansion = 4 planning horizons) — the old 600M ceiling killed
      // the process mid-request and the UI lost its backend. VM has 8 GB and
      // idles ~17%, so 3 GB is safe headroom while still catching a real leak.
      max_memory_restart: '3000M',

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
