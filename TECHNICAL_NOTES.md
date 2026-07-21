# Grid Intelligence — Technical Notes & Hard-Won Lessons

Detailed technical narrative of key implementation challenges solved during Replit development.
Use this as ground truth when making architectural decisions or debugging data issues.

**Last updated:** July 2026 (corrections applied post-Replit)

---

## 0. General Engineering Principles

### Python venv — confirmed installed packages (pypsa-engine .venv, Python 3.13)
The pypsa venv at `artifacts/pypsa-engine/.venv` runs Python 3.13 (installed via deadsnakes PPA on the Azure VM). Confirmed installed:
```
gridstatus          # ERCOT/CAISO/PJM API client
psycopg2-binary     # PostgreSQL driver
numpy pandas scipy  # scientific stack (pandas kept as gridstatus return type)
polars              # primary DataFrame library for all seeders — faster, less RAM
duckdb              # in-process OLAP SQL engine
requests            # HTTP
```
Install command for any missing package:
```bash
~/grid-intelligence/artifacts/pypsa-engine/.venv/bin/pip install <pkg>
```

### Use Polars, not Pandas, for large datasets
Switch all Python seeders and data processing to **Polars** — faster, more memory-efficient, better for bulk operations on 10k–1M+ row datasets. Pandas stays as a fallback only where a library (e.g. gridstatus) requires it.

### Data vintage: use 2025/2026 reports, not 2024
Any reference data from EIA, NREL ATB, ERCOT LTSA, CBRE, etc. should use **2025 or 2026 reports**. The 2024 versions used in Replit are now stale. Update report references during migration.

### Seed verification at seed time
**Every seeder must verify its own output immediately after running.** Don't wait until later — after a week you won't remember what was seeded or whether it was complete. Each seeder should finish with a verification query that checks:
- Row count matches expected range
- No null values in critical columns
- Date/time coverage is complete (no missing months/days)
- Sample spot-check: pull 3–5 known rows and compare against source

### Data strategy: 2025+2026 primary, 2024 optional backfill
Applied uniformly across all datasets:
- **SCED dispatch:** 2025+2026 primary; 2024 backfill is optional (run `seed-on-aws.sh --year 2024` separately)
- **DA/RT nodal/zonal/hub (ERCOT + CAISO):** 2025+2026 primary; 2024 backfill optional. **If data exists from Replit, migrate it rather than re-seeding.**
- Replit data migration takes precedence over re-seeding — avoids redundant API calls and preserves any historical data within the 60-day SCED window.

---

## 1. DA/RT Nodal Price Data at Scale — ZIP64 Parsing & Bundle Architecture

**ERCOT reports:** CDR 13060 (DAM), 13061 (RTM) — annual ZIP64 archives, 200–400 MB compressed.

**Root cause of failures:** ZIP64 uses 64-bit offsets; most Node.js ZIP libraries only read 32-bit fields.
When uncompressed > 4 GB, local header offset = `0xFFFFFFFF` (sentinel). Libraries fall back to wrong offsets → truncated output or "central directory not found".

**Fix:** Custom Node.js ZIP64 extractor — reads from central directory at end of archive (not local headers).
Algorithm: seek to EOCD record → parse ZIP64 EOCD locator → walk central directory entries → use 64-bit offsets to extract. Extracted XLSX piped into `xlsx` for parsing.
**Do not replace this with a ZIP library — they will silently fail on ERCOT's files.**

**CAISO ZIP quirk:** OASIS ATL_PNODE_MAP uses streaming ZIP with `compSize=0` in local headers — same central-directory parsing trick applies.

**Resource node scale (1,100+ nodes):**
- CDR NP6-905-cd (RT), NP4-190-cd (DA) — monthly ZIP bundles, one CSV per month, ~27k rows/month
- Upsert on `(node, year, month)` with unique constraint — idempotent, restartable
- Page size: 100k rows per API call from ERCOT bundle endpoint
- Python + psycopg2 `execute_values` with `page_size=5000` — ~10× faster than ORM inserts (switch inner processing to Polars)
- Gap-fill detection: `COUNT(DISTINCT node) < 900` = incomplete month → re-pull
- Total: 27,193 rows in `ercot_node_stats`, 28 months × 1,108 real resource nodes

**Verification query after seeding:**
```sql
SELECT year, month, COUNT(DISTINCT node) nodes, COUNT(*) rows
FROM ercot_node_stats
GROUP BY year, month
ORDER BY year, month;
-- Expect: ~1,108 nodes per month, ~27k rows per month
```

---

## 2. SCED Dispatch — The 60-Day Window Problem

**ERCOT NP3-965-ER (60-Day SCED Disclosure):** Rolling window — only last 60 days publicly available.

**Silent failure mode:** `gridstatus.get_60_day_sced_disclosure()` for dates > 60 days old returns empty DataFrame silently (no error, zero rows). Seeder "succeeds", logs `rows_inserted = 0`, moves on.
→ Thousands of log entries all showing 0 rows before detection.

**Detection fix:** If seeded date has `rows_inserted < 100`, flag as failed, don't mark complete.

**Gap-fill architecture:**
1. On PyPSA engine startup, spawn daemon thread
2. Query `ercot_dispatch_seed_log` for dates in [Jan 2025, today−60d] with `rows_inserted = 0` or missing
3. For pre-window dates: attempt API, expect zero rows, log as "pre-window, unavailable"
4. For within-60-day window: fetch and insert real data
5. Status via `GET /pypsa/admin/seed-dispatch-status`

**Memory profile:** ~60k–80k rows raw per day (5-min SCED, all resources) → ~16k–19k after hourly aggregation. Peak RSS: 150–200 MB per iteration. Single-threaded by design — parallel fetching would OOM. Use Polars for aggregation step.

**Seeding strategy on AWS:**
- Phase A: 2025-01-01 → today (within/near 60-day window — gets real data)
- Phase B (optional): 2024 backfill — run separately; pre-window dates log as unavailable, not errors

---

## 3. ERCOT & CAISO Public APIs — What's Actually Usable

### ERCOT (no auth for most)
- **CDR 13060/13061**: `misdownload/servlets/mirDownload?doclookupId=...` — direct HTTPS, no token. `doclookupId` per year is static, must be discovered manually from CDR index.
- **NP6-905-cd / NP4-190-cd**: `pubapi.ercot.com/api/2.0/dataproduct/downloadFile` — rate-limits aggressively; add exponential backoff with jitter.
- **CDR 10008 (CRITICAL)**: Bus/node location mapping CSV — bus name → zone → lat/lon. 1,108 resource nodes geocoded. This is the source of truth for all geo-spatial mapping. Must be re-pulled fresh if ERCOT updates it (bus retirements/additions happen annually). Also used for Tier-2 PyPSA bus coordinates.
- **B2C OAuth** (`B2C_1_PUBAPI-ROPC-FLOW`): client credentials → Bearer token via `login.microsoftonline.com`. `ERCOT_CLIENT_ID` + `ERCOT_PASSWORD`.
- **Gotcha:** NP6-345-CD (load by weather zone) returns HTTP 404 even with valid Bearer token — ERCOT removed public access. Use EIA-930 instead.

### CAISO (no auth)
- **OASIS PRC_LMP** (`oasis.caiso.com/oasisapi/SingleZip`): ZIP containing XML, hourly DA LMP. Params: `queryname=PRC_LMP`, `market_run_id=DAM`, `node=TH_SP15_GEN-APND`.
- **Critical limit:** Max 31-day date range per request. Wider range → 114-byte empty ZIP (silent, not an error). Detect by checking response size < 500 bytes.
- **OASIS PRC_HASP_LMP**: Real-time HASP prices. SP15/NP15/ZP26 only; granular nodes need market participant credentials.
- **OASIS ATL_PNODE_MAP**: 1,774 pricing nodes with lat/lon. Streaming ZIP with `compSize=0` — use central-directory parser.

### EIA-930 (free key required)
- `api.eia.gov/v2/electricity/rto/region-sub-ba-data/data/` with `facets[parent][]=ERCO` → 8 ERCOT sub-BA load zones hourly
- `api.eia.gov/v2/electricity/rto/fuel-type-data/data/` with `facets[respondent][]=ERCO` → hourly fuel mix
- Pagination: `offset` + `length`, 5000-row pages
- **Gotcha:** Electricity scope key returns 403 on `v2/natural-gas/*`
- **Report vintage:** Use 2025/2026 EIA AEO and Form 860 — not 2024

### FRED (no key)
- `api.stlouisfed.org/fred/series/observations?series_id=DHHNGSP` → Henry Hub daily spot prices
- Holiday dates return `value: "."` — forward-fill from prior trading day

---

## 4. Transmission Lines & Bus Geo-Location (CRITICAL)

**This data underpins PyPSA Tier-2, the map layer, nodal congestion, and shift factors. Must be flawless.**

- **CDR 10008 (ERCOT):** Primary source for 1,108+ bus lat/lon, zone assignment, bus name. Re-pull annually or after any ERCOT topology update.
- **HIFLD Transmission Lines:** Source for the 345kV topology used in Tier-2 (340-bus network). Cross-reference against ERCOT's own TARA/topology files where possible.
- **Bus shift factors:** Used for all bus-level LMP calculations. ERCOT publishes shift factors — use the official ERCOT published values, not just the B-matrix re-implementation (which is a fallback). Always verify that shift factors sum correctly across buses.
- **Re-implementation of PTDF (PyPSA 1.x removed `calculate_PTDF()`):**
  `Bf = incidence_matrix @ diag(susceptances)`, `B = Bf @ Bf.T`, `PTDF = inv(B) @ Bf`
  Haversine nearest-neighbor maps each 345kV bus → EIA sub-BA zone centroid.

**Verification:** After seeding transmission/bus data, run a sanity check:
- All buses in `ercot_buses` should have non-null lat/lon
- Every settlement point node should map to exactly one bus (no orphans)
- Shift factor matrix should be rank = N_buses − 1 (one slack bus)

---

## 5. PyPSA Engine — Tier Architecture & Critical Bugs

**Architecture:** Standalone FastAPI (Uvicorn, port 8083). Node API reverse-proxies `/pypsa/*`. OPF solves take 2–10s. Long-running process — NOT Lambda-compatible. Runs via PM2 on EC2.

**PyPSA data quality standard: FLAWLESS.** Every input dataset (bus locations, line susceptances, generator capacities, load profiles) must be verified before running any OPF. A wrong impedance value or missing bus silently produces wrong LMPs.

**Two-tier network:**
- **Tier 1 (5-bus):** Abstract ERCOT with 5 buses mapped to real load zones (NORTH, HOUSTON, SOUTH, WEST, PANHANDLE). Fast (<1s), used for all user-facing scenario simulators.
- **Tier 2 (340-bus):** Full ERCOT 345kV topology from HIFLD + CDR 10008. DC OPF (B-matrix). Used for nodal congestion analysis and PTDF shift factors.

**CRITICAL BUG — Tier isolation:**
`simulators.py` must always call `_build_tier1()` directly — NEVER `build_network()`.
`build_network()` routes to Tier-2 if topology data is in DB. Tier-2 bus names don't match short names ("NORTH_WIND", "SOUTH_SOLAR") → 100% curtailment on every scenario. This bug will silently return wrong results.

**OPF Infeasibility:**
HiGHS doesn't raise exception on infeasible OPF — returns silently.
Detection: check `net.buses_t.marginal_price.empty` — if True, solve failed.
Fix: add "emergency peaker" generators at every bus (very high cost, unlimited capacity) — prevents infeasibility, shows very high LMPs instead.

---

## 6. Candidate Rankings — 8-Dimension Scoring, 6 Investment Objectives

**Source data:** EIA Form 860 (update to 2025 vintage — current code uses 2024), 3,875 operable generators across ERCOT, CAISO, PJM.

**The 8 dimensions with default (Risk-Adjusted) weights:**

| # | Dimension | Weight | Data source |
|---|-----------|--------|-------------|
| 1 | Curtailment | 22% | Real neg-price % from ERCOT CDR 13060/13061 (28+ months); CAISO OASIS PRC_LMP; PJM pjm_node_stats (<0.5% neg-price historically) |
| 2 | Congestion | 18% | DA price basis vs hub from real monthly CDR/OASIS data. Queue assignment: haversine nearest-neighbour EIA plant → queue project |
| 3 | Basis Risk | 15% | DA spread: node vs reference hub, from real CDR/OASIS data |
| 4 | Capture Price | 12% | CDR hub DA monthly averages × technology timing ratio (solar diurnal, wind nocturnal, storage spread) |
| 5 | Market Revenue | 10% | MW × CF × capture price × 8,760h |
| 6 | Capacity | 10% | Nameplate MW |
| 7 | Interconnect Risk | 8% | Real queue depth (MW of competing projects) in EIA sub-BA zone — ERCOT GIS Report + CAISO public ISO data |
| 8 | RECs/Yr | 5% | Annual MWh (nameplate × CF) × regional REC price ($3–7/MWh ERCOT, $10–15/MWh CAISO) |

**Scores:** 0–100 per dimension (100 = best). Composite = weighted sum by active objective. Weights vary by objective preset.

**6 investment objective presets:** Risk-Adjusted Value, Lowest LCOE, Corporate Load Hedge, Decarbonisation, Capacity Value, Merchant/Developer Upside. Each reweights the 8 dimensions. Computed client-side as weighted dot product on normalized scores.

**Key assumptions (from app UI):**
- Universe: EIA 860 operable generators >1 MW across ERCOT (ERCO), CAISO (CISO), and PJM balancing authorities
- Capture Price = hub DA monthly average × technology timing ratio
- Mkt Revenue = MW × CF × capture price × 8,760h
- RECs/Yr = annual MWh × market REC price
- Interconnect Risk: powered by real queue depth by zone (not synthetic estimates)

**Use cases documented in app:**
- Developer/Originator: lowest curtailment + congestion → Risk-Adjusted, filter ERCOT + Wind
- PE/Fund Manager: best capture price + lowest basis risk → Lowest LCOE, filter CAISO + Solar
- IPP: queue depth by zone → sort by Congestion dimension
- Investor/Analyst: high RECs + low curtailment for ESG → Decarbonisation, filter by RECs/Yr score

---

## 7. Heat Rate Options — Bachelier vs Black-Scholes

**Why Bachelier:** Spark spread `P − HR × G` can go negative. Black-Scholes (log-normal) breaks for negative forwards. Bachelier (normal distribution) handles negatives — ISDA-recommended for spread options.

**Formula:** `C = e^{-rT} [ F·Φ(d) + σ√T·φ(d) ]` where `d = F/(σ√T)`

**Vol input:** `σ_abs` = annualised std dev of monthly first-differences `ΔS_t = S_t − S_{t-1}` of spark spread. NOT log-returns (undefined when spread crosses zero).

**Current calibration:** HB_NORTH vol at HR=9 ≈ $35/MWh annualised (~169% implied vol). Consistent with ERCOT Winter Storm tail risk.

---

## 8. Generator Stack / Merit Order

**Correction: Includes ALL generator types, not just thermal.** Separate tabs/buttons for: Gas, Solar, Wind, Biomass, and others. Merit-order dispatch applies primarily to dispatchable (thermal) units; renewables shown with their capacity factor profiles.

**Data sources (use 2025 vintage where available):**
- EIA Form 860 Schedule 3: design heat rates in MMBtu/MWh — **update to 2025 survey**
- FERC Form 1 O&M allocations: VOM costs
- EPA CAMPD CEMS: CO₂ intensity = actual emissions ÷ net generation

**Known limitation:** Pure economic dispatch ignores unit commitment (min run times, startup costs, ramp rates). Labelled as "simplified merit-order model" in UI.

**Key finding at current Henry Hub (~$2.50–$3/MMBtu):**
CCGT HR 6,500–7,000 BTU/MWh → marginal cost ~$16–21/MWh.
Coal/lignite HR >12,000 BTU/MWh → uneconomic above ~$1.50/MMBtu.

---

## 9. PPA & VPPA NPV Calculator — P10/P50/P90 Monte Carlo

**Correction: Calculator covers both PPAs (physical/financial) and VPPAs (financial only).** Not VPPA-only.
**Also includes CapEx modelling** so a developer can see complete forward outlook: CapEx + OpEx when valuing a deal or project.

**Structure:** VPPA = financial (Walmart pays fixed strike, receives/pays LMP − strike). PPA = physical or financial delivery at agreed price.

**Model (`GET /api/ppa-npv`):**
- Price path: Ornstein-Uhlenbeck (not GBM — OU produces negatives while mean-reverting). ERCOT negative prices occur ~8–12% of hours in West zone. GBM can't model this.
- Curtailment: % reduction from zone+tech scoring data
- Degradation: 0.5%/yr solar, 0.1%/yr wind (NREL ATB — use 2025/2026 vintage)
- P10/P50/P90: 1,000 simulation paths

**ITC/PTC in `computeFinancials()`:**
- `itcValueM` = 0.30 × total CapEx (IRA domestic content adder available)
- `ptcNpvM` = $27.5/MWh × projected generation × discount factor (10yr)
- `lcoeMwh` = (CapEx × FCR + OpEx) / (annual MWh × CF)

---

## 10. Data Verification Protocol

**Run immediately after each seeder completes. Do not skip.**

| Dataset | Verification query | Expected |
|---------|-------------------|----------|
| SCED dispatch | `SELECT date, rows_inserted FROM ercot_dispatch_seed_log ORDER BY date` | No nulls, rows_inserted > 100 for in-window dates |
| Nodal prices | `SELECT year, month, COUNT(DISTINCT node) FROM ercot_node_stats GROUP BY 1,2` | ~1,108 nodes per month |
| Bus locations | `SELECT COUNT(*) FROM ercot_buses WHERE lat IS NULL OR lon IS NULL` | 0 rows |
| Queue data | `SELECT market, COUNT(*) FROM queue_projects GROUP BY market` | ERCOT ~2k+, CAISO ~2,433 |
| DA/RT hub prices | `SELECT COUNT(*), MIN(datetime), MAX(datetime) FROM ercot_hub_prices` | Continuous date range, no gaps > 1 day |

**Spot-check protocol:** For each newly seeded dataset, pick 3 known reference points from the source (e.g. ERCOT website shows HB_NORTH DA price on a specific date) and verify they match within rounding tolerance. Log the spot-check date and values.

---

## 11. Data Analytics Tab (formerly "Data Quality")

**Tab name: "Data Analytics"** — shows all data sources by market: ERCOT, CAISO, PJM (if available).

Content includes:
- Table of all data sources: name, type, vintage, rows, last updated, source URL
- Online resource links for each market (ERCOT CDR, CAISO OASIS, EIA, FERC, etc.)
- Data completeness indicators (% of expected rows populated)

---

## 12. Methodology / Use Cases / Assumptions Sections

Most important tabs include a 3-part card section at the bottom of the page:
1. **What This Tool Does** (left) — describes the feature, data sources used, what outputs mean
2. **Use Cases** (centre) — 3–4 named personas (Developer/Originator, PE/Fund Manager, IPP, Investor/Analyst) with specific workflow examples
3. **Key Assumptions** (right) — per-dimension or per-model assumptions, data vintage, known limitations

This pattern is confirmed on the Rankings page and several others. **When adding new pages or features, add this 3-card section.** It is critical UX — the platform has many features and without this context users (and the dev after a week) forget how things work.

**Pages confirmed to have this section:** Rankings, (others to be verified)
**Pages that may need it added:** Any new pages built during AWS migration

---

## 13. Regulatory & Tax Data — Keeping It Current

Regulatory/IRA/tax credit data requires **active maintenance**. Strategy:
- ERCOT and CAISO publish rule changes on their websites on an ad hoc basis — need to monitor
- IRA provisions (ITC/PTC rates, domestic content adders, transferability) can change with legislation
- External links (FERC orders, IRS guidance, ISO tariffs) should be verified periodically
- Consider a lightweight "last verified" timestamp on each `regulatory_items` row so stale entries are visible

**To-do:** Design a process for periodic regulatory refresh — ideally quarterly, or when a major rule change is announced.

---

## Summary: Recurring Themes

1. **Public energy APIs have silent failure modes** — validate output size, row counts, and completeness; never trust HTTP 200.
2. **Scale requires memory-per-record thinking early** — ZIP64 parsing, page-size tuning, bulk insert batching all needed to go from 100 nodes to 1,100 nodes. Use Polars, not Pandas.
3. **Financial models need domain-appropriate assumptions** — Bachelier vs Black-Scholes, OU vs GBM, weighted capture prices vs hub averages separate a credible energy analytics tool from a generic dashboard.
4. **Verify data at seed time, not later** — immediate spot-checks against source prevent silent data quality issues from compounding.
5. **Use 2025/2026 data vintages** — 2024 EIA/NREL/ERCOT reports are now stale.
