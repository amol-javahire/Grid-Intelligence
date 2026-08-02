# Modelling AESO — Full Build Specification

## Project Name
**Modelling AESO**
Tagline: *Alberta Power Market Intelligence & Congestion Modelling Platform*

---

## What You Are Building

A full-stack power market analytics platform for the **Alberta Electric System Operator (AESO)** — Alberta's equivalent of ERCOT. AESO is in the middle of its **Energy Market Enhancements (EME)** project: transitioning from a single-node pool-price market to locational marginal pricing (LMP) and nodal congestion management, exactly what ERCOT completed over a decade ago. This platform models that transition using **PyPSA**, pulls all available **real public AESO data** (pool prices, supply/demand, generation, interconnection queue, congestion data), and presents it through a professional dark-navy analytics UI.

The platform has two target users:
1. **Power developers / project financiers** — evaluating greenfield wind/solar/storage sites in Alberta, screening interconnection queue depth, modelling LMP exposure under the coming nodal regime.
2. **Energy traders / portfolio managers** — tracking pool price dynamics, supply/demand fundamentals, constrained generation events, and building forward curves with PyPSA OPF.

---

## Stack (identical to Grid Origination Intelligence Platform — follow the same monorepo conventions)

| Layer | Choice |
|-------|--------|
| Monorepo | pnpm workspaces |
| Node | 24 |
| TypeScript | 5.9 |
| API framework | Express 5 |
| Database | PostgreSQL + Drizzle ORM |
| Validation | Zod (zod/v4), drizzle-zod |
| API codegen | Orval (from OpenAPI spec) |
| Build | esbuild (CJS bundle) |
| Frontend | React 18 + Vite + Tailwind CSS + shadcn/ui |
| Charts | Recharts |
| Maps | React Leaflet + OpenStreetMap |
| Routing | Wouter |
| Data fetching | TanStack Query (generated Orval hooks) |
| Python microservice | FastAPI + PyPSA + HiGHS LP solver (separate artifact, /pypsa path) |

**Design language:** Dark navy `#0f172a`, amber `#f59e0b`, teal `#14b8a6`, purple `#8b5cf6`. Same shadcn/ui dark theme, same sidebar layout with collapsible groups.

---

## Pages

| Path | Purpose |
|------|---------|
| `/` | Dashboard — pool price summary, generation mix donut, peak demand stats, 7-day capacity widget, market alerts |
| `/pool-price` | Historical Pool Price — hourly/daily/monthly AESO pool price (2024–present), volatility and spike analysis |
| `/supply-demand` | Supply & Demand Fundamentals — hourly AIL, available capacity, reserve margin, interchange |
| `/generation` | Generation Mix — hourly/monthly breakdown by fuel type (gas, coal, wind, solar, hydro, storage) |
| `/outages` | Outage Tracker — planned and forced generator outages (monthly forecast + daily actuals), capacity impact |
| `/7day-capacity` | 7-Day Capacity Outlook — forward-looking hourly available capability by fuel type, reserve margin forecast |
| `/wind-solar-forecast` | Wind & Solar Forecasting — AESO T-4h/T-1h forecasts vs actuals, forecast error analysis, ML accuracy |
| `/interconnection` | Interconnection Queue — Alberta generation projects awaiting connection, by type, MW, status |
| `/congestion` | Congestion Intelligence — AESO constrained-up/down generation events, transmission constraint analysis |
| `/nodal` | Nodal Transition Tracker — EME project timeline, simulated LMP spread analysis, readiness assessment |
| `/pypsa-network` | PyPSA Alberta Network — 15-bus reduced-order Alberta network, transmission topology viz, OPF results |
| `/pypsa-opf` | OPF Dispatch Simulator — interactive load/wind/solar CF sliders, real-time LMP spread output |
| `/pypsa-ml` | ML Congestion Model — XGBoost trained on pool price volatility + constraint events, feature importance |
| `/pypsa-scarcity` | Scarcity & Price Spike Model — high-price event analysis ($500–$999.99/MWh VOLL) |
| `/screening` | Project Screening — filter generation projects by zone, fuel type, capacity, congestion risk |
| `/map` | Map Workspace — Alberta generation projects on Leaflet map, transmission lines, constraint zones |
| `/guide` | Platform Guide — explains AESO market structure, EME transition, data sources |
| `/qa` | Q&A Copilot — LLM chat interface (planned: OpenAI + DB RAG, seeded with AESO market-updates text) |
| `/export` | Export Center — top project cards + CSV export |

---

## AESO Data Sources (All Public, No Authentication Required)

### 1. Pool Price — Hourly Historical
**URL pattern:** `http://ets.aeso.ca/ets_web/ip/Market/Reports/CSDReportServlet?contentType=html&reportCode=SCHED_CSD&beginDate=YYYY-MM-DD&endDate=YYYY-MM-DD`
- Contains: hourly pool price ($/MWh), settlement period, date
- Coverage: 2000–present; target Jan 2024–present
- Alternative bulk download: https://www.aeso.ca/market/market-and-system-reporting/data-requests/hourly-metered-volumes-and-pool-price-and-ail-data-2010-to-2023/
  - Returns ZIP of CSV files for each year
  - Columns: `Date`, `Hour Ending (HE)`, `Pool Price ($/MWh)`, `Forecast Pool Price`, `Alberta Internal Load (MW)`, `Net Generation (MW)`
- AESO pool price is capped at $999.99/MWh (Value of Lost Load / VOLL)
- Target: ~22,000 rows (Jan 2024–present, hourly)

### 2. Supply/Demand Fundamentals — Hourly
**Same CSD report or:** https://www.aeso.ca/market/market-and-system-reporting/supply-and-demand-report/
- Alberta Internal Load (AIL) in MW — total provincial demand
- Available Capacity (MW) — sum of all available generation
- Interchange (MW) — net import/export to BC, Saskatchewan
- Spinning Reserve, Operating Reserve
- Target table: `aeso_supply_demand` — hourly rows with AIL, net_gen, available_cap, interchange, reserve_margin

### 3. Generation Mix — Hourly by Fuel Type
**URL:** https://www.aeso.ca/market/market-and-system-reporting/generation-mix-report/
- Fuel types: Gas (CC + simple cycle), Coal, Wind, Solar, Hydro, Biomass/Other, Energy Storage
- Public CSV/API: http://ets.aeso.ca/ets_web/ip/Market/Reports/CSDReportServlet with generation mix report codes
- Also available as hourly metered volumes by fuel category
- Target table: `aeso_hourly_gen_output` — columns: `date`, `hour`, `gas_mw`, `coal_mw`, `wind_mw`, `solar_mw`, `hydro_mw`, `storage_mw`, `other_mw`, `total_mw`

### 4. Constrained Generation — Congestion Events
**URL:** https://www.aeso.ca/market/market-and-system-reporting/constrained-down-generation/
- Also: https://congestion.aeso.ca/ — real-time and historical transmission constraints
- Constrained-down generation: generators paid to reduce output due to transmission limits
- Constrained-up generation: generators paid to increase output despite being uneconomic
- Key fields: constraint event, MW constrained, start/end time, transmission corridor, cost
- Target table: `aeso_constraint_events` — date, hour, constraint_type (up/down), corridor, mw_constrained, cost_cad

### 5. Interconnection Queue
**Source:** https://www.aeso.ca/grid/connecting-to-the-grid/connection-project-reporting/
- Active, approved, and historical connection projects
- Fields: project name, type (wind/solar/gas/storage), MW, county/region, queue position, in-service date, status
- Also check: https://www.interconnection.fyi/?market=AESO (aggregated queue data)
- Target table: `aeso_queue_projects` — name, fuel_type, capacity_mw, region, status, queue_date, expected_online

### 6. Actual vs Forecast — Wind, Market Resource Query Hourly (WMRQH)
**URL:** `http://ets.aeso.ca/ets_web/ip/Market/Reports/ActualForecastWMRQHReportServlet`
- Real-time and historical comparison of actual vs forecast for: pool price, AIL, wind generation, solar generation
- Key for measuring forecast accuracy and building ML features (forecast error is a strong price spike predictor)
- HTML report; scrape or download as CSV
- Target table: `aeso_actual_forecast` — date, hour_ending, actual_pool_price, forecast_pool_price, actual_wind_mw, forecast_wind_mw, actual_ail_mw, forecast_ail_mw, actual_solar_mw, forecast_solar_mw
- **Use in:** Wind/Solar Forecasting page, pool price spike ML model (forecast_error feature)

### 7. Market Updates
**URL:** https://www.aeso.ca/market/market-updates/
- Narrative updates from AESO on market conditions, price events, EME progress, grid events
- Scrape as text for the Q&A Copilot RAG corpus and for the "Market Alerts" sidebar widget on the dashboard
- Not a structured data source; use for LLM context enrichment only

### 8. Monthly Outage Forecast
**URL:** `http://ets.aeso.ca/ets_web/ip/Market/Reports/MonthlyOutageForecastReportServlet?contentType=html`
- Planned generator outages by month, by facility, with MW offline and reason
- Critical for available capacity forecasting and reserve margin analysis
- Fields: facility name, fuel type, planned outage start, end, MW offline, reason
- Target table: `aeso_outages` — facility, fuel_type, outage_start, outage_end, mw_offline, outage_type (planned/forced), reason
- **Use in:** Outage Tracker page, reserve margin forecasting, supply/demand forward curve

### 9. Daily Outage Report
**URL:** `http://ets.aeso.ca/ets_web/ip/Market/Reports/DailyOutageReportServlet?contentType=html`
- Same as Monthly Outage Forecast but day-ahead granularity; includes both planned and forced outages
- More timely signal for next-day capacity margin
- Upsert into `aeso_outages` table (same schema as Monthly Outage Forecast above)
- **Seeder note:** Run daily to keep current-day outage data fresh

### 10. Seven-Day Hourly Available Capability Forecast
**URL:** `http://ets.aeso.ca/ets_web/ip/Market/Reports/SevenDaysHourlyAvailableCapabilityReportServlet?contentType=html`
- 7-day ahead, hour-by-hour available generation capability by fuel type
- This is the forward-looking version of the supply/demand fundamentals report
- Key for identifying upcoming tight reserve margin periods (predictive congestion risk)
- Fields: hour_ending, gas_mw, wind_mw, solar_mw, hydro_mw, storage_mw, total_mw, net_available_mw
- Target table: `aeso_7day_capability` — forecast_date, target_date, hour_ending, gas_mw, wind_mw, solar_mw, hydro_mw, total_available_mw, ail_forecast_mw, reserve_margin_pct
- **Use in:** 7-Day Capacity Outlook page, reserve margin alert widget on dashboard
- **Seeder note:** Upsert daily; keep 30 days of forecasts to track forecast accuracy over time

### 11. Wind and Solar Power Forecasting
**URL:** https://www.aeso.ca/grid/grid-planning/forecasting/wind-and-solar-power-forecasting/
- AESO's official wind and solar generation forecasting methodology and published forecast data
- Includes T-4h (4-hour ahead) and T-1h (1-hour ahead) forecasts for total wind + solar fleet
- **Key insight:** Wind forecast errors > ±500 MW are a strong predictor of price spikes; solar ramps drive afternoon duck-curve events
- Use this page's published forecast CSVs to populate `aeso_actual_forecast` (supplement to WMRQH servlet above)
- Also document AESO's forecast methodology in the Platform Guide for user context
- **Use in:** Wind/Solar Forecast Accuracy page, ML congestion model features

### 12. Dispatcho (Third-party AESO data aggregator)
**URL:** https://www.dispatcho.app/
- Commercial aggregator of AESO real-time and historical data with clean API-style access
- Use as a **fallback reference** to validate scraped ETS portal data and cross-check any parsing anomalies
- Do NOT use as a primary data source (commercial, may have terms-of-service restrictions)
- Useful for: manually verifying specific price events, checking outage data completeness, understanding data format quirks before writing scrapers

### 13. Annual Market Statistics
**URL:** https://www.aeso.ca/assets/Uploads/market-and-system-reporting/Annual-Market-Stats-2024.pdf
- Annual report with: average pool price by month, peak demand, generation by fuel, interconnection summary
- Use this to validate seeded data and populate summary stats on the dashboard

### 14. Transmission Capability
**URL:** https://www.aeso.ca/grid/connecting-to-the-grid/transmission-capability-map/
- Transmission capability map showing MW headroom on major corridors
- Key corridors: North-South 500kV backbone, Calgary area, Edmonton area, BC interties, SK interties
- Target: seeded as `aeso_transmission_corridors` table with corridor name, voltage, summer/winter MW capability, current loading

---

## Database Schema

```sql
-- Core pool price (primary time series — the AESO equivalent of ERCOT hub nodes)
CREATE TABLE aeso_hourly_pool_price (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  hour_ending INTEGER NOT NULL,  -- 1-24 (Alberta uses HE convention)
  pool_price NUMERIC(10,4),      -- $/MWh, capped at 999.99
  forecast_pool_price NUMERIC(10,4),
  ail_mw NUMERIC(10,2),          -- Alberta Internal Load
  net_gen_mw NUMERIC(10,2),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (date, hour_ending)
);

-- Hourly generation mix by fuel type
CREATE TABLE aeso_hourly_gen_output (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  hour_ending INTEGER NOT NULL,
  gas_mw NUMERIC(10,2),
  coal_mw NUMERIC(10,2),
  wind_mw NUMERIC(10,2),
  solar_mw NUMERIC(10,2),
  hydro_mw NUMERIC(10,2),
  storage_mw NUMERIC(10,2),
  other_mw NUMERIC(10,2),
  total_mw NUMERIC(10,2),
  UNIQUE (date, hour_ending)
);

-- Supply & demand fundamentals
CREATE TABLE aeso_supply_demand (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  hour_ending INTEGER NOT NULL,
  ail_mw NUMERIC(10,2),             -- Alberta Internal Load
  available_capacity_mw NUMERIC(10,2),
  reserve_margin_pct NUMERIC(6,2),
  bc_interchange_mw NUMERIC(10,2),  -- positive = import
  sk_interchange_mw NUMERIC(10,2),
  net_interchange_mw NUMERIC(10,2),
  UNIQUE (date, hour_ending)
);

-- Congestion / constrained generation events
CREATE TABLE aeso_constraint_events (
  id SERIAL PRIMARY KEY,
  event_date DATE NOT NULL,
  hour_ending INTEGER,
  constraint_type VARCHAR(10) NOT NULL,  -- 'up' or 'down'
  corridor VARCHAR(100),
  facility VARCHAR(200),
  mw_constrained NUMERIC(10,2),
  cost_cad NUMERIC(12,2),
  reason TEXT
);

-- Interconnection queue
CREATE TABLE aeso_queue_projects (
  id SERIAL PRIMARY KEY,
  project_name VARCHAR(300),
  fuel_type VARCHAR(50),       -- wind, solar, gas, storage, hydro
  capacity_mw NUMERIC(10,2),
  region VARCHAR(100),          -- Northern AB, Central AB, Southern AB, Calgary, Edmonton
  county VARCHAR(100),
  status VARCHAR(50),           -- active, approved, withdrawn, completed
  queue_date DATE,
  expected_online DATE,
  transmission_connection VARCHAR(200),
  lat NUMERIC(10,6),
  lng NUMERIC(10,6)
);

-- Transmission corridors
CREATE TABLE aeso_transmission_corridors (
  id SERIAL PRIMARY KEY,
  corridor_name VARCHAR(200),
  voltage_kv INTEGER,
  summer_capability_mw NUMERIC(10,2),
  winter_capability_mw NUMERIC(10,2),
  typical_loading_pct NUMERIC(6,2),
  constraint_frequency VARCHAR(50),  -- rare/occasional/frequent/chronic
  notes TEXT
);

-- Actual vs Forecast (WMRQH + Wind/Solar Forecasting pages)
CREATE TABLE aeso_actual_forecast (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  hour_ending INTEGER NOT NULL,       -- 1-24 (HE convention)
  actual_pool_price NUMERIC(10,4),
  forecast_pool_price NUMERIC(10,4),
  price_forecast_error NUMERIC(10,4) GENERATED ALWAYS AS (actual_pool_price - forecast_pool_price) STORED,
  actual_ail_mw NUMERIC(10,2),
  forecast_ail_mw NUMERIC(10,2),
  actual_wind_mw NUMERIC(10,2),
  forecast_wind_mw NUMERIC(10,2),
  wind_forecast_error_mw NUMERIC(10,2) GENERATED ALWAYS AS (actual_wind_mw - forecast_wind_mw) STORED,
  actual_solar_mw NUMERIC(10,2),
  forecast_solar_mw NUMERIC(10,2),
  solar_forecast_error_mw NUMERIC(10,2) GENERATED ALWAYS AS (actual_solar_mw - forecast_solar_mw) STORED,
  source VARCHAR(50),                 -- 'wmrqh' or 'aeso_forecast'
  UNIQUE (date, hour_ending)
);

-- Generator outages (monthly forecast + daily actuals)
CREATE TABLE aeso_outages (
  id SERIAL PRIMARY KEY,
  facility VARCHAR(200) NOT NULL,
  fuel_type VARCHAR(50),              -- gas, wind, solar, hydro, storage
  outage_type VARCHAR(20),            -- planned, forced, derated
  outage_start TIMESTAMP NOT NULL,
  outage_end TIMESTAMP,
  mw_offline NUMERIC(10,2),
  reason TEXT,
  source VARCHAR(30),                 -- 'monthly_forecast' or 'daily_report'
  reported_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX ON aeso_outages (outage_start);
CREATE INDEX ON aeso_outages (fuel_type);

-- 7-day hourly available capability forecast
CREATE TABLE aeso_7day_capability (
  id SERIAL PRIMARY KEY,
  forecast_date DATE NOT NULL,        -- date the forecast was published
  target_date DATE NOT NULL,          -- date being forecast
  hour_ending INTEGER NOT NULL,       -- 1-24
  gas_mw NUMERIC(10,2),
  wind_mw NUMERIC(10,2),
  solar_mw NUMERIC(10,2),
  hydro_mw NUMERIC(10,2),
  storage_mw NUMERIC(10,2),
  other_mw NUMERIC(10,2),
  total_available_mw NUMERIC(10,2),
  ail_forecast_mw NUMERIC(10,2),
  reserve_margin_pct NUMERIC(6,2),
  UNIQUE (forecast_date, target_date, hour_ending)
);
```

---

## PyPSA Alberta — Python Microservice

### Background
PyPSA has an official Alberta example network. Key facts:
- Alberta is a **single-node market** today (pool price = one price for all of AB)
- AESO's **Energy Market Enhancements (EME)** will introduce locational marginal pricing — essentially the same nodal transition ERCOT made
- The Alberta transmission system has ~240 buses at 138kV+ based on public AESO data
- Key generation zones: **Southern Alberta** (wind-heavy: Pincher Creek, Lethbridge corridor), **Central Alberta** (gas peakers, Edmonton), **Northern Alberta** (gas baseload, Fort McMurray area), **BC intertie** (hydro import)
- Wind capacity factor in southern AB can exceed 45% (Chinook corridor)

### Reduced-Order Network (15-bus model for OPF)
Model Alberta as 15 buses representing transmission constraint zones:
| Bus | Region | Dominant fuel | Key constraint |
|-----|---------|---------------|----------------|
| BUS_SOUTH | Southern AB (Lethbridge/Pincher Creek) | Wind | N-S export limit |
| BUS_CALGARY | Calgary metro | Gas CC + storage | Load centre |
| BUS_CENTRAL | Red Deer / central corridor | Gas + wind | Mid-province |
| BUS_EDMONTON | Edmonton metro | Gas CC | Load centre |
| BUS_NORTHWEST | Northwest AB | Gas | Northern export |
| BUS_NORTHEAST | Fort McMurray / oil sands | Gas | Heavy industrial |
| BUS_BC | BC intertie (Cranbrook) | Hydro import | Intertie limit |
| BUS_SK | Saskatchewan intertie | Gas/coal | Intertie limit |
| BUS_SOLAR_S | Southern solar zone | Solar | Duck curve risk |
| BUS_WIND_S1 | Pincher Creek wind cluster | Wind | 1,200 MW installed |
| BUS_WIND_S2 | Lethbridge/Taber wind cluster | Wind | 800 MW installed |
| BUS_WIND_N | Peace River/northern wind | Wind | Growing pipeline |
| BUS_STORAGE | Distributed storage nodes | Storage | Peak shaving |
| BUS_HYDRO | Run-of-river hydro (Oldman, etc.) | Hydro | Low capacity factor |
| BUS_PEAKER | Simple cycle gas peakers (system-wide) | Gas CT | Scarcity pricing |

### Key Transmission Lines (with MW limits)
- BUS_SOUTH → BUS_CALGARY: 1,200 MW (chronically constrained during high-wind events)
- BUS_SOUTH → BUS_CENTRAL: 800 MW
- BUS_CALGARY → BUS_CENTRAL: 2,400 MW (500kV backbone)
- BUS_CENTRAL → BUS_EDMONTON: 2,400 MW (500kV backbone)
- BUS_EDMONTON → BUS_NORTHEAST: 1,600 MW
- BUS_BC: ±1,000 MW (net intertie limit)
- BUS_SK: ±150 MW (small intertie)
- BUS_NORTHWEST → BUS_EDMONTON: 800 MW

### FastAPI Endpoints (Python microservice, port 8083, path /pypsa)
```
GET  /pypsa/healthz                  — health check
GET  /pypsa/network                  — 15-bus topology + current line loading
POST /pypsa/opf                      — run OPF with input params (load_mw, wind_cf, solar_cf, gas_price_gj)
GET  /pypsa/opf/default              — pre-computed baseline OPF result
GET  /pypsa/congestion               — simulated LMP spreads by scenario
POST /pypsa/ml/predict               — predict pool price spike probability
GET  /pypsa/ml/importance            — XGBoost feature importance
GET  /pypsa/ml/accuracy              — model evaluation metrics
GET  /pypsa/scenarios                — list of named OPF scenarios (base/high-wind/scarcity/EME-nodal)
```

### OPF Input Parameters (POST /pypsa/opf)
```json
{
  "load_mw": 10500,           // Alberta Internal Load (avg ~11,000 MW)
  "wind_cf": 0.35,            // fleet-wide wind capacity factor
  "solar_cf": 0.20,           // fleet-wide solar capacity factor  
  "gas_price_gj": 3.50,       // AECO-C natural gas price (C$/GJ)
  "coal_online": false,        // coal fleet status (phase-out 2023)
  "bc_import_mw": 400,        // BC intertie schedule
  "south_north_limit_mw": 1200 // configurable transmission cap
}
```

### ML Model Features (XGBoost for price spike prediction)
- `hour_ending` — hour of day (1–24)
- `day_of_week` — 0–6
- `month` — 1–12
- `ail_mw` — Alberta Internal Load
- `wind_penetration_pct` — wind_mw / ail_mw × 100
- `solar_penetration_pct` — solar_mw / ail_mw × 100
- `gas_price_gj` — AECO-C spot price
- `reserve_margin_pct` — (available_cap - ail) / ail × 100
- `rolling_24h_avg_price` — trailing 24-hour average pool price
- `bc_interchange_mw` — positive = import from BC
- `is_cold_weather` — below -20°C flag (Alberta extreme cold demand surges)
- Target: `is_spike` — pool price > $200/MWh (binary classification), and `pool_price` (regression)

---

## Seeder Scripts

### seed-aeso-pool-price.ts
- Download bulk ZIP from AESO data requests page (hourly pool price + AIL 2024)
- Parse CSV: columns `Date`, `Hour Ending (HE)`, `Pool Price ($/MWh)`, `AIL (MW)`, `Net Generation (MW)`
- Handle Alberta timezone (Mountain Time, UTC-7 summer / UTC-6 winter)
- Hour Ending (HE) convention: HE1 = midnight-1am, HE24 = 11pm-midnight
- Insert into `aeso_hourly_pool_price` with ON CONFLICT DO NOTHING
- Target: ~22,000 rows (Jan 2024–present)

### seed-aeso-generation-mix.ts
- Source: AESO ETS CSD report or generation mix CSV downloads
- Hourly fuel-type breakdown from Jan 2024
- Target: ~22,000 rows in `aeso_hourly_gen_output`

### seed-aeso-queue.ts
- Parse AESO connection project reporting page (public HTML/CSV)
- Geocode project county to lat/lng using Alberta county centroids lookup table
- Insert into `aeso_queue_projects`

### seed-aeso-actual-forecast.ts
- Source: `ActualForecastWMRQHReportServlet` — scrape HTML table for each day
- Supplement with AESO wind/solar power forecasting CSV downloads
- Populate `aeso_actual_forecast` with actual vs forecast for pool price, AIL, wind, solar
- Target: ~22,000 rows (Jan 2024–present)
- **Note:** Computed columns (forecast errors) are GENERATED ALWAYS — no manual calculation needed

### seed-aeso-outages.ts
- Source 1: `MonthlyOutageForecastReportServlet` — scrape monthly planned outage table
- Source 2: `DailyOutageReportServlet` — scrape daily outage schedule
- Parse facility name, fuel type, start/end, MW offline, outage type
- Upsert into `aeso_outages` with idempotency on (facility, outage_start, outage_type)
- **Run order:** Monthly forecast first (bulk historical), then daily for current data

### seed-aeso-7day-capability.ts
- Source: `SevenDaysHourlyAvailableCapabilityReportServlet`
- Scrape the HTML table: 168 rows (7 days × 24 hours) per run
- Store with `forecast_date = today` and `target_date = each forecast day`
- Run daily via cron to build a historical record of forecast accuracy over time
- Target: rolling 30-day window of forecasts in `aeso_7day_capability`

---

## Key AESO Market Facts to Encode in the UI

| Fact | Value |
|------|-------|
| Pool price cap (VOLL) | $999.99/MWh |
| Average pool price 2024 | ~$60–85/MWh (was ~$120+ during 2022 energy crisis) |
| Peak Alberta Internal Load | ~12,800 MW (winter cold snap) |
| Typical AIL | 9,000–11,500 MW |
| Coal phase-out completed | 2023 (Sheerness decommissioned) |
| Wind installed capacity | ~4,500 MW (mostly southern AB) |
| Solar installed capacity | ~700 MW (growing rapidly) |
| Gas fleet | ~10,000 MW (baseload CC + peakers) |
| BC intertie limit | ±1,000 MW |
| SK intertie limit | ±150 MW |
| EME nodal transition target | 2026–2027 (AESO Energy Market Enhancements) |
| South-to-Calgary corridor | Chronically constrained during high-wind events |
| AECO-C gas reference price | Henry Hub + basis (~USD $0.50–2.50/MMBtu differential) |

---

## Dashboard Stats Cards (Homepage)

Show these live from the DB on the dashboard:
1. **Current Pool Price** — latest hour pool price ($/MWh) with 24h trend arrow
2. **Alberta Internal Load** — current AIL (MW) vs seasonal average
3. **Wind Penetration** — current wind MW / AIL as %, with 7-day rolling avg
4. **Reserve Margin** — (available cap − AIL) / AIL × 100%
5. **Queue Depth** — total MW in interconnection queue by fuel type (donut)
6. **YTD Avg Pool Price** — year-to-date average vs prior year
7. **Constrained Events (30d)** — count of constrained-up/down events in last 30 days
8. **EME Readiness** — progress bar showing AESO's nodal transition milestones

---

## Pool Price Page — Key Charts

1. **Hourly Pool Price Time Series** — line chart, 30/90/365 day selectable, with price spike overlays (>$200 = amber, >$500 = red)
2. **Duration Curve** — % of hours above each price level ($0/$50/$100/$200/$500/$999.99)
3. **Monthly Average with Distribution** — box/whisker by month showing volatility
4. **Hour-of-Day Profile** — average pool price by hour (24-bar chart, shows morning/evening peaks)
5. **Price Spike History** — table of all hours with pool price > $300/MWh, with context (AIL, wind penetration, gas price)
6. **Gas Price Correlation** — scatter plot of pool price vs AECO-C spot price

---

## Supply/Demand Fundamentals Page — Key Charts

1. **Load vs Available Capacity** — dual line chart, hourly, with reserve margin shading
2. **Net Load After Wind/Solar** — (AIL - wind_mw - solar_mw) line chart — shows duck curve risk as renewables grow
3. **BC Interchange** — hourly import/export, highlighting hydro import during price spikes
4. **Weekly Supply Stack** — stacked area chart of gas/wind/solar/hydro/storage by week
5. **Reserve Margin Heat Calendar** — calendar heatmap of reserve margin by day (red = tight, green = comfortable)

---

## Generation Mix Page — Key Charts

1. **Real-Time Generation Stack** — stacked area chart by fuel type (gas/wind/solar/hydro/storage)
2. **Wind + Solar Share Trend** — monthly % of AIL met by wind + solar (growing trend)
3. **Gas Utilization** — CC vs simple cycle dispatch, showing peaker reliance during scarcity
4. **Coal Exit Impact** — show the before/after of coal decommissioning (2023) on generation mix and prices
5. **Renewable Curtailment Events** — hours where wind was curtailed due to south-north transmission constraints

---

## Congestion Intelligence Page — Key Features

Since AESO is transitioning TO nodal pricing (EME), this page has a unique angle:
1. **Current State** — constrained-up/down generation events from AESO public data; show MW and cost
2. **Constraint Frequency by Corridor** — which transmission corridors bind most often
3. **Estimated LMP Spread (Simulated)** — use PyPSA OPF results to show what nodal prices WOULD be under the EME regime at different wind penetration levels
4. **South-North Congestion Analysis** — focus on the Pincher Creek/Lethbridge → Calgary corridor (the most chronically constrained)
5. **Cost of Congestion** — estimated ratepayer cost of constrained-down payments (public data)
6. **EME Readiness Tracker** — AESO's published EME milestones, what has been completed vs outstanding

---

## Nodal Transition Tracker Page

This is unique to AESO (no equivalent in ERCOT-focused platform since ERCOT is already nodal):
1. **EME Timeline** — visual gantt/timeline of AESO's Energy Market Enhancements milestones
2. **What Changes with Nodal Pricing** — explainer cards: single pool price → locational prices, constrained-up/down payments → LMP-based settlement
3. **Simulated LMP Map** — run PyPSA OPF, show bus-level LMP on Alberta map (15 buses, coloured circles)
4. **Winner/Loser Analysis** — which zones gain (Southern wind generators with low LMP) vs which face new costs (load in Calgary/Edmonton if import congestion)
5. **Comparison to ERCOT** — show ERCOT's nodal transition experience (2010) as a case study

---

## Map Workspace

- Base: OpenStreetMap, Alberta extent (49°N–60°N, 110°W–120°W)
- Layers (toggleable):
  - **Generation projects** — dots sized by MW, coloured by fuel type (wind=teal, solar=amber, gas=slate, storage=purple)
  - **Interconnection queue** — triangles for pending projects
  - **Transmission lines** — AESO 240kV/500kV backbone (from public AESO GIS or NRCan OpenData)
  - **Constraint zones** — polygon overlays showing Southern AB congestion zone
  - **PyPSA buses** — the 15 model buses as labelled circles coloured by simulated LMP
- Click on any project pin → drawer showing: name, fuel type, MW, status, estimated LMP under nodal regime, congestion risk score

---

## Outage Tracker Page — Key Features

1. **Monthly Outage Calendar** — Gantt-style calendar showing planned outages per facility, MW offline, and duration
2. **Total MW Offline by Month** — bar chart of aggregate planned outage capacity by fuel type (gas vs wind vs hydro)
3. **Capacity Impact on Reserve Margin** — overlay outage MW on reserve margin chart to show tight-capacity periods
4. **Forced vs Planned Split** — donut chart of forced outage events vs planned maintenance
5. **Facility Outage History** — searchable table: facility, outage type, MW, start, end, duration hours
6. **Next 30 Days Outlook** — forward-looking panel showing upcoming planned outages and resulting reserve margin

---

## 7-Day Capacity Outlook Page — Key Features

1. **Hourly Available Capability Stack** — stacked bar chart (gas/wind/solar/hydro/storage) for next 7 days, 168 bars
2. **Reserve Margin Forecast** — line chart of forecast reserve margin % by hour, with red warning zones (<10%)
3. **Net Load Forecast** — AIL forecast minus wind and solar forecast = net thermal requirement
4. **Daily Min/Max Reserve** — table summary: each of the next 7 days, lowest and highest reserve margin and the hour
5. **Historical Forecast Accuracy** — how accurate were 7-day forecasts from 30 days ago vs what actually happened
6. **Alert Widget** — automatically flag any hours in the next 7 days where reserve margin < 10% (tight supply alert)

---

## Wind & Solar Forecasting Accuracy Page — Key Features

1. **Forecast vs Actual Time Series** — dual line chart: AESO wind forecast vs actual wind generation, hourly
2. **Forecast Error Distribution** — histogram of wind forecast errors (MW) — shows bias and variance
3. **Solar Duck Curve Analysis** — average solar injection curve by month, overlaid on net load, showing ramp steepness
4. **Error by Hour of Day** — average absolute forecast error by hour (solar errors peak at solar noon; wind errors overnight)
5. **Price Spike Correlation** — scatter plot of wind forecast error vs pool price — strong negative correlation (more wind shortfall → higher price)
6. **T-4h vs T-1h Accuracy** — compare AESO's 4-hour-ahead vs 1-hour-ahead forecast accuracy over time
7. **ML Feature Importance** — show wind forecast error as a key feature in the pool price spike ML model

---

## Interconnection Queue Page

- Table: all AESO active queue projects, sortable by MW/type/date
- Filter bar: fuel type, region (Southern/Central/Northern/Edmonton/Calgary), status (active/approved/withdrawn)
- Queue depth by region (horizontal bar chart)
- Wind-dominated queue analysis: Southern AB has >8,000 MW of wind in queue vs <1,200 MW of transmission export capacity → massive congestion risk post-EME
- Storage queue analysis: storage projects growing rapidly; show MW by year submitted

---

## Project Scoring (for Screening page)

Score each queue project on 8 dimensions (1–10 scale), similar to the ERCOT platform:

| Dimension | AESO Signal |
|-----------|-------------|
| `congestion_risk` | Based on region; Southern AB = high risk due to export constraint |
| `curtailment_risk` | Wind capacity factor × corridor constraint frequency |
| `pool_price_exposure` | Distance from gas peaker stack (lower = more exposure to gas marginal price) |
| `transmission_headroom` | Available MW on nearest constraint corridor |
| `queue_position` | MW ahead in queue on same transmission facility |
| `emulating_eme_lmp` | Estimated LMP at project bus under EME nodal regime (from PyPSA OPF) |
| `gas_price_correlation` | How much project revenue depends on gas price signal (storage vs wind vs gas) |
| `confidence_score` | Data completeness, project vintage, sponsor track record |

---

## API Routes (Express, prefix /api)

```
GET /api/aeso/pool-price               — query params: from, to
GET /api/aeso/pool-price/stats         — monthly/annual summary stats
GET /api/aeso/pool-price/spikes        — all hours with pool price > threshold (default $300)
GET /api/aeso/generation               — hourly generation mix, query: from, to
GET /api/aeso/supply-demand            — hourly AIL, capacity, reserve margin
GET /api/aeso/supply-demand/stats      — monthly averages
GET /api/aeso/actual-forecast          — actual vs forecast data, query: from, to, metric
GET /api/aeso/actual-forecast/errors   — forecast error stats by hour/month/metric
GET /api/aeso/outages                  — generator outage events, filter: type, from, to, fuel_type
GET /api/aeso/outages/summary          — MW offline by month, by fuel type
GET /api/aeso/outages/upcoming         — outages starting in next 30 days
GET /api/aeso/7day-capability          — latest 7-day hourly capability forecast
GET /api/aeso/7day-capability/accuracy — historical forecast accuracy vs actuals
GET /api/aeso/queue                    — all queue projects, filter: type, region, status
GET /api/aeso/queue/stats              — summary: MW by fuel type, region breakdown
GET /api/aeso/constraints              — constrained generation events, filter: type, from, to
GET /api/aeso/constraints/summary      — constraint cost and frequency by corridor
GET /api/pypsa/...                     — reverse-proxied to FastAPI Python microservice (port 8083)
```

---

## Sidebar Structure

```
Dashboard
Pool Price
Supply & Demand
Generation Mix
Capacity & Outages [collapsible group]
  ├── Outage Tracker
  └── 7-Day Capacity Outlook
Renewables [collapsible group]
  └── Wind & Solar Forecasting
AESO Market [collapsible group]
  ├── Interconnection Queue
  ├── Congestion Intelligence
  └── Nodal Transition Tracker
Map Workspace
PyPSA Engine [collapsible group]
  ├── Alberta Network (OPF)
  ├── OPF Simulator
  ├── ML Congestion Model
  └── Price Spike Model
Project Screening
Q&A Copilot
Export Center
Platform Guide
```

---

## Done Criteria

- [ ] PostgreSQL tables created and seeded with real AESO public data (Jan 2024–present)
- [ ] Pool price page shows real hourly prices with spike detection and duration curve
- [ ] Supply/demand page shows real AIL, available capacity, reserve margin charts
- [ ] Generation mix page shows fuel-type breakdown by hour/month
- [ ] Outage Tracker page renders planned/forced outage data from monthly + daily ETS reports
- [ ] 7-Day Capacity Outlook page renders current forecast from SevenDaysHourly servlet
- [ ] Wind & Solar Forecasting page renders AESO actual vs forecast with error analysis
- [ ] Interconnection queue populated from AESO connection project reporting
- [ ] Congestion page shows real constrained-up/down event data
- [ ] PyPSA Alberta 15-bus OPF running at /pypsa/healthz → 200
- [ ] /pypsa/opf accepts wind_cf + load_mw and returns bus-level LMP spreads
- [ ] ML model trained on pool price + supply/demand + forecast-error features; /pypsa/ml/predict returns spike probability
- [ ] All pages render with real data; no placeholder/mock data except where AESO data unavailable
- [ ] Map shows queue projects and PyPSA bus LMPs on Alberta basemap
- [ ] Nodal Transition Tracker page explains EME and shows simulated LMP map

---

## Seeder Execution Order

1. `seed-aeso-pool-price` — hourly pool price + AIL (Jan 2024–present)
2. `seed-aeso-generation-mix` — hourly fuel-type breakdown
3. `seed-aeso-supply-demand` — available capacity, reserve margin, interchange
4. `seed-aeso-actual-forecast` — actual vs forecast for pool price, AIL, wind, solar (WMRQH servlet)
5. `seed-aeso-outages` — monthly forecast outages first, then daily actuals
6. `seed-aeso-7day-capability` — current 7-day hourly available capability (run daily)
7. `seed-aeso-queue` — interconnection queue projects with geocoding
8. `seed-aeso-constraints` — constrained-up/down event history
9. (PyPSA microservice runs independently, seeded on startup via pre-computed OPF)

---

## Notes for the Agent Building This

1. **AESO uses Hour Ending (HE) convention** — HE1 = first hour of the day (midnight to 1am). Contrast with CAISO/ERCOT which use OPR_HR starting at 1. Store as `hour_ending INTEGER` (1–24) and display as "HE1"–"HE24".
2. **Alberta is Mountain Time** — UTC-7 in summer, UTC-6 in winter. Pool price timestamps are in Mountain Time in AESO files.
3. **Pool price cap = $999.99/MWh** — this is the VOLL. Any hour at $999.99 is a scarcity event. Treat these as special in the UI.
4. **Coal is gone** — Sheerness (last coal plant) decommissioned 2023. Coal generation data will be zero from mid-2023 onward.
5. **AESO is NOT yet nodal** — pool price is a single system-wide price. All LMP/nodal content is SIMULATED using PyPSA, clearly labelled as such. The EME nodal regime is not yet live.
6. **Southern Alberta wind export constraint is the #1 story** — the corridor from Pincher Creek/Lethbridge to Calgary is the chronically constrained transmission path. This is the Alberta equivalent of ERCOT's CREZ lines. All congestion analysis should foreground this.
7. **AECO-C gas price** drives the marginal cost of the gas peaker fleet, which sets pool price ~60–70% of hours. Include AECO-C spot price as a key context variable (use proxy/public sources or model it).
8. **PyPSA Alberta example** in the official docs uses a simplified network — the 15-bus model described above is a more detailed version. Refer to the PyPSA examples at https://pypsa.readthedocs.io for Alberta-specific parameters.
9. **ETS portal** (http://ets.aeso.ca) is AESO's public data portal. CSD reports contain most of the historical hourly data. The report servlet endpoint is: `http://ets.aeso.ca/ets_web/ip/Market/Reports/CSDReportServlet` — use appropriate report codes for pool price, generation, and supply data.
10. **No auth required** for any AESO public data — all endpoints listed above are accessible without API keys.
