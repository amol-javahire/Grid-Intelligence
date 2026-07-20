#!/usr/bin/env bash
##############################################################################
# Grid Intelligence Platform — Azure VM Bootstrap
#
# VM:      Ubuntu 22.04 LTS, B2pts v2 (2 vCPU, 4 GB RAM) — Azure free 12 months
# DB:      Azure Database for PostgreSQL Flexible Server (external, managed)
# Run as:  bash infra/azure-setup.sh
# Run from: /home/azureuser/grid-intelligence  (after git clone)
#
# BEFORE running this script:
#   1. Create Azure PostgreSQL Flexible Server in portal:
#        - Server name:    grid-intelligence-db  (or your choice)
#        - Compute:        Burstable B1MS (1 vCPU, 2 GB RAM) — free 12 months
#        - Storage:        32 GB
#        - Admin user:     gridadmin
#        - DB name:        grid_origination
#   2. Enable TimescaleDB:
#        Portal → PostgreSQL server → Server Parameters
#        → shared_preload_libraries = timescaledb → Save → Restart server
#   3. Set firewall rule on Azure PostgreSQL:
#        Portal → PostgreSQL server → Networking
#        → Add firewall rule: allow the VM's public IP (or "Allow Azure services")
#   4. Set NSG rules on the VM:
#        Portal → VM → Networking → Add inbound rule
#        → Port 80 (HTTP), 443 (HTTPS) — SSH (22) is already open
#   5. Copy .env to /home/azureuser/grid-intelligence/.env
#        (see infra/.env.example — use Azure PostgreSQL connection string)
#   6. cd /home/azureuser/grid-intelligence && bash infra/azure-setup.sh
##############################################################################

set -euo pipefail

APP_USER=azureuser
APP_DIR=/home/${APP_USER}/grid-intelligence
LOG_DIR=/var/log/grid-intelligence
NGINX_WEB_ROOT=/var/www/grid-platform
NODE_VERSION=24

log()  { echo -e "\n\033[1;36m[$(date '+%H:%M:%S')] $*\033[0m"; }
ok()   { echo -e "\033[1;32m  ✓ $*\033[0m"; }
err()  { echo -e "\033[1;31m[ERROR] $*\033[0m" >&2; exit 1; }

# ── Preflight checks ──────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && err "Run as root: sudo bash infra/azure-setup.sh"
[[ ! -f "$APP_DIR/.env" ]] && err ".env not found at $APP_DIR/.env — copy infra/.env.example and fill in values first."

log "=== Grid Intelligence — Azure VM Bootstrap ==="
echo "  App dir  : $APP_DIR"
echo "  VM user  : $APP_USER"
echo "  Node ver : $NODE_VERSION"
echo ""

# ── Step 0: System update + essential packages ───────────────────────────────
log "[0] System update and essential packages..."
apt-get update -qq
apt-get install -y -qq \
  curl wget git build-essential \
  nginx certbot python3-certbot-nginx \
  python3 python3-pip python3-venv \
  postgresql-client \
  ufw \
  jq unzip
ok "System packages installed."

# ── Step 1: 2 GB swap (VM has 1 GiB RAM — swap needed for PyPSA OPF spikes) ──
log "[1] Creating 2 GB swap file..."
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "Swap created (1 GB)."
else
  ok "Swap already exists — skipped."
fi

# ── Step 2: Firewall (ufw — Azure NSG handles external, ufw on VM as backstop) ─
log "[2] Configuring ufw firewall..."
ufw --force enable
ufw allow ssh
ufw allow http
ufw allow https
ok "ufw: SSH, HTTP, HTTPS allowed."

# ── Step 3: Node.js $NODE_VERSION via NodeSource ─────────────────────────────
log "[3] Installing Node.js $NODE_VERSION..."
if ! command -v node &>/dev/null || [[ "$(node -e 'process.stdout.write(process.version.split(\".\")[0].replace(\"v\",\"\"))')" != "$NODE_VERSION" ]]; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y -qq nodejs
fi
node --version
ok "Node.js $(node --version) ready."

# ── Step 4: pnpm + PM2 ───────────────────────────────────────────────────────
log "[4] Installing pnpm and PM2..."
npm install -g pnpm pm2 --silent
ok "pnpm $(pnpm --version) | PM2 $(pm2 --version)"

# ── Step 5: Python venv for PyPSA engine ─────────────────────────────────────
log "[5] Setting up Python virtual environment for PyPSA..."
PYPSA_DIR="$APP_DIR/artifacts/pypsa-engine"
if [ -d "$PYPSA_DIR" ]; then
  if [ ! -d "$PYPSA_DIR/.venv" ]; then
    python3 -m venv "$PYPSA_DIR/.venv"
  fi
  "$PYPSA_DIR/.venv/bin/pip" install --quiet --upgrade pip
  if [ -f "$PYPSA_DIR/requirements.txt" ]; then
    "$PYPSA_DIR/.venv/bin/pip" install --quiet -r "$PYPSA_DIR/requirements.txt"
    ok "PyPSA dependencies installed from requirements.txt."
  else
    "$PYPSA_DIR/.venv/bin/pip" install --quiet pypsa highspy uvicorn fastapi
    ok "PyPSA core packages installed (no requirements.txt found)."
  fi
else
  ok "pypsa-engine directory not found yet — run after full repo is cloned."
fi

# ── Step 6: pnpm install ─────────────────────────────────────────────────────
log "[6] Installing Node dependencies..."
cd "$APP_DIR"
pnpm install --frozen-lockfile
ok "pnpm install complete."

# ── Step 7: Build ─────────────────────────────────────────────────────────────
log "[7] Building frontend and API..."
pnpm run build
ok "Build complete."

# ── Step 8: nginx setup ───────────────────────────────────────────────────────
log "[8] Configuring nginx..."
mkdir -p "$NGINX_WEB_ROOT"
cp -r "$APP_DIR/artifacts/grid-platform/dist/." "$NGINX_WEB_ROOT/"
chown -R www-data:www-data "$NGINX_WEB_ROOT"

# Install nginx config
cp "$APP_DIR/infra/nginx.conf" /etc/nginx/sites-available/grid-intelligence
ln -sf /etc/nginx/sites-available/grid-intelligence /etc/nginx/sites-enabled/grid-intelligence
rm -f /etc/nginx/sites-enabled/default   # remove default placeholder

nginx -t
systemctl reload nginx
ok "nginx configured and reloaded."

# ── Step 9: Log directory ─────────────────────────────────────────────────────
log "[9] Creating log directory..."
mkdir -p "$LOG_DIR"
chown -R "$APP_USER:$APP_USER" "$LOG_DIR"
ok "Log dir: $LOG_DIR"

# ── Step 10: PM2 start + systemd ─────────────────────────────────────────────
log "[10] Starting app with PM2 and enabling systemd startup..."
cd "$APP_DIR"

# Start or reload
if pm2 list | grep -q 'api-server'; then
  pm2 reload infra/ecosystem.config.js --update-env
else
  sudo -u "$APP_USER" pm2 start infra/ecosystem.config.js
fi

pm2 save

# Enable PM2 to start on boot
env PATH=$PATH:/usr/bin pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" | tail -1 | bash
ok "PM2 running and enabled on boot."

# ── Step 11: TimescaleDB extension ───────────────────────────────────────────
log "[11] Enabling TimescaleDB extension on Azure PostgreSQL..."

# Load DATABASE_URL from .env
set -a; source "$APP_DIR/.env"; set +a
[[ -z "${DATABASE_URL:-}" ]] && err "DATABASE_URL not set in .env"

if psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;" 2>/dev/null; then
  ok "TimescaleDB extension enabled."
else
  echo ""
  echo "  ⚠  Could not enable TimescaleDB automatically."
  echo "     Most likely cause: shared_preload_libraries not yet set in Azure portal."
  echo ""
  echo "     Fix in Azure Portal:"
  echo "       1. Go to PostgreSQL Flexible Server → Server Parameters"
  echo "       2. Set shared_preload_libraries = timescaledb"
  echo "       3. Click Save → Restart the server"
  echo "       4. Then run manually:"
  echo "          psql \"\$DATABASE_URL\" -c 'CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;'"
  echo ""
fi

# ── Done ──────────────────────────────────────────────────────────────────────
log "=== Bootstrap complete ==="
echo ""
echo "  Next steps:"
echo "  1. HTTPS:  sudo certbot --nginx -d gridintel.ca -d www.gridintel.ca"
echo "  2. DNS:    Add A record in GoDaddy → VM public IP"
echo "  3. Seed:   bash infra/seed-on-azure.sh"
echo "  4. Check:  pm2 status | pm2 logs api-server"
echo ""
pm2 status
