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
    res.json({ ...row, capacityMw: Number(row.capacityMw), overallScore: Number(row.overallScore), latitude: Number(row.latitude), longitude: Number(row.longitude) });
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
