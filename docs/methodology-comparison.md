# Methodology Comparison: Reference Document vs. Current App Implementation

> Generated: June 30, 2026  
> Reference: `docs/calculation-methodology.md`  
> App scoring engine: `scripts/src/assign-and-score-nodal.ts` (v5)  
> Objective weights: `artifacts/api-server/src/routes/candidates.ts`

---

## Summary

| Dimension | Reference Formula | App Implementation | Gap Level |
|-----------|------------------|-------------------|-----------|
| Capture Price | Hourly-profile-weighted LMP | Fixed tech multiplier (0.82–1.18×) | **Medium** |
| Basis Risk | `StdDev(Nodal_LMP - Hub_LMP)` + VaR | Price volatility proxy (σ of monthly DA) | **Medium** |
| Congestion Score | Weighted sum: basis 50%, curtail 30%, vol 20% | Linear: `50 + basisPct×150 - volPenalty + assetAdj` | **Low** |
| Curtailment | `Curtailed_MWh / Potential_MWh` | Negative-price-% as proxy | **Low** |
| Market Revenue | `(Nodal_LMP - Strike) × Contracted_MWh` | Log-scaled gross revenue score | **Medium** |
| LCOE | `[CapEx × CRF + FOM] / AEP + VOM` | Not computed — weighted score only | **High** |
| ITC / PTC | Dollar credit against project cost | Not computed | **High** |
| Shape Risk | `Pearson(Gen_profile, Load_profile)` | Not implemented | **High** |
| Battery SoC | `SoC_t+1 = SoC_t + Charge×η - Discharge/η` | PyPSA only (simulation mode) | **Low** |
| Reserve Margin | `(Installed_Cap - Peak) / Peak × 100` | PyPSA scarcity simulator only | **Low** |
| PPA NPV | `Σ [Annual_Net_Value / (1+WACC)^y]` | Not computed | **High** |
| Basis VaR | `Mean_basis - 1.645 × σ_basis` | Not computed | **High** |

---

## Dimension-by-Dimension Detail

### 1. Capture Price Score

**Reference (§1.3, §4.x):**
```
Capture_Price = Nodal_LMP weighted by generation profile
  i.e., for solar: weight LMPs by hour of day (daytime hours only)
  for wind: weight by actual wind output profile (often overnight)
  True capture price < hub average for solar (cannibalization), further below for wind
```

**Current app (`CAPTURE_RATIO` in scoring engine):**
```typescript
const CAPTURE_RATIO: Record<string, number> = {
  wind:    0.82,   // fixed: wind earns 82% of flat hub DA
  solar:   1.03,   // fixed: solar earns 103% (underestimates cannibalization in heavy-solar grids)
  storage: 1.18,   // fixed: storage arbitrages, earns premium
  ...
};
const captureDA = signalStats.avg_da * ratio;
const raw = (captureDA / sysAvg) * 50;
```

**Gap:** The fixed ratios are reasonable defaults for 2024 ERCOT but don't adjust for:
- Growing solar penetration (cannibalization lowers solar capture price over time)
- Seasonal variation (solar capture higher in winter, lower in summer)
- Zone-specific generation profiles

**Recommendation:** Keep fixed ratios for now (data-efficient). Upgrade to hourly-weighted capture price once we have hourly generation profiles from NREL PVWatts/WTK alongside hourly LMPs.

---

### 2. Basis Risk Score

**Reference (§1.3, §8.3):**
```
Basis = Nodal_LMP - Hub_LMP  (per hour)
Basis_Volatility = StdDev(Monthly_Avg_Basis)
Basis_VaR_95 = Mean_basis - 1.645 × StdDev_basis
```

**Current app:**
```typescript
// Uses price volatility (σ of monthly DA) as proxy for basis risk
const raw = 70 - ((vol - ercotSysVol) / ercotSysVol) * 22;
```

**Gap:** We use *price volatility* as a proxy rather than computing the actual nodal-to-hub spread. For hub/zone nodes this is fine because they ARE the hub. For resource nodes (1,108 ERCOT resource nodes), `avg_da` is the resource node's DA price and `avg_vol` is its standard deviation — but we never compute `(resource_node_DA - hub_DA)` explicitly.

**Recommendation:** In the next scoring run, compute `avg_basis = avg_da - hub_avg_da` and `basis_vol = StdDev(monthly_node_DA - monthly_hub_DA)` from `ercot_node_stats`. This gives true nodal basis per §1.3.

---

### 3. Congestion Score

**Reference (§8.1, §9.10):**
```
Congestion_Score = 0.5 × Normalized_Basis + 0.3 × Normalized_Curtailment + 0.2 × Normalized_Volatility
(z-score normalized across all nodes)
```

**Current app:**
```typescript
const basisPct  = (da - ercotBusAvg) / ercotBusAvg;         // relative basis
const volPenalty = ((vol - ercotSysVol) / ercotSysVol) * 8;  // volatility penalty
const assetAdj  = ERCOT_CONG_ADJ[assetType];                  // tech adjustment
raw = 50 + basisPct * 150 - volPenalty + assetAdj;
```

**Gap:** Structure is similar (basis + volatility + asset type) but:
- We don't include curtailment explicitly in congestion (it's a separate dimension)
- Weights are implicit in the `* 150` and `* 8` scalars rather than explicit w1/w2/w3
- We use relative basis (% of hub) rather than z-score normalization
- Asset adjustment is hardcoded per tech type rather than derived from PTDF

**Recommendation:** The current approach is reasonable. Could migrate to z-score normalization for cleaner interpretation, but results would be similar.

---

### 4. Curtailment Score

**Reference (§4.4):**
```
Curtailment_Rate (%) = Curtailed_MWh / Potential_MWh × 100
Revenue_Impact = Curtailment_Rate × Nameplate × 8,760 × Avg_LMP
```

**Current app:**
```typescript
const negPct = signalStats.avg_neg_pct;  // % of hours with negative DA price
const mult   = ERCOT_CURT_MULT[assetType];  // wind=1.30, solar=1.25
return Math.min(98, Math.max(5, 100 - negPct * mult * 1.4));
```

**Gap:** We use *negative price frequency* as a curtailment proxy. This is a well-established industry proxy (negative prices → curtailment signals). We don't have actual curtailment MWh data (that requires CDR Report 22536 or ERCOT's Generation Resource Data, not publicly available).

**Recommendation:** Negative price frequency is the best available proxy from public data. The reference formula requires proprietary curtailment data. Current approach is appropriate.

---

### 5. Market Revenue Score

**Reference (§6.1):**
```
Annual_Net_Value = (Realized_Nodal_LMP - PPA_Strike) × Contracted_MWh
Contracted_MWh  = Nameplate × CF_P50 × 8,760 × (1 - Curtailment_rate)
```

**Current app:**
```typescript
const annualRevM = (capacityMw * cf * 8760 * da * captureRatio) / 1_000_000;
const logRev     = Math.log10(annualRevM);
const raw        = 20 + ((logRev + 2) / 4.3) * 75;  // 0-100 score
```

**Gap:** We compute *gross revenue* (no PPA strike price deducted) and log-scale it to a 0–100 score. We don't compute net PPA value because:
- PPA strike varies by deal
- The platform ranks candidates for Walmart to evaluate, not to price a specific PPA

**Recommendation:** The gross revenue scoring is appropriate for ranking. The reference's net PPA value formula should be added as a separate "deal calculator" feature (user inputs strike price, sees net value and NPV).

---

### 6. LCOE — MAJOR GAP

**Reference (§6.3):**
```
LCOE = [CapEx × CRF + Annual_FOM] / AEP + VOM
CRF  = r × (1+r)^n / [(1+r)^n - 1]
After-ITC: LCOE_net = [(CapEx × (1 - 0.30)) × CRF + FOM] / AEP + VOM
```

**Current app:**
- The "Lowest LCOE" objective (`lowest_lcoe` in `OBJECTIVE_WEIGHTS`) weights `priceScore` 30% + `financialScore` 25% etc.
- This is a *proxy* for LCOE preference, not an actual LCOE computation.
- No CapEx, FOM, VOM, CRF, or ITC values are stored in the candidates table.

**Recommendation:** Build a LCOE calculator as a sidebar panel on the candidate detail page. User inputs CapEx ($/kW), WACC, project life, FOM. App computes LCOE and shows it alongside the score. Default CapEx values: solar $1,000/kW, wind $1,400/kW, storage $300/kWh.

---

### 7. ITC / PTC — MAJOR GAP

**Reference (§6.4):**
```
ITC = ITC_rate × Total_Eligible_CapEx
PTC = $0.0275/kWh × AEP_MWh × 1,000  (10 years)
```

**Current app:**
- The `environmental_score` dimension scores REC value, not ITC/PTC
- No tax credit computation anywhere in the scoring engine

**Recommendation:** Add ITC/PTC as computed display fields in the candidate detail view. Solar/storage → ITC (30% of CapEx). Wind → PTC ($0.0275/kWh × AEP × 10yr NPV at WACC). Display both and let user see which is larger.

---

### 8. Shape Risk — MAJOR GAP

**Reference (§9.2):**
```
Shape_correlation = Pearson(Generator_profile_t, Load_profile_t)  [8,760 hrs]
Solar: +0.5 to +0.7 (daytime, moderate-high load correlation)
West TX wind: +0.1 to +0.3 (overnight, poor correlation)
Shape_risk_penalty = (1 - correlation) × avg_price × 0.02-0.05
```

**Current app:**
- `grid_stability_score` column exists in the DB but is NOT populated by the scoring engine
- No shape risk calculation implemented

**Recommendation:** This is achievable now that we have:
- Hourly ERCOT zone load data (174,282 rows in `ercot_load_hourly`)
- Hourly hub prices (in `ercot_hub_hourly` / `ercot_node_stats`)
- Technology-specific synthetic generation profiles by zone

Compute shape correlation as: `corr(tech_generation_profile_t, zone_load_t)` using typical diurnal profiles by asset type and season. Populate `grid_stability_score`.

---

### 9. Battery Storage

**Reference (§3.1–3.4):**
```
SoC_t+1 = SoC_t + Charge_t × η_charge - Discharge_t / η_discharge
Arbitrage_Value = Σ[Discharge × LMP] - Σ[Charge × LMP]
Min profitable spread = LMP_charge × (1/η_rte - 1)  [≈ 8.7% at η=0.92]
Battery LCOE: Cost_per_MWh = CapEx / (Cycles × η_rte) × 1,000 + VOM
```

**Current app:**
- SoC dynamics: **fully implemented** in `artifacts/pypsa-engine/simulators.py`
- Arbitrage value: **computed** in the PyPSA battery simulator (LP optimization)
- Score: treated as any other asset — capture ratio 1.18× (storage arbitrages)

**Gap:** The battery cycling economics formula (§9.9, cost per MWh discharged) is not shown to users. The PyPSA battery page shows revenue but not the breakeven spread analysis.

---

### 10. PPA NPV — NOT IMPLEMENTED

**Reference (§6.2):**
```
NPV = Σ_{y=1}^{T} [Annual_Net_Value_y / (1+WACC)^y] - Upfront_costs
```

**Current app:** Not implemented anywhere. The rankings page shows scores, not NPVs.

**Recommendation:** Add as a deal calculator feature. User inputs: strike price, contract term, WACC, CapEx. App outputs: NPV at P10/P50/P90 gas scenarios, breakeven gas price (§9.7).

---

### 11. Basis VaR — NOT IMPLEMENTED

**Reference (§8.3):**
```
Basis_VaR_95 = Mean_basis - 1.645 × StdDev_basis
```

**Current app:** Not computed. We have `avg_vol` (σ of monthly DA prices) and `avg_da` in `ercot_node_stats`, so `Basis_VaR_95 = avg_da - 1.645 × avg_vol` is computable from existing data.

**Recommendation:** Easy to add as a display field on the nodal analysis page.

---

## What to Build Next (Priority Order)

| Priority | Feature | Effort | Impact |
|----------|---------|--------|--------|
| 1 | **Shape Risk score** — Pearson(gen_profile, load_profile) | Medium | Fixes gap in `grid_stability_score` |
| 2 | **Basis VaR display** — `avg_da - 1.645 × avg_vol` on nodal page | Low | Exposes existing data in reference formula |
| 3 | **LCOE calculator panel** — user inputs CapEx/WACC, app computes | Medium | Makes "Lowest LCOE" objective meaningful |
| 4 | **ITC/PTC display** on candidate detail | Low | Tax credit context for deal team |
| 5 | **PPA deal calculator** — user inputs strike, sees NPV/breakeven | High | Core deal team workflow |
| 6 | **Hourly capture price** — profile-weighted LMPs from NREL data | High | Improves accuracy of price_score |

---

## What the App Does Well (Not in Reference Document)

- **Real nodal data:** 1,108 ERCOT resource nodes × 28 months of real DA/RT prices
- **Queue-based interconnect risk:** actual MW backlog from real CAISO queue data
- **PyPSA OPF simulation:** proper network physics for congestion/curtailment stress tests
- **PTDF shift factors:** bus-level load assignment from 345kV network model
- **Multi-market scoring:** ERCOT, CAISO, PJM with market-specific calibration
- **EIA 860 integration:** all 3,875 operable US generators scored automatically
