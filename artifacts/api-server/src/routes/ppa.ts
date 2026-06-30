import { Router } from "express";
import { db } from "@workspace/db";
import { candidatesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

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

function getCaptureRatio(assetType: string, market: string): number {
  if (market === "ERCOT") return ERCOT_CAPTURE[assetType] ?? 0.90;
  if (market === "CAISO") return CAISO_CAPTURE[assetType] ?? 0.90;
  return PJM_CAPTURE[assetType] ?? 0.90;
}

function npv(cashflows: number[], wacc: number): number {
  return cashflows.reduce((sum, cf, t) => sum + cf / Math.pow(1 + wacc, t + 1), 0);
}

/**
 * GET /api/ppa-npv
 *
 * Compute VPPA (Financial PPA) NPV from Walmart's perspective.
 * Walmart enters a Contract for Differences: they receive (market_price - strike) × volume.
 *   Positive = hedge gain (market > strike)
 *   Negative = hedge cost (market < strike)
 *
 * Query params:
 *   candidateId  - integer (required)
 *   strike       - $/MWh offtake/settlement price (required)
 *   term         - contract length in years (default 15)
 *   wacc         - Walmart WACC for discounting (default 0.08)
 *   volume       - override contracted MWh/yr (default = capacity × CF × 8760)
 *   escalation   - annual market price escalation rate (default 0.015 = 1.5%/yr)
 */
router.get("/ppa-npv", async (req, res) => {
  try {
    const candidateId = Number(req.query.candidateId);
    if (!candidateId || isNaN(candidateId)) {
      res.status(400).json({ error: "bad_request", message: "candidateId required" });
      return;
    }

    const strike       = Number(req.query.strike       ?? 35);
    const term         = Math.min(30, Math.max(1, Number(req.query.term ?? 15)));
    const wacc         = Math.max(0.01, Math.min(0.20, Number(req.query.wacc ?? 0.08)));
    const escalation   = Math.max(0, Math.min(0.10, Number(req.query.escalation ?? 0.015)));

    const [cand] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, candidateId));
    if (!cand) {
      res.status(404).json({ error: "not_found", message: "Candidate not found" });
      return;
    }

    const assetType  = cand.assetType;
    const market     = cand.market;
    const capacityMw = Number(cand.capacityMw);
    const cf         = CF[assetType]?.[market] ?? 0.30;
    const capture    = getCaptureRatio(assetType, market);

    // Nodal DA price from price_score → back-calc or use a lookup
    // Use the stored estimatedLcoe as a proxy, or fall back to market reference
    const marketRefDA = market === "ERCOT" ? 31.42 : market === "CAISO" ? 33.25 : 38.50;
    const contractedMwhYr = Number(req.query.volume) > 0
      ? Number(req.query.volume)
      : capacityMw * cf * 8760;

    // Base (P50) capture price = market ref × capture ratio × an adjustment from price_score
    const priceScoreRatio = cand.priceScore ? (Number(cand.priceScore) / 50) : 1.0;
    const baseCapture = marketRefDA * capture * priceScoreRatio;

    function buildScenarioCashflows(priceMultiplier: number): number[] {
      const cashflows: number[] = [];
      for (let t = 0; t < term; t++) {
        const marketPrice = baseCapture * priceMultiplier * Math.pow(1 + escalation, t);
        const annualCashflow = (marketPrice - strike) * contractedMwhYr;
        cashflows.push(annualCashflow);
      }
      return cashflows;
    }

    const p50Flows = buildScenarioCashflows(1.00);
    const p10Flows = buildScenarioCashflows(1.20);
    const p90Flows = buildScenarioCashflows(0.80);

    const p50Npv = npv(p50Flows, wacc);
    const p10Npv = npv(p10Flows, wacc);
    const p90Npv = npv(p90Flows, wacc);

    const p50AvgCashflow = p50Flows.reduce((s, v) => s + v, 0) / term;

    const breakevenPrice = (() => {
      let lo = 0, hi = 300;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        const flows = Array.from({ length: term }, (_, t) =>
          (mid * Math.pow(1 + escalation, t) - strike) * contractedMwhYr
        );
        if (npv(flows, wacc) < 0) lo = mid; else hi = mid;
      }
      return (lo + hi) / 2;
    })();

    res.json({
      candidateId,
      candidateName: cand.name,
      assetType,
      market,
      capacityMw,
      contractedMwhYr: Math.round(contractedMwhYr),
      inputs: { strike, term, wacc, escalation },
      baseCapturePriceMwh: Math.round(baseCapture * 100) / 100,
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
          avgAnnualCashflowM: Math.round(p50AvgCashflow / 1e6 * 10) / 10,
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
        year: t + 1,
        cashflowM: Math.round(v / 1e6 * 10) / 10,
        marketPriceMwh: Math.round(baseCapture * Math.pow(1 + escalation, t) * 100) / 100,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "ppa-npv error");
    res.status(500).json({ error: "internal_error", message: "Failed to compute PPA NPV" });
  }
});

export default router;
