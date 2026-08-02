# Data Sources Reference — Grid Intelligence Platform

Definitive guide for refreshing platform data: every DB table, its upstream origin,
auth requirement, seeder script, and refresh cadence. Captured from the Replit
deployment (2026-07). Companion to [REPLIT_ARCHITECTURE.md](REPLIT_ARCHITECTURE.md)
(per-tab) and [CLAUDE.md](CLAUDE.md).

---

## Part 1 — Master DB Table Source Registry

| Table | Rows | Upstream source | Auth | Cadence | Seeder |
|-------|------|-----------------|------|---------|--------|
| `candidates` | ~3,875 / 6,163 | **EIA 860** Annual Generator Report — `eia.gov/electricity/data/eia860/xls/eia8602025ER.zip` (**2025 vintage**) | none | Annual (~Jun) | `extract-eia860.py` → `seed-candidates.ts` → 4 scoring scripts → `assign-and-score-nodal.ts` |
| `queue_projects` | ~1,793 ERCOT + CAISO | ERCOT GIS Report pg7-200-er via `gridstatus` lib; CAISO queue | none (ERCOT) | Quarterly | `seed-ercot-queue-real.py` (pypsa venv); `seed-queue-real.ts` (CAISO) |
| `ercot_node_stats` | ~800 nodes × 29 mo | ERCOT CDR 12301 (monthly); Authenticated API for >12mo history | ERCOT_PASSWORD (auth API); CDR public | Monthly (CDR 7-day window) | `seed-ercot-nodes-cdr.ts`; gap-fill `POST /pypsa/admin/seed?mode=gaps` |
| `ercot_hub_da_rt_hourly` | ~21K | ERCOT CDR 13060 (DAM hourly) + 13061 (RTM 15-min→hourly) | none (public CDR) | Monthly (add doclookupIds) | `seed-ercot-hourly.ts` (XML parse, 22MB files) |
| `caiso_hub_da_rt_hourly` | 63,495 | CAISO OASIS API — PRC_LMP/DAM + PRC_HASP_LMP/HASP | none | Monthly (idempotent) | `seed-caiso-hourly.ts` (31-day max/request) |
| `caiso_node_stats` | 3 nodes × 29 mo | CAISO OASIS monthly aggregates | none | Monthly | `seed-caiso-nodes.ts` / `seed-caiso-real.ts` |
| `pjm_node_stats` | PJM hub/zone | PJM DataMiner 2 API | PJM free account | Monthly | `seed-pjm-nodes.ts` / `seed-pjm.ts` |
| `gas_prices` | 651 | Henry Hub: EIA API v2 (NG.RNGWHHD.D), FRED DHHNGSP fallback; Waha: oilpriceapi.com | EIA_API_KEY; Waha key | Daily/weekly | `seed-gas-prices.ts` (uses `curl`, not node https) |
| `ercot_hourly_dispatch` | ~26M | ERCOT CDR NP3-965-ER SCED 60-Day Disclosure | ERCOT_USERNAME + PASSWORD + SUBSCRIPTION_KEY | Monthly (60-day window) | `seed-ercot-dispatch.py` (pypsa venv) — **note: we replaced with `infra/seed-sced-gap.py`, direct API + Polars** |
| `mv_dispatch_monthly` | 38,820 | MV — aggregates `ercot_hourly_dispatch` by year/month/resource | n/a | after dispatch seed | `REFRESH MATERIALIZED VIEW mv_dispatch_monthly` |
| `mv_capture_monthly` | 179 | MV — gen-weighted hub price by fuel/month; joins dispatch + hub_hourly | n/a | after seed | `REFRESH MATERIALIZED VIEW mv_capture_monthly` — **we repointed to `ercot_nodal_da_rt_hourly` (`infra/create-mv-capture-monthly.sql`)** |
| `ercot_load_by_zone` | 8 zones × mo | EIA-930 region-sub-ba-data (ERCO, 8 weather zones) | EIA_API_KEY | Monthly | `seed-ercot-load-fuelmix.ts` |
| `ercot_hourly_gen_output` | 8 fuels × mo | EIA-930 fuel-type-data (ERCO) | EIA_API_KEY | Monthly | `seed-ercot-load-fuelmix.ts` (same script) |
| `iso_hourly_temps` | 21,168/zone (11 zones) | Climatological baselines (NOAA normals) hardcoded in seeder | none | one-time | `seed-temperatures-completion.py` (pypsa venv) |
| `temperature_forecasts` | 12,056 (11 zones × 1,096 d, Jul2026–Jun2029) | Climatology + 0.3°F/yr trend; Open-Meteo CMIP6 supplement | none | when window expires | `compute-load-forecast.py` |
| `load_forecasts` | 8,768 (8 zones × 1,096 d) | OLS regression on temp+calendar (R² 0.88–0.92); EV+DC layered | none | after temps update | `compute-load-forecast.py` |
| `datacenters` | 55 | Manually curated (press releases, ERCOT large-load filings) | none | Manual quarterly | `seed-datacenters.py` (edit DATACENTERS list) |
| `regulatory_items` | 30 | Manual baseline + monthly scraper (ERCOT/CAISO/PUCT/FERC) | none | Monthly | `seed-regulatory.py` (seed); `scrape-regulatory.py` (refresh) |
| `generators` + `thermal_params` | 31 ERCOT thermal | Manually compiled ERCOT plant data (heat rates, dispatch params) | none | Manual annual | `seed-generators.sql` |
| `transmission_lines` | 23,674 | HIFLD Electric Power Transmission Lines (115kV+ ERCOT/CAISO/PJM) | none | one-time (~annual) | one-time script — **geometry normalization required (MultiLineString 3-D)**; NOT in current Drizzle schema |
| `screenings` | user-gen | App writes on "Save Screening" | n/a | n/a | none (app-generated) |

---

## Part 2 — Secrets Reference (Replit env vars)

| Secret | Used for | Obtain | Fallback |
|--------|----------|--------|----------|
| `ERCOT_USERNAME` / `ERCOT_PASSWORD` / `ERCOT_SUBSCRIPTION_KEY` | SCED dispatch + node-stats gap-fill | ERCOT Developer Portal (mis.ercot.com) | CDR public (7-day window) for node stats; dispatch blocked without |
| `EIA_API_KEY` | gas_prices (Henry Hub), ercot_load_by_zone, ercot_hourly_gen_output | eia.gov/opendata (free, instant) | Henry Hub→FRED (no auth); load/fuel-mix **no fallback** |
| `WAHA_API_KEY` (oilpriceapi.com) | Waha gas price | oilpriceapi.com (paid) | Waha falls back to HH proxy for LZ_WEST/HB_PAN/HB_WEST scoring |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | Q&A Copilot LLM + web search | Replit AI Integrations | Copilot errors; rest unaffected |

All ERCOT keys are already in the Azure VM `.env`. EIA/Waha/OpenAI keys need to be
added to the VM `.env` before running the fresh-seed scripts (not needed for pg_dump copy).

---

## Part 3 — Refresh Runbooks

### 3A. Monthly incremental (after month-end)
1. ERCOT node stats — `POST /pypsa/admin/seed?mode=gaps` or `seed-ercot-nodes-cdr` (~8 min, ERCOT_PASSWORD)
2. ERCOT hub hourly — add doclookupIds to DAM_IDS+RTM_IDS, `seed-ercot-hourly` (~10–20 min)
3. CAISO hub hourly — `seed-caiso-hourly` (~5 min)
4. CAISO node stats — `seed-caiso-nodes` (~5 min)
5. Gas prices — `seed-gas-prices` (~1 min, EIA_API_KEY/FRED)
6. ERCOT load + fuel mix — `seed-ercot-load-fuelmix` (~5 min, EIA_API_KEY)
7. ERCOT SCED dispatch — `infra/seed-sced-gap.py` (our version; direct API + Polars)
8. Refresh MVs — `REFRESH MATERIALIZED VIEW mv_dispatch_monthly; mv_capture_monthly;`
9. Re-score candidates — `score-ercot-curtailment && score-caiso-curtailment && score-ercot-congestion && score-caiso-congestion` (~5 min)
10. Scrape regulatory — `scrape-regulatory.py` (~2 min)

### 3B. Annual (after new EIA 860 ER publishes ~Jun)
1. Download new EIA 860 ZIP → `/tmp/eia860YYYYER.zip`
2. `extract-eia860.py` → regenerates `candidates-seed.csv` (~6,163 rows)
3. `seed-candidates`
4. Re-run 4 scoring scripts
5. `assign-and-score-nodal` (**run synchronously — never pipe to head, SIGPIPE kills updates**)
6. Refresh queue — `seed-ercot-queue-real.py` + `seed-queue-real.ts`
7. Update CAPEX benchmarks in `ppa-calculator.tsx`

### 3C. One-time / ad-hoc
- `transmission_lines` — HIFLD (geometry normalization required)
- `datacenters` / `generators`+`thermal_params` — manual edits then re-run
- `iso_hourly_temps` / `temperature_forecasts` / `load_forecasts` — extend window via `compute-load-forecast.py`

---

## Part 4 — Live-computed / hardcoded (no DB table)

- **PyPSA simulators** — HiGHS LP, topology hardcoded in `network.py` from EIA 860 2024 nameplates; historical mode reads `gas_prices`.
- **Map datacenter layer** — OpenStreetMap Overpass API (lazy, distinct from the 55-row `datacenters` table).
- **Heat Rate Options** — Bachelier model, all Greeks client-side; inputs from `gas_prices`+`ercot_node_stats`.
- **EV projections** — hardcoded in `ev-charging.tsx` (TxDMV: ERCOT 456,667 EVs end-2025, 16% CAGR; CAISO 1.9M ZEVs, 13% CAGR; 1.51/1.40 kW/veh).
- **CAPEX benchmarks / IRA cards** — hardcoded (NREL ATB 2024, Lazard v17, IRS IRA guidance).
