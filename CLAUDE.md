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
- API: Express 5 (Node, PM2, port 3001)
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
set -a; source .env; set +a
nohup .venv/bin/python infra/seed-sced-gap.py > /tmp/sced-gap.log 2>&1 &
tail -f /tmp/sced-gap.log
```

---

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
- Q&A Copilot: swap OpenAI → Claude API
- TimescaleDB compression: `SELECT add_compression_policy('ercot_hourly_dispatch', INTERVAL '7 days');`
- PJM real queue data (future, from pjm.com)
