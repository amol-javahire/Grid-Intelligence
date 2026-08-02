# NPV Calculator — 8-Dimension VPPA Methodology

> **Purpose:** Complete formula reference for the NPV Calculator's VPPA financial model.  
> All 8 ranking dimension scores are converted to financial adjustments using the formulas below.  
>
> **Saved:** July 1, 2026. Reflects scoring v6 + NPV Calculator implementation.  
> Implementation: `artifacts/api-server/src/routes/ppa.ts`  
> Frontend: `artifacts/grid-platform/src/pages/ppa-calculator.tsx`  
> See `docs/calculation-methodology.md` §6 for the underlying PPA/NPV formula library.

---

## 1. VPPA STRUCTURE

A VPPA (Virtual Power Purchase Agreement, also called a Financial PPA or Contract for Differences) is a purely financial hedge — no physical delivery of power.

```
Annual Cashflow ($/yr) = (Total_Revenue_MWh - Strike) × Delivered_MWh_yr

where:
  Total_Revenue_MWh = Power_Capture_Price + REC_Revenue_MWh
  Delivered_MWh_yr  = Gross_MWh_yr × (1 - Curtailment_Haircut) × Availability_Factor

Settlement logic:
  If market_price > strike → generator pays offtaker  (offtaker gains)
  If market_price < strike → offtaker pays generator  (hedge cost)
  RECs transfer separately to offtaker (bundled VPPA)
```

**NPV Formula:**
```
NPV = Σ_{y=1}^{T} [Annual_Cashflow_y / (1 + WACC)^y]

where Annual_Cashflow_y = (Total_Revenue × escalation_factor^y - Strike) × Delivered_MWh
      escalation_factor = 1 + annual_price_escalation_rate
      T = contract term (years)
      WACC = offtaker's weighted average cost of capital
```

---

## 2. PRICE WATERFALL — BUILD-UP TO EFFECTIVE CAPTURE PRICE

The effective power capture price is constructed in layers, each derived from a scoring dimension:

```
Step 1:  Market DA Reference ($/MWh)
         ERCOT = $31.42    CAISO = $33.25    PJM = $38.50
         (2024 annual averages from real CDR/OASIS data)

Step 2:  × Capture Ratio  →  Raw Capture Price
         Ratio = tech-specific fraction of hub DA price actually earned by the asset
         (see Section 4 for values derived from real hourly ERCOT/CAISO data)

Step 3:  × (1 − Shape Discount)  →  After-Shape Price
         Shape Discount derived from gridStabilityScore (see Section 5.3)

Step 4:  + Basis Adjustment ($/MWh)  →  Power Capture Price
         Basis Adj derived from locationScore (see Section 5.1)

Step 5:  + REC Revenue ($/MWh)  →  Total Revenue per MWh
         REC Revenue derived from environmentalScore × market base (see Section 5.5)
```

**Full price formula:**
```
Power_Capture_Price = Market_DA_Ref × Capture_Ratio × (1 - Shape_Discount) + Basis_Adj_MWh

Total_Revenue_MWh   = Power_Capture_Price + REC_Revenue_MWh
```

---

## 3. VOLUME WATERFALL — BUILD-UP TO DELIVERED MWH/YR

```
Step 1:  Gross MWh/yr = Capacity_MW × Capacity_Factor × 8,760

Step 2:  × (1 − Curtailment_Haircut)  →  After-Curtailment MWh
         Curtailment_Haircut derived from curtailmentScore (see Section 5.2)

Step 3:  × Availability_Factor  →  Delivered MWh/yr
         Availability derived from interconnectionScore + developmentRiskScore (see Section 5.4)
```

**Full volume formula:**
```
Delivered_MWh_yr = Capacity_MW × CF × 8,760 × (1 - Curtailment_Haircut) × Availability_Factor
```

---

## 4. CAPACITY FACTORS & CAPTURE RATIOS BY ASSET TYPE

### 4.1 Capacity Factors (used to compute Gross MWh/yr)

| Asset Type    | ERCOT | CAISO | PJM  |
|---------------|-------|-------|------|
| Solar         | 0.27  | 0.29  | 0.22 |
| Wind          | 0.40  | 0.32  | 0.35 |
| Battery       | 0.18  | 0.18  | 0.18 |
| Natural Gas   | 0.60  | 0.55  | 0.58 |
| Nuclear       | 0.92  | 0.92  | 0.92 |
| Hydro         | 0.40  | 0.42  | 0.38 |
| Biomass       | 0.65  | 0.65  | 0.65 |
| Geothermal    | 0.88  | 0.88  | 0.88 |
| Coal          | 0.55  | 0.55  | 0.55 |

### 4.2 Capture Ratios (fraction of flat hub DA price earned by asset)

Derived from **real ERCOT hourly data** (scoring v6, `ercot_hub_da_rt_hourly`, Jan 2024–Apr 2026) and CAISO OASIS:

| Asset Type    | ERCOT  | CAISO | PJM  | Notes |
|---------------|--------|-------|------|-------|
| Solar         | 0.724  | 0.68  | 0.82 | Duck curve: generates at midday when DA prices lowest |
| Wind          | 1.010  | 0.95  | 0.90 | ERCOT wind earns slight premium (overnight peak in winter) |
| Battery       | 1.797  | 1.90  | 1.45 | Arbitrages peak-valley spread, earns well above flat price |
| Natural Gas   | 1.000  | 0.98  | 0.98 | Sets marginal price — earns near hub |
| Nuclear       | 0.990  | 0.95  | 0.95 | Baseload, slight off-peak penalty |
| Hydro         | 0.950  | 1.05  | 1.02 | CAISO hydro dispatchable to peak hours |
| Biomass       | 0.990  | 0.99  | 0.99 | Dispatchable, similar to gas |
| Geothermal    | 1.000  | 1.00  | 1.00 | Firm baseload |
| Coal          | 0.940  | 0.94  | 0.94 | Baseload, slight off-peak penalty |

**ERCOT solar capture ratio of 0.724** reflects real duck curve data: solar generates peak 10am–2pm when DA prices are lowest due to saturation, earning only 72.4% of the flat hourly average.

---

## 5. SCORE-TO-ADJUSTMENT MAPPING (ALL 8 DIMENSIONS)

All scores are 0–100 (higher = better / lower risk). The conversion functions are implemented identically in both backend (`ppa.ts`) and frontend (`ppa-calculator.tsx`) to avoid extra API round-trips.

### 5.1 Basis Adjustment — from `locationScore`

**What it represents:** The node-to-hub DA price spread. Negative basis = delivery node trades below system average due to transmission congestion.

```
Basis_Adj_MWh:
  if locationScore >= 50:  Basis_Adj = (score - 50) / 50 × $6     [range: $0 to +$6]
  if locationScore  < 50:  Basis_Adj = (score - 50) / 50 × $12    [range: -$12 to $0]

Asymmetric: downside extends to -$12 (severe congestion) but upside caps at +$6
(congestion can create large sustained discounts; "clear" nodes rarely earn large premiums)

Examples:
  score 80 → +$3.60/MWh  (node trades above hub)
  score 50 → $0.00/MWh   (node tracks hub exactly)
  score 25 → -$6.00/MWh  (moderately congested node)
  score 10 → -$9.60/MWh  (severely congested, e.g. West TX wind node)

Source data: avg_da from ercot_node_stats vs ercot hub avg; caiso_node_stats for CAISO
```

**Slider range in UI:** −$12/MWh to +$8/MWh

---

### 5.2 Curtailment Haircut — from `curtailmentScore`

**What it represents:** Fraction of potential generation lost to economic or operational curtailment. Reduces delivered MWh/yr, not the $/MWh price.

```
Curtailment_Haircut = max(0, min(0.25, (100 - curtailmentScore) / 100 × 0.22))

Mapping:
  score 100 → 0.0%  (no curtailment)
  score 80  → 4.4%  (low curtailment zone)
  score 60  → 8.8%  (moderate — typical CREZ wind)
  score 40  → 13.2% (high curtailment zone)
  score 20  → 17.6% (severe, e.g. West TX solar in spring shoulder)
  score 0   → 22.0% (maximum used in model; hard cap at 25%)

Proxy: curtailmentScore uses negative-price frequency as curtailment signal
(negative DA prices → generators curtailed; industry-standard proxy for public data)

Revenue impact of curtailment:
  Annual_MWh_lost = Gross_MWh_yr × Curtailment_Haircut
  Revenue_lost ($) = Annual_MWh_lost × (Market_Price - Strike)
```

**Slider range in UI:** 0% to 25%

---

### 5.3 Shape / Timing Discount — from `gridStabilityScore`

**What it represents:** Discount on the capture price from generating during hours when prices are systematically below the flat average. Captures the residual shape mismatch not already in the capture ratio.

```
Shape_Discount = max(0, min(0.20, (100 - gridStabilityScore) / 100 × 0.15))

Mapping:
  score 100 → 0.0%   (perfect shape match vs load)
  score 80  → 3.0%   (slight mismatch)
  score 60  → 6.0%   (moderate, typical ERCOT wind)
  score 40  → 9.0%   (significant, e.g. CAISO solar)
  score 20  → 12.0%  (poor shape match)
  score 0   → 15.0%  (maximum shape discount; hard cap at 20%)

Scoring methodology: gridStabilityScore = Pearson correlation of synthetic generation
profile vs zone load profile, scaled to 0–100.
  Pearson = +1.0 → score ~100  (generates perfectly with load)
  Pearson = +0.3 → score ~65   (typical solar)
  Pearson = 0.0  → score ~50   (uncorrelated)
  Pearson = -0.5 → score ~25   (anti-correlated, worst case)

Price waterfall position: applied AFTER capture ratio, BEFORE basis adjustment
  After_Shape_Price = Raw_Capture_Price × (1 - Shape_Discount)
```

**Slider range in UI:** 0% to 20%

---

### 5.4 Availability Factor — from `interconnectionScore` + `developmentRiskScore`

**What it represents:** Plant uptime fraction reflecting both transmission reliability (ongoing congestion/disconnection risk) and interconnect fragility (development risk affecting firm access). For operating plants, development risk is resolved but interconnection congestion can still force involuntary outages.

```
Avg_Reliability = (interconnectionScore + developmentRiskScore) / 2
Availability_Factor = 0.93 + (Avg_Reliability / 100) × 0.06

Mapping:
  Both scores 100 → 0.99 (99% availability — highly reliable asset)
  Both scores  75 → 0.975 (97.5%)
  Both scores  50 → 0.96  (96% — base case for typical operating plant)
  Both scores  25 → 0.945 (94.5%)
  Both scores   0 → 0.93  (93% — worst case used in model)

Applies to volume (multiplied AFTER curtailment haircut):
  Delivered_MWh = After_Curtailment_MWh × Availability_Factor

Distinguishing curtailment from availability:
  Curtailment = economic (negative prices, grid-directed economic curtailment)
  Availability = technical (forced outages, transmission disconnections, access risk)
```

**Slider range in UI:** 80% to 99%

---

### 5.5 REC Revenue — from `environmentalScore` + market

**What it represents:** Additional $/MWh revenue from renewable energy certificates transferred to the offtaker (bundled VPPA). RECs have real market value and directly increase the offtaker's total revenue per MWh.

```
REC_Revenue_MWh = Market_REC_Base × (environmentalScore / 100)

Market REC Base Prices:
  ERCOT: $2.00/MWh   (Texas RECs / TRECs — low demand, commodity pricing)
  CAISO: $7.00/MWh   (California RPS compliance, bundled premium)
  PJM:   $5.50/MWh   (generic PJM RECs; NOT state SRECs — NJ/PA SRECs can be $50–150+)

Mapping (ERCOT example):
  environmentalScore 100 → $2.00/MWh
  environmentalScore  75 → $1.50/MWh
  environmentalScore  50 → $1.00/MWh
  environmentalScore  25 → $0.50/MWh
  environmentalScore   0 → $0.00/MWh

Position in cashflow:
  Total_Revenue_MWh = Power_Capture_Price + REC_Revenue_MWh
  Cashflow = (Total_Revenue_MWh × escalation^t - Strike) × Delivered_MWh

Breakeven with RECs: the breakeven POWER price (excluding RECs) is lower when RECs add value
  Breakeven_Power_Price = Strike - REC_Revenue_MWh  [at P50, approximate]
```

**Slider range in UI:** $0 to $15/MWh  
**Note:** PJM state SRECs (PA, NJ, MD) are orders of magnitude higher — override the slider for state-specific deals.

---

### 5.6 Market Price Spread — from `financialScore` (auto, not a slider)

**What it represents:** Width of the P10/P90 price uncertainty band. A high financialScore means the market revenue is reliable and predictable (tight spread). A low score means high revenue volatility (wide spread).

```
Spread_Half  = 0.15 + (1 - financialScore / 100) × 0.10

P10_Multiplier = 1 + Spread_Half   [bullish scenario]
P90_Multiplier = 1 - Spread_Half   [bearish scenario]

Mapping:
  financialScore 100 → ±15% spread  (P10=+15%, P90=−15%)
  financialScore  75 → ±17.5% spread
  financialScore  50 → ±20% spread  (base / default)
  financialScore  25 → ±22.5% spread
  financialScore   0 → ±25% spread  (high volatility — wide uncertainty band)

Example: $31 effective capture, financialScore=40 (spread ±21%)
  P10 price = $31 × 1.21 = $37.51/MWh  [if market is 21% above base]
  P50 price = $31 × 1.00 = $31.00/MWh
  P90 price = $31 × 0.79 = $24.49/MWh  [if market is 21% below base]

Not overridable: this reflects the fundamental market uncertainty of the asset's ISO
zone and asset type — the model auto-sets based on score. Users can see the ±% displayed.
```

---

### 5.7 Tax Credit Eligibility — from `regulatoryScore` (context badge, not financial adjustment)

**What it represents:** The project's likely eligibility for ITC (Investment Tax Credit) or PTC (Production Tax Credit). For the **offtaker**, tax credits don't directly change NPV — but they reduce the developer's cost floor, which sets the minimum acceptable strike price.

```
Context badges shown in results panel:
  regulatoryScore >= 65 → "ITC 30% eligible"  (solar, storage, offshore wind)
  regulatoryScore 40–65 → "PTC eligible"       (onshore wind, geothermal)
  regulatoryScore  < 40 → "Limited tax credits" (gas, coal, some hydro)

Developer economics context (not in offtaker NPV):
  ITC: Credit = 30% × Total_Eligible_CapEx  → reduces project financing need
  PTC: Annual_Value = $0.0275/kWh × AEP_MWh × 1,000  (10 years)
  ITC vs PTC breakeven CF ≈ 22–25%  (below this, ITC usually preferred)

Strike floor implication:
  ITC-eligible project: developer can accept lower strike (cost subsidized by 30%)
  PTC-eligible project: developer needs strike ≥ LCOE − PTC_contribution
  Developer LCOE estimates (with credits): wind $25–35/MWh, solar $20–30/MWh
```

See `docs/calculation-methodology.md` §6.4 for full ITC/PTC formulas.

---

### 5.8 Capacity / Demand Proximity — from `demandProximityScore` (context only)

**What it represents:** Log-scaled plant size score. Larger plants generate more total MWh/yr and offer more hedging volume per deal. For NPV, size is already implicit in `capacityMw × CF × 8,760`.

```
Context: demandProximityScore is log-scaled plant size for ranking purposes
  2,000 MW → score ~93
    500 MW → score ~76
    100 MW → score ~58
     10 MW → score ~36

Not a separate financial adjustment — size is captured directly via:
  Gross_MWh_yr = Capacity_MW × CF × 8,760
```

---

## 6. COMPLETE CASHFLOW FORMULA

Combining all 5 financial adjustments:

```
For each year t (1 to T):

  Market_Revenue_t = (Market_DA_Ref × Capture_Ratio × (1 - Shape_Discount) + Basis_Adj + REC_Revenue)
                     × (1 + escalation)^t    [power price escalates; REC revenue treated as fixed]

  Cashflow_t ($) = (Market_Revenue_t - Strike) × Gross_MWh × (1 - Curtailment) × Availability

NPV = Σ_{t=1}^{T} Cashflow_t / (1 + WACC)^t
```

**Simplified form:**
```
Effective_Revenue = Total_Revenue_MWh = Power_Capture + REC_Value
Effective_Volume  = Gross_MWh × (1 − Curtailment_Haircut) × Availability_Factor
Net_MWh_Spread    = Effective_Revenue − Strike  [positive → offtaker gains; negative → hedge cost]

Annual_P50_CF = Net_MWh_Spread × Effective_Volume × (1+escalation)^t
NPV           = PV annuity of Annual_P50_CF at WACC
```

---

## 7. BREAKEVEN POWER PRICE

The market power price (excluding RECs) at which NPV = 0:

```
Solve for breakeven_power such that:
  NPV[ (breakeven_power + REC_Revenue - Strike) × Effective_Volume × escalation^t ] = 0

Closed form (no escalation):
  breakeven_power = Strike - REC_Revenue   [at WACC, no escalation]

With escalation: solved numerically via bisection (60 iterations, range $0–$300/MWh)

Interpretation:
  If current market forecast > breakeven → positive NPV → offtaker expects hedge gain at P50
  If market forecast < breakeven → negative NPV → offtaker carries hedge cost at P50
  Useful for: "how low does power need to fall before this deal hurts us?"
```

---

## 8. SCENARIO METHODOLOGY (P10 / P50 / P90)

```
P50 (Base case):    price_multiplier = 1.00
P10 (Bullish):      price_multiplier = 1 + Spread_Half   (from financialScore, typically 1.15–1.25)
P90 (Bearish):      price_multiplier = 1 - Spread_Half   (from financialScore, typically 0.75–0.85)

Applied to: Total_Revenue_MWh (power + REC both scaled by multiplier at P50; REC more stable in practice)
Volume: same across all scenarios (curtailment and availability are already incorporated as expected values)

Annual cashflow chart: always P50 (base case) with escalation
Scenario cards: discounted NPV at P10/P50/P90 price multipliers
```

---

## 9. DEFAULT CONTRACT TERMS

| Parameter | Default | Range | Notes |
|-----------|---------|-------|-------|
| Strike Price | $35/MWh | $15–$80 | Current market range for utility-scale VPPAs |
| Contract Term | 15 years | 5–25 yr | 10–20 yr most common for VPPAs |
| WACC | 8% | 4–15% | Typical investment-grade corporate offtaker |
| Price Escalation | 1.5%/yr | 0–5% | Long-run power price inflation assumption |

---

## 10. REFERENCE VALUES

### Market DA Price References (2024 annual averages, real data)

| Market | DA Reference | Source |
|--------|-------------|--------|
| ERCOT  | $31.42/MWh  | CDR Report 13060 hub/zone averages |
| CAISO  | $33.25/MWh  | OASIS PRC_LMP SP15/NP15/ZP26 average |
| PJM    | $38.50/MWh  | Published monthly hub averages |

### REC Market Price Ranges (2024 estimates)

| Market | Range | Used in Model | Notes |
|--------|-------|--------------|-------|
| ERCOT (TRECs) | $0.25–$2.50/MWh | $0–$2.00/MWh | Low demand, surplus supply |
| CAISO (CA RPS) | $3–$12/MWh | $0–$7.00/MWh | RPS compliance bundled premium |
| PJM generic | $1–$8/MWh | $0–$5.50/MWh | State SRECs (NJ/PA/MD) much higher — override slider |

### Availability Factor Reference Ranges

| Scenario | Factor | Represents |
|----------|--------|------------|
| High reliability | 0.97–0.99 | Strong interconnection, low congestion history |
| Base case | 0.95–0.97 | Typical operating plant with no major issues |
| Moderate risk | 0.93–0.95 | Some transmission constraints or development risk |
| High risk | 0.90–0.93 | Fragile interconnect or heavily congested corridor |

### Capture Ratio Benchmarks (real ERCOT hourly data)

| Asset | ERCOT | Interpretation |
|-------|-------|----------------|
| Solar 0.724 | Earns 72.4% of flat hub DA | Midday glut depresses prices when generating |
| Wind 1.010  | Earns 101% of flat hub DA  | Winter overnight generation catches peak prices |
| Storage 1.797 | Earns 179.7% of flat hub DA | Arbitrages spread; charges cheap, discharges dear |

---

## 11. STRESS TESTING GUIDE

**To stress-test a congested wind project (e.g. West Texas):**
- Basis Adj: drag toward −$8 to −$12/MWh
- Curtailment: drag toward 15–22%
- Shape Discount: drag toward 8–12% (wind generates when load is low overnight)
- Availability: hold at 95–97% (transmission congestion, not disconnection)
- REC Revenue: ERCOT — hold low ($0.25–$1.50/MWh)

**To stress-test a CAISO solar project (duck curve):**
- Basis Adj: slight negative −$1 to −$3/MWh (NP15 typically near hub; SP15 can diverge)
- Curtailment: 5–10% (CAISO spring curtailment well-documented)
- Shape Discount: 8–12% (generates 10am–2pm, DA prices depressed by saturation)
- Availability: 96–98% (CAISO interconnect generally reliable for operating plants)
- REC Revenue: $4–$8/MWh (CA RPS compliance premium)

**To find the minimum viable strike price:**
- Set all sliders to your base-case assumptions
- Set WACC and term
- Note the Breakeven Power Price in the results header
- That is the market floor below which P50 NPV turns negative

---

## 12. IMPLEMENTATION NOTES

### Score Conversion (mirrored frontend/backend)

Both `ppa.ts` (Node.js) and `ppa-calculator.tsx` (React) implement `scoreToRiskDefaults()` with identical logic to avoid an extra API round-trip when a project is selected. If the backend conversion formulas are updated, the frontend must also be updated.

### Override Mechanism

The API accepts optional query params (`basisAdjMwh`, `curtailmentHaircut`, `shapeDiscount`, `availabilityFactor`, `recRevenueMwh`) that override the score-derived defaults. The P10/P90 spread (from `financialScore`) is NOT overridable — it's auto-derived from the market certainty score.

### Breakeven Computation

Breakeven power price is solved numerically via 60-iteration bisection (search range $0–$300/MWh), converging to ~$0.001/MWh precision. The bisection accounts for WACC discounting and price escalation across the contract term.

### Known Simplifications

1. **REC escalation:** REC revenue is treated as fixed (no escalation applied). In practice, REC prices can rise (tighter RPS) or fall (more supply). Override the slider for long-term assumptions.
2. **P10/P90 volume held constant:** Scenarios vary price multiplier only. In reality, high-price scenarios often correlate with lower renewable generation (hot, low-wind summer peaks). This underestimates P90 downside for weather-correlated risks.
3. **PJM state SRECs excluded:** The PJM REC base ($5.50/MWh) reflects generic PJM RECs, not state compliance certificates. NJ Solar SRECs, PA AECs, and MD SRECs can be $20–$150+/MWh — override the slider for specific state deals.
4. **Capture ratio fixed at 2024 actuals:** Does not account for future cannibalization as solar/wind penetration grows. ERCOT solar capture ratio likely declines toward 0.60–0.65 by 2030 under high-buildout scenarios.
