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

# ── AESO AUC / MSA — clear the 7-day disk cache and immediately re-warm it ──
# (artifacts/api-server/src/routes/auc_msa.ts). Without this, the cache only
# refreshes lazily on whatever request happens to land after it goes stale —
# this makes the refresh actually happen on a schedule instead of "eventually,
# maybe." No AESO auth required; both are plain public curl targets. Assumes
# api-server is listening on localhost:8080 (see infra/nginx-grid.conf).
job_aeso_content() {
  run_step "clear AUC/MSA cache" curl -sf -X POST http://localhost:8080/api/aeso/scrape/refresh -o /dev/null
  run_step "warm AUC feed"       curl -sf http://localhost:8080/api/aeso/auc/feed -o /dev/null
  run_step "warm MSA documents"  curl -sf http://localhost:8080/api/aeso/msa/documents -o /dev/null
  run_step "warm MSA recent"     curl -sf http://localhost:8080/api/aeso/msa/recent -o /dev/null
}

# ── AESO LTA report list — flag (don't silently apply) new quarterly reports ─
# LTA_REPORTS in artifacts/api-server/src/routes/aeso_stats.ts is a hardcoded
# URL list; AESO posts a new quarterly PDF ~4x/year at a predictable filename
# pattern. This job does NOT edit source or rebuild anything — it just checks
# whether AESO's LTA download page references a PDF URL not already in that
# array, and logs a loud, greppable line if so, so a human adds the one line.
# job_aeso_content and this job are the only two AESO-scoped refreshes that
# exist: REM is 100% hand-written static content in rem.tsx with no live
# source at all, so there is nothing for a cron job to refresh there — if
# AESO's REM design changes, that page needs a manual content edit, not a
# scheduled job.
job_aeso_lta_check() {
  cd "$APP_DIR" || return 1
  run_step "check for new AESO LTA report" "$VENV" infra/check-aeso-lta-new.py
}

case "$JOB" in
  regulatory)  job_regulatory ;;
  queue)       job_queue ;;
  prices)      job_prices ;;
  sced)        job_sced ;;
  derive)      job_derive ;;
  aeso-content) job_aeso_content ;;
  aeso-lta)    job_aeso_lta_check ;;
  all)         job_prices; job_sced; job_derive; job_queue; job_regulatory; job_aeso_content; job_aeso_lta_check ;;
  *)           echo "usage: $0 {regulatory|queue|prices|sced|derive|aeso-content|aeso-lta|all}"; exit 2 ;;
esac

log "refresh-cron.sh '$JOB' complete"

# ============================================================================
# CRONTAB BLOCK — paste into `crontab -e`
# ----------------------------------------------------------------------------
# Times are VM local (UTC unless changed). Staggered so jobs never overlap and
# never collide with each other on the database.
#
# # Grid Intelligence scheduled refreshes
# 15 9  * * *  /home/azureuser/grid-intelligence/infra/refresh-cron.sh prices       >> /var/log/grid-intelligence/cron-prices.log 2>&1
# 45 10 * * *  /home/azureuser/grid-intelligence/infra/refresh-cron.sh sced         >> /var/log/grid-intelligence/cron-sced.log 2>&1
# 30 12 * * *  /home/azureuser/grid-intelligence/infra/refresh-cron.sh derive       >> /var/log/grid-intelligence/cron-derive.log 2>&1
# 0  6  * * 1  /home/azureuser/grid-intelligence/infra/refresh-cron.sh queue        >> /var/log/grid-intelligence/cron-queue.log 2>&1
# 30 6  * * 1  /home/azureuser/grid-intelligence/infra/refresh-cron.sh regulatory   >> /var/log/grid-intelligence/cron-regulatory.log 2>&1
# 0  7  * * 1  /home/azureuser/grid-intelligence/infra/refresh-cron.sh aeso-content >> /var/log/grid-intelligence/cron-aeso-content.log 2>&1
# 15 7  * * 1  /home/azureuser/grid-intelligence/infra/refresh-cron.sh aeso-lta     >> /var/log/grid-intelligence/cron-aeso-lta.log 2>&1
#
# Rationale:
#   prices  daily  — ERCOT/CAISO publish continuously; incremental and cheap
#   sced    daily  — 60-day disclosure window advances one day at a time
#   derive  daily  — must run AFTER prices+sced or the rollups go stale
#   queue   weekly — ERCOT GIS and CAISO queues update roughly monthly
#   regulatory weekly — rule filings are low-velocity; daily adds noise
#   aeso-content weekly — matches the AUC/MSA cache's own 7-day freshness window
#   aeso-lta     weekly — AESO posts a new LTA report ~4x/year; weekly just
#                         catches it promptly, doesn't need to be more frequent
#
# Cost: $0 beyond the VM you're already running. Every job here is a plain
# curl/psql/python call against an already-provisioned Azure VM and Postgres
# instance — none of them call the Claude API or any paid service.
# ============================================================================
