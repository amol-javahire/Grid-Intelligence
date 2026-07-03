---
name: ERCOT resource node gap-fill
description: How to fill missing/partial months in ercot_node_stats using the PyPSA background seeder
---

## Rule
To extend ercot_node_stats to the current month, trigger `POST /pypsa/admin/seed?mode=gaps&key=$ERCOT_PASSWORD`. The seeder runs as a FastAPI BackgroundTask in the persistent PyPSA workflow — it survives after the bash session ends. Poll `GET /pypsa/admin/seed-status` for progress.

**Why:** The ERCOT pagination API returns ~330k intervals per month at 10k page size (~7 min/month). Trying to run the seeder from a bash command always times out. Running it as a PyPSA background task lets it complete asynchronously. The `gaps` mode queries the DB first and only fetches months with <900 distinct nodes, so it skips already-complete months.

**How to apply:**
1. Restart PyPSA engine if code changed: `restart_workflow "artifacts/pypsa-engine: PyPSA Engine"`
2. Trigger: `curl -X POST "http://localhost:80/pypsa/admin/seed?mode=gaps&key=$(printenv ERCOT_PASSWORD)"`
3. Poll: `curl "http://localhost:80/pypsa/admin/seed-status"` — check `phase` field for progress
4. Typical duration: ~2-3 min/month at 100k page size; ~7 min/month if API limits to 10k
5. Verify: `SELECT year, month, COUNT(DISTINCT node) FROM ercot_node_stats WHERE year=2026 GROUP BY year,month ORDER BY year,month`

## Gap threshold
`< 900 distinct nodes` = gap month. Full months have 1,082–1,115 nodes (Jan–Jul 2026).

## Current coverage (as of Jul 2026)
ercot_node_stats: 30,948 rows, latest 2026-07, all months 2024-01 through 2026-07 complete.
