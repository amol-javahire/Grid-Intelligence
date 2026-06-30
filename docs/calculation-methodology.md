# Power Markets App — Calculation Methodology Reference

> **Purpose:** Formula library for app verification and implementation in Replit.  
> All formulas are ERCOT-centric unless noted. Units are explicit throughout.
>
> **Saved:** June 30, 2026. This is the canonical methodology document.  
> See `docs/methodology-comparison.md` for a comparison with the current app implementation.

---

## 1. CORE DISPATCH & PRICING

### 1.1 Marginal Cost of Generation
```
Marginal Cost ($/MWh) = Heat Rate (BTU/kWh) × Fuel Price ($/MMBtu) / 1,000
                       + Variable O&M ($/MWh)
                       + Emission Cost ($/MWh)   [if carbon priced]
```
Examples:
- CCGT at 7,000 BTU/kWh, gas $3.50/MMBtu, VOM $3/MWh → MC = 7.0 × 3.50 + 3 = **$27.50/MWh**
- Peaker at 10,500 BTU/kWh, gas $3.50/MMBtu → MC = 10.5 × 3.50 = **$36.75/MWh**

### 1.2 LMP Decomposition (ERCOT Nodal)
```
LMP_node = Energy_component + Congestion_component + Loss_component

Congestion_component = Σ (Shadow_price_constraint_k × PTDF_node_k)
  where PTDF = Power Transfer Distribution Factor (sensitivity of node flow to constraint)

Loss_component = Marginal_Loss_Factor × Reference_LMP
  (typically small: ±$0.50–2/MWh in ERCOT)
```

### 1.3 Nodal Discount / Basis
```
Basis ($/MWh) = Nodal_LMP - Hub_LMP

Average_Annual_Basis = mean(Hourly_Nodal_LMP - Hourly_Hub_LMP)  over 8,760 hours

Basis_Volatility = StdDev(Monthly_Avg_Basis)  [use for risk assessment]
```

### 1.4 Implied Heat Rate (market price signal)
```
Implied Heat Rate (BTU/kWh) = LMP ($/MWh) / Gas Price ($/MMBtu) × 1,000

Interpretation:
  < 6,500 BTU/kWh → renewables or coal setting price
  6,500–7,500    → efficient CCGT on margin
  7,500–9,000    → less efficient CCGT or older combined cycle
  9,000–12,000   → simple cycle peaker on margin
  > 12,000       → scarcity / demand response
```

### 1.5 Dispatch Stack (Merit Order)
```
For each generator i, compute MC_i (see 1.1)
Sort generators by MC ascending → dispatch order
Market price = MC of the last unit needed to meet demand (marginal unit)
```

---

## 2. THERMAL ASSET FORMULAS

### 2.1 Heat Rate Curve (Part-Load Efficiency)
```
Heat Rate at load fraction f = HR_full × (1 + α × (1-f) + β × (1-f)²)

Typical coefficients for CCGT:
  HR_full = 6,800 BTU/kWh
  α = 0.10,  β = 0.05
  → At 50% load: HR = 6,800 × (1 + 0.10×0.5 + 0.05×0.25) = ~7,480 BTU/kWh
```

### 2.2 Daily Fuel Cost (thermal unit)
```
Daily Fuel Cost ($) = Σ_t [Output_t (MW) × Heat_Rate_t (BTU/kWh) × Gas_Price ($/MMBtu) / 1,000]
                     + Startup_Cost ($) × [1 if started that day]
```

### 2.3 Summer De-rating
```
Derated Capacity (MW) = Nameplate (MW) × (1 - Derate_factor)

Derate_factor for CCGT (approximate):
  Ambient temp 95°F → 5% derate
  Ambient temp 105°F → 10-12% derate
  Rule of thumb: ~0.5% per °F above 59°F (ISO conditions)
```

### 2.4 Capacity Factor (thermal)
```
Capacity Factor (%) = Annual_Generation (MWh) / (Nameplate_MW × 8,760) × 100

Typical ERCOT values:
  CCGT baseload: 55–70%
  CCGT mid-merit: 30–50%
  Simple cycle peaker: 5–15%
```

---

## 3. BATTERY STORAGE FORMULAS

### 3.1 State of Charge (SoC) Transition
```
SoC_t+1 = SoC_t + (Charge_t × η_charge) - (Discharge_t / η_discharge)

where:
  Charge_t, Discharge_t in MWh during interval t
  η_charge = charge efficiency (e.g., 0.96)
  η_discharge = discharge efficiency (e.g., 0.96)
  Round-trip efficiency η_rte = η_charge × η_discharge (e.g., 0.92)

Constraints:
  SoC_min ≤ SoC_t ≤ SoC_max      (e.g., 0.05 × E_max to 0.95 × E_max)
  Charge_t ≤ P_max_charge
  Discharge_t ≤ P_max_discharge
  Charge_t × Discharge_t = 0      (cannot charge and discharge simultaneously)
```

### 3.2 Energy Arbitrage Value
```
Arbitrage_Value ($/day) = Σ_t [Discharge_t × LMP_t] - Σ_t [Charge_t × LMP_t] - VOM × Total_MWh

Perfect foresight upper bound:
  Value = Σ_peak_hours (LMP_peak × Discharge) - Σ_valley_hours (LMP_valley × Charge)

Efficiency-adjusted spread needed to be profitable:
  Min spread ($/MWh) = LMP_charge / η_rte - LMP_charge
                     = LMP_charge × (1/η_rte - 1)
  e.g., at η_rte=0.92: need spread > LMP_charge × 0.087
  If charging at $20/MWh: must discharge at > $20/0.92 = $21.74/MWh to profit
```

### 3.3 Ancillary Revenue (ERCOT)
```
ECRS Revenue ($/yr) = Capacity_offered (MW) × Clearing_price ($/MW-hr) × Hours_cleared

Regulation Revenue ($/yr) = Reg_capacity (MW) × Reg_price ($/MW-hr) × 8,760 × Utilization_factor
  Utilization_factor ≈ 0.1–0.2 (regulation capacity rarely fully deployed)

Total Battery Revenue = Arbitrage + ECRS + Regulation_Up + Regulation_Down + Non_Spin
```

### 3.4 Degradation
```
Capacity_year_n (MWh) = E_max × (1 - degradation_rate)^n
  degradation_rate ≈ 0.02/yr (2% per year Li-ion, calendar + cycle)

Augmentation cost: add capacity at year n to maintain contracted output
  Augmentation_cost = (E_max - Capacity_year_n) × $/kWh_replacement_cost
```

---

## 4. WIND & SOLAR FORMULAS

### 4.1 Wind Generation
```
Output_t (MWh) = Nameplate (MW) × CF_t × Δt (hr)
  where CF_t = capacity factor in hour t [0,1], derived from power curve

Power curve (simplified):
  Output = 0                                 if wind_speed < cut_in (typically 3 m/s)
  Output = Nameplate × (v³ - v_ci³)/(v_r³ - v_ci³)  if cut_in ≤ v < rated (typically 13 m/s)
  Output = Nameplate                         if rated ≤ v < cut_out (typically 25 m/s)
  Output = 0                                 if v ≥ cut_out

Losses applied to gross output:
  Net CF = Gross CF × (1 - wake_loss%) × (1 - availability_loss%) × (1 - electrical_loss%)
  Typical: 5–8% wake, 1–3% availability, 0.5–1% electrical → net ≈ 90–93% of gross
```

### 4.2 Solar Generation
```
Output_t (MWac) = G_t × A × η_panel × η_inverter × (1 - loss_total)
  where:
    G_t = irradiance (kW/m²) in hour t
    A = panel area (m²)
    η_panel = panel efficiency (~20–22% monocrystalline)
    η_inverter = inverter efficiency (~97–98%)
    loss_total = soiling + shading + wiring + temperature losses (~5–10%)

OR use capacity factor approach (simpler for PCM):
  Output_t (MWac) = Nameplate_MWac × CF_t
  CF_t from NREL PVWatts for site lat/lon/tilt/tracking type

DC/AC clipping adjustment:
  If DC_output > Nameplate_MWac (inverter limit):
    AC_output = min(DC_output × η_inverter, Nameplate_MWac)
  This occurs ~5–10% of hours with high ILR (1.3+)
```

### 4.3 Annual Energy Production (AEP)
```
AEP (MWh/yr) = Nameplate (MW) × 8,760 (hrs/yr) × Capacity_Factor

P50 AEP = best estimate of long-run average
P90 AEP = value exceeded 90% of years (more conservative; used for debt sizing)
P90 ≈ P50 × (1 - 1.28 × CV)   where CV = coefficient of variation of annual energy
  Typical CV: 5–8% wind, 2–4% solar

P50/P90 ratio: solar ~0.95–0.97; wind ~0.88–0.92
```

### 4.4 Curtailment Rate
```
Curtailment_Rate (%) = Curtailed_MWh / Potential_MWh × 100
  where Potential_MWh = what would have been generated absent curtailment

Effective_Capacity_Factor = Gross_CF × (1 - Curtailment_Rate)

Revenue_Impact = Curtailment_Rate × Nameplate × 8,760 × Avg_LMP
```

---

## 5. CARBON & EMISSIONS FORMULAS

### 5.1 Emission Rate Conversion
```
CO2 emissions (tons/MWh) = Heat_Rate (BTU/kWh) × Emission_Factor (lb/MMBtu) / (1,000 × 2,000)

Gas (CCGT at 6,800 BTU/kWh):
  CO2 = 6,800 × 117 / (1,000 × 2,000) = 0.398 MT CO2/MWh  (~0.41 commonly used)

Coal (at 10,000 BTU/kWh):
  CO2 = 10,000 × 205 / (1,000 × 2,000) = 1.025 MT CO2/MWh  (~0.95–1.0 commonly used)

NOx: Rate (lb/MMBtu) × Heat_Rate / 1,000 × 1/2,000 = tons NOx/MWh
SO2: Rate (lb/MMBtu) × Heat_Rate / 1,000 × 1/2,000 = tons SO2/MWh
```

### 5.2 Carbon Adder on Dispatch Cost
```
Carbon_Adder ($/MWh) = CO2_intensity (MT/MWh) × Carbon_Price ($/ton)

Gas CCGT: 0.41 MT/MWh × $28/ton  = $11.48/MWh
Gas CCGT: 0.41 MT/MWh × $50/ton  = $20.50/MWh
Gas CCGT: 0.41 MT/MWh × $87/ton  = $35.67/MWh   [CCA 2030F]
Coal:     0.95 MT/MWh × $28/ton  = $26.60/MWh

Adjusted MC = Base_MC + Carbon_Adder
```

### 5.3 CSAPR Emissions Calculation (for compliance tracking)
```
Emissions (tons) = Heat_Input (MMBtu/hr) × Emission_Rate (lb/MMBtu) / 2,000 × Operating_Hours

Annual SO2 tons = Σ_t [Heat_Input_t × SO2_rate / 2,000]
Annual NOx tons = Σ_t [Heat_Input_t × NOx_rate / 2,000]

Heat_Input (MMBtu/hr) = Output (MWh/hr) × Heat_Rate (BTU/kWh) / 1,000,000
```

### 5.4 CCA Price Impact on Import Competitiveness (CAISO, for reference)
```
Effective import value advantage ($/MWh) =
  [Gas_LMP × (1 + fuel_adjustment)] - [Import_price + Wheeling_cost]

At high CCA prices: gas plants carry carbon_adder; imports (renewables) don't.
Breakeven CCA price where imports win:
  CCA_breakeven = (Gas_MC - Import_price) / CO2_intensity_gas
```

---

## 6. PPA & INVESTMENT FORMULAS

### 6.1 PPA Net Value (annual, $/yr)
```
Annual_Net_Value = (Realized_Nodal_LMP - PPA_Strike) × Contracted_MWh

Contracted_MWh = Nameplate (MW) × CF_P50 × 8,760 × (1 - Curtailment_rate)

Realized_Nodal_LMP = Hub_LMP + Basis (negative for West TX, positive for Houston)
```

### 6.2 PPA NPV
```
NPV = Σ_{y=1}^{T} [Annual_Net_Value_y / (1 + WACC)^y] - Upfront_costs

where:
  T = contract term (years)
  WACC = 7–9% typical for corporate offtaker
  Annual_Net_Value_y = f(gas_price_scenario, renewable_build, curtailment)

Sensitivity: run at P10/P50/P90 gas price and renewable build scenarios
NPV_risk = (NPV_P90 - NPV_P10) / 2   [half-width of uncertainty range]
```

### 6.3 Levelized Cost of Energy (LCOE)
```
LCOE ($/MWh) = [CapEx × CRF + Annual_FOM] / Annual_AEP_MWh + VOM

Capital Recovery Factor (CRF) = r × (1+r)^n / [(1+r)^n - 1]
  r = discount rate (WACC); n = project life (years)

After-ITC LCOE:
  LCOE_net = [(CapEx × (1 - ITC_rate)) × CRF + Annual_FOM] / AEP + VOM

Example: 200 MW solar, $1,100/kW CapEx, 30% ITC, 8% WACC, 25yr life, 28% CF:
  CapEx_after_ITC = $1,100 × 0.70 = $770/kW = $154M total
  CRF = 0.08 × 1.08^25 / (1.08^25 - 1) = 0.0937
  AEP = 200 × 0.28 × 8,760 = 490,560 MWh/yr
  LCOE = (154M × 0.0937 + $3M FOM) / 490,560 + $1.50 VOM ≈ $31.90/MWh
```

### 6.4 ITC / PTC Calculation
```
ITC Credit ($) = ITC_rate × Total_Eligible_Project_Cost
  Total_eligible = CapEx (equipment + construction) — excludes land, interconnection
  Base+PW/Apprenticeship: 30%; + Energy Community: 40%; + Domestic Content: 50%; + Low-Income: 60%

PTC Annual Value ($) = PTC_rate ($/kWh) × AEP_MWh × 1,000
  = $0.0275/kWh × AEP_MWh × 1,000

PTC 10-yr NPV = PTC_annual / WACC × (1 - 1/(1+WACC)^10)

ITC vs PTC breakeven CF:
  Use ITC if: CapEx × ITC_rate > PTC_annual_value × PTC_NPV_factor
  Typically wind prefers PTC (high CF × 10yrs), solar can go either way
```

### 6.5 Revenue at Risk (RaR)
```
Revenue_at_Risk_95 = Revenue_P50 - Revenue_P5   [95th percentile downside]

For PPA offtaker:
  PPA_cost = Strike × Contracted_MWh (fixed)
  Market_value = Realized_LMP × Actual_MWh (variable)
  Net_P5 = Revenue_P5_market - PPA_cost_P95 [worst case combination]
```

---

## 7. EV LOAD FORMULAS

### 7.1 EV Load Addition (hourly)
```
EV_Load_t (MW) = N_vehicles × E_daily (kWh/vehicle) × f_charge_t / Δt

where:
  N_vehicles = total EV fleet in region
  E_daily = 38 miles/day × 0.30 kWh/mile = 11.4 kWh/vehicle/day
  f_charge_t = fraction of daily charging occurring in hour t
    Unmanaged home L2: ~80% of charging in hours 17-22 (5-10 PM)
    Managed TOU: ~80% of charging in hours 23-06 (11 PM-6 AM)
    Workplace: ~70% in hours 8-17

Sum check: Σ_t f_charge_t = 1.0 (all energy charged each day)
```

### 7.2 V2G Available Capacity
```
V2G_capacity (MW) = N_vehicles × participation_rate × avg_usable_battery (kWh)
                    × discharge_rate_factor / duration_hours

where:
  avg_usable_battery ≈ 40 kWh (leaving 50% SoC for driver range)
  discharge_rate_factor ≈ 0.5 (L2 bidirectional: 7.2 kW max)
  
Example 2030: 5M vehicles × 10% participation × 40 kWh available
  = 200 GWh potential storage; at 4-hr discharge: 50 GW theoretical
  Practically: 5–8 GW realizable with L2 V2G infrastructure
```

### 7.3 EV Load Factor Impact
```
Load_Factor = Avg_Load / Peak_Load

Unmanaged EV: coincides with peak → Load_Factor decreases (worse)
Managed EV: fills valley → Load_Factor increases (better)

Peak reduction from managed vs unmanaged:
  ΔPeak (MW) = EV_Load_unmanaged_peak - EV_Load_managed_peak
```

---

## 8. CONGESTION & TRANSMISSION FORMULAS

### 8.1 Congestion Component of LMP
```
Congestion_LMP_node = -Σ_k [λ_k × PTDF_node,k]

where:
  λ_k = shadow price on transmission constraint k ($/MWh) [positive when binding]
  PTDF_node,k = power transfer distribution factor (fraction of injection at node
                that flows on constraint k); range [-1, 1]

Negative congestion component → nodal LMP < hub → generator disadvantaged
Positive congestion component → nodal LMP > hub → load pays premium
```

### 8.2 Congestion Rent
```
Congestion_Rent ($/hr) = Shadow_price_k ($/MWh) × Flow_limit_k (MW)

Annual congestion rent on constraint k:
  = Σ_t [λ_k,t × F_limit_k × 1_binding_t]

TCR (Transmission Congestion Right) value = expected annual congestion rent on a path
```

### 8.3 Basis Risk Quantification
```
Basis_VaR_95 = Mean_basis - 1.645 × StdDev_basis   [monthly basis distribution]

If basis is normally distributed:
  95th percentile worst basis = Mean - 1.645σ
  99th percentile: Mean - 2.326σ

Revenue impact of basis widening by ΔBasis:
  Annual_revenue_impact = ΔBasis ($/MWh) × Annual_MWh_sold
```

---

## 9. ADDITIONAL FORMULAS SUGGESTED FOR THE APP

### 9.1 Price Cannibalization (renewable saturation)
```
Price_suppression ($/MWh per GW) ≈ -$0.50 to -$1.00/MWh per GW solar added

More precise model:
  ΔPrice = α × ΔRenewable_penetration%
  α estimated from historical ERCOT regression: ~-$0.30 to -$0.50 per 1% penetration increase

Cannibalization_factor for solar asset revenue:
  Revenue_year_n = Revenue_year_1 × (1 - penetration_growth × price_suppression)^n
```

### 9.2 Shape Risk Score
```
Shape_correlation = Pearson(Generator_profile_t, Load_profile_t)  over 8,760 hrs

Range: -1 to +1
  +1 = perfect match (generator produces when load is high — ideal)
   0 = no correlation
  -1 = anti-correlated (generates when load is low — worst case)

Solar shape score: +0.5 to +0.7 (produces during day when load is moderate-high)
West TX wind shape score: +0.1 to +0.3 (produces nights/shoulder when load is lower)

Shape_risk_penalty = (1 - Shape_correlation) × avg_price × imbalance_rate
  imbalance_rate ≈ 0.02–0.05 (2–5% of revenue lost to shape mismatch)
```

### 9.3 Net Revenue Adequacy (for thermal investment signal)
```
Net_Revenue = Energy_Revenue + Ancillary_Revenue - Fixed_O&M

Energy_Revenue = Σ_t [max(0, LMP_t - MC_t) × Nameplate] × (1 - FOR)
  (unit earns infra-marginal rent when LMP > MC)

Investment_viable if: Net_Revenue > Annualized_CapEx (i.e., CRF × CapEx)
Missing_money = Annualized_CapEx - Net_Revenue  [drives scarcity pricing events]
```

### 9.4 ELCC (Effective Load-Carrying Capability)
```
ELCC = capacity of a perfectly reliable unit that provides the same
       reliability improvement as the renewable fleet

Approximation for solar in ERCOT:
  ELCC_solar ≈ CF_at_peak_hours × Nameplate
  Peak hours = top 10% load hours (roughly 2–8 PM summer)
  Solar ELCC ≈ 20–35% of nameplate (produces well during afternoon peak)

For wind:
  ELCC_wind ≈ CF_at_peak_hours × Nameplate
  Wind ELCC ≈ 10–20% of nameplate (often low CF during summer afternoon peak in TX)

Battery ELCC:
  ELCC_battery ≈ min(Power_MW, Energy_MWh / Peak_Duration_hrs)
  4-hr battery: ELCC ≈ ~80–90% of power rating
```

### 9.5 Reserve Margin & Scarcity Pricing
```
Reserve_Margin (%) = (Installed_Capacity - Peak_Demand) / Peak_Demand × 100
ERCOT target: ~13.75% planning reserve margin (2026)

Scarcity_hours/yr ≈ f(Reserve_Margin)
  At 10% RM: ~50–100 scarcity hours/yr
  At 5% RM: ~200–400 scarcity hours/yr

Scarcity_revenue_contribution = Scarcity_hours × (VOLL - MC) × Nameplate
  VOLL (Value of Lost Load) in ERCOT = $5,000/MWh cap (ERCOT ORDC)
  ORDC (Operating Reserve Demand Curve) adder:
    At 2,000 MW reserves: ORDC = ~$0/MWh
    At 1,000 MW: ORDC = ~$300/MWh
    At 500 MW: ORDC = ~$1,500/MWh
    Below 1,500 MW (Low Frequency threshold): ORDC = $5,000/MWh
```

### 9.6 Gas-Power Price Relationship
```
Power_price ≈ Gas_price × IHR + VOM + Carbon_adder

where IHR = implied heat rate (BTU/kWh) of marginal unit

Regression to estimate IHR by season/hour:
  LMP_t = β_0 + β_1 × Gas_t + ε_t

β_1 = IHR estimate; R² should be > 0.6 in gas-dominated market (ERCOT)

Use for: quick power price estimation when running PLEXOS is too slow
```

### 9.7 PPA Breakeven Gas Price
```
PPA_breakeven_gas = (Strike - VOM - Basis) / (IHR / 1,000)
  
i.e., the gas price at which the forward power curve equals PPA strike

If gas_forward < PPA_breakeven: PPA is above market (offtaker overpaying)
If gas_forward > PPA_breakeven: PPA is below market (offtaker getting a deal)

Example: Strike $30/MWh, VOM $2, Basis -$8, IHR 7,200 BTU/kWh
  Breakeven gas = (30 - 2 - (-8)) / (7.2) = $36 / 7.2 = $5.00/MMBtu
  → If gas forward < $5/MMBtu, PPA looks expensive
```

### 9.8 Solar/Wind Revenue Degradation (multi-year)
```
Revenue_year_n = Revenue_year_1 × (1 - deg_rate)^n × (Price_year_n / Price_year_1)

where deg_rate = panel/turbine degradation:
  Solar: 0.3–0.5%/yr
  Wind: 0.5–1.0%/yr (blade wear, gearbox)

Combined 20-yr degradation:
  Solar: (1-0.004)^20 = 0.923 → 7.7% energy loss
  Wind:  (1-0.007)^20 = 0.869 → 13.1% energy loss
```

### 9.9 Battery Cycling Economics
```
Cost_per_cycle = (CapEx / (Cycles_lifetime × η_rte)) + VOM

Cycles_lifetime for Li-ion: 3,000–5,000 at 80% DoD (depth of discharge)
  At $250/kWh CapEx, 4,000 cycles, η_rte=0.92:
  Cost_per_cycle = $250 / (4,000 × 0.92) + $1.50 = $0.068 + $1.50 = $1.57/kWh discharged

Profitability condition (arbitrage):
  Required spread ($/MWh) > Cost_per_MWh_discharged

Corrected formula:
  Cost_per_MWh_discharged = CapEx($/MWh) / (Cycles × η_rte) × 1,000 + VOM($/MWh)
  = $250,000/MWh / (4,000 × 0.92) × 1 MWh + $1.50
  = $68/MWh + $1.50 = $69.50/MWh

  Min spread needed: LMP_discharge - LMP_charge/η_rte > $69.50/MWh  
  i.e., Sell price > Buy_price/0.92 + $69.50
```

### 9.10 Site Congestion Score (composite ranking metric)
```
Congestion_Score = w1 × Normalized_Basis + w2 × Normalized_Curtailment + w3 × Normalized_Volatility

Normalized values: z-score across all candidate nodes
Weights: w1=0.5, w2=0.3, w3=0.2 (adjust per use case)

Combined_Score = Resource_Score × (1 - Congestion_Score)
  → Ranks sites by resource quality penalized by congestion risk
```

---

## 10. KEY CONSTANTS & REFERENCE VALUES

| Parameter | Value | Notes |
|-----------|-------|-------|
| Gas CO2 intensity | 117 lb/MMBtu | EPA default for natural gas |
| Coal CO2 intensity | 205 lb/MMBtu | Bituminous coal |
| Gas to power CO2 | 0.41 MT CO2/MWh | CCGT at 7,000 BTU/kWh |
| Coal to power CO2 | 0.95 MT CO2/MWh | At 9,280 BTU/kWh |
| Unit conversion | 1 MMBtu = 1,000 kBtu = 1,000,000 BTU | |
| Unit conversion | 1 ton = 2,000 lbs | US short ton |
| ERCOT VOLL cap | $5,000/MWh | Energy offer cap |
| ERCOT peak hours | ~83 hrs/yr | Top 1% load hours |
| Li-ion round-trip eff | 88–92% | Modern utility-scale |
| Li-ion degradation | ~2%/yr | Calendar + cycle aging |
| Wind wake loss | 5–8% | Internal array losses |
| Solar soiling loss | 1–3% | Region/dust dependent |
| Solar DC/AC ratio | 1.25–1.40 | Typical ILR |
| PTC rate (2024) | $0.0275/kWh | With prevailing wage |
| ITC rate (2024) | 30% base | With prevailing wage |
| ERCOT planning RM | 13.75% | 2026 target |
| WACC (utility) | 7–9% | Typical LCOE discount rate |

---

## 11. DATA SOURCES FOR APP INTEGRATION

| Data | Source | API/Access |
|------|--------|------------|
| ERCOT nodal LMPs | ercot.com → Market Data | Public download / ERCOT API |
| ERCOT generation by fuel | ercot.com → Grid Info | Public |
| ERCOT ancillary prices | ercot.com → Market Data | Public |
| NYMEX gas futures | CME Group | CME DataMine API |
| EIA generator data | eia.gov/electricity | EIA Open Data API |
| NREL wind/solar resource | wtk.nrel.gov / nsrdb.nrel.gov | NREL API (free key) |
| EPA plant emissions | campd.epa.gov | CAM API (REST, free) |
| DOE Energy Communities | energycommunities.gov | GIS layer download |
| ERCOT CDR | ercot.com → Planning | PDF/Excel download |
