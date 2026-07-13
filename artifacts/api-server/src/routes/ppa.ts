import { Router } from "express";
import { db } from "@workspace/db";
import { candidatesTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

const router = Router();

// Capacity factor by asset type × market
const CF: Record<string, Record<string, number>> = {
  solar:       { ERCOT: 0.27, CAISO: 0.29, PJM: 0.22 },
  wind:        { ERCOT: 0.40, CAISO: 0.32, PJM: 0.35 },
  storage:     { ERCOT: 0.18, CAISO: 0.18, PJM: 0.18 },
  natural_gas: { ERCOT: 0.60, CAISO: 0.55, PJM: 0.58 },
  nuclear:     { ERCOT: 0.92, CAISO: 0.92, PJM: 0.92 },
  hydro:       { ERCOT: 0.40, CAISO: 0.42, PJM: 0.38 },
  biomass:     { ERCOT: 0.65, CAISO: 0.65, PJM: 0.65 },
  geothermal:  { ERCOT: 0.88, CAISO: 0.88, PJM: 0.88 },
  coal:        { ERCOT: 0.55, CAISO: 0.55, PJM: 0.55 },
};

// Capture ratios from real hourly ERCOT data (scoring v6) / OASIS for CAISO
const ERCOT_CAPTURE: Record<string, number> = {
  solar: 0.724, wind: 1.010, storage: 1.797, natural_gas: 1.0,
  nuclear: 0.99, hydro: 0.95, biomass: 0.99, geothermal: 1.0, coal: 0.94,
};
const CAISO_CAPTURE: Record<string, number> = {
  solar: 0.68, wind: 0.95, storage: 1.90, natural_gas: 0.98,
  nuclear: 0.95, hydro: 1.05, biomass: 0.99, geothermal: 1.0, coal: 0.94,
};
const PJM_CAPTURE: Record<string, number> = {
  solar: 0.82, wind: 0.90, storage: 1.45, natural_gas: 0.98,
  nuclear: 0.95, hydro: 1.02, biomass: 0.99, geothermal: 1.0, coal: 0.94,
};

// Market DA reference prices ($/MWh, 2024 avg from real data)
// Used as fallback when no forward curve is available
const MARKET_REF_DA: Record<string, number> = {
  ERCOT: 31.42, CAISO: 33.25, PJM: 38.50,
};

// REC market base prices $/MWh (conservative: ERCOT TRECs low; PJM generic, not state SRECs)
const REC_BASE_MWH: Record<string, number> = {
  ERCOT: 2.0, CAISO: 7.0, PJM: 5.5,
};

function getCaptureRatio(assetType: string, market: string): number {
  if (market === "ERCOT") return ERCOT_CAPTURE[assetType] ?? 0.90;
  if (market === "CAISO") return CAISO_CAPTURE[assetType] ?? 0.90;
  return PJM_CAPTURE[assetType] ?? 0.90;
}

/**
 * Convert all ranking dimension scores into financial adjustments.
 * All scores are 0–100 (higher = better / lower risk).
 */
function scoreToRiskDefaults(scores: {
  locationScore:       number;
  curtailmentScore:    number;
  gridStabilityScore:  number;
  interconnectionScore: number;
  developmentRiskScore: number;
  environmentalScore:  number;
  financialScore:      number;
  market:              string;
}) {
  const {
    locationScore, curtailmentScore, gridStabilityScore,
    interconnectionScore, developmentRiskScore, environmentalScore,
    financialScore, market,
  } = scores;

  const basisAdjMwh = locationScore >= 50
    ? ((locationScore - 50) / 50) * 6
    : ((locationScore - 50) / 50) * 12;

  const curtailmentHaircut = Math.max(0, Math.min(0.25, (100 - curtailmentScore) / 100 * 0.22));
  const shapeDiscount = Math.max(0, Math.min(0.20, (100 - gridStabilityScore) / 100 * 0.15));
  const avgReliability = (interconnectionScore + developmentRiskScore) / 2;
  const availabilityFactor = 0.93 + (avgReliability / 100) * 0.06;
  const recRevenueMwh = (REC_BASE_MWH[market] ?? 4) * (environmentalScore / 100);

  const spreadHalf = 0.15 + (1 - financialScore / 100) * 0.10;
  const p10Multiplier = 1 + spreadHalf;
  const p90Multiplier = 1 - spreadHalf;

  return {
    basisAdjMwh:       Math.round(basisAdjMwh * 100) / 100,
    curtailmentHaircut: Math.round(curtailmentHaircut * 1000) / 1000,
    shapeDiscount:      Math.round(shapeDiscount * 1000) / 1000,
    availabilityFactor: Math.round(availabilityFactor * 1000) / 1000,
    recRevenueMwh:      Math.round(recRevenueMwh * 100) / 100,
    p10Multiplier:      Math.round(p10Multiplier * 1000) / 1000,
    p90Multiplier:      Math.round(p90Multiplier * 1000) / 1000,
  };
}

function npv(cashflows: number[], wacc: number): number {
  return cashflows.reduce((sum, cf, t) => sum + cf / Math.pow(1 + wacc, t + 1), 0);
}

/**
 * Fetch the average synthetic power price from the gas forward strip.
 * Returns null if no strip data is available.
 *
 * Synthetic price = gasForward × heatRate × seasonalMultiplier
 * Default heat rate 8.5 MMBtu/MWh (representative ERCOT marginal unit)
 */
async function computeForwardPowerAvg(heatRate: number = 8.5): Promise<number | null> {
  try {
    const rows = await db.execute<{ delivery_month: string; settle_price: string }>(sql`
      SELECT delivery_month::text, settle_price::float8
      FROM gas_forwards
      WHERE as_of_date = (SELECT MAX(as_of_date) FROM gas_forwards)
        AND settle_price IS NOT NULL
      ORDER BY delivery_month ASC
    `);
    if (!rows.rows.length) return null;
    const avg = rows.rows.reduce((s, r) => s + Number(r.settle_price) * heatRate, 0) / rows.rows.length;
    return Math.round(avg * 100) / 100;
  } catch {
    return null;
  }
}

/**
 * GET /api/ppa-npv
 *
 * Compute VPPA NPV incorporating all 8 ranking dimension scores as financial adjustments.
 *
 * Optional params:
 *   forwardPowerPriceMwh  — override market reference DA price with synthetic power forward avg
 *                           (computed by ercot-gas Forward Curve tab: gasStrip × heatRate)
 *                           When provided, marketRefSource = 'forward_curve'
 *                           When absent, tries gas_forwards table; falls back to historical avg
 */
router.get("/ppa-npv", async (req, res) => {
  try {
    const candidateId = Number(req.query.candidateId);
    if (!candidateId || isNaN(candidateId)) {
      res.status(400).json({ error: "bad_request", message: "candidateId required" });
      return;
    }

    const strike     = Number(req.query.strike ?? 35);
    const term       = Math.min(30, Math.max(1, Number(req.query.term ?? 15)));
    const wacc       = Math.max(0.01, Math.min(0.20, Number(req.query.wacc ?? 0.08)));
    const escalation = Math.max(0, Math.min(0.10, Number(req.query.escalation ?? 0.015)));

    const [cand] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, candidateId));
    if (!cand) {
      res.status(404).json({ error: "not_found", message: "Candidate not found" });
      return;
    }

    const assetType  = cand.assetType;
    const market     = cand.market;
    const capacityMw = Number(cand.capacityMw);
    const cf         = CF[assetType]?.[market] ?? 0.30;
    const captureRatio = getCaptureRatio(assetType, market);

    // Read all scoring dimensions
    const locationScore       = cand.locationScore       ? Number(cand.locationScore)       : 50;
    const curtailmentScoreN   = cand.curtailmentScore    ? Number(cand.curtailmentScore)    : 50;
    const gridStabilityN      = cand.gridStabilityScore  ? Number(cand.gridStabilityScore)  : 50;
    const interconnectionN    = cand.interconnectionScore ? Number(cand.interconnectionScore) : 50;
    const developmentRiskN    = cand.developmentRiskScore ? Number(cand.developmentRiskScore) : 50;
    const environmentalN      = cand.environmentalScore  ? Number(cand.environmentalScore)  : 50;
    const financialN          = cand.financialScore      ? Number(cand.financialScore)      : 50;
    const demandProximityN    = cand.demandProximityScore ? Number(cand.demandProximityScore) : 50;
    const regulatoryN         = cand.regulatoryScore     ? Number(cand.regulatoryScore)     : 50;

    const defaults = scoreToRiskDefaults({
      locationScore, curtailmentScore: curtailmentScoreN, gridStabilityScore: gridStabilityN,
      interconnectionScore: interconnectionN, developmentRiskScore: developmentRiskN,
      environmentalScore: environmentalN, financialScore: financialN, market,
    });

    // Accept caller overrides or fall back to score-derived defaults
    const basisAdjMwh      = req.query.basisAdjMwh       !== undefined ? Number(req.query.basisAdjMwh)       : defaults.basisAdjMwh;
    const curtailmentHaircut = req.query.curtailmentHaircut !== undefined ? Math.max(0, Math.min(0.25, Number(req.query.curtailmentHaircut))) : defaults.curtailmentHaircut;
    const shapeDiscount    = req.query.shapeDiscount      !== undefined ? Math.max(0, Math.min(0.20, Number(req.query.shapeDiscount)))      : defaults.shapeDiscount;
    const availabilityFactor = req.query.availabilityFactor !== undefined ? Math.max(0.80, Math.min(1.0, Number(req.query.availabilityFactor))) : defaults.availabilityFactor;
    const recRevenueMwh    = req.query.recRevenueMwh      !== undefined ? Math.max(0, Math.min(30, Number(req.query.recRevenueMwh)))         : defaults.recRevenueMwh;

    const p10Multiplier = defaults.p10Multiplier;
    const p90Multiplier = defaults.p90Multiplier;

    // ── Market reference price resolution ─────────────────────────────────
    // Priority: (1) caller-provided forwardPowerPriceMwh, (2) gas_forwards strip, (3) historical avg
    let marketRefDA: number;
    let marketRefSource: "caller_override" | "forward_curve" | "historical_avg";

    if (req.query.forwardPowerPriceMwh !== undefined) {
      const v = Number(req.query.forwardPowerPriceMwh);
      marketRefDA = !isNaN(v) && v > 0 ? v : (MARKET_REF_DA[market] ?? 31.42);
      marketRefSource = "caller_override";
    } else {
      // Try to derive from gas forward strip (ERCOT markets only for now)
      const fwdAvg = market === "ERCOT" ? await computeForwardPowerAvg(8.5) : null;
      if (fwdAvg != null && fwdAvg > 0) {
        marketRefDA = fwdAvg;
        marketRefSource = "forward_curve";
      } else {
        marketRefDA = MARKET_REF_DA[market] ?? 31.42;
        marketRefSource = "historical_avg";
      }
    }

    // Price build-up
    const rawCapturePrice   = marketRefDA * captureRatio;
    const afterShapePrice   = rawCapturePrice * (1 - shapeDiscount);
    const afterBasisPrice   = afterShapePrice + basisAdjMwh;
    const effectiveCapturePrice = afterBasisPrice;
    const totalRevenueMwh   = effectiveCapturePrice + recRevenueMwh;

    // Volume: gross → curtailment → availability
    const grossMwhYr = Number(req.query.volume) > 0
      ? Number(req.query.volume)
      : capacityMw * cf * 8760;
    const afterCurtailmentMwh = grossMwhYr * (1 - curtailmentHaircut);
    const effectiveMwhYr = afterCurtailmentMwh * availabilityFactor;

    function buildScenarioCashflows(priceMultiplier: number): number[] {
      const cashflows: number[] = [];
      for (let t = 0; t < term; t++) {
        const marketRevMwh = totalRevenueMwh * priceMultiplier * Math.pow(1 + escalation, t);
        cashflows.push((marketRevMwh - strike) * effectiveMwhYr);
      }
      return cashflows;
    }

    const p50Flows = buildScenarioCashflows(1.00);
    const p10Flows = buildScenarioCashflows(p10Multiplier);
    const p90Flows = buildScenarioCashflows(p90Multiplier);

    const p50Npv = npv(p50Flows, wacc);
    const p10Npv = npv(p10Flows, wacc);
    const p90Npv = npv(p90Flows, wacc);

    // Breakeven market price where NPV(P50) = 0
    const breakevenPower = (() => {
      let lo = 0, hi = 300;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        const flows = Array.from({ length: term }, (_, t) =>
          ((mid + recRevenueMwh) * Math.pow(1 + escalation, t) - strike) * effectiveMwhYr
        );
        if (npv(flows, wacc) < 0) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    })();

    res.json({
      candidateId,
      candidateName:    cand.name,
      assetType,
      market,
      capacityMw,
      grossMwhYr:       Math.round(grossMwhYr),
      contractedMwhYr:  Math.round(effectiveMwhYr),
      inputs: { strike, term, wacc, escalation },

      // Full price waterfall
      priceWaterfall: {
        marketRefDa:        Math.round(marketRefDA * 100) / 100,
        marketRefSource,
        captureRatio:       Math.round(captureRatio * 1000) / 1000,
        rawCapturePrice:    Math.round(rawCapturePrice * 100) / 100,
        shapeDiscount:      Math.round(shapeDiscount * 1000) / 1000,
        afterShapePrice:    Math.round(afterShapePrice * 100) / 100,
        basisAdjMwh:        Math.round(basisAdjMwh * 100) / 100,
        powerCapturePrice:  Math.round(effectiveCapturePrice * 100) / 100,
        recRevenueMwh:      Math.round(recRevenueMwh * 100) / 100,
        totalRevenueMwh:    Math.round(totalRevenueMwh * 100) / 100,
      },

      // Volume waterfall
      volumeWaterfall: {
        grossMwhYr:           Math.round(grossMwhYr),
        curtailmentHaircut:   Math.round(curtailmentHaircut * 1000) / 1000,
        curtailmentLossMwhYr: Math.round(grossMwhYr * curtailmentHaircut),
        afterCurtailmentMwh:  Math.round(afterCurtailmentMwh),
        availabilityFactor:   Math.round(availabilityFactor * 1000) / 1000,
        availabilityLossMwhYr: Math.round(afterCurtailmentMwh * (1 - availabilityFactor)),
        deliveredMwhYr:       Math.round(effectiveMwhYr),
      },

      // All score dimensions used in model + context
      riskFactors: {
        locationScore, curtailmentScore: curtailmentScoreN, gridStabilityScore: gridStabilityN,
        interconnectionScore: interconnectionN, developmentRiskScore: developmentRiskN,
        environmentalScore: environmentalN,
        financialScore: financialN, demandProximityScore: demandProximityN, regulatoryScore: regulatoryN,
        basisAdjMwh:         Math.round(basisAdjMwh * 100) / 100,
        curtailmentHaircut:  Math.round(curtailmentHaircut * 1000) / 1000,
        shapeDiscount:       Math.round(shapeDiscount * 1000) / 1000,
        availabilityFactor:  Math.round(availabilityFactor * 1000) / 1000,
        recRevenueMwh:       Math.round(recRevenueMwh * 100) / 100,
        p10Multiplier:       Math.round(p10Multiplier * 1000) / 1000,
        p90Multiplier:       Math.round(p90Multiplier * 1000) / 1000,
      },

      baseCapturePriceMwh: Math.round(totalRevenueMwh * 100) / 100,
      scenarios: {
        p10: {
          label: `Bullish (+${Math.round((p10Multiplier - 1) * 100)}% power price)`,
          priceMultiplier: p10Multiplier,
          npvM: Math.round(p10Npv / 1e6 * 10) / 10,
          avgAnnualCashflowM: Math.round(npv(p10Flows, 0) / term / 1e6 * 10) / 10,
        },
        p50: {
          label: "Base (current market)",
          priceMultiplier: 1.00,
          npvM: Math.round(p50Npv / 1e6 * 10) / 10,
          avgAnnualCashflowM: Math.round(npv(p50Flows, 0) / term / 1e6 * 10) / 10,
        },
        p90: {
          label: `Bearish (${Math.round((p90Multiplier - 1) * 100)}% power price)`,
          priceMultiplier: p90Multiplier,
          npvM: Math.round(p90Npv / 1e6 * 10) / 10,
          avgAnnualCashflowM: Math.round(npv(p90Flows, 0) / term / 1e6 * 10) / 10,
        },
      },
      breakevenPriceMwh: Math.round(breakevenPower * 100) / 100,
      annualCashflowsP50M: p50Flows.map((v, t) => ({
        year:          t + 1,
        cashflowM:     Math.round(v / 1e6 * 10) / 10,
        marketPriceMwh: Math.round(totalRevenueMwh * Math.pow(1 + escalation, t) * 100) / 100,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "ppa-npv error");
    res.status(500).json({ error: "internal_error", message: "Failed to compute PPA NPV" });
  }
});

export default router;
