---
name: PPA NPV endpoint + ITC/LCOE financial fields
description: GET /api/ppa-npv endpoint, computeFinancials() in candidates.ts, /ppa frontend page.
---

# PPA NPV Endpoint + ITC/LCOE Financial Fields

## GET /api/ppa-npv
File: `artifacts/api-server/src/routes/ppa.ts`

Query params: `candidateId`, `strike` ($/MWh), `term` (yr, default 15), `wacc` (default 0.08), `escalation` (default 0.015), `volume` (MWh/yr override)

Returns: P10/P50/P90 NPV scenarios, breakeven price, annual cashflow array

**VPPA logic:** Walmart receives `(market_price - strike) × contracted_mwh`. Positive = hedge gain (market > strike). NPV discounted at WACC.

**Capture price derivation:** `marketRefDA × captureRatio × (priceScore / 50)` — uses stored `price_score` as a proxy for node quality vs market reference.

**Scenarios:** P50=base market (1×), P10=bullish (+20%), P90=bearish (-20%) — simple price multipliers, not Monte Carlo.

## computeFinancials() in candidates.ts

Added to `artifacts/api-server/src/routes/candidates.ts` — called in both list + detail endpoints.

Formula: 
```
CRF = 0.08 × 1.08^25 / (1.08^25 - 1) ≈ 0.0937
capexAfterItc = ITC_ELIGIBLE ? capex × 0.70 : capex
lcoeBase = 1000 × (capexAfterItc × CRF + fom) / (cf × 8760) + vom
ptcAdj = PTC_ELIGIBLE ? 27.5 × (PV_10yr / PV_25yr) : 0
lcoe = lcoeBase - ptcAdj
```

ITC_ELIGIBLE: solar, storage (30% of CapEx)
PTC_ELIGIBLE: wind, geothermal, biomass, hydro ($0.0275/kWh × 8760 × CF × 10yr PV factor)

Standard CapEx 2024 ($/kW): solar=1050, wind=1450, storage=1200, gas=1000, nuclear=7500

Returns in API: `lcoeMwh`, `totalCapexM`, `itcValueM`, `ptcAnnualM`, `ptcNpvM`, `taxCreditType`

## /ppa Frontend Page
File: `artifacts/grid-platform/src/pages/ppa-calculator.tsx`
Route: `/ppa`, nav: "PPA Calculator" (Calculator icon)

Uses `useListCandidates` (not useGetCandidates — that hook doesn't exist). Candidate type: `Candidate` from `@workspace/api-client-react`. DB column is `c.name` (not `c.projectName`).

Calls `/api/ppa-npv` directly via fetch (not codegen hooks — endpoint not in OpenAPI spec).
