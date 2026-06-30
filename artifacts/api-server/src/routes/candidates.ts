import { Router } from "express";
import { db, candidatesTable } from "@workspace/db";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import {
  ListCandidatesQueryParams,
  CreateCandidateBody,
  GetCandidateParams,
  UpdateCandidateBody,
  UpdateCandidateParams,
  DeleteCandidateParams,
} from "@workspace/api-zod";
import { computeRec } from "../lib/rec";

// ── ITC / PTC / LCOE Computed Financials ─────────────────────────────────────
// Standard CapEx benchmarks (2024, utility scale, $/kW)
const CAPEX_PER_KW: Record<string, number> = {
  solar: 1050, wind: 1450, storage: 1200, natural_gas: 1000,
  nuclear: 7500, hydro: 2500, biomass: 1200, geothermal: 3000, coal: 2800,
};
const FOM_PER_KW: Record<string, number> = {
  solar: 17, wind: 48, storage: 18, natural_gas: 38,
  nuclear: 140, hydro: 55, biomass: 60, geothermal: 40, coal: 80,
};
const VOM_PER_MWH: Record<string, number> = {
  solar: 0, wind: 3, storage: 2, natural_gas: 5,
  nuclear: 3, hydro: 4, biomass: 8, geothermal: 2, coal: 7,
};
const CF_TABLE: Record<string, Record<string, number>> = {
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
const ITC_ELIGIBLE = new Set(["solar", "storage"]);
const PTC_ELIGIBLE = new Set(["wind", "geothermal", "biomass", "hydro"]);
const WACC_FIN   = 0.08;
const LIFE_YR    = 25;
const CRF        = WACC_FIN * Math.pow(1 + WACC_FIN, LIFE_YR) / (Math.pow(1 + WACC_FIN, LIFE_YR) - 1);
const PV_10YR    = (1 - 1 / Math.pow(1 + WACC_FIN, 10)) / WACC_FIN;
const PV_LIFE    = (1 - 1 / Math.pow(1 + WACC_FIN, LIFE_YR)) / WACC_FIN;
const PTC_MWH    = 27.5; // $0.0275/kWh × 1000

function computeFinancials(assetType: string, capacityMw: number, market: string) {
  const capex = CAPEX_PER_KW[assetType] ?? 1500;
  const fom   = FOM_PER_KW[assetType] ?? 40;
  const vom   = VOM_PER_MWH[assetType] ?? 5;
  const cf    = CF_TABLE[assetType]?.[market] ?? 0.30;
  const capexAfterItc = ITC_ELIGIBLE.has(assetType) ? capex * 0.70 : capex;
  const lcoeBase      = 1000 * (capexAfterItc * CRF + fom) / (cf * 8760) + vom;
  const ptcAdj        = PTC_ELIGIBLE.has(assetType) ? PTC_MWH * (PV_10YR / PV_LIFE) : 0;
  const lcoeMwh       = Math.round((lcoeBase - ptcAdj) * 100) / 100;
  const totalCapexM   = Math.round(capacityMw * 1000 * capex / 1e6 * 10) / 10;
  const itcValueM     = ITC_ELIGIBLE.has(assetType) ? Math.round(totalCapexM * 0.30 * 10) / 10 : 0;
  const ptcAnnualM    = PTC_ELIGIBLE.has(assetType)
    ? Math.round(capacityMw * cf * 8760 * PTC_MWH / 1e6 * 10) / 10 : 0;
  const ptcNpvM       = Math.round(ptcAnnualM * PV_10YR * 10) / 10;
  const taxCreditType = ITC_ELIGIBLE.has(assetType) ? "ITC 30%" : PTC_ELIGIBLE.has(assetType) ? "PTC $0.0275/kWh" : null;
  return { lcoeMwh, totalCapexM, itcValueM, ptcAnnualM, ptcNpvM, taxCreditType };
}

const router = Router();

// Scoring weights per objective
const OBJECTIVE_WEIGHTS: Record<string, Record<string, number>> = {
  lowest_lcoe: { priceScore: 0.3, financialScore: 0.25, interconnectionScore: 0.15, locationScore: 0.1, curtailmentScore: 0.1, regulatoryScore: 0.05, environmentalScore: 0.02, gridStabilityScore: 0.01, demandProximityScore: 0.01, developmentRiskScore: 0.01 },
  risk_adjusted_value: { priceScore: 0.2, financialScore: 0.15, regulatoryScore: 0.15, developmentRiskScore: 0.15, interconnectionScore: 0.1, curtailmentScore: 0.1, locationScore: 0.05, gridStabilityScore: 0.05, environmentalScore: 0.03, demandProximityScore: 0.02 },
  load_hedge: { demandProximityScore: 0.25, gridStabilityScore: 0.2, locationScore: 0.15, priceScore: 0.15, interconnectionScore: 0.1, curtailmentScore: 0.05, regulatoryScore: 0.05, financialScore: 0.03, environmentalScore: 0.01, developmentRiskScore: 0.01 },
  decarbonization: { environmentalScore: 0.3, curtailmentScore: 0.2, gridStabilityScore: 0.15, locationScore: 0.1, regulatoryScore: 0.1, priceScore: 0.05, interconnectionScore: 0.05, demandProximityScore: 0.03, financialScore: 0.01, developmentRiskScore: 0.01 },
};

function computeOverallScore(candidate: Record<string, number | null>, objective = "risk_adjusted_value"): number {
  const weights = OBJECTIVE_WEIGHTS[objective] || OBJECTIVE_WEIGHTS.risk_adjusted_value;
  let score = 0;
  for (const [dim, weight] of Object.entries(weights)) {
    score += (Number(candidate[dim]) || 50) * weight;
  }
  return Math.round(score * 100) / 100;
}

router.get("/candidates", async (req, res) => {
  try {
    const parsed = ListCandidatesQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query params", message: parsed.error.message });
      return;
    }
    const { market, assetType, status, minScore, maxScore, limit = 100, offset = 0 } = parsed.data;

    const conditions = [];
    if (market) conditions.push(eq(candidatesTable.market, market));
    if (assetType) conditions.push(eq(candidatesTable.assetType, assetType));
    if (status) conditions.push(eq(candidatesTable.status, status));
    if (minScore !== undefined) conditions.push(gte(sql`${candidatesTable.overallScore}::numeric`, minScore));
    if (maxScore !== undefined) conditions.push(lte(sql`${candidatesTable.overallScore}::numeric`, maxScore));

    const rows = await db
      .select()
      .from(candidatesTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .limit(limit)
      .offset(offset);

    const result = rows.map(r => {
      const capacityMw = Number(r.capacityMw);
      const rec = computeRec(r.assetType, r.market, capacityMw);
      const fin = computeFinancials(r.assetType, capacityMw, r.market);
      return {
        ...r,
        capacityMw,
        latitude: Number(r.latitude),
        longitude: Number(r.longitude),
        overallScore: Number(r.overallScore),
        estimatedLcoe: r.estimatedLcoe ? Number(r.estimatedLcoe) : null,
        offtakePriceMwh: r.offtakePriceMwh ? Number(r.offtakePriceMwh) : null,
        priceScore: r.priceScore ? Number(r.priceScore) : null,
        locationScore: r.locationScore ? Number(r.locationScore) : null,
        curtailmentScore: r.curtailmentScore ? Number(r.curtailmentScore) : null,
        interconnectionScore: r.interconnectionScore ? Number(r.interconnectionScore) : null,
        regulatoryScore: r.regulatoryScore ? Number(r.regulatoryScore) : null,
        financialScore: r.financialScore ? Number(r.financialScore) : null,
        environmentalScore: r.environmentalScore ? Number(r.environmentalScore) : null,
        gridStabilityScore: r.gridStabilityScore ? Number(r.gridStabilityScore) : null,
        demandProximityScore: r.demandProximityScore ? Number(r.demandProximityScore) : null,
        developmentRiskScore: r.developmentRiskScore ? Number(r.developmentRiskScore) : null,
        ...rec,
        ...fin,
      };
    });

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "listCandidates error");
    res.status(500).json({ error: "internal_error", message: "Failed to list candidates" });
  }
});

router.post("/candidates", async (req, res) => {
  try {
    const parsed = CreateCandidateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", message: parsed.error.message });
      return;
    }
    const data = parsed.data;
    const overallScore = computeOverallScore(data as unknown as Record<string, number | null>);

    const [row] = await db.insert(candidatesTable).values({
      ...data,
      capacityMw: String(data.capacityMw),
      latitude: String(data.latitude),
      longitude: String(data.longitude),
      estimatedLcoe: data.estimatedLcoe ? String(data.estimatedLcoe) : null,
      offtakePriceMwh: data.offtakePriceMwh ? String(data.offtakePriceMwh) : null,
      priceScore: data.priceScore ? String(data.priceScore) : null,
      locationScore: data.locationScore ? String(data.locationScore) : null,
      curtailmentScore: data.curtailmentScore ? String(data.curtailmentScore) : null,
      interconnectionScore: data.interconnectionScore ? String(data.interconnectionScore) : null,
      regulatoryScore: data.regulatoryScore ? String(data.regulatoryScore) : null,
      financialScore: data.financialScore ? String(data.financialScore) : null,
      environmentalScore: data.environmentalScore ? String(data.environmentalScore) : null,
      gridStabilityScore: data.gridStabilityScore ? String(data.gridStabilityScore) : null,
      demandProximityScore: data.demandProximityScore ? String(data.demandProximityScore) : null,
      developmentRiskScore: data.developmentRiskScore ? String(data.developmentRiskScore) : null,
      overallScore: String(overallScore),
    }).returning();

    res.status(201).json({ ...row, capacityMw: Number(row.capacityMw), overallScore: Number(row.overallScore), latitude: Number(row.latitude), longitude: Number(row.longitude) });
  } catch (err) {
    req.log.error({ err }, "createCandidate error");
    res.status(500).json({ error: "internal_error", message: "Failed to create candidate" });
  }
});

router.get("/candidates/:id", async (req, res) => {
  try {
    const parsed = GetCandidateParams.safeParse({ id: Number(req.params.id) });
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid id", message: parsed.error.message });
      return;
    }
    const [row] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, parsed.data.id));
    if (!row) {
      res.status(404).json({ error: "not_found", message: "Candidate not found" });
      return;
    }
    const fin = computeFinancials(row.assetType, Number(row.capacityMw), row.market);
    const rec = computeRec(row.assetType, row.market, Number(row.capacityMw));
    res.json({ ...row, capacityMw: Number(row.capacityMw), overallScore: Number(row.overallScore), latitude: Number(row.latitude), longitude: Number(row.longitude), ...rec, ...fin });
  } catch (err) {
    req.log.error({ err }, "getCandidate error");
    res.status(500).json({ error: "internal_error", message: "Failed to get candidate" });
  }
});

router.put("/candidates/:id", async (req, res) => {
  try {
    const paramsParsed = UpdateCandidateParams.safeParse({ id: Number(req.params.id) });
    const bodyParsed = UpdateCandidateBody.safeParse(req.body);
    if (!paramsParsed.success || !bodyParsed.success) {
      res.status(400).json({ error: "Invalid request", message: "Bad params or body" });
      return;
    }
    const data = bodyParsed.data;
    const overallScore = computeOverallScore(data as unknown as Record<string, number | null>);

    const [row] = await db.update(candidatesTable)
      .set({
        ...data,
        capacityMw: data.capacityMw ? String(data.capacityMw) : undefined,
        latitude: data.latitude ? String(data.latitude) : undefined,
        longitude: data.longitude ? String(data.longitude) : undefined,
        estimatedLcoe: data.estimatedLcoe ? String(data.estimatedLcoe) : undefined,
        offtakePriceMwh: data.offtakePriceMwh ? String(data.offtakePriceMwh) : undefined,
        priceScore: data.priceScore ? String(data.priceScore) : undefined,
        locationScore: data.locationScore ? String(data.locationScore) : undefined,
        curtailmentScore: data.curtailmentScore ? String(data.curtailmentScore) : undefined,
        interconnectionScore: data.interconnectionScore ? String(data.interconnectionScore) : undefined,
        regulatoryScore: data.regulatoryScore ? String(data.regulatoryScore) : undefined,
        financialScore: data.financialScore ? String(data.financialScore) : undefined,
        environmentalScore: data.environmentalScore ? String(data.environmentalScore) : undefined,
        gridStabilityScore: data.gridStabilityScore ? String(data.gridStabilityScore) : undefined,
        demandProximityScore: data.demandProximityScore ? String(data.demandProximityScore) : undefined,
        developmentRiskScore: data.developmentRiskScore ? String(data.developmentRiskScore) : undefined,
        overallScore: String(overallScore),
        updatedAt: new Date(),
      })
      .where(eq(candidatesTable.id, paramsParsed.data.id))
      .returning();

    if (!row) {
      res.status(404).json({ error: "not_found", message: "Candidate not found" });
      return;
    }
    res.json({ ...row, capacityMw: Number(row.capacityMw), overallScore: Number(row.overallScore), latitude: Number(row.latitude), longitude: Number(row.longitude) });
  } catch (err) {
    req.log.error({ err }, "updateCandidate error");
    res.status(500).json({ error: "internal_error", message: "Failed to update candidate" });
  }
});

router.delete("/candidates/:id", async (req, res) => {
  try {
    const parsed = DeleteCandidateParams.safeParse({ id: Number(req.params.id) });
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid id", message: parsed.error.message });
      return;
    }
    await db.delete(candidatesTable).where(eq(candidatesTable.id, parsed.data.id));
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "deleteCandidate error");
    res.status(500).json({ error: "internal_error", message: "Failed to delete candidate" });
  }
});

export default router;
