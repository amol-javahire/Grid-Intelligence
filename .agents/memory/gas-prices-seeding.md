---
name: Gas prices seeding + network constraints
description: ERCOT Gas page seeder — Henry Hub from FRED, Waha from OilPriceAPI/model. Node.js https.get is blocked in Replit sandbox.
---

## Rule
Node.js `https.get` and native `fetch` time out in this Replit environment for external URLs.
Use `execSync('curl -s --max-time N ...')` instead for all HTTP calls in seed scripts.

**Why:** The Replit sandbox blocks outbound TCP from Node.js but allows curl (different network path).

**How to apply:** Any new seed script that makes HTTP requests must shell out to curl, not use https/fetch modules.

## EIA API key scope
The project's `EIA_API_KEY` is scoped to electricity only. It returns 0 results for natural gas queries.
Waha Hub prices are sourced from OIL_PRICE_API_KEY (OilPriceAPI) or forward-filled model values.

## Working sources
- **Henry Hub (FRED DHHNGSP)**: `curl https://fred.stlouisfed.org/graph/fredgraph.csv?id=DHHNGSP` — free, daily since 1997, CSV format, no auth.
- **Waha Hub**: `OIL_PRICE_API_KEY` secret + model forward-fill for holidays/gaps.

## Dev DB status (July 2026)
- 1,328 rows: henry_hub + waha, Jan 2024 → Jul 5 2026
- Columns: id, hub, date, price, source
- Source values: 'fred', 'oilpriceapi', 'model'
- Holidays/zero-prices forward-filled from prior trading day

## Admin endpoint
- `POST /api/admin/reseed-gas-prices` spawns `seed-gas-prices` script (~30 sec)
- Only available after deploy picks up the new admin route (added July 2026)

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
