# Grid Intelligence Platform — Architecture Brief

Interview reference. Everything here is verified against the codebase as of 2026-07-29, not
aspirational. Where the code and the docs disagree, this file follows the code and says so.

---

## 1. The 60-second version

Two sibling web applications that screen power markets for PPA origination opportunities:

| App | Market | What it answers |
|---|---|---|
| **Grid Platform** | ERCOT / CAISO / PJM | Which of ~3,875 EIA-860 projects are worth a PPA, scored on 8 risk dimensions |
| **AESO Platform** | Alberta | Same question for Alberta's 230-generator fleet, plus DCF valuation and offtake structuring |

They share one backend, one database, one API contract, and one deployment. The Alberta app is
the newer and more developed of the two.

**Why two apps rather than one with a market switch:** ERCOT and Alberta are structurally
different markets. ERCOT has nodal LMP, so basis and congestion are first-class concepts. Alberta
runs a single province-wide pool price, so those dimensions *do not exist* — until the
Restructured Energy Market (REM) introduces nodal pricing around mid-2027. Forcing both into one
UI would have meant either inventing Alberta basis numbers or greying out half the ERCOT
interface. Separate apps, shared infrastructure.

---

## 2. Architecture at a glance

```
                    Browser
                       │  http://20.98.152.245  (port 80, no TLS yet)
                       ▼
              ┌──────────────────┐
              │  nginx (port 80) │   single vhost, path-based routing
              └──────────────────┘
        ┌──────────┬─────────────┬──────────────┐
        │ /        │ /aeso/      │ /api/, /pypsa/│
        ▼          ▼             ▼
   grid-platform  aeso-platform   Express API (Node, :8080)
   (static SPA)   (static SPA)        │
   /var/www/…     /var/www/…          │ internal proxy
                                      ▼
                            FastAPI PyPSA engine (:8083)
                            bound to 127.0.0.1 — NOT internet-reachable
                                      │
                                      ▼
                    Azure PostgreSQL Flexible Server (TimescaleDB)
```

Both SPAs are built to static files and served directly by nginx. Only the API server touches the
database. The Python engine is reachable *only* through the Node API — it binds to `127.0.0.1`, so
there is no path from the internet to it except via Express.

**Two-hop proxy, and why:** the browser calls `/pypsa/aeso/opf`. nginx forwards `/pypsa/` to
Express on `:8080`; Express strips the prefix and forwards to FastAPI on `127.0.0.1:8083`. That
extra hop exists so the optimisation engine is never directly exposed, and so auth/logging/rate
limiting can eventually live in one place rather than being duplicated in Python.

---

## 3. Monorepo layout

pnpm workspaces. 13 packages under three roots:

```
artifacts/          deployable applications
  grid-platform/      React SPA — ERCOT/CAISO/PJM
  aeso-platform/      React SPA — Alberta
  api-server/         Express 5 API
  pypsa-engine/       FastAPI + PyPSA optimisation service
  pitch-deck/         React deck
  mockup-sandbox/     component scratch space

lib/                shared libraries
  db/                 Drizzle schema — 35 table definitions (SOURCE OF TRUTH)
  api-spec/           OpenAPI 3 contract — 1,806 lines
  api-client-react/   GENERATED React Query hooks
  api-zod/            GENERATED Zod validators
  integrations-*/     OpenAI helpers

scripts/            seeders and one-off data jobs
infra/              deployment, nginx, cron, seeding scripts
```

**Worth mentioning unprompted:** `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440` — no npm
package can be installed until it has been public for 24 hours. That is a deliberate
supply-chain-attack defence: malicious npm releases are typically caught and pulled within hours,
so a one-day quarantine removes most of the exposure. It is the kind of thing that signals you
think about dependency risk, not just features.

---

## 4. Frontend

**Stack:** React 19, Vite, TypeScript, Tailwind CSS v4, shadcn/ui, Recharts, Leaflet, wouter
(routing), TanStack React Query (server state).

**Points worth making:**

- **No global state library.** Server state lives in React Query; UI state is local `useState`.
  Redux would be ceremony for an app whose state is almost entirely "what the server said."
- **Two data-access patterns, deliberately.** Most pages use generated hooks
  (`useGetAesoPoolPrice`) from the OpenAPI contract. Newer endpoints use hand-written
  `useQuery` + `fetch`. The generated path enforces the contract; the hand-written path lets a
  new endpoint ship without regenerating the whole client. Being able to explain *why* both
  exist is better than pretending it is uniform.
- **`BASE_PATH` is baked at build time.** Vite requires `BASE_PATH` and `PORT` as env vars or the
  build throws. The Alberta app is built with `BASE_PATH=/aeso/` so its asset URLs resolve under
  the subpath. This cannot be changed after build — a `/`-built bundle served at `/aeso/` returns
  404s for every asset. That was a real deployment bug.
- **Client-side computation for the models.** The DCF and offtake models run entirely in the
  browser — no round-trip per slider drag. That is why the sensitivity scrubber recomputes NPV
  in real time. The cost is that the model logic is duplicated if it ever needs a server-side
  equivalent.

---

## 5. Backend — Express API

**Express 5 on Node, PM2-managed, port 8080.** 23 route modules under
`artifacts/api-server/src/routes/`.

**The strongest architectural point: contract-first API with codegen.**

```
lib/api-spec/openapi.yaml   (hand-written, 1,806 lines)
            │  orval
            ├──────────────► lib/api-client-react/src/generated/   (React Query hooks)
            └──────────────► lib/api-zod/src/generated/            (Zod validators)
```

The OpenAPI spec is the contract. `orval` generates both the typed React Query hooks the frontend
imports and the Zod runtime validators. Change the spec, regenerate, and the frontend fails to
compile if you broke something. This is the answer to "how do you keep frontend and backend in
sync" — the type system enforces it rather than a convention.

**Error-handling principle worth quoting:** routes never return an empty success. From
`aeso_rankings.ts`:

> Never return an empty success — an empty list would read as "no assets" rather than "query failed".

A 500 with `{error: "internal_error"}` is more honest than a 200 with `[]`, because the second one
looks like a valid answer. This principle also drove the Dashboard rebuild (below).

---

## 6. Python / PyPSA engine

**FastAPI + Uvicorn, Python 3.13, port 8083, its own venv.** Runs DC optimal power flow via PyPSA
with the HiGHS LP solver.

Two Alberta network models:

| Model | Buses | Data provenance |
|---|---|---|
| `aeso_network.py` | 3 (SOUTH/CENTRAL/NORTH) | Academic aggregation — **illustrative only** |
| `aeso_network_regional.py` | 9 | AESO's own 2025 Long-Term Transmission Plan |

The 9-bus model uses AESO's six published planning regions with their published load and
generation-by-fuel figures, plus three boundary interties (BC 800 MW, Montana 310 MW,
Saskatchewan 153 MW) from AESO's Available Transfer Capability information document, and real
1,000 MW ratings for the WATL and EATL HVDC lines. **Five internal AC line ratings are
engineering estimates** and are flagged as such in every API response (`capacity_source:
"estimated"`) and badged amber in the UI.

**The best story in the whole project — "Phase 0":**

An audit found the OPF endpoint was returning a hardcoded `"status": "optimal"` regardless of
what the solver actually reported, and the network contained a hidden 25,000 MW slack generator
that could silently serve unmet load while being excluded from reported totals. So a scenario
where the modelled fleet physically could not meet demand would come back looking clean.

Fixed by: returning the real solver status and termination condition; surfacing slack dispatch
explicitly as `unserved_load_mw` with a `model_status: "load_shed"` flag; including slack cost in
the total; reporting load-weighted average price alongside the naive mean; separating "line is
near its limit" from "line is actually binding" (shadow price dual); adding an energy-balance
residual check; and pinning dependency versions into the response. Plus four deterministic test
scenarios including a genuinely infeasible one.

That is the answer to "tell me about a time you found a problem in your own work." The model
still has real limitations — it is not calibrated against historical settlement data — but it no
longer *claims* to be something it isn't.

---

## 7. Database

**Azure PostgreSQL Flexible Server with TimescaleDB.** Drizzle ORM; 35 schema files in
`lib/db/src/schema/` are the source of truth. Migrations run via `drizzle-kit push` **from
`lib/db/`**, not from the API server directory.

**Scale:**

| Table | Rows | Notes |
|---|---|---|
| `aeso_metered_volume` | ~14.9M | Hourly generator-level, Jul 2025 – Jun 2026 |
| CAISO nodal DA prices | ~32.6M | 2,739 nodes, Jan 2025 – Jul 2026 |
| `aeso_hourly_pool_price` | ~22.5k | Hourly, Jan 2024 – Jul 2026 |
| `aeso_asset_registry` | 3,728 | 230 with capability data from the CSD report |

**The metrics layer is where the real engineering judgment shows.** Capacity factor, capture
price and capture rate are computed in a layered SQL structure:

- `aeso_pool_monthly` (materialised view) — hour-weighted average pool price, computed from the
  **complete price series**, never gated on hours where a given generator happened to run
- `aeso_asset_monthly` (materialised view) — stores **raw components** per asset per month
  (MWh, revenue, capacity-hours), not ratios
- `aeso_asset_ttm` / `aeso_fuel_ttm` (views) — trailing-twelve-month figures computed as
  `SUM(components) ÷ once`

**Why that matters, and it is a genuinely good interview answer:** averaging twelve monthly
capture rates gives the wrong number. A month where the asset generated 5 GWh and a month where it
generated 50 GWh would count equally. The correct trailing-twelve-month capture price is total
revenue ÷ total generation — sum the components, divide once. Storing ratios instead of components
makes that impossible to compute correctly later. The same logic applies to capacity factor
(capacity-hour weighted) and to the pool price denominator (hour weighted, computed independently
of any generator).

**Two known data-quality caveats surfaced in the UI rather than hidden:** cogeneration capacity
factor is understated because metered volume is net-to-grid while capability is total (cogen
consumes most output behind the fence); battery capacity factor (~0.3%) is meaningless because
Alberta batteries mostly provide contingency reserve, not energy arbitrage.

---

## 8. Azure infrastructure

| Component | Spec |
|---|---|
| VM | `D2as_v6`, 2 vCPU / 8 GB, Ubuntu, `20.98.152.245` |
| Database | Azure PostgreSQL Flexible Server + TimescaleDB |
| Process manager | PM2 — `api-server`, `pypsa-engine` |
| Web server | nginx, single vhost, port 80 |
| Scheduling | crontab → `infra/refresh-cron.sh` |

**PM2 config detail worth knowing:** `pypsa-engine` has `max_memory_restart: 3000M`. It was
originally 600 MB, which killed the process mid-request during multi-period solves (24-hour
battery optimisation, multi-horizon expansion). The VM has 8 GB and idles at ~17%, so 3 GB is
headroom that still catches a genuine leak.

**Cron schedule** (`infra/refresh-cron.sh`), staggered so jobs never collide on the database:

- Daily: ERCOT/CAISO nodal prices, ERCOT SCED gap-fill, then derived-view rebuilds *after* the
  price jobs (order matters — rollups go stale otherwise)
- Weekly: interconnection queues, regulatory scrapes, AESO AUC/MSA cache refresh, AESO LTA
  new-report check

**A deployment war story worth telling:** the Alberta app was originally going to run on port
8081. The Azure Network Security Group rule for 8081 repeatedly failed to take effect —
`Test-NetConnection` kept returning `TcpTestSucceeded: False`. Rather than keep debugging the
NSG, the design changed to serve both apps from port 80 under different paths via one nginx
vhost. That removed the NSG dependency entirely and is a better architecture anyway: one TLS
certificate to manage later, one port open, no cross-origin complexity.

---

## 9. Data pipeline

Everything is real published data. Sources by market:

**Alberta:** AESO public API gateway (pool price, asset list, metered volumes), AESO ETS legacy
portal (Current Supply Demand report — HTTP, no auth, gives per-asset capability and fuel type),
AESO Long-Term Adequacy PDFs (parsed with pdfplumber), Government of Alberta monthly gas
reference price (388 months, 1994–present), TC Energy indicative forward curve, Alberta MSA
quarterly reports, AUC RSS.

**ERCOT/CAISO:** ERCOT CDR API (direct, streaming ZIP → Polars, no gridstatus dependency), CAISO
OASIS SingleZip, EIA-860, FRED (Henry Hub).

**Convention:** Polars, not pandas, for all Python data processing — lower memory and faster on
the multi-million-row ingests. Pandas only where a library forces it.

**Two data-engineering problems worth being able to discuss:**

1. **DST handling.** AESO reports interval-start in Mountain Time. On the November fall-back day
   hour 01:00 occurs twice, producing duplicate `(date, hour_ending)` keys; on the March
   spring-forward day it is skipped, so that month legitimately has 719 hourly rows instead of
   720. Handled with last-wins dedupe before upsert, and the 719 was verified as correct rather
   than "fixed."

2. **A parser that reconciles before it writes.** The CSD report seeder sums per-fuel capability
   and checks it against the report's own summary block, refusing to write on mismatch. That
   caught two real bugs: unlabelled fuel sections merging into the wrong block (blank lines are
   the only delimiter), and preamble lines like "Alberta Internal Load (AIL)" matching the
   asset-name regex and creating ~12.5 GW of phantom generators.

---

## 10. Things to say before you are asked

These are real gaps. Naming them first is much stronger than being caught by them.

**There is no authentication.** `CLAUDE.md` says "Clerk (Google OAuth)" — that is stale. There
are zero Clerk references in the codebase, `app.use(cors())` is wide open, and the site is served
over plain HTTP with no TLS. Anyone with the IP can read everything and hit every endpoint. This
is fine for a demo of public market data and is the first thing to fix for anything real. **Do
not claim the app has auth.**

**The interconnection queue table is synthetic.** `scripts/src/seed-aeso-data.ts` generates 50
`Math.random()` projects with names deliberately close to real Alberta assets. It has not been
run against production and the queue tab is empty rather than fake — but the seeder exists and
should be deleted, not left where someone might run it.

**The ERCOT PyPSA "Tier 2 real topology" label is wrong.** Its branches come from a geographic
k-nearest-neighbour algorithm over ERCOT-labelled buses, not real electrical topology. It is a
synthetic graph. Known, documented in `ERCOT_PYPSA_VALIDATION.md`, not yet relabelled.

**CAISO has a mislabelled series.** `seed-caiso-hourly.ts` pulls `PRC_HASP_LMP` but the UI calls
it "RT". HASP is not the 5-minute real-time market. Documented, not yet fixed.

**No test suite beyond the PyPSA scenarios.** There are four deterministic OPF tests. There are
no frontend tests, no API integration tests, no CI gate.

**The 9-bus model is not calibrated.** It has never been back-tested against historical
settlement data. It is labelled as such in the UI and in every API response.

---

## 11. Likely questions

**"Walk me through what happens when I load the rankings page."**
Browser requests `/aeso/rankings` → nginx serves the SPA shell from `/var/www/aeso-platform`
(`try_files` falls back to `index.html` for client-side routes) → React mounts, wouter matches the
route → React Query calls `/api/aeso/rankings` → nginx proxies to Express on `:8080` → the route
aggregates metered volume against pool price, joins the asset registry, returns rows plus a
coverage block → the client scores seven dimensions and renders. Scoring is client-side so the
objective presets reweight instantly without a round-trip.

**"Why PostgreSQL and not a time-series database?"**
It is PostgreSQL *with* TimescaleDB, so it is a time-series database — hypertables and compression
policies over ordinary SQL. The relational side matters because the workload is not purely
time-series: asset registries, queue projects and screening sessions are relational, and the
metrics layer is materialised views joining across both. Splitting into a separate TSDB plus a
relational store would have meant cross-store joins in application code. Caveat worth stating:
Azure ships the Apache-licensed TimescaleDB, so native compression policies are not available.

**"How do you handle a data source changing under you?"**
Reconcile-before-write (the CSD parser refuses to write when its own totals disagree), fail loudly
rather than returning empty success, and mark provenance on every derived number. The forward
curve, the gas series and the transmission line ratings all carry explicit sourced / derived /
estimated / unsourced labels that render in the UI. Where a figure genuinely is not available —
Alberta insurance benchmarks, decommissioning $/MW — it says so rather than borrowing a US number.

**"What would you do differently?"**
Put the metrics layer in the database from the start. The first version computed capture rates in
application code by averaging monthly ratios, which is wrong, and the fix meant rebuilding the
whole aggregation as raw-component storage with a single division at the end. Storing components
rather than ratios should have been the initial design.

**"What is the hardest thing in here?"**
Not the code — deciding what the app is allowed to claim. A 3-bus DC-OPF that reports "optimal"
and shows nodal prices for a market that does not have nodal pricing is worse than useless in
front of someone who knows the market. Most of the recent work has been making the software's
confidence match the evidence behind it: real solver status, explicit load-shedding, per-line
provenance badges, and naming REM basis exposure as identified-but-not-priced instead of
inventing a number.

---

## Quick reference

```bash
ssh -i grid-intelligence-vm_key.pem azureuser@20.98.152.245
cd ~/grid-intelligence
set -a; source .env; set +a          # REQUIRED before psql/pnpm — not auto-loaded

pm2 status
pm2 logs api-server --lines 50
pm2 restart all

pnpm --filter api-server build
BASE_PATH=/aeso/ pnpm --filter aeso-platform build
sudo rsync -a --delete artifacts/aeso-platform/dist/public/ /var/www/aeso-platform/

cd lib/db && pnpm exec drizzle-kit push    # migrations run from HERE
```

| Port | Service |
|---|---|
| 80 | nginx (both SPAs + API proxy) |
| 8080 | Express API |
| 8083 | FastAPI PyPSA (localhost-bound) |
