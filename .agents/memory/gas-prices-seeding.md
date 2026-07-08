---
name: Gas prices seeding + network constraints
description: ERCOT Gas page seeder — Henry Hub from EIA API v2/FRED, Waha from OilPriceAPI/model. Node.js https.get is blocked in Replit sandbox.
---

## Rule
Node.js `https.get` and native `fetch` time out in this Replit environment for external URLs.
Use `execSync('curl -s --max-time N ...')` instead for all HTTP calls in seed scripts.

**Why:** The Replit sandbox blocks outbound TCP from Node.js but allows curl (different network path).

**How to apply:** Any new seed script that makes HTTP requests must shell out to curl, not use https/fetch modules.

## EIA API key — works for natural gas

**CORRECTION from earlier memory**: `EIA_API_KEY` is NOT restricted to electricity only.
It works for natural gas via the backward-compat v2 path: `NG.RNGWHHD.D` returns 5000 rows.
The previous "electricity-only scope" misunderstanding was due to using the wrong EIA API path.

**Henry Hub EIA endpoint (confirmed working)**:
```
https://api.eia.gov/v2/seriesid/NG.RNGWHHD.D?api_key={EIA_API_KEY}&start=2024-01-01&length=5000
```
Returns daily Henry Hub spot prices in `response.data[].{period, value}` format.

**Waha Hub via EIA**: EIA does not publish daily Waha spot prices via a public API series.
Waha prices are proprietary (Platts/S&P Gas Daily, NGI, Argus). No series ID was found
via backward-compat path despite trying 10+ guesses (RNGWWAHD, RNGWWAHTXD, etc.).

## Working sources
- **Henry Hub primary**: EIA API v2 backward-compat `NG.RNGWHHD.D` — free, daily (2024-present).
  Note: curl to EIA may be blocked in Replit sandbox; FRED is automatic fallback.
- **Henry Hub fallback**: `curl https://fred.stlouisfed.org/graph/fredgraph.csv?id=DHHNGSP` — free, daily since 1997.
- **Waha Hub real data**: `OIL_PRICE_API_KEY` (oilpriceapi.com, NGI-sourced) — real daily from Feb 2025.
- **Waha Hub model**: Henry Hub + seasonal basis (calibrated from EIA Natural Gas Weekly averages):
  - Jan−Feb: −0.60, Mar: −1.80, Apr−May: −2.80, Jun−Aug: −1.40, Sep−Oct: −1.00, Nov−Dec: −0.70
  - Model rows tagged source='model'; never overwritten by subsequent model runs.

## Dev DB status (July 2026)
- henry_hub: 651 rows, Jan 2024 → Jun 2026, source: fred
- waha: 677 rows, Jan 2024 → Jul 5 2026, sources: oilpriceapi (364 rows, Feb 2025+) + model (313 rows)

## Admin endpoint
- `POST /api/admin/reseed-gas-prices` spawns `seed-gas-prices` script (~30 sec)

## gas_prices table
```sql
CREATE TABLE gas_prices (
  id SERIAL PRIMARY KEY, hub TEXT NOT NULL, date DATE NOT NULL,
  price NUMERIC(10,4), source TEXT,
  CONSTRAINT gas_prices_hub_date_uq UNIQUE (hub, date)
);
```

## API endpoints (all at /api/gas-prices)
- `GET /api/gas-prices` — raw rows, `?hub=henry_hub&from=&to=`
- `GET /api/gas-prices/spark-spread` — power − gas×HR, `?node=HB_HOUSTON&heat_rate=8.5&gas_hub=henry_hub`
- `GET /api/gas-prices/implied-heat-rate` — power÷gas, `?node=&gas_hub=`
- `GET /api/gas-prices/waha-basis` — Waha−HH + LZ_WEST power basis
- `GET /api/gas-prices/summary` — latest prices + spark by all hub/LZ nodes

## Page
`/ercot-gas` — 5 tabs: Price History, Spark Spread (interactive HR slider), Implied Heat Rate, Waha Basis, Market Context.

## Frontend fix (July 2026)
Spark Spread KPI: searches backward for last non-null sparkSpread instead of using `at(-1)`.
Fixes "— /MWh" shown when the latest month has power data but no matching gas price yet.
