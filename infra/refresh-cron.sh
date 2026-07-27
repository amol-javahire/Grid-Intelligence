#!/usr/bin/env bash
# ============================================================================
# refresh-cron.sh — scheduled data refreshes for Grid Intelligence.
#
# Runs entirely on the VM via crontab. No Claude/API credits are consumed —
# these are plain Python/Node scripts hitting public regulator endpoints.
#
# Install (once):
#   chmod +x ~/grid-intelligence/infra/refresh-cron.sh
#   crontab -e     # then add the schedule block at the bottom of this file
#
# Manual run:
#   ~/grid-intelligence/infra/refresh-cron.sh regulatory
#   ~/grid-intelligence/infra/refresh-cron.sh queue
#   ~/grid-intelligence/infra/refresh-cron.sh prices
# ============================================================================
set -uo pipefail          # NOT -e: one failing job must not abort the rest

APP_DIR="/home/azureuser/grid-intelligence"
VENV="$APP_DIR/artifacts/pypsa-engine/.venv/bin/python3"
LOG_DIR="/var/log/grid-intelligence"
JOB="${1:-all}"

mkdir -p "$LOG_DIR" 2>/dev/null || LOG_DIR="/tmp"

# Load secrets (DATABASE_URL, ERCOT_*, EIA_API_KEY …)
set -a
# shellcheck source=/dev/null
[ -f "$APP_DIR/.env" ] && source "$APP_DIR/.env"
set +a

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*"; }

run_step() {
  local name="$1"; shift
  log "── START $name"
  local t0=$SECONDS
  if "$@"; then
    log "── OK    $name  ($((SECONDS-t0))s)"
  else
    log "── FAIL  $name  (exit $?) — continuing"
  fi
}

# ── Regulatory & tax items (ERCOT / CAISO / PUCT / FERC) ────────────────────
job_regulatory() {
  cd "$APP_DIR" || return 1
  run_step "regulatory scrape" "$VENV" scripts/src/scrape-regulatory.py
}

# ── Interconnection queues (ERCOT GIS + CAISO) ──────────────────────────────
job_queue() {
  cd "$APP_DIR" || return 1
  run_step "ERCOT queue" "$VENV" scripts/src/seed-ercot-queue-real.py
  # CAISO queue is the TS seeder
  if [ -d "$APP_DIR/scripts" ]; then
    run_step "CAISO queue" pnpm --dir "$APP_DIR/scripts" run seed-queue-real
  fi
}

# ── Daily price top-up (ERCOT nodal + CAISO nodal, incremental) ─────────────
# Both seeders skip already-seeded dates, so a daily run only fetches new days.
job_prices() {
  cd "$APP_DIR" || return 1
  run_step "ERCOT nodal prices" "$VENV" infra/seed-nodal-prices.py both
  if [ -f "$APP_DIR/infra/seed-caiso-nodal.py" ]; then
    run_step "CAISO nodal prices" "$VENV" infra/seed-caiso-nodal.py both
  fi
}

# ── ERCOT SCED dispatch (60-day disclosure window) ──────────────────────────
job_sced() {
  cd "$APP_DIR" || return 1
  run_step "ERCOT SCED gap-fill" "$VENV" infra/seed-sced-gap.py
}

# ── Rebuild derived layers after any price/dispatch change ──────────────────
job_derive() {
  cd "$APP_DIR" || return 1
  run_step "regen ercot_node_stats" psql "$DATABASE_URL" -f infra/regen-ercot-node-stats.sql
  run_step "fill ercot_hub_hourly"  psql "$DATABASE_URL" -f infra/fill-ercot-hub-hourly.sql
  run_step "refresh mv_dispatch_monthly" psql "$DATABASE_URL" -c "REFRESH MATERIALIZED VIEW mv_dispatch_monthly;"
  run_step "refresh mv_capture_monthly"  psql "$DATABASE_URL" -c "REFRESH MATERIALIZED VIEW mv_capture_monthly;"
}

case "$JOB" in
  regulatory) job_regulatory ;;
  queue)      job_queue ;;
  prices)     job_prices ;;
  sced)       job_sced ;;
  derive)     job_derive ;;
  all)        job_prices; job_sced; job_derive; job_queue; job_regulatory ;;
  *)          echo "usage: $0 {regulatory|queue|prices|sced|derive|all}"; exit 2 ;;
esac

log "refresh-cron.sh '$JOB' complete"

# ============================================================================
# CRONTAB BLOCK — paste into `crontab -e`
# ----------------------------------------------------------------------------
# Times are VM local (UTC unless changed). Staggered so jobs never overlap and
# never collide with each other on the database.
#
# # Grid Intelligence scheduled refreshes
# 15 9  * * *  /home/azureuser/grid-intelligence/infra/refresh-cron.sh prices     >> /var/log/grid-intelligence/cron-prices.log 2>&1
# 45 10 * * *  /home/azureuser/grid-intelligence/infra/refresh-cron.sh sced       >> /var/log/grid-intelligence/cron-sced.log 2>&1
# 30 12 * * *  /home/azureuser/grid-intelligence/infra/refresh-cron.sh derive     >> /var/log/grid-intelligence/cron-derive.log 2>&1
# 0  6  * * 1  /home/azureuser/grid-intelligence/infra/refresh-cron.sh queue      >> /var/log/grid-intelligence/cron-queue.log 2>&1
# 30 6  * * 1  /home/azureuser/grid-intelligence/infra/refresh-cron.sh regulatory >> /var/log/grid-intelligence/cron-regulatory.log 2>&1
#
# Rationale:
#   prices  daily  — ERCOT/CAISO publish continuously; incremental and cheap
#   sced    daily  — 60-day disclosure window advances one day at a time
#   derive  daily  — must run AFTER prices+sced or the rollups go stale
#   queue   weekly — ERCOT GIS and CAISO queues update roughly monthly
#   regulatory weekly — rule filings are low-velocity; daily adds noise
# ============================================================================
