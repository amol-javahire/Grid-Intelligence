#!/usr/bin/env bash
##############################################################################
# Grid Intelligence Platform — Database Seeding Script (Azure PostgreSQL)
#
# Run ONCE after azure-setup.sh has completed and the app is running.
# Run from: /home/azureuser/grid-intelligence  (APP_DIR)
# Usage:    bash infra/seed-on-azure.sh [--skip-sced] [--year 2025]
#
# Seeding order (dependencies matter):
#   0. Schema push (drizzle-kit push)
#   1. Generators / EIA 860 base data       (seed-generators.sql)
#   2. Interconnection queue data            (seed-ercot-queue-real.ts + CAISO/PJM)
#   3. Regulatory / market rules             (seed-regulatory.py)
#   4. Load forecast base data               (compute-load-forecast.py)
#   5. Data centre pipeline                  (seed-datacenters.py)
#   6. Temperature normals                   (seed-temperatures.py)
#   7. Gas forward prices                    (seed-gas-forwards.ts)
#   8. ERCOT nodal DA/RT prices              (existing price seeders)
#   9. SCED generator-level dispatch         (seed-ercot-dispatch.py)  ← heaviest, last
#
# SCED strategy: 2025 + 2026-to-date first, backfill 2024 separately.
# Each day is ~17k rows; gap-fill log (ercot_dispatch_seed_log) makes reruns safe.
# TimescaleDB columnar compression reduces 50M rows to ~1 GB on disk.
#
# Options:
#   --skip-sced    Skip the SCED seeder (run everything else)
#   --year YYYY    Limit SCED seeder to a specific year (2024, 2025, or 2026)
#   --sced-only    Run only the SCED seeder
##############################################################################

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS_DIR="$APP_DIR/scripts/src"
PYPSA_VENV="$APP_DIR/artifacts/pypsa-engine/.venv/bin/python"

SKIP_SCED=false
SCED_ONLY=false
SCED_YEAR=""

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-sced) SKIP_SCED=true; shift ;;
    --sced-only) SCED_ONLY=true; shift ;;
    --year) SCED_YEAR="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

log()  { echo -e "\n\033[1;36m[$(date '+%H:%M:%S')] $*\033[0m"; }
ok()   { echo -e "\033[1;32m  ✓ $*\033[0m"; }
warn() { echo -e "\033[1;33m  ⚠ $*\033[0m"; }
err()  { echo -e "\033[1;31m[ERROR] $*\033[0m" >&2; exit 1; }

# Load env
if [ ! -f "$APP_DIR/.env" ]; then
  err ".env not found at $APP_DIR/.env — copy infra/.env.example and fill in values."
fi
set -a; source "$APP_DIR/.env"; set +a

# Verify DATABASE_URL is set
[[ -z "${DATABASE_URL:-}" ]] && err "DATABASE_URL is not set in .env"

# Azure PostgreSQL requires SSL — verify ?sslmode=require is in the connection string
if [[ "$DATABASE_URL" != *"sslmode"* ]]; then
  warn "DATABASE_URL does not include ?sslmode=require — Azure PostgreSQL requires SSL."
  warn "Add ?sslmode=require to your DATABASE_URL in .env and rerun."
  exit 1
fi

log "=== Grid Intelligence — Database Seeding (Azure PostgreSQL) ==="
echo "  App dir     : $APP_DIR"
echo "  Database    : ${DATABASE_URL//:*@/://<password>@}"   # mask password in log
echo "  Skip SCED   : $SKIP_SCED"
echo "  SCED year   : ${SCED_YEAR:-all}"
echo ""

cd "$APP_DIR"

if ! $SCED_ONLY; then

  # ── Step 0: Schema push ─────────────────────────────────────────────────────
  log "[0] Pushing database schema (drizzle-kit push)..."
  pnpm --filter @workspace/api-server exec drizzle-kit push
  ok "Schema up to date."

  # ── Step 1: Generator base data (EIA 860) ────────────────────────────────────
  log "[1] Seeding generator/plant data (EIA 860 SQL)..."
  if [ -f "$SCRIPTS_DIR/seed-generators.sql" ]; then
    psql "$DATABASE_URL" -f "$SCRIPTS_DIR/seed-generators.sql"
    ok "Generators seeded."
  else
    warn "seed-generators.sql not found — skipping."
  fi

  # ── Step 2: Interconnection queue data ──────────────────────────────────────
  log "[2] Seeding interconnection queue data..."

  if pnpm --filter @workspace/scripts exec tsx "$SCRIPTS_DIR/seed-ercot-queue-real.ts"; then
    ok "ERCOT queue seeded."
  else
    warn "ERCOT queue seeder failed — check ERCOT credentials in .env."
  fi

  # CAISO + PJM queue data (add scripts here when available)
  # pnpm --filter @workspace/scripts exec tsx "$SCRIPTS_DIR/seed-caiso-queue.ts"
  # pnpm --filter @workspace/scripts exec tsx "$SCRIPTS_DIR/seed-pjm-queue.ts"

  # ── Step 3: Regulatory / market rules ────────────────────────────────────────
  log "[3] Seeding regulatory data..."
  if [ -f "$SCRIPTS_DIR/seed-regulatory.py" ]; then
    "$PYPSA_VENV" "$SCRIPTS_DIR/seed-regulatory.py"
    ok "Regulatory data seeded."
  else
    warn "seed-regulatory.py not found — skipping."
  fi

  # ── Step 4: Load forecast ────────────────────────────────────────────────────
  log "[4] Computing load forecast base data..."
  if [ -f "$SCRIPTS_DIR/compute-load-forecast.py" ]; then
    "$PYPSA_VENV" "$SCRIPTS_DIR/compute-load-forecast.py"
    ok "Load forecast seeded."
  else
    warn "compute-load-forecast.py not found — skipping."
  fi

  # ── Step 5: Data centre pipeline ─────────────────────────────────────────────
  log "[5] Seeding data centre pipeline..."
  if [ -f "$SCRIPTS_DIR/seed-datacenters.py" ]; then
    "$PYPSA_VENV" "$SCRIPTS_DIR/seed-datacenters.py"
    ok "Data centre data seeded."
  else
    warn "seed-datacenters.py not found — skipping."
  fi

  # ── Step 6: Temperature normals ──────────────────────────────────────────────
  log "[6] Seeding temperature normals..."
  if [ -f "$SCRIPTS_DIR/seed-temperatures.py" ]; then
    "$PYPSA_VENV" "$SCRIPTS_DIR/seed-temperatures.py"
    ok "Temperature data seeded."
  else
    warn "seed-temperatures.py not found — skipping."
  fi

  # ── Step 7: Gas forward prices ───────────────────────────────────────────────
  log "[7] Seeding gas forward prices..."
  if [ -f "$SCRIPTS_DIR/seed-gas-forwards.ts" ]; then
    pnpm --filter @workspace/scripts exec tsx "$SCRIPTS_DIR/seed-gas-forwards.ts"
    ok "Gas forwards seeded."
  else
    warn "seed-gas-forwards.ts not found — skipping."
  fi

  # ── Step 8: Nodal DA/RT prices (ERCOT, CAISO) ────────────────────────────────
  log "[8] Seeding nodal DA/RT price data..."
  warn "Manual step: run existing price seeders here once ported to Azure credentials."
  # Example (update script names as needed):
  # pnpm --filter @workspace/scripts seed-ercot-real
  # pnpm --filter @workspace/scripts seed-caiso-real

fi   # end !SCED_ONLY

# ── Step 9: SCED generator-level dispatch ────────────────────────────────────
if ! $SKIP_SCED; then
  log "[9] Seeding ERCOT SCED dispatch data (this takes hours — nohup safe)..."
  echo "    Strategy: 2025 + 2026-to-date first, then backfill 2024."
  echo "    Each day ~17k rows | Gap-fill log makes reruns safe."
  echo "    TimescaleDB compression: ~50M rows ≈ 0.5-1 GB on disk."
  echo "    RAM peak: 50-150 MB per day | B2pts v2 handles it."
  echo ""

  SCED_SCRIPT="$SCRIPTS_DIR/seed-ercot-dispatch.py"
  if [ ! -f "$SCED_SCRIPT" ]; then
    warn "seed-ercot-dispatch.py not found at $SCED_SCRIPT — skipping SCED."
  else
    if [[ -z "${ERCOT_USERNAME:-}" || -z "${ERCOT_PASSWORD:-}" ]]; then
      err "ERCOT_USERNAME / ERCOT_PASSWORD not set in .env — cannot run SCED seeder."
    fi

    if [ -n "$SCED_YEAR" ]; then
      log "  Running SCED seeder for year $SCED_YEAR only..."
      SCED_START="${SCED_YEAR}-01-01"
      SCED_END="${SCED_YEAR}-12-31"
      START_DATE="$SCED_START" END_DATE="$SCED_END" \
        "$PYPSA_VENV" "$SCED_SCRIPT"
    else
      log "  Phase A: 2025-01-01 → 2026-to-date (priority)..."
      START_DATE="2025-01-01" \
        "$PYPSA_VENV" "$SCED_SCRIPT"

      log "  Phase B: 2024-01-01 → 2024-12-31 (backfill)..."
      START_DATE="2024-01-01" END_DATE="2024-12-31" \
        "$PYPSA_VENV" "$SCED_SCRIPT"
    fi

    ok "SCED seeding complete."
  fi
fi

log "=== Seeding finished! ==="
echo ""
echo "Verify row counts:"
echo "  psql \"\$DATABASE_URL\" -c \"SELECT schemaname, tablename, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 20;\""
echo ""
echo "Enable TimescaleDB compression (run after seeding):"
echo "  psql \"\$DATABASE_URL\" -c \"SELECT add_compression_policy('ercot_dispatch', INTERVAL '7 days');\""
