/**
 * Renewable Energy Credit (REC) computation utilities.
 *
 * Methodology:
 *   Annual RECs (MWh) = capacity_mw × capacity_factor × 8,760 h
 *   Annual value ($)  = annual_mwh × rec_price_per_mwh
 *
 * Capacity factors: EIA / ISO annual reports (2024 averages).
 *
 * REC benchmark prices (updated Jul 2025):
 *   ERCOT → Texas Renewable Energy Credits (TRCs): $2–5/MWh by fuel type
 *            Wind TRCs $1–5/MWh (oversupplied); solar TRCs $3–10/MWh (no carve-out but scarcer).
 *            Sources: ERCOT REC program, Green-e Certification data, broker surveys 2025.
 *   CAISO → CA WREGIS voluntary/unbundled RECs (PCC3 TRECs): $5–10/MWh
 *            Solar commands highest demand from CA utilities; geothermal valued for baseload.
 *            Sources: CPUC/CEC WREGIS reports, voluntary market broker data 2025.
 *   PJM   → State-specific: SRECs (solar), ORECs (offshore), Class I/II RECs (wind/other)
 *            NJ legacy SREC near SACP ceiling (~$200/MWh); MD $45–70/MWh (2025);
 *            PA $40–50/MWh; DC Tier 1 very constrained ($400+).
 *            Sources: PJM GATS, NJBPU, MEA, SREC Trade, state PUC filings (2025)
 */

// Capacity factors: EIA / ISO annual reports (2024 actuals).
// ERCOT wind 38% confirmed by Potomac Economics 2024 SOTM (Table 2, pub. Jun 2025).
// ERCOT solar 27% consistent with ERCOT generation reports 2024.
// CAISO solar 29% from CAISO 2024 annual statistics; wind 28% system average.
const CAPACITY_FACTORS: Record<string, Record<string, number>> = {
  solar:        { ERCOT: 0.27, CAISO: 0.29, PJM: 0.22 },
  wind:         { ERCOT: 0.38, CAISO: 0.28, PJM: 0.35 },  // ERCOT ↓ from 0.40 (Potomac 2024); CAISO ↓ from 0.32
  offshore_wind:{ ERCOT: 0.42, CAISO: 0.42, PJM: 0.45 },
  hydro:        { ERCOT: 0.40, CAISO: 0.42, PJM: 0.38 },
  geothermal:   { ERCOT: 0.88, CAISO: 0.88, PJM: 0.88 },
  biomass:      { ERCOT: 0.65, CAISO: 0.65, PJM: 0.65 },
  hybrid:       { ERCOT: 0.27, CAISO: 0.29, PJM: 0.22 },
  solar_storage:{ ERCOT: 0.27, CAISO: 0.29, PJM: 0.22 },
  wind_storage: { ERCOT: 0.38, CAISO: 0.28, PJM: 0.35 },
};

// ERCOT TRC prices by fuel type ($/MWh) — Texas Renewable Energy Credits (2025)
// Wind TRCs: $1–5/MWh (heavily oversupplied by CREZ buildout; voluntary market only)
// Solar TRCs: $3–10/MWh (no solar carve-out but less abundant than wind → premium)
// Source: Green-e, ERCOT REC program, broker surveys 2025
const ERCOT_PRICES: Record<string, number> = {
  solar:         5.00,  // was 2.00 — updated to 2025 solar TRC premium range midpoint
  wind:          2.00,  // was 1.00 — updated to 2025 range midpoint ($1–5)
  offshore_wind: 2.00,
  hydro:         1.50,  // was 1.25
  geothermal:    2.00,  // was 1.25 — rare baseload premium
  biomass:       1.50,  // was 1.25
  hybrid:        5.00,  // was 2.00 — follows solar component
  solar_storage: 5.00,  // was 2.00
  wind_storage:  2.00,  // was 1.00
};

// CAISO WREGIS voluntary/unbundled REC prices by fuel type ($/MWh) — 2025
// PCC3 (unbundled TRECs): tradeable separately from power delivery — lowest tier
// Solar: $8–12/MWh; wind: $5–7/MWh; geothermal: $6–10/MWh (baseload premium)
// Source: CPUC/CEC WREGIS reports, voluntary market broker surveys 2025
const CAISO_PRICES: Record<string, number> = {
  solar:         10.00,  // was 13.00 — updated to unbundled voluntary range
  wind:           6.00,  // was 8.00  — oversupply continues to weigh on prices
  offshore_wind:  6.00,  // was 8.00
  hydro:          5.00,  // was 6.00  — large hydro has limited RPS eligibility
  geothermal:     8.00,  // was 10.00 — baseload premium, fewer projects
  biomass:        5.00,  // was 6.00
  hybrid:        10.00,  // was 13.00 — follows solar component
  solar_storage: 10.00,  // was 13.00
  wind_storage:   6.00,  // was 8.00
};

// PJM solar SREC prices by state ($/MWh) — from PJM GATS / state PUC data (2024)
// DC, NJ, IL, MD, PA have active SREC markets; others have generic Class I RECs
export const PJM_SOLAR_SREC_BY_STATE: Record<string, number> = {
  DC: 430,  // DC SRECs — solar Tier 1 carve-out, very limited supply; DOEE (2025)
  NJ: 200,  // NJ SRECs — SACP ceiling was $218 (2024)→$208 (2025); spot near ceiling; NJBPU (2025)
  IL:  80,  // IL Shines ADRECs — adjusted delivery payments; IPA (2025)
  MD:  65,  // MD SREC — MEA data (2025): range $45–70; ACP declining to $22.50 by 2030
  PA:  45,  // PA SRECs — AEPS Act; SREC Trade (2025)
  DE:  20,  // DE SRECs — DESRP; DPUC (2025)
  VA:   5,  // VA — VCEA, bundled REC only, no solar carve-out
  NC:   3,  // NC REPS — modest solar REC premium
  OH:   2,  // OH — limited RPS after 2014 freeze
  IN:   2,  // IN — voluntary market
  WV:   1,  // WV — minimal RPS
  KY: 0.75, // KY — no RPS mandate
  MI:   2,  // MI — PSCR program
  MN:   4,  // MN — MSIA NextGen program
  TN:   1,  // TN — no state RPS
};

// PJM non-solar REC prices by state ($/MWh) — Class I wind / hydro / biomass (2025)
export const PJM_NONSOLAR_REC_BY_STATE: Record<string, number> = {
  DC:   8,
  NJ:   7,  // NJ Class I REC
  IL:   2,
  MD:   6,
  PA:  10,  // PA AEPS Tier I — updated to $8–12 range midpoint (2025)
  DE:   5,
  VA:   5,
  NC:   3,
  OH: 1.5,
  IN:   2,
  WV:   1,
  KY: 0.75,
  MI:   2,
  MN:   4,
  TN:   1,
};

// Offshore OREC by state ($/MWh) — state-specific offshore programs
const PJM_OFFSHORE_OREC_BY_STATE: Record<string, number> = {
  NJ: 120,  // NJ OREC program
  MD: 132,  // MD OREC (2024 auction)
  VA:  80,  // VA offshore (Coastal Virginia program)
};

// REC market program label by state (for display)
export function getPjmRecLabel(assetType: string, state: string): string {
  const t = assetType.toLowerCase();
  if (t === "offshore_wind") {
    return state in PJM_OFFSHORE_OREC_BY_STATE ? `${state} OREC` : "PJM Class I REC";
  }
  if (t === "solar" || t === "solar_storage" || t === "hybrid") {
    const hasActiveSrec = ["DC","NJ","IL","MD","PA","DE"].includes(state);
    if (state === "DC") return "DC SREC (Tier 1)";
    if (state === "IL") return "IL Shines ADEC";
    if (hasActiveSrec) return `${state} SREC`;
    return `${state} Class I REC`;
  }
  return `${state} Class I REC`;
}

const REC_ELIGIBLE = new Set([
  "solar", "wind", "offshore_wind", "hydro",
  "geothermal", "biomass", "hybrid", "solar_storage", "wind_storage",
]);

export interface RecData {
  recEligible: boolean;
  annualRecMwh: number;
  recPricePerMwh: number;
  annualRecValueUsd: number;
  lifetimeRecValue20yr: number;
  recMarketLabel: string;
}

export function computeRec(assetType: string, market: string, capacityMw: number, state?: string): RecData {
  const t = (assetType ?? "").toLowerCase();
  const eligible = REC_ELIGIBLE.has(t);

  if (!eligible || capacityMw <= 0) {
    return {
      recEligible: false,
      annualRecMwh: 0,
      recPricePerMwh: 0,
      annualRecValueUsd: 0,
      lifetimeRecValue20yr: 0,
      recMarketLabel: "",
    };
  }

  const cf = CAPACITY_FACTORS[t]?.[market] ?? 0.30;
  const genRatio = t === "hybrid" ? 0.60 : 1.0;

  let price: number;
  let recMarketLabel: string;

  if (market === "ERCOT") {
    price = ERCOT_PRICES[t] ?? 1.25;
    recMarketLabel = "Texas TRC";
  } else if (market === "CAISO") {
    price = CAISO_PRICES[t] ?? 7.00;
    recMarketLabel = "CA WREGIS RPS";
  } else {
    // PJM — state-specific
    const st = (state ?? "").toUpperCase();
    if (t === "offshore_wind") {
      price = PJM_OFFSHORE_OREC_BY_STATE[st] ?? 120;
    } else if (t === "solar" || t === "solar_storage" || t === "hybrid") {
      price = PJM_SOLAR_SREC_BY_STATE[st] ?? 5;
    } else {
      price = PJM_NONSOLAR_REC_BY_STATE[st] ?? 3;
    }
    recMarketLabel = st ? getPjmRecLabel(t, st) : "PJM REC";
  }

  const annualRecMwh      = Math.round(capacityMw * cf * 8760 * genRatio);
  const annualRecValueUsd = Math.round(annualRecMwh * price);

  return {
    recEligible: true,
    annualRecMwh,
    recPricePerMwh: price,
    annualRecValueUsd,
    lifetimeRecValue20yr: annualRecValueUsd * 20,
    recMarketLabel,
  };
}
