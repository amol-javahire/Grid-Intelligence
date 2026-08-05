# Grid Intelligence Platform — Claude Context

This file is read automatically at the start of every session. It is the primary source of truth for conventions, packages, and architecture. Before writing any code, check this file and `TECHNICAL_NOTES.md`.

---

## Project Overview

**Product:** Grid Origination Intelligence Platform — SaaS renewable energy PPA origination tool for power market teams (ERCOT, CAISO, PJM).

**GitHub:** https://github.com/amol-javahire/Grid-Intelligence
**Domain:** gridintel.ca
**Deployed on:** Azure VM (D2as_v6, 20.98.152.245, user: azureuser) + Azure PostgreSQL Flexible Server (TimescaleDB)

**Stack:**
- Frontend: React 19 / Vite / Tailwind CSS v4 / shadcn/ui / Recharts / Leaflet
- API: Express 5 (Node, PM2, **port 8080** — set in `infra/ecosystem.config.js`;
  routes mount under `/api`, so e.g. `http://localhost:8080/api/ppa-npv`)
- PyPSA engine: FastAPI / Uvicorn (Python 3.13, port 8083)
- DB: PostgreSQL + TimescaleDB via Drizzle ORM (schema in `lib/db/`)
- Auth: Clerk (Google OAuth)
- Monorepo: pnpm workspaces (13 packages)

---

## Python Environment (pypsa-engine venv)

**Python version:** 3.13 (installed via deadsnakes PPA on Azure VM)
**Venv path:** `~/grid-intelligence/artifacts/pypsa-engine/.venv`
**Activate:** `source ~/grid-intelligence/artifacts/pypsa-engine/.venv/bin/activate`
**Run directly:** `~/grid-intelligence/artifacts/pypsa-engine/.venv/bin/python <script>`

### Confirmed installed packages
| Package | Purpose |
|---------|---------|
| `polars` | Primary DataFrame library for all seeders — faster, less RAM than pandas |
| `duckdb` | In-process OLAP SQL engine for analytics |
| `requests` | HTTP — used by seed-sced-gap.py to hit ERCOT API directly (no gridstatus) |
| `psycopg2-binary` | PostgreSQL driver |
| `pandas` | Avoid — only keep if a library explicitly requires it |
| `numpy` `scipy` | Scientific stack |
| `requests` | HTTP |
| `fastapi` `uvicorn` | PyPSA engine API server |
| `pypsa` `highspy` | Power flow / OPF solver |

**Install missing package:**
```bash
~/grid-intelligence/artifacts/pypsa-engine/.venv/bin/pip install <pkg>
```

---

## Node/npm Root Packages (notable ones)

| Package | Purpose |
|---------|---------|
| `canvas@3.2.3` | Installed in root — Automattic/node-canvas: Cairo-backed server-side canvas. Use `createCanvas()`, `loadImage()`, `canvas.toBuffer()` to render images/PDFs/SVGs in Node.js. Requires native build: run `pnpm approve-builds` then `pnpm install` if not working. |
| `recharts` | Charts on the frontend |
| `leaflet` | Map with ERCOT/CAISO/PJM project pins |
| `drizzle-orm` | ORM — schema lives in `lib/db/`, NOT `api-server/` |

---

## Token-Saving Tools

### graphify (Python skill — NOT an npm package)
`pip install graphifyy` then `graphify install` — Claude Code skill from github.com/Graphify-Labs/graphify.
**Confirmed installed: v0.9.16** on Python 3.14 (local Windows). PATH: `%APPDATA%\Python\Python314\Scripts`.
Reads files (code, PDFs, markdown, images), builds a knowledge graph, outputs `graphify-out/graph.json`.
**71.5x fewer tokens per query** vs reading raw files — use this before large codebase analysis sessions.

```bash
/graphify .           # build graph of current project
/graphify . --update  # re-process only changed files
/graphify query "what connects X to Y?"
```

Output: `graphify-out/graph.html` (interactive), `graphify-out/GRAPH_REPORT.md` (god nodes, surprising connections)

### caveman-code (global npm tool)
`npm install -g @juliusbrussee/caveman-code` — terminal coding agent with 4-layer token compression.
**Confirmed installed: v0.65.2** (also available as Claude plugin from marketplace).
**~2× fewer tokens than Codex** on identical tasks. Claude Code-compatible (reads this CLAUDE.md, .mcp.json, skills, hooks directly).

```powershell
caveman                          # interactive TUI
caveman "fix the failing tests"  # start with a prompt
caveman --goal "ship feature X"  # autonomous loop until done
caveman --plan "refactor auth"   # read-only plan mode, then /act to execute
```

Compression layers: terse replies · per-tool output caps (bash 80 lines, read 300) · file read dedup (−99% on re-reads) · optional RTK Rust binary.
Supports OAuth login with Claude Pro/Max — no API key needed if you have a subscription.
GitHub: https://github.com/JuliusBrussee/caveman-code

---

## Critical Conventions — Always Follow

1. **Use Polars, not Pandas** for all Python data processing. Pandas only where a library forces it (e.g. gridstatus return types).

2. **drizzle-kit lives in `lib/db/`**, not `api-server/`. Run schema push as:
   ```bash
   cd ~/grid-intelligence/lib/db && pnpm exec drizzle-kit push
   ```

3. **ERCOT SCED seeder** — `infra/seed-sced-gap.py` hits ERCOT CDR API directly (no gridstatus). Streams ZIP → pure Polars parsing → inserts hourly aggregates. No pandas, no OOM. Requires `ERCOT_USERNAME`, `ERCOT_PASSWORD` in `.env`. Targets 2025-12-06 → today-60d.

4. **SCED 2024 data is lowest priority** — if DB space is tight, delete it first:
   ```sql
   DELETE FROM ercot_hourly_dispatch WHERE hour < '2025-01-01';
   DELETE FROM ercot_dispatch_seed_log WHERE seed_date < '2025-01-01';
   ```

5. **Dec 5, 2025 is already logged as 0 rows** in `ercot_dispatch_seed_log` — skip it, no data exists for that day.

6. **PM2 process manager** — api-server wraps env loading via `infra/start-api.sh`. `set -a; source .env; set +a` is required before running any pnpm commands that need DATABASE_URL.

7. **Data vintages:** Always use 2025/2026 EIA, NREL ATB, ERCOT LTSA, CBRE reports. 2024 versions are stale.

7a. **EIA API v2 — two traps, both cost a full debug cycle (2026-07-31):**
   - **`curl` needs `-g`/`--globoff`.** EIA URLs contain `data[0]`, `facets[x][]`,
     `sort[0][column]`. Without `-g`, curl reads `[` as range-glob syntax and
     exits 3 *before sending anything*. Every EIA seeder in this repo was
     silently failing this way and falling back to model data.
   - **Always pin `&start=YYYY-MM`.** STEO series carry history back to ~2010
     alongside the forecast. `sort=asc&length=N` returns the OLDEST N months,
     not the forward ones — this seeded 2010–2015 prices as "forwards".
   Verify any EIA seeder by checking the delivery-month range is in the FUTURE.

7b. **ERCOT `resource_type` uses CODES, not words (2026-08-02).** ERCOT emits
   `PVGR`, `PWRSTR`, `CCGT90`, `CCLE90`, `SCGT90`, `SCLE90`, `GSREH`, `GSNONR`,
   `GSSUP`, `CLLIG`, `NUC`, `HYDRO`, `WIND`, `DSL`, `RENEW` — never "SOLAR",
   "GAS", "COAL", "NUCLEAR" or "STORAGE". `seed-sced-gap.py` shipped with a map
   keyed on those non-existent words, so everything except WIND/HYDRO silently
   became `other`: all of 2026 collapsed to 3 fuel types (122,069 GWh in one
   bucket) while 2024–2025 stayed correct at 8.
   - `RESOURCE_TYPE_MAP` must stay IDENTICAL in `infra/seed-sced-gap.py` and
     `scripts/src/seed-ercot-dispatch.py` — same table, one vocabulary,
     including the `natural_gas` spelling (not `gas`).
   - Unmapped codes are now counted and dumped as warnings at end of run.
     Never let an unknown code silently fall into `other`.
   - Repair for already-stored rows: `infra/backfill-ercot-2026-resource-types.sql`
     (relearns type by `resource_name` from the known-good 2024–2025 period;
     the raw ERCOT code is not retained in the table so it can't be re-derived).

8. **Verify every seeder immediately** after it completes — spot-check row counts and known reference values against source. See TECHNICAL_NOTES.md §10 for verification queries.

---

## Azure VM Quick Reference

```bash
# Connect
ssh azureuser@20.98.152.245

# App directory
cd ~/grid-intelligence

# PM2 status
pm2 status

# View logs
pm2 logs api-server --lines 50
pm2 logs pypsa-engine --lines 50

# Restart services
pm2 restart all

# SCED gap seeder (run in background)
# NOTE: the venv is under artifacts/pypsa-engine/, NOT the repo root.
# A bare `.venv/bin/python` from ~/grid-intelligence does not exist.
set -a; source .env; set +a
nohup artifacts/pypsa-engine/.venv/bin/python infra/seed-sced-gap.py > /tmp/sced-gap.log 2>&1 &
tail -f /tmp/sced-gap.log

# Read-only source check — dumps the raw ERCOT Resource Type codes for one day,
# flagging any not in RESOURCE_TYPE_MAP. Run this before trusting a re-seed.
artifacts/pypsa-engine/.venv/bin/python infra/seed-sced-gap.py --inspect 2026-03-15
```

---

## Frontend Build & Deploy — READ BEFORE BUILDING

**Only one nginx vhost is installed:** `/etc/nginx/sites-enabled/grid-intelligence`
(from `infra/nginx-grid.conf`). Single server on port 80, path-based:
`/aeso/*` → `/var/www/aeso-platform`, `/*` → `/var/www/grid-platform`.

`infra/nginx-aeso.conf` (port 8081, `BASE_PATH=/`) is an **unused alternative**.
Do not take build settings from it — it is not installed. Verify with
`ls -l /etc/nginx/sites-enabled/` before trusting any config file in `infra/`.

`vite.config.ts` **throws** unless both `PORT` and `BASE_PATH` are set, even for
a build (`PORT` is only used by the dev server, but the check runs regardless).

**BASE_PATH must match the serving path or the app loads blank** — vite bakes
asset URLs at build time, so a `BASE_PATH=/` bundle served under `/aeso/`
requests `/assets/…` and 404s. This has been broken this way once already.

### AESO platform (`/aeso/`)
```bash
cd ~/grid-intelligence
PORT=5173 BASE_PATH=/aeso/ pnpm --filter @workspace/aeso-platform build

# Verify BEFORE copying — must print /aeso/assets/..., not /assets/...
grep -o 'src="[^"]*"' artifacts/aeso-platform/dist/public/index.html

sudo rm -rf /var/www/aeso-platform/assets   # drop orphaned hashed bundles
sudo cp -r artifacts/aeso-platform/dist/public/* /var/www/aeso-platform/
```

### Grid platform (`/`)
```bash
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/grid-platform build
sudo cp -r artifacts/grid-platform/dist/public/* /var/www/grid-platform/
```

No `pm2 restart` is needed for frontend-only changes — nginx serves the static
build directly. Hard-refresh (Ctrl+Shift+R) after deploying; the old bundle is
cached.

### API server — MUST BUILD, restart alone does nothing

`infra/start-api.sh` execs `artifacts/api-server/dist/index.mjs`, a compiled
bundle. `git pull` + `pm2 restart api-server` will happily restart the OLD
code and give no error. Any change under `artifacts/api-server/src/` needs:

```bash
pnpm --filter @workspace/api-server build   # runs artifacts/api-server/build.mjs
pm2 restart api-server
```

Verify the bundle actually changed: `ls -l artifacts/api-server/dist/index.mjs`
and check the mtime is now. This cost a full debug cycle on 2026-08-02 — the
ppa.ts EIA-forward wiring looked broken for two rounds when it had simply
never been compiled.

---

## Table Naming Convention (established 2026-08-02)

Price and generation tables follow `{market}_{granularity}_{content}_hourly`.
Rename existing tables/code together (grep every reference, rename table via
`ALTER TABLE`/`ALTER INDEX`, sweep code, syntax-check) — do not add a new
table under the old convention.

**Price tables** — DA + RT as columns on one row (`da_price`, `rt_price`), not
split into separate DA/RT tables. Splitting would force a join for every
DA-RT spread calc (`/nodal`, `/congestion` pages depend on this being wide).

| Table | Granularity | Status |
|---|---|---|
| `ercot_nodal_da_rt_hourly` | all ERCOT resource nodes | live |
| `caiso_nodal_da_rt_hourly` | all CAISO resource nodes (2,814) | live |
| `ercot_hub_da_rt_hourly` | ~15 named hubs/load-zones only | live |
| `caiso_hub_da_rt_hourly` | NP15/SP15/ZP26 only | live |
| `pjm_nodal_da_rt_hourly` | all PJM nodes | reserved, not built |
| `pjm_hub_da_rt_hourly` | PJM hubs | reserved, not built |

**Gen-stack tables** — system-wide generation by FUEL TYPE, hourly (the
stacked-area "generation mix" chart). NOT per-generator dispatch — see
`ercot_hourly_dispatch` for that (per-resource SCED telemetry, predates this
convention, deliberately not renamed — touches a 4.7GB table + `mv_dispatch_monthly`
+ PyPSA queries; flag to the user before ever touching it). Minimum coverage
required: Jan 2025 onward (both real tables below already start Jan 2024).

Seeded 2026-08-03 from EIA-930 via `scripts/src/seed-eia930-markets.py`,
hourly, Jan 2024 → current month, ~180k rows each.

| Table | Verified avg MW (2025+) |
|---|---|
| `ercot_hourly_gen_output_by_fuel_agg` | gas 22.4 GW, wind 13.7, solar 8.4, coal 7.1, nuclear 4.7, storage 291 MW, **hydro 55 MW** |
| `caiso_hourly_gen_output_by_fuel_agg` | gas 7.1 GW, solar 5.9, hydro 2.5, wind 2.4, nuclear 2.1, geothermal 722 MW |
| `pjm_hourly_gen_output_by_fuel_agg` | gas 41.8 GW, nuclear 31.1, coal 16.8, wind 3.8, solar 3.1, hydro 1.8 |
| `ercot_hourly_gen_output` | superseded by the `_by_fuel_agg` table above — repoint consumers then drop |
| `aeso_hourly_gen_output` | live, Jan 2024+ (was `aeso_generation_mix`), AESO API not EIA |

**CAISO `other` is NEGATIVE (−221 MW avg) — this is not a bug.** EIA-930 does
not report a separate `BAT` series for CISO, so the ~10 GW battery fleet lands
in `OTH`, and net of round-trip losses it consumes more than it delivers on an
hourly average. Consequences:
- CAISO has NO `storage` fuel line despite having one of the largest fleets.
- A stacked-area chart will try to plot a negative series. Handle explicitly:
  either render storage below the axis or exclude it and say so.
PJM likewise reports no `PS`, so Bath County and other pumped storage sit
inside `other` (1,754 MW avg) mixed with genuinely-other generation.

ERCOT is the only one of the three with a clean `BAT` → `storage` series.

Per-generator dispatch tables (ERCOT precedent: `ercot_hourly_dispatch`) are a
DIFFERENT thing from gen-stack tables — one row per generator per hour, not
aggregated by fuel type. Do not conflate the two when building CAISO's
per-generator dispatch table.

**Load tables** — all three US markets seeded from EIA-930 (2026-08-03),
hourly, Jan 2024 → current month, via `scripts/src/seed-eia930-markets.py`.

| Table | Zones | Rows | Notes |
|---|---|---|---|
| `ercot_hourly_zonal_load` | 8 | 180,804 | COAS EAST FWES NCEN NRTH SCEN SOUT WEST — the weather zones |
| `caiso_hourly_zonal_load` | 4 | 90,226 | PGAE SCE SDGE VEA — the four DLAPs |
| `pjm_hourly_zonal_load` | 20 | 451,260 | EIA's codes, NOT PJM's (see below) |
| `aeso_hourly_load` | — | — | real but duplicated across `aeso_supply_demand.ail_mw` and `aeso_hourly_pool_price.ail_mw` — consolidate |

ZONE-NAME TRAPS — both cause silent empty joins:
- **CAISO**: load is at DLAPs (PGAE/SCE/SDGE/VEA); prices are at trading hubs
  (NP15/SP15/ZP26). Different partitions BY MARKET DESIGN. CAISO does not
  publish load by NP15/SP15/ZP26 and never will. Do not join on zone.
- **PJM**: EIA abbreviates zone names differently from PJM's Data Miner.
  EIA `AE BC CE JC ME PE PEP PL PN PS AP` = PJM `AECO BGE COMED JCPL METED
  PECO PEPCO PPL PENELEC PSEG APS`. Stored as EIA returns them; translate
  before joining to `pjm_node_stats`.

The old `ercot_load_by_zone` is the SAME real EIA-930 data under the old name —
superseded by `ercot_hourly_zonal_load`; repoint consumers then drop it.

**Other renamed tables:** `hourly_temperatures` → `iso_hourly_temps` (kept
unified with `iso`/`zone` columns rather than 4 per-market tables, so
cross-market queries are a filter not a UNION); `aeso_pool_price` →
`aeso_hourly_pool_price`.

## A seeder that cannot parse its input MUST ABORT, never substitute a default

Four separate silent-failure bugs in this project, all of which reported
SUCCESS while producing wrong or no data:

1. `curl` without `-g` exited (code 3) BEFORE SENDING on every EIA URL
   containing `data[0]` / `facets[x][]`. Seeders fell back to model data.
2. `pl.read_database` returned ZERO ROWS instead of raising on a valid query
   with a parameter-passing mismatch — a calibration script then reported
   "no data available" for a table holding 22,528 rows.
3. `seed-queue-real.ts` fabricated coordinates from `Math.random()` around a
   state centroid, and picked the interconnection node at random, rather than
   failing when the real queue fetch was unavailable.
4. `parseAesoDatetime` DEFAULTED hour-ending to 1 when it could not find an
   `HE##` marker. An endpoint returning `"2026-06-01 00:00"` therefore
   collapsed all 24 hours of every day onto `hour_ending = 1`, and the upsert
   overwrote the same row 24 times.

The rule: when a seeder cannot parse, cannot fetch, or cannot match, it must
raise and stop. A default value, a fallback dataset or a silently-empty result
is indistinguishable from success at the call site, and every one of these cost
a full debugging session to find. Verify with ROW COUNTS, not by reading the
seeder — see "Real vs synthetic data" below, which records the same lesson.

## AESO market dynamics — how Alberta actually prices (2026-08-04)

Domain knowledge from the user. This is not derivable from the tables and it
determines what the PyPSA model can and cannot reproduce.

**Load is driven by CALGARY temperature**, not a provincial average. Use the
Calgary zone in `iso_hourly_temps` for the load regression, not a composite.
- Summer (Jun-Aug): load climbs hard above **+25 °C**.
- Winter: load is very high below **−20 °C**.

**The summer midday peak is now SUPPRESSED by the solar buildout.** The old
afternoon peak has flattened. Volatility has moved to the two ramps:
- **Morning ramp before sunrise** — load rising, solar not yet up.
- **Evening ramp at sunset** — solar dropping off as wind typically picks up.

**Overnight wind normally holds prices below $20.** This matches the observed
distribution: 76% of hours under $30, averaging $13.26.

**Spikes are COINCIDENT-EVENT driven, not load driven.** Prices spike when
several of these land together:
  - two or more gas units trip or are on outage
  - solar drops off
  - wind under-delivers vs forecast
  - a steep load ramp
  - the **BC-AB tie on outage**

### What this means for the 9-bus OPF — read before "improving" the model

1. **A single-snapshot DC OPF cannot reproduce Alberta's volatility.** The
   ramps are inherently intertemporal; `net.set_snapshots(pd.RangeIndex(1))`
   has no ramp rates, no unit commitment, no intertemporal coupling at all.
   Fixing the price LEVEL (merit-order stack) does not touch this. Multi-period
   with ramp constraints is required, and that is a structural change.

2. **A deterministic OPF at average conditions will never produce a spike.**
   Spikes need the coincident outages, so HISTORICAL REPLAY is the credible
   path to reproducing scarcity — for each hour, derate the units and ties
   that were actually out. Not tuning marginal costs.

   BUT the data is NOT there yet. Verified 2026-08-04 by row count:
   `aeso_generation_outage`, `aeso_intertie_outage` and `aeso_interchange` are
   ALL EMPTY. An earlier note in this file claimed we held them — that came
   from reading the schema and the INSERT statements rather than counting rows,
   the same error that produced the merit-order claim below. Seed them first.

   **Only 3 of ~13 AESO tables actually have data** (2026-08-04):
   populated — `aeso_hourly_pool_price` (22.5k), `aeso_metered_volume` (14.9M,
   2025-07 onward, carries `fuel_type` and `asset_class` so no join needed),
   `aeso_asset_registry` (3,728).
   empty — `aeso_actual_forecast` (AIL), `aeso_merit_order`,
   `aeso_interchange`, `aeso_intertie_outage`, `aeso_generation_outage`,
   `aeso_supply_demand`, `aeso_hourly_gen_output` (the last has NO WRITER at
   all — drop it).

3. **Calibration prediction, revised with this knowledge:**
   - cheap hours → model runs HIGH (fallback stack has no zero/negative offers)
   - spike hours → model runs LOW (no outages applied, no ramp constraints)
   An earlier guess that the model would over-predict at high load was only
   half right; without outages it will under-predict the tail.

4. **The BC-AB tie matters more than its MW suggests** — it appears in the
   spike mechanism directly. The three boundary buses currently have no
   generator and no load, so all three ties carry zero flow and the model
   cannot represent a tie outage at all.

## TIMEZONE — hourly tables do NOT share one convention (2026-08-03)

`(year, month, day, hour)` means different things in different tables. Joining
two hourly tables on those columns without checking is a silent 5-7 hour
misalignment that produces plausible-looking, wrong capture prices.

- **EIA-930 tables are UTC.** Every `*_hourly_gen_output_by_fuel_agg` and
  `*_hourly_zonal_load`, plus the superseded `ercot_hourly_gen_output` /
  `ercot_load_by_zone`. Proven, not assumed: ERCOT solar peaks at hour 19
  (= 14:00 CDT) and July load at hour 22 (= 17:00 CDT). Local-time storage
  would put those at 13 and 17.
- **ISO price tables are market-local** (ERCOT Central, CAISO Pacific, PJM
  Eastern, AESO Mountain) — this is the expected convention but MUST be
  verified per table, not assumed.
- **`ercot_hourly_dispatch` is unambiguous** — `hour` is `timestamptz`.

Authoritative record is the `iso_table_metadata` registry
(`infra/2026-08-03-rename-price-tables-and-timezone.sql`), mirrored into
`COMMENT ON TABLE` so `\d+` shows it. **Query the registry before writing any
cross-table hourly join.** It is a registry rather than a per-row column
because the value is constant per table and a TEXT column would store the same
string 32.6M times in `ercot_nodal_da_rt_hourly` alone.

Converting UTC → local in a query:

```sql
-- EIA-930 (UTC) joined to an ERCOT local-time price table
SELECT (make_timestamp(g.year, g.month, g.day, g.hour, 0, 0) AT TIME ZONE 'UTC')
         AT TIME ZONE 'America/Chicago' AS local_ts, ...
```

DST caveat: local-time tables have 23- and 25-hour days twice a year, so a
local-time `hour` can be duplicated or missing. UTC tables always have exactly
24. Any aggregation that assumes 24 hours/day is wrong on those two days.

Open-Meteo returns LOCAL time by default — `iso_hourly_temps` must be seeded
with an explicit timezone and a `source` column before the load/temperature
regression in `compute-load-forecast.py` can be trusted (task #24).

## Real vs synthetic data — CHECK BEFORE TRUSTING ANY TABLE

Several tables hold calibrated SYNTHETIC data with nothing in the table name or
schema indicating it. This has already caused one wrong conclusion (2026-08:
`ercot_fuel_mix`/`ercot_load_by_zone` were reported as "live real data, Jan 2024+"
on the basis of date coverage alone, without checking the seeder header).

**CHECK THE DATA, NOT THE SEEDER.** Reading a seeder header is NOT sufficient
and has now produced wrong conclusions twice in one day (2026-08-03), both
times because a table has MULTIPLE seeders and the deprecated synthetic one was
read while the real one had actually populated the table. Query the table and
match against a known fingerprint instead — e.g. ERCOT hydro is ~54 MW if real,
~700 MW if synthetic; ERCOT load zones are `COAS/NCEN/...` if real (EIA-930),
`LZ_*` if synthetic.

| Table | Reality |
|---|---|
| `ercot_hourly_dispatch` | REAL — ERCOT 60-day SCED disclosure |
| `ercot_nodal_da_rt_hourly`, `caiso_nodal_da_rt_hourly` | REAL — ERCOT CDR / CAISO OASIS |
| `ercot_hub_da_rt_hourly`, `caiso_hub_da_rt_hourly` | REAL |
| `aeso_*` | REAL — `apimgw.aeso.ca` |
| `ercot_hourly_gen_output` | REAL — EIA-930 fuel-type hourly, Jan 2024+, via `scripts/src/seed-ercot-real-data.py`. Verified 2026-08-03: gas 21.9 GW, wind 13.7 GW, solar 8.1 GW, nuclear 4.7 GW, hydro **54 MW**. That hydro figure is the fingerprint — ERCOT has almost no hydro; the old synthetic model claimed ~700 MW. **Do NOT run `infra/rebuild-ercot-gen-output-from-sced.sql`** — SCED excludes behind-the-meter distributed solar, so it would REGRESS solar vs the EIA-930 figures already loaded. That script is only useful for a dispatch-only view, never for generation mix. |
| `ercot_load_by_zone` | REAL — EIA-930 sub-BA hourly, Jan 2024+, via `scripts/src/seed-ercot-real-data.py`. Zones are EIA codes (COAS/EAST/FWES/NCEN/NRTH/SCEN/SOUT/WEST), NOT the old `LZ_*` names. **`seed-ercot-load-fuelmix.ts` is the DEPRECATED synthetic seeder — do not run it, it would overwrite real data with `LZ_*` rows.** ERCOT's own NP6-345-CD returns 404 on the public API even with a valid token; EIA-930 is the working source. |
| `pjm_node_stats` | model-calibrated, not a real PJM API |
| `iso_hourly_temps` | MIXED — real Open-Meteo seeder AND two synthetic fallback seeders exist; table has NO source column, so real vs synthetic is currently indistinguishable. Add one before relying on it. |

New tables holding any modelled data MUST carry a `source` column from day one.

### Destructive SQL must be transactional (learned the hard way 2026-08-03)

`infra/rebuild-ercot-gen-output-from-sced.sql` ran `DELETE` then `INSERT` as
separate autocommitting statements. The run was interrupted between them and
every `ercot_hourly_gen_output` row from 2024-01 to 2026-05 was destroyed;
recovery needed a full EIA-930 re-seed.

Any script that deletes before inserting MUST wrap both in `BEGIN`/`COMMIT`,
and should assert non-empty before committing. An interrupted run then rolls
back to a no-op instead of emptying the table. That script is now marked
DO NOT RUN — its premise (that the table was synthetic) was wrong.

### Rebuilding ERCOT gen output from SCED

`infra/rebuild-ercot-gen-output-from-sced.sql` replaces synthetic rows with a
real fuel-type aggregation of `ercot_hourly_dispatch`, but ONLY for (year,month)
pairs SCED covers — safe to re-run as gap-filling progresses. Caveat: SCED
excludes behind-the-meter distributed generation, so solar reads low vs ERCOT's
published fuel mix. Do not scale to match published totals without labelling it.

## Key Files

| File | Purpose |
|------|---------|
| `TECHNICAL_NOTES.md` | Deep technical decisions: ZIP64 parsing, SCED 60-day window, PyPSA tier bug, scoring logic, Bachelier model, VPPA Monte Carlo |
| `DESIGN_REFERENCE.md` | Full frontend design tokens, all 30+ page notes, correct route map |
| `infra/seed-on-azure.sh` | Full DB seeding script (steps 0–9) |
| `infra/seed-sced-gap.py` | SCED gap-fill for 2025-12-06 → today (new, replaces old main loop) |
| `infra/ecosystem.config.js` | PM2 process config |
| `infra/start-api.sh` | Env loader wrapper for api-server |
| `lib/db/` | Drizzle schema — run drizzle-kit from here |

---

## Pending / In Progress

- SCED seeding: 2025-12-06 → 2026-07-21 still in progress (running via `seed-sced-gap.py`)
- DNS: verify `nslookup gridintel.ca` → 20.98.152.245
- HTTPS: `sudo certbot --nginx -d gridintel.ca -d www.gridintel.ca`
- Q&A Copilot: LLM provider is **NVIDIA NIM**, not OpenAI, despite the legacy
  `AI_INTEGRATIONS_OPENAI_*` env names (Replit provisioned them). Prefer
  `LLM_BASE_URL` / `LLM_API_KEY`; the old names still work as a fallback.
  - `https://integrate.api.nvidia.com/v1`, key format `nvapi-...`
  - **70B models are unusable on the free tier**: measured 112 s for a
    two-token reply, plus an outright 504. 8B answers in 0.4 s. nginx's
    default `proxy_read_timeout` (60 s) kills anything slower anyway, so
    raising the model size means raising that too.
  - Client now has a 45 s timeout (`LLM_TIMEOUT_MS`) so failures surface fast
    instead of hanging behind the SDK's ~10 min default.
  - Route requires TOOL CALLING — verify any replacement model supports it.
  - **If 8B proves too weak at multi-step tool planning, switch to Kimi K2.5**
    (`https://api.moonshot.ai/v1`, OpenAI-compatible, supports tool calling).
    ~$0.60/$3.00 per M tokens — at <100 queries/month that is well under
    $1/month. Decision 2026-08-03: stayed on the free NVIDIA 8B because volume
    is tiny and nothing needed changing; revisit if answer quality bites.
  - Ollama / self-hosting is NOT viable on this VM: D2as_v6 is 2 vCPU / 8 GB,
    no GPU, already shared with Postgres, api-server and PyPSA (which spikes to
    3 GB). A quantised 8B on CPU runs ~2-4 tok/s — slower than the 70B problem
    it would be solving.
- TimescaleDB compression: `SELECT add_compression_policy('ercot_hourly_dispatch', INTERVAL '7 days');`
- PJM real queue data (future, from pjm.com)
