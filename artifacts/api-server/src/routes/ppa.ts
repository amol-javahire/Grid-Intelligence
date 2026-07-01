import { Router } from "express";
import { db } from "@workspace/db";
import { candidatesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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
const MARKET_REF_DA: Record<string, number> = {
  ERCOT: 31.42, CAISO: 33.25, PJM: 38.50,
};

function getCaptureRatio(assetType: string, market: string): number {
  if (market === "ERCOT") return ERCOT_CAPTURE[assetType] ?? 0.90;
  if (market === "CAISO") return CAISO_CAPTURE[assetType] ?? 0.90;
  return PJM_CAPTURE[assetType] ?? 0.90;
}

/**
 * Convert 0-100 dimension scores into monetary/volume risk adjustments.
 *
 * basisAdjMwh:        locationScore → node-hub DA spread ($/MWh, can be negative)
 * curtailmentHaircut: curtailmentScore → fraction of generation lost to curtailment
 * shapeDiscount:      gridStabilityScore → capture price discount from gen/load mismatch
 */
function scoreToRiskDefaults(
  locationScore: number,     // 0-100, higher = better (lower basis risk)
  curtailmentScore: number,  // 0-100, higher = better (lower curtailment)
  gridStabilityScore: number // 0-100, higher = better (better shape match)
) {
  // Basis adjustment: asymmetric — downside up to -$12, upside up to +$6
  //   score 100 → +$6, score 50 → $0, score 0 → -$12
  const basisAdjMwh = locationScore >= 50
    ? ((locationScore - 50) / 50) * 6
    : ((locationScore - 50) / 50) * 12;

  // Curtailment haircut: score 100 → 0%, score 50 → 10%, score 0 → 22%
  const curtailmentHaircut = Math.max(0, Math.min(0.25, (100 - curtailmentScore) / 100 * 0.22));

  // Shape discount on price: score 100 → 0%, score 50 → 7.5%, score 0 → 15%
  // (already partially captured in capture ratio, this is the residual mismatch)
  const shapeDiscount = Math.max(0, Math.min(0.20, (100 - gridStabilityScore) / 100 * 0.15));

  return { basisAdjMwh, curtailmentHaircut, shapeDiscount };
}

function npv(cashflows: number[], wacc: number): number {
  return cashflows.reduce((sum, cf, t) => sum + cf / Math.pow(1 + wacc, t + 1), 0);
}

/**
 * GET /api/ppa-npv
 *
 * Compute VPPA (Financial PPA) NPV from the offtaker's perspective.
 * Contract for Differences: offtaker receives (market_price - strike) × volume.
 *   Positive = hedge gain (market > strike)
 *   Negative = hedge cost (market < strike)
 *
 * Query params:
 *   candidateId       - integer (required)
 *   strike            - $/MWh settlement price (required)
 *   term              - contract length in years (default 15)
 *   wacc              - offtaker WACC for discounting (default 0.08)
 *   volume            - override contracted MWh/yr
 *   escalation        - annual market price escalation rate (default 0.015)
 *
 * Risk override params (defaults derived from candidate scores):
 *   basisAdjMwh       - node-hub basis adjustment $/MWh (can be negative)
 *   curtailmentHaircut - fraction of volume lost to curtailment (0–0.25)
 *   shapeDiscount      - capture price discount from shape mismatch (0–0.20)
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

    // Score-derived risk defaults
    const locationScore     = cand.locationScore     ? Number(cand.locationScore)     : 50;
    const curtailmentScoreN = cand.curtailmentScore  ? Number(cand.curtailmentScore)  : 50;
    const gridStabilityN    = cand.gridStabilityScore ? Number(cand.gridStabilityScore) : 50;

    const defaults = scoreToRiskDefaults(locationScore, curtailmentScoreN, gridStabilityN);

    // Accept caller overrides or fall back to score-derived defaults
    const basisAdjMwh      = req.query.basisAdjMwh       !== undefined
      ? Number(req.query.basisAdjMwh)       : defaults.basisAdjMwh;
    const curtailmentHaircut = req.query.curtailmentHaircut !== undefined
      ? Math.max(0, Math.min(0.25, Number(req.query.curtailmentHaircut))) : defaults.curtailmentHaircut;
    const shapeDiscount    = req.query.shapeDiscount      !== undefined
      ? Math.max(0, Math.min(0.20, Number(req.query.shapeDiscount)))      : defaults.shapeDiscount;

    // Effective price build-up:
    //   marketRefDA × captureRatio → raw capture price
    //   × (1 - shapeDiscount)     → shape/timing penalty
    //   + basisAdjMwh             → node-hub congestion spread
    const marketRefDA       = MARKET_REF_DA[market] ?? 31.42;
    const rawCapturePrice   = marketRefDA * captureRatio;
    const afterShapePrice   = rawCapturePrice * (1 - shapeDiscount);
    const effectiveCapturePrice = afterShapePrice + basisAdjMwh;

    // Contracted volume with curtailment haircut
    const grossMwhYr = Number(req.query.volume) > 0
      ? Number(req.query.volume)
      : capacityMw * cf * 8760;
    const effectiveMwhYr = grossMwhYr * (1 - curtailmentHaircut);

    function buildScenarioCashflows(priceMultiplier: number): number[] {
      const cashflows: number[] = [];
      for (let t = 0; t < term; t++) {
        const marketPrice = effectiveCapturePrice * priceMultiplier * Math.pow(1 + escalation, t);
        cashflows.push((marketPrice - strike) * effectiveMwhYr);
      }
      return cashflows;
    }

    const p50Flows = buildScenarioCashflows(1.00);
    const p10Flows = buildScenarioCashflows(1.20);
    const p90Flows = buildScenarioCashflows(0.80);

    const p50Npv = npv(p50Flows, wacc);
    const p10Npv = npv(p10Flows, wacc);
    const p90Npv = npv(p90Flows, wacc);

    const breakevenPrice = (() => {
      let lo = 0, hi = 300;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        const flows = Array.from({ length: term }, (_, t) =>
          (mid * Math.pow(1 + escalation, t) - strike) * effectiveMwhYr
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
      contractedMwhYr:  Math.round(effectiveMwhYr),
      grossMwhYr:       Math.round(grossMwhYr),
      inputs: { strike, term, wacc, escalation },

      // Full price waterfall for frontend display
      priceWaterfall: {
        marketRefDa:      Math.round(marketRefDA * 100) / 100,
        captureRatio:     Math.round(captureRatio * 1000) / 1000,
        rawCapturePrice:  Math.round(rawCapturePrice * 100) / 100,
        shapeDiscount:    Math.round(shapeDiscount * 1000) / 1000,
        afterShapePrice:  Math.round(afterShapePrice * 100) / 100,
        basisAdjMwh:      Math.round(basisAdjMwh * 100) / 100,
        effectiveCapture: Math.round(effectiveCapturePrice * 100) / 100,
      },

      // Risk factor values used (defaults or caller overrides)
      riskFactors: {
        locationScore,
        curtailmentScore:    curtailmentScoreN,
        gridStabilityScore:  gridStabilityN,
        basisAdjMwh:         Math.round(basisAdjMwh * 100) / 100,
        curtailmentHaircut:  Math.round(curtailmentHaircut * 1000) / 1000,
        shapeDiscount:       Math.round(shapeDiscount * 1000) / 1000,
        curtailmentLossMwhYr: Math.round(grossMwhYr * curtailmentHaircut),
      },

      baseCapturePriceMwh: Math.round(effectiveCapturePrice * 100) / 100,
      scenarios: {
        p10: {
          label: "Bullish (+20% power price)",
          priceMultiplier: 1.20,
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
          label: "Bearish (-20% power price)",
          priceMultiplier: 0.80,
          npvM: Math.round(p90Npv / 1e6 * 10) / 10,
          avgAnnualCashflowM: Math.round(npv(p90Flows, 0) / term / 1e6 * 10) / 10,
        },
      },
      breakevenPriceMwh: Math.round(breakevenPrice * 100) / 100,
      annualCashflowsP50M: p50Flows.map((v, t) => ({
        year:          t + 1,
        cashflowM:     Math.round(v / 1e6 * 10) / 10,
        marketPriceMwh: Math.round(effectiveCapturePrice * Math.pow(1 + escalation, t) * 100) / 100,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "ppa-npv error");
    res.status(500).json({ error: "internal_error", message: "Failed to compute PPA NPV" });
  }
});

export default router;
