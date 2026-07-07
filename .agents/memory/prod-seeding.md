---
name: Prod DB seeding approach
description: How to seed the production database — admin endpoints, auth, and table status
---

# Prod DB Seeding — Lessons Learned

## Admin endpoint auth
- Auth: `Authorization: Bearer $SESSION_SECRET` header (NOT `?key=` query param)
- `?key=` URL-encoding breaks for long secrets (88-char base64 has `=` signs) → returns 401
- Always use `-H "Authorization: Bearer $SESSION_SECRET"` with curl

## Child process DB connections work in prod
- Spawned scripts via `pnpm --filter @workspace/scripts run <script>` DO connect to the prod DB.
- They inherit `{ ...process.env }` including `DATABASE_URL` — SSL warning about sslmode is non-fatal.
- AESO seed (21k rows), queue seed, caiso-hourly, pjm all succeed via child process.

## The one exception: XLSX parsing in autoscale
- `seed-ercot-hourly.ts` downloads a 21.3 MB XLSX from ERCOT CDR and parses with SheetJS.
- In prod autoscale container, this takes **1-3 hours** (vs minutes in dev) due to CPU throttling.
- Symptom: job output stops at "Parsing RTM sheet by sheet..." for a very long time.
- The script is NOT stuck — it eventually completes, but timing is unpredictable.

**Why:** SheetJS parses the entire 21.3 MB file into memory as a JS object. Autoscale containers have throttled CPU.

**How to apply:** If ercot_hub_hourly shows 0 rows after triggering seed-ercot-hourly, do NOT assume it's stuck — wait 1-3 hours before concluding failure. Keep the container alive by making periodic admin API calls.

## Inline seed endpoints (fallback for any table)
- `POST /api/admin/reseed-aeso-inline` — seeds all 9 AESO tables using live db connection, no subprocess
- `POST /api/admin/reseed-queue-inline` — seeds queue_projects (1,500 rows) inline
- `POST /api/admin/reseed-generators` — seeds 31 generators + 31 thermal_params inline (static embedded data)
- These always work because they use the same `db` pool the API server already has open.
- executeSql({ environment: "production" }) is **READ-ONLY** — cannot insert/update via that tool

## Deploy timing warning
- Do NOT deploy while background child-process seeding jobs are running on prod
- Deploy sends SIGTERM to the current instance → kills child processes mid-run
- Wait for all active jobs to complete, then deploy

## Admin endpoint inventory (as of July 2026)
| Endpoint | Script | Notes |
|----------|--------|-------|
| `POST /api/admin/reseed-generators` | inline | 31 generators + 31 thermal_params; TRUNCATE+reinsert |
| `POST /api/admin/reseed-gas-prices` | seed-gas-prices | Henry Hub from FRED DHHNGSP + Waha; ~30 sec |
| `POST /api/admin/seed-ercot-load-fuelmix` | seed-ercot-load-fuelmix | EIA-930; 174k + 167k rows |
| `POST /api/admin/reseed-ercot-hourly` | seed-ercot-hourly | CDR; 327k rows; 1-3h autoscale |
| `POST /api/admin/reseed-caiso-hourly` | seed-caiso-hourly | CAISO OASIS; ~45 min |
| `POST /api/admin/reseed-ercot-nodes` | seed-ercot-real | CDR hub/zone stats; 5-10 min |
| `POST /api/admin/reseed-pjm` | seed-pjm | calibrated model; fast |
| `POST /api/admin/reseed-caiso-nodes` | seed-caiso-real | OASIS CAISO; 3-5 min |
| `GET /api/admin/status` | — | 14-table count + active jobs |

## Prod table targets (dev counts)
- gas_prices: 1,328 rows (henry_hub + waha, Jan 2024–Jul 2026)
- generators: 31 (ERCOT thermal)
- thermal_params: 31 (ERCOT thermal)
- ercot_load_by_zone: 174,282
- ercot_fuel_mix: 167,190
- ercot_hub_hourly: 327,195
- ercot_node_stats: 30,948 (1,100 prod = 15 hub/zone only; resource nodes missing)
- pjm_node_stats: 14,336 (416 prod = outdated)
- caiso_hub_hourly: 65,655
