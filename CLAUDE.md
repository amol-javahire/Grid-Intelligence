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

| Table | Status |
|---|---|
| `ercot_hourly_gen_output` | live, Jan 2024+ (was `ercot_fuel_mix`) |
| `aeso_hourly_gen_output` | live, Jan 2024+ (was `aeso_generation_mix`) |
| `caiso_hourly_gen_output` | reserved, not built |
| `pjm_hourly_gen_output` | reserved, not built |

Per-generator dispatch tables (ERCOT precedent: `ercot_hourly_dispatch`) are a
DIFFERENT thing from gen-stack tables — one row per generator per hour, not
aggregated by fuel type. Do not conflate the two when building CAISO's
per-generator dispatch table.

**Load tables** (min coverage Jan 2025):

| Table | Status |
|---|---|
| `ercot_hourly_zonal_load` | exists as `ercot_load_by_zone`, **SYNTHETIC** — rename + real source both pending |
| `aeso_hourly_load` | real, but duplicated across `aeso_supply_demand.ail_mw` and `aeso_hourly_pool_price.ail_mw` — consolidate |
| `caiso_hourly_zonal_load` | not built |
| `pjm_hourly_zonal_load` | not built |

**Other renamed tables:** `hourly_temperatures` → `iso_hourly_temps` (kept
unified with `iso`/`zone` columns rather than 4 per-market tables, so
cross-market queries are a filter not a UNION); `aeso_pool_price` →
`aeso_hourly_pool_price`.

## Real vs synthetic data — CHECK BEFORE TRUSTING ANY TABLE

Several tables hold calibrated SYNTHETIC data with nothing in the table name or
schema indicating it. This has already caused one wrong conclusion (2026-08:
`ercot_fuel_mix`/`ercot_load_by_zone` were reported as "live real data, Jan 2024+"
on the basis of date coverage alone, without checking the seeder header).

**Before describing any table as real, open its seeder and read the header.**

| Table | Reality |
|---|---|
| `ercot_hourly_dispatch` | REAL — ERCOT 60-day SCED disclosure |
| `ercot_nodal_da_rt_hourly`, `caiso_nodal_da_rt_hourly` | REAL — ERCOT CDR / CAISO OASIS |
| `ercot_hub_da_rt_hourly`, `caiso_hub_da_rt_hourly` | REAL |
| `aeso_*` | REAL — `apimgw.aeso.ca` |
| `ercot_hourly_gen_output` | MIXED — check the `source` column (`sced_real` vs `synthetic`) |
| `ercot_load_by_zone` | SYNTHETIC — `seed-ercot-load-fuelmix.ts`, needs CDR NP6-346-CD |
| `pjm_node_stats` | model-calibrated, not a real PJM API |
| `iso_hourly_temps` | MIXED — real Open-Meteo seeder AND two synthetic fallback seeders exist; table has NO source column, so real vs synthetic is currently indistinguishable. Add one before relying on it. |

New tables holding any modelled data MUST carry a `source` column from day one.

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
