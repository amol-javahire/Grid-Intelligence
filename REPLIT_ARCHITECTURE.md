# Replit Architecture — Per-Tab Technical Reference

Source of truth for how each tab/page of the Grid Origination Intelligence Platform
works: its data source(s), the DB table(s) it reads, the API route that serves it,
and any calculation logic. Captured from the working Replit deployment so the Azure
migration can rebuild each tab's data faithfully.

**Read alongside:** [CLAUDE.md](CLAUDE.md) (conventions/stack) and
[TECHNICAL_NOTES.md](TECHNICAL_NOTES.md) (deep technical decisions).

> Scope: **Grid Intelligence Platform (ERCOT/CAISO/PJM)** only. The AESO/Alberta app is a
> separate product in the monorepo and is intentionally excluded here.

---

## Migration context (as of 2026-07-22)

The Azure DB is a **partial migration** — only the ERCOT price/dispatch pipeline was
seeded. Populated on Azure: `ercot_hourly_dispatch` (24.9M), `ercot_nodal_da_rt_hourly`
(11.7M, our fresh hourly DA+RT seed), `ercot_node_locations` (819), `queue_projects`
(3,493), `iso_hourly_temps`, `gas_forwards`, `datacenters`, `regulatory_items`,
`caiso_node_stats` (77, partial). **Empty/critical gap:** `candidates` (0 — the whole
PPA screening universe), `generators` (31, should be ~6,163), `screenings`,
`caiso_hub_da_rt_hourly`, `pjm_node_stats`, `gas_prices`, `ercot_buses`, `ercot_lines`,
`load_forecasts`, `temperature_forecasts`.

**Migration plan (executing 2026-07-23+):** `pg_dump --data-only --column-inserts` the
empty tables from Replit → scp to VM → `drizzle-kit push` (create missing) → TRUNCATE
targets → load. `candidates`/`generators` re-seeded from **latest EIA-860** instead of
copied (Replit's are stale).

**Data vintage rules (user directive, 2026-07-22):**
- **ERCOT** stays latest — do NOT overwrite `ercot_hourly_dispatch`, `ercot_nodal_da_rt_hourly`,
  `ercot_node_locations`, `ercot_node_stats`, `ercot_nodal_stats`.
- **EIA** data (`candidates`, `generators`) → re-seed from latest EIA-860 vintage.
- Bulk-load all data first, then revise tab by tab (user checks each tab).

---

## Table → Tab dependency map (migration checklist)

| Table | Feeds these tabs | Azure status |
|-------|------------------|--------------|
| `candidates` | Dashboard, Rankings, Map, Export, QA, RECs, PPA, Generators (non-gas) | **EMPTY — critical** |
| `generators` + `thermal_params` | Generators / Merit Order | 31 rows (stale) |
| `screenings` | Rankings (save), Saved Screenings | empty/missing |
| `ercot_node_stats` | ERCOT Historical, Nodal, all 6 CI pages, Gas/Spark, Heat-Rate | present (360; regen from hourly) |
| `caiso_node_stats` | CAISO Historical, Nodal | 77 (partial) |
| `caiso_hub_da_rt_hourly` | CAISO Hourly | **empty** |
| `ercot_hub_da_rt_hourly` | ERCOT Historical (Hourly Shape) | present |
| `ercot_load_by_zone` | ERCOT Historical (Zone Load) | empty |
| `ercot_hourly_gen_output` | ERCOT Historical (Fuel Mix) | empty |
| `pjm_node_stats` | (PJM historical/scoring) | **empty** |
| `queue_projects` | Queue, Dashboard, Map, RECs, Rankings (Interconnect dim) | 3,493 (ok) |
| `transmission_lines` | Map (lazy layer) | check (HIFLD 23,674) |
| `gas_prices` | ERCOT Gas/Spark, Heat-Rate Options, PyPSA historical | **empty** |
| `gas_forwards` | ERCOT Gas (Forward Curve) | present |
| `regulatory_items` | Regulatory & Tax | present (30) |
| `datacenters` | AI & Datacenters, Map | present (55) |
| `iso_hourly_temps` | Weather (actuals) | present |
| `temperature_forecasts` | Weather (climate forecast) | empty |
| `load_forecasts` | EV Charging, Load Forecast Stress | empty |
| `ercot_buses` / `ercot_lines` / `ercot_bus_shift_factors` | Nodal (shift factors), PyPSA topology | **empty** |
| `mv_dispatch_monthly` | ERCOT Dispatch (supply stack, summary) | **missing MV** |
| `mv_capture_monthly` | ERCOT Dispatch (capacity factor, capture) | rebuilt on ercot_nodal_da_rt_hourly |

Materialized views to (re)create on Azure: `mv_dispatch_monthly` (38,820 rows —
supply-stack/summary), `mv_capture_monthly` (capture — already repointed to
`ercot_nodal_da_rt_hourly`).

---

## GROUP 1 — Core Intelligence

### / — Dashboard
- **API:** `GET /api/dashboard/summary` (candidates: COUNT total/active, SUM capacity_mw, AVG overall_score); `GET /api/dashboard/market-breakdown` (candidates GROUP BY market + asset_type → COUNT, SUM/1000 for GW).
- **Tables:** `candidates`, `queue_projects`.
- **Visuals:** 4 KPI cards (Active Candidates, Total Capacity MW, Avg Score, Queue count); stacked bar ERCOT vs CAISO capacity GW by 8 fuel colours; screening form (Market × Asset Type × Objective → `/rankings` with URL params).

### /rankings — Candidate Rankings
- **API:** `GET /api/candidates?market=&assetType=` → `candidates` (8 score fields + REC fields). Objective re-weighting is **browser-side** (no extra API call).
- **Tables:** `candidates`, `screenings` (save).
- **8 score dimensions (0–100):** Curtailment (`curtailmentScore` — neg_price_percent × asset-type mult), Congestion (`interconnectionScore` — DA basis vs mkt avg + volatility penalty), Basis Risk (`locationScore` — StdDev monthly DA), Capture Price (`priceScore` — hub DA × timing ratio: wind 82% / solar 103% / storage 118%), Capacity (`demandProximityScore` — log-scaled MW), Mkt Revenue (`financialScore` — MW×CF×hub_da×capture×8760, log-scaled), Interconnect Risk (`developmentRiskScore` — queue MW in same zone), RECs/Yr (`environmentalScore` — annual_mwh × rec_price; gas/nuclear=0).
- **6 objectives (weight emphasis):** Risk-Adjusted (Curt 22/Cong 18/Basis 15); Lowest LCOE (Capture 30/Curt 22); Corporate Load Hedge (Curt 30/Cong 22/Basis 18); Decarbonization (Cap 25/Curt 22/REC 20); Capacity Value (Cap 35/Curt 18); Merchant Upside (Capture 35/Basis 20/Rev 18). Score = Σ(dim × weight).
- **Colour bands:** ≥75 emerald · ≥60 teal · ≥45 amber · <45 red.
- **Actions:** Export CSV (8 dims + REC), Save Screening (`POST /api/screenings`), delete, sort.

### /map — Map Workspace
- **APIs/tables:** `GET /api/candidates?limit=5000` (`candidates` — circles by ISO: ERCOT teal/CAISO blue/PJM purple, filter fuel + MW slider log 1–3000); `GET /api/queue-projects` (`queue_projects` — diamonds); `GET /api/transmission-lines?minVoltage=115` (`transmission_lines`, 23,674 HIFLD, **lazy 34MB GeoJSON**, 7 voltage bands); OpenStreetMap Overpass API (data centers, lazy).
- **Filters:** ISO toggle, per-layer fuel, MW slider, voltage bands.

### /screenings — Saved Screenings
- **API:** `GET /api/screenings` → `screenings` (name, market, asset type, objective, candidate ID list, created ts).

### /export — Export Center
- CSV/JSON export with column selection; frontend-driven from loaded `candidates`.

### /qa — Q&A Copilot
- **API:** `POST /api/chat` (streaming SSE). LLM tools: `run_sql` (any table → table/chart), `run_simulation` (PyPSA :8083 → LMP bar + stats), `web_search`, `get_candidate_info` (candidates by name). SSE events: sql_query/sql_done/table/chart/simulation/websearch/content.
- **Tables:** all.

---

## GROUP 2 — Market Data (Historical)

### /ercot — ERCOT Historical
- **Tabs:** DA/RT Prices, On/Off-Peak, Volatility & Neg-Prices (all `ercot_node_stats` via `useListErcotNodeStats({node,year})`, 15 nodes, YoY toggle); Zone Load (`GET /api/ercot/load-by-zone?year=` → `ercot_load_by_zone`, 8 EIA-930 zones); Fuel Mix (`GET /api/ercot/fuel-mix?year=` → `ercot_hourly_gen_output`); Hourly Shape (`GET /api/ercot/hub-hourly?node=&year=&month=` → `ercot_hub_da_rt_hourly`, 24-bar avg DA).

### /caiso — CAISO Historical
- **API:** `useListCaisoNodeStats({node,year})` → `caiso_node_stats`. Nodes NP15/SP15/ZP26, 2024–2026. Sub-tabs: DA vs RT, On/Off-Peak, Volatility & Neg-Prices.

### /caiso-hourly — CAISO Hourly
- **API:** `GET /api/caiso/hub-hourly?node=&year=&month=` + `/coverage` → `caiso_hub_da_rt_hourly` (63,495 rows: 3 nodes × 29 months DA+RT). 24-bar DA / RT / DA−RT basis (|basis|>15 red, >5 amber); coverage grid; monthly stats.

### /nodal — Nodal Analysis
- **APIs/tables:** `useListErcotNodeStats` (2 ERCOT nodes), `useListCaisoNodeStats` (CAISO), `useGetErcotBusShiftFactors()` (340-bus PTDF), `useGetErcotBusLoad()`. Dual-node price compare + basis spread; CAISO zone compare; DA/RT/spread toggle.
- **Tables:** `ercot_node_stats`, `caiso_node_stats`, `ercot_bus_shift_factors`.

### /ercot-dispatch — ERCOT Dispatch / SCED
- **4 tabs:** Supply Stack (`GET /api/ercot/dispatch/supply-stack?date=` → `ercot_hourly_dispatch` via **`mv_dispatch_monthly`**; merit-order step chart); Monthly Summary (`GET /api/ercot/dispatch/summary` → `mv_dispatch_monthly`, 38,820 rows); Capacity Factor + Capture Price (`GET /api/ercot/dispatch/capture` → **`mv_capture_monthly`**). CF = SUM(gen_mwh)/(MAX(hsl_mw)×hours). 1,215 resources, offer sentinels −$250/$5,000 stripped.
- **Note:** this is the tab we've been repointing to `ercot_nodal_da_rt_hourly` (Capture Prices/Rates + Capacity Factors slider). `mv_dispatch_monthly` still needs creating on Azure.

### /ercot-gas — ERCOT Gas & Spark Spread
- **5 tabs:** Gas Prices (`gas_prices` — HH & Waha, Waha basis), Spark Spread (`gas_prices` + `ercot_node_stats` — Power DA − gas×heat_rate), Heat Rate (Power DA / gas ×1000; CCGT 6500–7500, CT 9000–11000), Forward Curve (`gas_prices` + forwards — synthetic power fwd = gas_fwd × HR × seasonal), Multi-Node Summary.
- **Waha note:** avg −$1.01/MMBtu TTM; `LZ_WEST` & `HB_PAN` use Waha not HH in scoring.

---

## GROUP 3 — Congestion Intelligence (all → `ercot_node_stats`, `/api/congestion-intel/*`)

- **/ci — Overview:** thresholds |RT−DA basis| >$3 congestion / >$15 severe / >$35 extreme; 4 KPIs; monthly stacked severity bar (~800 nodes × 29 mo).
- **/ci-heatmap:** node × month heat-map, cell = avg DA basis, click → node series.
- **/ci-node:** single-node DA/RT/basis line + on/off-peak + neg-price count.
- **/ci-basis:** multi-node basis scatter+line vs HB_BUSAVG.
- **/ci-backtest:** merchant revenue backtest (DA × CF × MW vs hub avg).
- **/ci-quality:** node × month coverage grid, flags <900 nodes/month.
- **/ci-methodology:** static (CDR 13060 / CDR 12301 sources, formulas).

---

## GROUP 4 — PyPSA Simulators (all → PyPSA microservice `/pypsa/*`, port 8083)

- **/pypsa-network — Network OPF:** `POST /pypsa/opf`, `/pypsa/default`, `/pypsa/gas-price?date=`. Scenario or Historical (real gas from `gas_prices`). 5-bus ERCOT (NORTH/WEST/PAN/SOUTH/HOUSTON), 6 corridors. Outputs LMP/bus, flow%, dispatch table, system stats. Leaflet map.
- **/pypsa-curtailment:** `POST /pypsa/curtailment`. Load/wind/solar/gas + West overbuild. Curtailed MW/%, zone summary, neg-price buses.
- **/pypsa-tx-relief:** `POST /pypsa/tx-relief`. Upgrade a corridor 0–200% → baseline vs upgraded LMP/loading, congestion-rent & spread reduction.
- **/pypsa-scarcity:** `POST /pypsa/scarcity`. Peak 45–85 GW, wind/solar/gas/nuclear derate, VOLL $5,000. Reserve margin, load shed, LMP→VOLL, zone risk radar. Uri analog (wind 4%, gas derate 40%).
- **/pypsa-battery:** `POST /pypsa/battery`. Storage bus/MW/MWh/eff, hub, year/month. Hourly charge/discharge/SoC, DA/RT/effective price, arbitrage revenue, annual estimate.
- **/pypsa-expansion:** `POST /pypsa/expansion`. Periods [2026,2028,2030,2032], NREL ATB 2024 CAPEX. New builds/period, CAPEX, avg LMP, unserved %, discounted system cost.

---

## GROUP 5 — Interconnection & Stack

### /queue — Interconnection Queue
- **API:** `GET /api/queue-projects?market=&status=&fuelType=` → `queue_projects` (real ERCOT GIS + CAISO, 1,793 ERCOT); `GET /api/queue/summary`. Donut by fuel, bar by market, table (Queue ID, name, fuel, MW, status, county, request date, COD, REC $).

### /generators — Generators & Merit Order
- **APIs/tables:** `GET /api/generators/merit-order?gasPrice=&co2Price=` → `generators` + `thermal_params` (31 ERCOT thermal); `GET /api/candidates?assetType=` → `candidates` (7 fuel tabs).
- **Merit math:** MC = (gas×heat_rate/1000) + vom + (co2_rate×co2_price); supply stack cumulative MW vs offer price; demand slider 5–30 GW → price-setter.

---

## GROUP 6 — Market Intelligence

### /recs — RECs
- **APIs:** `useListCandidates()` (REC-eligible fuels), `useListQueueProjects()`. Fields: rec_eligible (gas/nuclear=false), annual_rec_mwh = cap×CF×8760, rec_price (ERCOT TRC ~$1.50, CAISO WREGIS ~$10–12), annual_rec_value, lifetime 20yr. Bar $M by fuel, pie MW by fuel.

### /regulatory — Regulatory & Tax Intelligence
- **API:** `GET /api/regulatory?market=` + `/summary` → `regulatory_items` (30: 10 ERCOT, 8 CAISO, 12 Federal/IRA). Categories, impact levels, IRA quick-ref cards (ITC 30%+adders, PTC $27.50/MWh, storage ITC, domestic +10%, energy communities +10%).

### /ppa — PPA / VPPA Calculator
- **API:** `GET /api/ppa-npv` → P10/P50/P90 Monte Carlo VPPA NPV. Inputs: candidate, strike, term, discount, vol, CF override. NPV = Σ[cap×CF×8760×(price_sim − strike)]/(1+r)^t. `computeFinancials()` adds lcoe, capex_m, itc_m, ptc_npv_m per candidate. CAPEX benchmarks hardcoded (NREL ATB 2024 / Lazard v17).
- **Table:** `candidates`.

### /heat-rate-options — Heat Rate Options
- **API:** `GET /api/gas-prices/spark-spread-options` → `gas_prices` + `ercot_node_stats`. **Bachelier** pricer (browser): F = Power_DA − HR×gas; premium/Greeks. Curves: premium/delta/vega vs strike, implied HR vs realised vol scatter.

---

## GROUP 7 — Load & Demand Intelligence

### /weather — Weather & Temperature
- **APIs:** `useGetTemperature` / `useGetTemperatureStats` → `iso_hourly_temps` (21,168/zone: 8 ERCOT + 3 CAISO); `useGetTemperatureForecast` / overview → `temperature_forecasts` (12,056, Jul 2026–Jun 2029). Sub-tabs: daily avg, hourly profile, monthly stats (HDD/CDD), climate forecast (+0.3°F/yr).

### /ev-charging — EV Charging Load
- **API:** `GET /api/load-forecast/overview` → `load_forecasts` (`ev_mw` col). EV projections hardcoded (ERCOT 380K→830K EVs by 2029 @1.51kW; CAISO 1.9M→3.55M @1.40kW). Zone breakdown bars.

### /datacenters — AI & Datacenters
- **API:** `GET /api/datacenters` → `datacenters` (55: ERCOT/CAISO/PJM). Fields: name, operator, market, state, lat/lon, MW, status, COD, zone. KPI cards + state×status bar.

### /load-forecast-stress — Load Forecast Stress Test
- **APIs:** `GET /api/load-forecast/daily?market=` → `load_forecasts` (8,768 rows: 8 ERCOT zones × 1,096 days; base_mw/ev_mw/dc_mw/total_mw); `POST /pypsa/scarcity` at forecast peak. Zone→hub map (HOUSTON=COAS+EAST, NORTH=NCEN+NRTH, WEST=FWES+WEST, SOUTH=SCEN+SOUT). Nameplate: Wind 38,566.7 / Solar 22,171.5 / Gas 96,241 MW.
