import { useState, useCallback, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useListCandidates, type Candidate } from "@workspace/api-client-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import {
  TrendingUp, TrendingDown, Minus, DollarSign, AlertCircle, Loader2,
  ChevronDown, ChevronUp, Leaf, Zap, Shield, Calculator, BookOpen, Target, FlaskConical,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// ─── CAPEX benchmarks (NREL ATB 2024 · EIA AEO 2024 · Lazard v17 · BNEF 1H2024) ───

interface CapexBenchmark {
  tech: string;
  emoji: string;
  color: string;
  capexLo: number; capexHi: number;       // $/kW installed
  capexNote: string;
  landAcresMw: string;                    // acres per MW (or lease note)
  landCostNote: string;
  fixedOmLo: number; fixedOmHi: number;   // $/kW-yr
  varOmLo: number;   varOmHi: number;     // $/MWh
  interconnLo: number; interconnHi: number; // $/kW
  insuranceLo: number; insuranceHi: number; // $/kW-yr
  decommNote: string;
  lifeYears: number;
  techNotes: string[];
}

const CAPEX_BENCHMARKS: CapexBenchmark[] = [
  {
    tech: "Utility Solar PV",
    emoji: "☀️",
    color: "border-amber-500/40 bg-amber-900/10",
    capexLo: 950,   capexHi: 1150,
    capexNote: "Single-axis tracker · modules $280-340 · BOS+EPC $420-520 · soft costs $200-320",
    landAcresMw: "5–8 acres/MW",
    landCostNote: "$1,500–5,000/acre · $7–40/kW",
    fixedOmLo: 15,  fixedOmHi: 18,
    varOmLo: 0,     varOmHi: 1,
    interconnLo: 20,  interconnHi: 80,
    insuranceLo: 3.5, insuranceHi: 5.5,
    decommNote: "$25,000–65,000/acre after 25–30yr",
    lifeYears: 30,
    techNotes: [
      "Module prices fell ~50% 2021–2024 (BNEF) — equipment now ~28% of all-in cost",
      "ITC basis: 30% base + 10% domestic content adder where eligible",
      "Land lease alternative: $300–800/acre-yr avoids land CAPEX entirely",
    ],
  },
  {
    tech: "Onshore Wind",
    emoji: "🌬️",
    color: "border-teal-500/40 bg-teal-900/10",
    capexLo: 1200,  capexHi: 1600,
    capexNote: "Turbine supply $720–920 · BOS (foundation, roads, electrical) $280–420 · soft costs $120–200",
    landAcresMw: "10–16 acres/MW impact (30–40 acres/turbine spacing)",
    landCostNote: "Leased $8,000–15,000/turbine-yr · land usable for farming",
    fixedOmLo: 38,  fixedOmHi: 55,
    varOmLo: 2,     varOmHi: 4,
    interconnLo: 40,  interconnHi: 140,
    insuranceLo: 5,   insuranceHi: 9,
    decommNote: "$25,000–100,000/turbine (decommissioning bond required in TX)",
    lifeYears: 25,
    techNotes: [
      "Fixed O&M includes long-term service agreement (LTSA) with OEM — critical for 25yr warranty",
      "PTC: $27.50/MWh base (2024) × 10yr for projects meeting wage/apprenticeship requirements",
      "Interconnection range wide: coastal TX queue has $40–60/kW; remote PAN has $100–140/kW",
    ],
  },
  {
    tech: "BESS (4-hour Li-ion)",
    emoji: "🔋",
    color: "border-emerald-500/40 bg-emerald-900/10",
    capexLo: 900,   capexHi: 1200,
    capexNote: "Pack+BMS $140–190/kWh · PCS $50–70/kW · BOS+EPC $200–280 · soft costs $60–120",
    landAcresMw: "0.5–1 acre/MW-AC",
    landCostNote: "$2–15/kW · far lower than generation assets",
    fixedOmLo: 10,  fixedOmHi: 15,
    varOmLo: 0.5,   varOmHi: 1.5,
    interconnLo: 15,  interconnHi: 50,
    insuranceLo: 2,   insuranceHi: 4.5,
    decommNote: "Minimal — modules recycled; BMS/PCS residual value",
    lifeYears: 20,
    techNotes: [
      "Augmentation reserve: 1.5–2.5% CAPEX/yr for capacity fade replacement over 20yr life",
      "ITC: 30% for standalone storage ≥3hr (Inflation Reduction Act §48E, 2023)",
      "Ancillary services (ERCOT ORDC/ECRS) can add 30–60% on top of pure DA arbitrage revenue",
      "Costs falling ~15%/yr (BNEF) — 2026 projects may price $750–1,000/kW all-in",
    ],
  },
  {
    tech: "Gas CCGT",
    emoji: "⚡",
    color: "border-orange-500/40 bg-orange-900/10",
    capexLo: 800,   capexHi: 1050,
    capexNote: "EPC turnkey $650–850 · site prep + cooling $80–120 · soft costs $100–180",
    landAcresMw: "2–5 acres/MW (site footprint)",
    landCostNote: "$0.4–5/kW · owned freehold",
    fixedOmLo: 10,  fixedOmHi: 14,
    varOmLo: 3,     varOmHi: 5,
    interconnLo: 50,  interconnHi: 120,
    insuranceLo: 4,   insuranceHi: 7,
    decommNote: "$50,000–200,000 total site remediation",
    lifeYears: 30,
    techNotes: [
      "Variable O&M excludes fuel — add Henry Hub × 6.5 MMBtu/MWh heat rate for total dispatch cost",
      "Carbon: voluntary market $5–25/t CO₂ × 0.4t/MWh = $2–10/MWh additional cost exposure",
      "New CCGT rarely pencils without capacity revenue or long-term offtake in current market",
    ],
  },
  {
    tech: "Gas CT (Peaker)",
    emoji: "🔥",
    color: "border-red-500/40 bg-red-900/10",
    capexLo: 550,   capexHi: 800,
    capexNote: "Combustion turbine package $380–550 · BOP $100–160 · soft costs $80–140",
    landAcresMw: "2–4 acres/MW",
    landCostNote: "$0.4–4/kW",
    fixedOmLo: 7,   fixedOmHi: 10,
    varOmLo: 5,     varOmHi: 12,
    interconnLo: 40,  interconnHi: 100,
    insuranceLo: 3,   insuranceHi: 6,
    decommNote: "$30,000–150,000 total",
    lifeYears: 25,
    techNotes: [
      "Higher heat rate (9.5–11 MMBtu/MWh) vs CCGT (6.5): more fuel cost per MWh generated",
      "Revenue primarily from scarcity pricing (ERCOT ORDC) and ancillary services, not energy margin",
      "ERCOT peakers earned $200–400/kW-yr during Summer 2023 and Winter Uri peak days",
    ],
  },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface PriceWaterfall {
  marketRefDa:       number;
  marketRefSource:   "caller_override" | "forward_curve" | "historical_avg";
  captureRatio:      number;
  rawCapturePrice:   number;
  shapeDiscount:     number;
  afterShapePrice:   number;
  basisAdjMwh:       number;
  powerCapturePrice: number;
  recRevenueMwh:     number;
  totalRevenueMwh:   number;
}

interface VolumeWaterfall {
  grossMwhYr:            number;
  curtailmentHaircut:    number;
  curtailmentLossMwhYr:  number;
  afterCurtailmentMwh:   number;
  availabilityFactor:    number;
  availabilityLossMwhYr: number;
  deliveredMwhYr:        number;
}

interface RiskFactors {
  // Slider inputs
  locationScore:       number;
  curtailmentScore:    number;
  gridStabilityScore:  number;
  interconnectionScore: number;
  developmentRiskScore: number;
  environmentalScore:  number;
  // Context only
  financialScore:      number;
  demandProximityScore: number;
  regulatoryScore:     number;
  // Applied values
  basisAdjMwh:         number;
  curtailmentHaircut:  number;
  shapeDiscount:       number;
  availabilityFactor:  number;
  recRevenueMwh:       number;
  p10Multiplier:       number;
  p90Multiplier:       number;
}

interface ScenarioResult {
  label: string;
  priceMultiplier: number;
  npvM: number;
  avgAnnualCashflowM: number;
}

interface PpaNpvResult {
  candidateId:       number;
  candidateName:     string;
  assetType:         string;
  market:            string;
  capacityMw:        number;
  grossMwhYr:        number;
  contractedMwhYr:   number;
  inputs:            { strike: number; term: number; wacc: number; escalation: number };
  priceWaterfall:    PriceWaterfall;
  volumeWaterfall:   VolumeWaterfall;
  riskFactors:       RiskFactors;
  baseCapturePriceMwh: number;
  scenarios:         { p10: ScenarioResult; p50: ScenarioResult; p90: ScenarioResult };
  breakevenPriceMwh: number;
  annualCashflowsP50M: { year: number; cashflowM: number; marketPriceMwh: number }[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_PATH = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const ISO_OPTIONS = ["ERCOT", "CAISO"] as const;
const TECH_LABELS: Record<string, string> = {
  solar: "Solar", wind: "Wind", storage: "Battery Storage",
  natural_gas: "Natural Gas", nuclear: "Nuclear", hydro: "Hydro",
  coal: "Coal", geothermal: "Geothermal", other: "Other",
};
const REC_BASE: Record<string, number> = { ERCOT: 2.0, CAISO: 7.0 };

function techLabel(t: string) {
  return TECH_LABELS[t] ?? t.charAt(0).toUpperCase() + t.slice(1);
}

// Mirror backend scoreToRiskDefaults() — avoids an extra round-trip when project changes
function scoreToRiskDefaults(s: {
  locationScore: number; curtailmentScore: number; gridStabilityScore: number;
  interconnectionScore: number; developmentRiskScore: number; environmentalScore: number;
  financialScore: number; market: string;
}) {
  const basisAdjMwh = s.locationScore >= 50
    ? ((s.locationScore - 50) / 50) * 6
    : ((s.locationScore - 50) / 50) * 12;
  const curtailmentHaircut  = Math.max(0, Math.min(0.25, (100 - s.curtailmentScore)  / 100 * 0.22));
  const shapeDiscount       = Math.max(0, Math.min(0.20, (100 - s.gridStabilityScore) / 100 * 0.15));
  const avgReliability      = (s.interconnectionScore + s.developmentRiskScore) / 2;
  const availabilityFactor  = 0.93 + (avgReliability / 100) * 0.06;
  const recRevenueMwh       = (REC_BASE[s.market] ?? 4) * (s.environmentalScore / 100);
  return {
    basisAdjMwh:        Math.round(basisAdjMwh * 100) / 100,
    curtailmentHaircut: Math.round(curtailmentHaircut * 1000) / 1000,
    shapeDiscount:      Math.round(shapeDiscount * 1000) / 1000,
    availabilityFactor: Math.round(availabilityFactor * 1000) / 1000,
    recRevenueMwh:      Math.round(recRevenueMwh * 100) / 100,
  };
}

function regulatoryLabel(score: number) {
  if (score >= 65) return { text: "ITC 30% eligible", color: "text-teal-400 bg-teal-900/30 border-teal-700" };
  if (score >= 40) return { text: "PTC eligible", color: "text-amber-400 bg-amber-900/30 border-amber-700" };
  return { text: "Limited tax credits", color: "text-slate-400 bg-slate-800 border-slate-600" };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function NpvCard({ scenario, k }: { scenario: ScenarioResult; k: "p10" | "p50" | "p90" }) {
  const positive  = scenario.npvM >= 0;
  const neutral   = Math.abs(scenario.npvM) < 0.5;
  const color     = neutral ? "border-slate-600" : positive ? "border-teal-500" : "border-red-500";
  const Icon      = neutral ? Minus : positive ? TrendingUp : TrendingDown;
  const iconColor = neutral ? "text-slate-400" : positive ? "text-teal-400" : "text-red-400";
  const badge     = {
    p10: "bg-teal-900/40 text-teal-300 border border-teal-700",
    p50: "bg-slate-700 text-slate-200",
    p90: "bg-red-900/40 text-red-300 border border-red-700",
  }[k];
  const fmt = (n: number) => n >= 0 ? `+$${n.toFixed(1)}M` : `-$${Math.abs(n).toFixed(1)}M`;
  return (
    <div className={`rounded-lg border-2 ${color} bg-slate-800/60 p-4`}>
      <div className="flex items-center justify-between mb-2">
        <span className={`text-xs font-semibold px-2 py-0.5 rounded ${badge}`}>{k.toUpperCase()}</span>
        <Icon className={`h-4 w-4 ${iconColor}`} />
      </div>
      <p className="text-xs text-slate-400 mb-1">{scenario.label}</p>
      <p className={`text-2xl font-bold ${positive ? "text-teal-300" : neutral ? "text-slate-300" : "text-red-300"}`}>
        {fmt(scenario.npvM)}
      </p>
      <p className="text-xs text-slate-500 mt-1">Avg {fmt(scenario.avgAnnualCashflowM)}/yr</p>
    </div>
  );
}

function ScoreBadge({ score, size = "sm" }: { score: number; size?: "xs" | "sm" }) {
  const color = score >= 70 ? "text-teal-400" : score >= 45 ? "text-amber-400" : "text-red-400";
  return <span className={`font-semibold ${color} ${size === "xs" ? "text-[11px]" : "text-xs"}`}>{score.toFixed(0)}</span>;
}

function WaterfallRow({ label, value, note, highlight, indent }: {
  label: string; value: string; note?: string; highlight?: boolean; indent?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between py-1.5 ${highlight ? "border-t border-slate-600 mt-1 pt-2.5" : ""}`}>
      <div className={indent ? "pl-3" : ""}>
        <span className={`text-xs ${highlight ? "text-slate-200 font-semibold" : "text-slate-400"}`}>{label}</span>
        {note && <span className="text-[10px] text-slate-600 ml-1.5">{note}</span>}
      </div>
      <span className={`text-xs font-mono ${highlight ? "text-teal-300 font-bold" : "text-slate-300"}`}>{value}</span>
    </div>
  );
}

const ALL_SCORES: { key: keyof Candidate; label: string; desc: string }[] = [
  { key: "curtailmentScore",    label: "Curtailment",   desc: "Volume haircut" },
  { key: "locationScore",       label: "Basis",         desc: "Node-hub spread" },
  { key: "gridStabilityScore",  label: "Shape",         desc: "Gen/load timing" },
  { key: "interconnectionScore",label: "Congestion",    desc: "Transmission" },
  { key: "developmentRiskScore",label: "Dev Risk",      desc: "Availability" },
  { key: "environmentalScore",  label: "RECs",          desc: "REC revenue" },
  { key: "financialScore",      label: "Mkt Rev",       desc: "Price certainty" },
  { key: "regulatoryScore",     label: "Tax Credit",    desc: "ITC / PTC" },
];

// ─── Main page ────────────────────────────────────────────────────────────────

export default function PpaCalculator() {
  // Project selection
  const [selectedIso,  setSelectedIso]  = useState<string>("");
  const [selectedTech, setSelectedTech] = useState<string>("");
  const [candidateId,  setCandidateId]  = useState<number | null>(null);

  // Contract terms
  const [strike,     setStrike]     = useState(35);
  const [term,       setTerm]       = useState(15);
  const [wacc,       setWacc]       = useState(8);
  const [escalation, setEscalation] = useState(1.5);

  // All 5 financial risk sliders
  const [basisAdj,     setBasisAdj]     = useState(0);
  const [curtailment,  setCurtailment]  = useState(0.05);
  const [shapeDsc,     setShapeDsc]     = useState(0.05);
  const [availability, setAvailability] = useState(0.96);
  const [recRevenue,   setRecRevenue]   = useState(2.0);
  const [riskExpanded, setRiskExpanded] = useState(false);

  const [result,   setResult]   = useState<PpaNpvResult | null>(null);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);
  const [capexMw,  setCapexMw]  = useState(200);

  // Forward curve integration
  const [useForwardCurve, setUseForwardCurve] = useState(true);
  const { data: fwdCurveData } = useQuery<{
    avgSyntheticPowerFwd: number | null;
    avgPowerFwd: number | null;
    asOfDate: string | null;
    heatRate: number;
    promptForward: number | null;
  }>({
    queryKey: ["forward-curve-ppa"],
    queryFn: async () => {
      const r = await fetch(`${BASE_PATH}/api/gas-prices/forward-curve?node=HB_HOUSTON&heat_rate=8.5`);
      if (!r.ok) throw new Error("forward-curve unavailable");
      return r.json();
    },
    staleTime: 30 * 60_000,
  });

  // Synthetic forward power price derived from gas strip × heat rate
  const fwdPowerAvgMwh = useMemo(() => {
    if (!useForwardCurve) return null;
    return fwdCurveData?.avgSyntheticPowerFwd ?? null;
  }, [useForwardCurve, fwdCurveData]);

  // Candidates
  const { data: candidatesData, isLoading: candidatesLoading } = useListCandidates(
    selectedIso ? { market: selectedIso as "ERCOT" | "CAISO", limit: 2000 } : { limit: 0 }
  );
  const allForIso: Candidate[] = candidatesData ?? [];

  const techOptions = useMemo(() => {
    const seen = new Set<string>();
    allForIso.forEach(c => { if (c.assetType) seen.add(c.assetType); });
    return Array.from(seen).sort();
  }, [allForIso]);

  const projectOptions = useMemo(() => {
    if (!selectedTech) return [];
    return allForIso
      .filter(c => c.assetType === selectedTech)
      .sort((a, b) => (b.capacityMw ?? 0) - (a.capacityMw ?? 0));
  }, [allForIso, selectedTech]);

  const selectedCandidate = useMemo(
    () => projectOptions.find(c => c.id === candidateId) ?? null,
    [projectOptions, candidateId]
  );

  // Auto-populate risk sliders from candidate scores
  useEffect(() => {
    if (!candidateId || !selectedCandidate) return;
    const d = scoreToRiskDefaults({
      locationScore:       selectedCandidate.locationScore       ?? 50,
      curtailmentScore:    selectedCandidate.curtailmentScore    ?? 50,
      gridStabilityScore:  selectedCandidate.gridStabilityScore  ?? 50,
      interconnectionScore: selectedCandidate.interconnectionScore ?? 50,
      developmentRiskScore: selectedCandidate.developmentRiskScore ?? 50,
      environmentalScore:  selectedCandidate.environmentalScore  ?? 50,
      financialScore:      selectedCandidate.financialScore      ?? 50,
      market:              selectedCandidate.market ?? selectedIso,
    });
    setBasisAdj(d.basisAdjMwh);
    setCurtailment(d.curtailmentHaircut);
    setShapeDsc(d.shapeDiscount);
    setAvailability(d.availabilityFactor);
    setRecRevenue(d.recRevenueMwh);
    setRiskExpanded(true);
    setResult(null);
  }, [candidateId]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleIsoChange(iso: string) {
    setSelectedIso(iso); setSelectedTech(""); setCandidateId(null); setResult(null);
  }
  function handleTechChange(tech: string) {
    setSelectedTech(tech); setCandidateId(null); setResult(null);
  }
  function handleProjectChange(id: number | null) {
    setCandidateId(id); setResult(null);
  }

  const compute = useCallback(async () => {
    if (!candidateId) return;
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({
        candidateId:         String(candidateId),
        strike:              String(strike),
        term:                String(term),
        wacc:                String(wacc / 100),
        escalation:          String(escalation / 100),
        basisAdjMwh:         String(basisAdj),
        curtailmentHaircut:  String(curtailment),
        shapeDiscount:       String(shapeDsc),
        availabilityFactor:  String(availability),
        recRevenueMwh:       String(recRevenue),
      });
      // Pass synthetic forward power price when toggle is on and data is available
      if (fwdPowerAvgMwh != null) {
        params.set("forwardPowerPriceMwh", String(fwdPowerAvgMwh));
      }
      const res = await fetch(`${BASE_PATH}/api/ppa-npv?${params}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      setResult(await res.json() as PpaNpvResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [candidateId, strike, term, wacc, escalation, basisAdj, curtailment, shapeDsc, availability, recRevenue, fwdPowerAvgMwh]);

  const selectCls = "w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-40 disabled:cursor-not-allowed";
  const chartData = result?.annualCashflowsP50M.map(r => ({ year: `Y${r.year}`, cashflow: r.cashflowM })) ?? [];

  return (
    <div className="p-6 space-y-6 min-h-screen bg-slate-900 text-slate-100">
      <div>
        <h1 className="text-2xl font-bold text-white">NPV Calculator</h1>
        <p className="text-sm text-slate-400 mt-1">
          All 8 ranking dimensions feed the model — basis, curtailment, shape, availability, and REC revenue
          are editable for stress testing; market price spread auto-derives from the financial quality score.
        </p>
      </div>

      {/* ── Forward curve banner ── */}
      {fwdCurveData?.avgSyntheticPowerFwd != null && (
        <div className="flex items-center gap-3 rounded-lg border border-teal-700/50 bg-teal-900/20 px-4 py-3">
          <Zap className="h-4 w-4 text-teal-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-xs text-slate-300">
              <span className="font-semibold text-teal-300">Gas Forward Strip loaded</span>
              {" — "}synthetic power price:{" "}
              <span className="font-mono text-amber-300">${fwdCurveData.avgSyntheticPowerFwd.toFixed(2)}/MWh</span>
              {" "}(HH strip × 8.5 HR, {fwdCurveData.heatRate} MMBtu/MWh)
              {fwdCurveData.asOfDate && (
                <span className="text-slate-500"> · curve as of {fwdCurveData.asOfDate}</span>
              )}
            </span>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer shrink-0">
            <input
              type="checkbox"
              checked={useForwardCurve}
              onChange={e => setUseForwardCurve(e.target.checked)}
              className="accent-teal-500 h-3.5 w-3.5"
            />
            Use in NPV
          </label>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* ── Left panel ── */}
        <div className="lg:col-span-1 space-y-4 bg-slate-800 rounded-xl p-5 border border-slate-700">

          {/* Step 1 — ISO */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-teal-700 text-teal-100 text-[10px] font-bold mr-1.5">1</span>
              Market (ISO)
            </label>
            <select className={selectCls} value={selectedIso} onChange={e => handleIsoChange(e.target.value)}>
              <option value="">— Select ISO —</option>
              {ISO_OPTIONS.map(iso => <option key={iso} value={iso}>{iso}</option>)}
            </select>
          </div>

          {/* Step 2 — Technology */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-teal-700 text-teal-100 text-[10px] font-bold mr-1.5">2</span>
              Technology
              {candidatesLoading && selectedIso && <Loader2 className="inline h-3 w-3 ml-1.5 animate-spin text-teal-400" />}
            </label>
            <select className={selectCls} value={selectedTech}
              disabled={!selectedIso || candidatesLoading}
              onChange={e => handleTechChange(e.target.value)}>
              <option value="">— Select technology —</option>
              {techOptions.map(t => (
                <option key={t} value={t}>
                  {techLabel(t)} ({allForIso.filter(c => c.assetType === t).length})
                </option>
              ))}
            </select>
          </div>

          {/* Step 3 — Project */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-teal-700 text-teal-100 text-[10px] font-bold mr-1.5">3</span>
              Project
              {selectedTech && <span className="ml-1.5 text-slate-500">({projectOptions.length} · sorted by MW)</span>}
            </label>
            <select className={selectCls} value={candidateId ?? ""}
              disabled={!selectedTech}
              onChange={e => handleProjectChange(Number(e.target.value) || null)}>
              <option value="">— Select a project —</option>
              {projectOptions.map(c => (
                <option key={c.id} value={c.id}>{c.name} · {c.capacityMw} MW</option>
              ))}
            </select>
          </div>

          {/* ── Risk Factors ── */}
          {candidateId && selectedCandidate && (
            <div className="rounded-lg border border-slate-600 bg-slate-900/50 overflow-hidden">
              <button
                className="w-full flex items-center justify-between px-4 py-3 text-xs font-semibold text-slate-300 hover:bg-slate-800/60 transition-colors"
                onClick={() => setRiskExpanded(v => !v)}
              >
                <span className="flex items-center gap-1.5">
                  <Shield className="h-3.5 w-3.5 text-amber-400" />
                  Risk Factors
                  <span className="text-slate-500 font-normal">· 5 sliders · auto-loaded from scores</span>
                </span>
                {riskExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>

              {riskExpanded && (
                <div className="px-4 pb-4 space-y-1 border-t border-slate-700">
                  {/* All 8 score badges */}
                  <div className="grid grid-cols-4 gap-1.5 pt-3 pb-3">
                    {ALL_SCORES.map(({ key, label }) => {
                      const score = (selectedCandidate[key] as number | null | undefined) ?? 50;
                      return (
                        <div key={key} className="text-center bg-slate-800 rounded-lg p-1.5">
                          <p className="text-[9px] text-slate-500 leading-tight mb-0.5">{label}</p>
                          <ScoreBadge score={score} size="xs" />
                        </div>
                      );
                    })}
                  </div>

                  <div className="border-t border-slate-700/60 pt-3 space-y-4">
                    {/* Basis adj */}
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        Basis Adj <span className={`font-semibold ml-1 ${basisAdj >= 0 ? "text-teal-400" : "text-red-400"}`}>
                          {basisAdj >= 0 ? "+" : ""}{basisAdj.toFixed(2)} $/MWh
                        </span>
                        <span className="text-[10px] text-slate-600 ml-1">(from Basis score)</span>
                      </label>
                      <input type="range" min={-12} max={8} step={0.25} value={basisAdj}
                        onChange={e => setBasisAdj(Number(e.target.value))}
                        className="w-full accent-teal-500" />
                      <div className="flex justify-between text-[10px] text-slate-600"><span>−$12 congested</span><span>+$8 clear</span></div>
                    </div>

                    {/* Curtailment */}
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        Curtailment <span className="font-semibold text-amber-400 ml-1">{(curtailment * 100).toFixed(1)}%</span>
                        <span className="text-[10px] text-slate-600 ml-1">(from Curtailment score)</span>
                      </label>
                      <input type="range" min={0} max={0.25} step={0.005} value={curtailment}
                        onChange={e => setCurtailment(Number(e.target.value))}
                        className="w-full accent-amber-500" />
                      <div className="flex justify-between text-[10px] text-slate-600"><span>0%</span><span>25% of volume</span></div>
                    </div>

                    {/* Shape discount */}
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        Shape Discount <span className="font-semibold text-purple-400 ml-1">{(shapeDsc * 100).toFixed(1)}%</span>
                        <span className="text-[10px] text-slate-600 ml-1">(from Shape score)</span>
                      </label>
                      <input type="range" min={0} max={0.20} step={0.005} value={shapeDsc}
                        onChange={e => setShapeDsc(Number(e.target.value))}
                        className="w-full accent-purple-500" />
                      <div className="flex justify-between text-[10px] text-slate-600"><span>0%</span><span>20% price discount</span></div>
                    </div>

                    {/* Availability */}
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">
                        Availability <span className="font-semibold text-blue-400 ml-1">{(availability * 100).toFixed(1)}%</span>
                        <span className="text-[10px] text-slate-600 ml-1">(from Congestion + Dev Risk)</span>
                      </label>
                      <input type="range" min={0.80} max={0.99} step={0.005} value={availability}
                        onChange={e => setAvailability(Number(e.target.value))}
                        className="w-full accent-blue-500" />
                      <div className="flex justify-between text-[10px] text-slate-600"><span>80% (unreliable)</span><span>99%</span></div>
                    </div>

                    {/* REC revenue */}
                    <div>
                      <label className="block text-xs text-slate-400 mb-1 flex items-center gap-1">
                        <Leaf className="h-3 w-3 text-green-400" />
                        REC Revenue <span className="font-semibold text-green-400 ml-1">${recRevenue.toFixed(2)}/MWh</span>
                        <span className="text-[10px] text-slate-600 ml-1">(from RECs score)</span>
                      </label>
                      <input type="range" min={0} max={15} step={0.25} value={recRevenue}
                        onChange={e => setRecRevenue(Number(e.target.value))}
                        className="w-full accent-green-500" />
                      <div className="flex justify-between text-[10px] text-slate-600"><span>$0</span><span>$15/MWh</span></div>
                    </div>

                    {/* Financial score → P10/P90 spread (auto, not a slider) */}
                    <div className="rounded-lg bg-slate-800 px-3 py-2 flex items-center justify-between">
                      <span className="text-[10px] text-slate-500 flex items-center gap-1">
                        <Zap className="h-3 w-3 text-slate-500" />
                        P10/P90 spread (from Mkt Rev score {(selectedCandidate.financialScore ?? 50).toFixed(0)})
                      </span>
                      <span className="text-[10px] text-slate-300 font-mono">
                        ±{(15 + (1 - (selectedCandidate.financialScore ?? 50) / 100) * 10).toFixed(0)}%
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Contract Terms ── */}
          <div className="border-t border-slate-700 pt-4 space-y-4">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Contract Terms</h3>

            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Strike Price: <span className="text-teal-400 font-semibold">${strike}/MWh</span>
              </label>
              <input type="range" min={15} max={80} step={0.5} value={strike}
                onChange={e => setStrike(Number(e.target.value))}
                className="w-full accent-teal-500" />
              <div className="flex justify-between text-xs text-slate-600"><span>$15</span><span>$80</span></div>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Contract Term: <span className="text-teal-400 font-semibold">{term} years</span>
              </label>
              <input type="range" min={5} max={25} step={1} value={term}
                onChange={e => setTerm(Number(e.target.value))}
                className="w-full accent-teal-500" />
              <div className="flex justify-between text-xs text-slate-600"><span>5 yr</span><span>25 yr</span></div>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">
                WACC: <span className="text-amber-400 font-semibold">{wacc}%</span>
              </label>
              <input type="range" min={4} max={15} step={0.5} value={wacc}
                onChange={e => setWacc(Number(e.target.value))}
                className="w-full accent-amber-500" />
              <div className="flex justify-between text-xs text-slate-600"><span>4%</span><span>15%</span></div>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Price Escalation: <span className="text-purple-400 font-semibold">{escalation}%/yr</span>
              </label>
              <input type="range" min={0} max={5} step={0.25} value={escalation}
                onChange={e => setEscalation(Number(e.target.value))}
                className="w-full accent-purple-500" />
              <div className="flex justify-between text-xs text-slate-600"><span>0%</span><span>5%/yr</span></div>
            </div>
          </div>

          <button onClick={compute} disabled={!candidateId || loading}
            className="w-full py-2.5 rounded-lg font-semibold text-sm bg-teal-600 hover:bg-teal-500 disabled:bg-slate-700 disabled:text-slate-500 transition-colors flex items-center justify-center gap-2">
            {loading
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Computing…</>
              : <><DollarSign className="h-4 w-4" /> Compute NPV</>}
          </button>

          {error && (
            <div className="flex gap-2 text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg p-3">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />{error}
            </div>
          )}
        </div>

        {/* ── Results panel ── */}
        <div className="lg:col-span-2 space-y-5">
          {!result && !loading && (
            <div className="flex flex-col items-center justify-center h-72 bg-slate-800/40 border border-slate-700 border-dashed rounded-xl text-slate-500">
              <DollarSign className="h-10 w-10 mb-3 opacity-30" />
              <p className="text-sm">Select a project and compute NPV</p>
              <p className="text-xs mt-2 text-center max-w-xs leading-relaxed">
                All 8 ranking scores auto-populate as financial adjustments.<br />
                Drag any slider to stress-test assumptions before computing.
              </p>
            </div>
          )}

          {result && (
            <>
              {/* ── Project header ── */}
              <div className="bg-slate-800 rounded-xl border border-slate-700 p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-200">{result.candidateName}</p>
                    <p className="text-xs text-slate-400">{result.market} · {techLabel(result.assetType)} · {result.capacityMw} MW</p>
                  </div>
                  {/* Tax credit context badge */}
                  {result.riskFactors.regulatoryScore !== undefined && (() => {
                    const rl = regulatoryLabel(result.riskFactors.regulatoryScore);
                    return (
                      <span className={`text-[10px] font-semibold px-2 py-1 rounded border ${rl.color}`}>
                        {rl.text}
                      </span>
                    );
                  })()}
                </div>
                <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
                  {[
                    { label: "Gross Gen",    value: `${(result.grossMwhYr / 1000).toFixed(0)} GWh/yr` },
                    { label: "Delivered",    value: `${(result.contractedMwhYr / 1000).toFixed(0)} GWh/yr` },
                    { label: "Strike",       value: `$${result.inputs.strike}/MWh` },
                    { label: "Total Revenue",value: `$${result.baseCapturePriceMwh}/MWh` },
                    { label: "Breakeven",    value: `$${result.breakevenPriceMwh}/MWh` },
                    { label: "Term / WACC",  value: `${result.inputs.term} yr / ${(result.inputs.wacc * 100).toFixed(1)}%` },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <p className="text-[10px] text-slate-500">{label}</p>
                      <p className="text-xs font-medium text-slate-200">{value}</p>
                    </div>
                  ))}
                </div>
                {result.baseCapturePriceMwh < result.inputs.strike && (
                  <div className="mt-3 text-xs text-amber-400 bg-amber-900/20 border border-amber-800/40 rounded px-3 py-2">
                    ⚠ Total revenue (${result.baseCapturePriceMwh}/MWh incl. RECs) is below strike — offtaker carries net hedge cost at P50
                  </div>
                )}
              </div>

              {/* ── Price waterfall + Volume waterfall ── */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Price waterfall */}
                <div className="bg-slate-800 rounded-xl border border-slate-700 p-4">
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Revenue Build-Up ($/MWh)</h3>
                  <WaterfallRow
                    label="Market DA Reference"
                    value={`$${result.priceWaterfall.marketRefDa}`}
                    note={
                      result.priceWaterfall.marketRefSource === "forward_curve"
                        ? "gas strip × HR"
                        : result.priceWaterfall.marketRefSource === "caller_override"
                        ? "user override"
                        : "2024 hist avg"
                    }
                  />
                  <WaterfallRow label={`× Capture Ratio (${(result.priceWaterfall.captureRatio * 100).toFixed(1)}%)`}
                    value={`$${result.priceWaterfall.rawCapturePrice.toFixed(2)}`} note="tech × market" indent />
                  <WaterfallRow label={`− Shape Discount (${(result.priceWaterfall.shapeDiscount * 100).toFixed(1)}%)`}
                    value={`$${result.priceWaterfall.afterShapePrice.toFixed(2)}`} note="timing mismatch" indent />
                  <WaterfallRow label={`± Basis Adj (${result.priceWaterfall.basisAdjMwh >= 0 ? "+" : ""}${result.priceWaterfall.basisAdjMwh.toFixed(2)})`}
                    value={`$${result.priceWaterfall.powerCapturePrice.toFixed(2)}`} note="node-hub spread" indent />
                  <WaterfallRow label={`+ REC Revenue ($${result.priceWaterfall.recRevenueMwh.toFixed(2)}/MWh)`}
                    value={`$${result.priceWaterfall.totalRevenueMwh.toFixed(2)}`} note="bundled RECs" indent />
                  <WaterfallRow label="vs Strike" value={`$${result.inputs.strike}/MWh`} highlight />
                  <WaterfallRow
                    label="Net $/MWh at P50"
                    value={`${(result.priceWaterfall.totalRevenueMwh - result.inputs.strike) >= 0 ? "+" : ""}$${(result.priceWaterfall.totalRevenueMwh - result.inputs.strike).toFixed(2)}`}
                    highlight
                  />
                </div>

                {/* Volume waterfall */}
                <div className="bg-slate-800 rounded-xl border border-slate-700 p-4">
                  <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Volume Waterfall (GWh/yr)</h3>
                  <WaterfallRow label="Nameplate Generation"
                    value={`${(result.volumeWaterfall.grossMwhYr / 1000).toFixed(1)} GWh`} />
                  <WaterfallRow label={`− Curtailment (${(result.volumeWaterfall.curtailmentHaircut * 100).toFixed(1)}%)`}
                    value={`−${(result.volumeWaterfall.curtailmentLossMwhYr / 1000).toFixed(1)} GWh`} indent />
                  <WaterfallRow label="After curtailment"
                    value={`${(result.volumeWaterfall.afterCurtailmentMwh / 1000).toFixed(1)} GWh`} indent />
                  <WaterfallRow label={`× Availability (${(result.volumeWaterfall.availabilityFactor * 100).toFixed(1)}%)`}
                    value={`−${(result.volumeWaterfall.availabilityLossMwhYr / 1000).toFixed(1)} GWh`} indent />
                  <WaterfallRow label="Delivered Volume"
                    value={`${(result.volumeWaterfall.deliveredMwhYr / 1000).toFixed(1)} GWh`} highlight />

                  {/* Mini score reference */}
                  <div className="mt-3 pt-3 border-t border-slate-700 grid grid-cols-4 gap-1.5">
                    {[
                      { label: "Basis",        score: result.riskFactors.locationScore },
                      { label: "Curtailment",  score: result.riskFactors.curtailmentScore },
                      { label: "Shape",        score: result.riskFactors.gridStabilityScore },
                      { label: "Congestion",   score: result.riskFactors.interconnectionScore },
                      { label: "Dev Risk",     score: result.riskFactors.developmentRiskScore },
                      { label: "RECs",         score: result.riskFactors.environmentalScore },
                      { label: "Mkt Rev",      score: result.riskFactors.financialScore },
                      { label: "Tax Credit",   score: result.riskFactors.regulatoryScore },
                    ].map(({ label, score }) => (
                      <div key={label} className="text-center bg-slate-900/60 rounded py-1.5 px-1">
                        <p className="text-[9px] text-slate-500 leading-tight">{label}</p>
                        <ScoreBadge score={score} size="xs" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* ── P10/P50/P90 scenario cards ── */}
              <div className="grid grid-cols-3 gap-3">
                <NpvCard scenario={result.scenarios.p10} k="p10" />
                <NpvCard scenario={result.scenarios.p50} k="p50" />
                <NpvCard scenario={result.scenarios.p90} k="p90" />
              </div>

              {/* ── Annual cashflow chart ── */}
              <div className="bg-slate-800 rounded-xl border border-slate-700 p-4">
                <h3 className="text-sm font-semibold text-slate-300 mb-4">
                  P50 Annual Cashflows — (Revenue − Strike) × Delivered Volume
                </h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="year" tick={{ fontSize: 10, fill: "#64748b" }} />
                    <YAxis tick={{ fontSize: 10, fill: "#64748b" }} tickFormatter={v => `$${v}M`} />
                    <Tooltip
                      contentStyle={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8 }}
                      labelStyle={{ color: "#94a3b8" }}
                      formatter={(v: number) => [`$${v.toFixed(1)}M`, "Cash Flow"]}
                    />
                    <ReferenceLine y={0} stroke="#64748b" strokeDasharray="4 2" />
                    <Bar dataKey="cashflow" radius={[3, 3, 0, 0]} fill="#14b8a6" />
                  </BarChart>
                </ResponsiveContainer>
                <p className="text-xs text-slate-500 mt-2 text-center">
                  Revenue = power capture + REC · Positive = hedge gain · Negative = hedge cost · {result.inputs.escalation * 100}%/yr escalation
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── CAPEX / Project Development Cost Reference ───────────────────────────── */}
      <div className="border-t border-slate-700 pt-6">
        <div className="flex items-center gap-2 mb-1">
          <Calculator className="h-5 w-5 text-teal-400" />
          <h2 className="text-lg font-bold text-slate-200">Project Development Cost Reference</h2>
        </div>
        <p className="text-xs text-slate-400 mb-5">
          2024–2025 US utility-scale benchmarks · NREL ATB 2024 · EIA AEO 2024 · Lazard LCOE v17 · BNEF 1H2024 · all figures in real 2024 USD
        </p>

        <div className="bg-slate-800 rounded-xl border border-slate-700 p-4 mb-5">
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-sm text-slate-300 font-medium">Project Size:</span>
            <input
              type="range" min={10} max={2000} step={10} value={capexMw}
              onChange={e => setCapexMw(Number(e.target.value))}
              className="w-44 accent-teal-500"
            />
            <span className="text-sm font-mono text-teal-400 w-20">{capexMw} MW</span>
            <span className="text-xs text-slate-500">→ total project cost and annual O&M ranges scale with size</span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {CAPEX_BENCHMARKS.map(b => {
            const totalLo = (b.capexLo * capexMw * 1000 / 1_000_000).toFixed(0);
            const totalHi = (b.capexHi * capexMw * 1000 / 1_000_000).toFixed(0);
            const annualOmLo = (b.fixedOmLo * capexMw * 1000 / 1_000_000).toFixed(1);
            const annualOmHi = (b.fixedOmHi * capexMw * 1000 / 1_000_000).toFixed(1);
            const icLo = (b.interconnLo * capexMw * 1000 / 1_000_000).toFixed(1);
            const icHi = (b.interconnHi * capexMw * 1000 / 1_000_000).toFixed(1);
            return (
              <div key={b.tech} className={`rounded-xl border p-4 ${b.color}`}>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xl">{b.emoji}</span>
                  <div>
                    <p className="text-sm font-bold text-slate-200">{b.tech}</p>
                    <p className="text-[10px] text-slate-500">{b.lifeYears}-year design life</p>
                  </div>
                </div>
                <div className="bg-slate-900/60 rounded-lg px-3 py-2 mb-3">
                  <p className="text-[10px] text-slate-500 mb-0.5">All-in project cost — {capexMw} MW</p>
                  <p className="text-lg font-bold font-mono text-slate-100">${totalLo}M – ${totalHi}M</p>
                  <p className="text-[10px] text-slate-500">${b.capexLo.toLocaleString()}–${b.capexHi.toLocaleString()}/kW · {b.capexNote}</p>
                </div>
                <div className="space-y-1.5 text-xs">
                  {[
                    { label: "Land",            value: `${b.landAcresMw}  ·  ${b.landCostNote}` },
                    { label: "Fixed O&M",       value: `$${b.fixedOmLo}–${b.fixedOmHi}/kW-yr  ($${annualOmLo}M–${annualOmHi}M/yr at ${capexMw} MW)` },
                    { label: "Variable O&M",    value: b.varOmHi === 0 ? "< $1/MWh (negligible)" : `$${b.varOmLo}–${b.varOmHi}/MWh` },
                    { label: "Interconnection", value: `$${b.interconnLo}–${b.interconnHi}/kW  ($${icLo}M–${icHi}M)` },
                    { label: "Insurance",       value: `$${b.insuranceLo}–${b.insuranceHi}/kW-yr` },
                    { label: "Decommission",    value: b.decommNote },
                  ].map(row => (
                    <div key={row.label} className="flex gap-2">
                      <span className="text-slate-500 w-24 shrink-0 leading-snug">{row.label}</span>
                      <span className="text-slate-300 leading-snug">{row.value}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-3 pt-3 border-t border-slate-700/50 space-y-1">
                  {b.techNotes.map((note, i) => (
                    <p key={i} className="text-[10px] text-slate-500 leading-snug">▸ {note}</p>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <p className="mt-4 text-[10px] text-slate-600">
          Ranges reflect geographic variation, supply chain conditions, and project complexity as of 2024–2025. Interconnection costs are highly site-dependent — verify via ISO feasibility study. Figures exclude financing costs (IDC, DSRA). Sources: NREL ATB 2024, EIA AEO 2024, Lazard LCOE v17, BNEF 1H2024 Battery Price Survey, Wood Mackenzie US Solar H2 2024.
        </p>
      </div>

      {/* Explainer panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="bg-slate-800/50 border-slate-700/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5 text-white">
              <BookOpen className="h-4 w-4 text-teal-400" />
              What This Tool Does
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-slate-400 space-y-2">
            <p>
              Builds a <span className="text-slate-200 font-medium">Virtual PPA / VPPA NPV model</span> with
              P10/P50/P90 scenario distributions. Select any of the 3,875 EIA 860 candidates — all 8 risk dimension
              scores from the Rankings engine auto-populate as financial adjustments (basis, curtailment, capture
              price, shape, REC revenue).
            </p>
            <p>
              The <span className="text-slate-200 font-medium">real Henry Hub gas forward strip</span> (from FRED
              DHHNGSP) powers a synthetic power price benchmark for comparison against your PPA strike. A full
              annual cashflow waterfall breaks out every revenue and cost line over the contract term.
            </p>
            <p>
              The <span className="text-slate-200 font-medium">Project Development Cost Reference</span> section
              above provides NREL ATB 2024 benchmarks (CAPEX, O&amp;M, land, interconnection) for all major
              technology types to anchor project cost assumptions.
            </p>
          </CardContent>
        </Card>

        <Card className="bg-slate-800/50 border-slate-700/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5 text-white">
              <Target className="h-4 w-4 text-amber-400" />
              Use Cases
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-slate-400 space-y-2">
            <ul className="space-y-1.5 list-none">
              {[
                ["Developer", "At what PPA strike price does a 200 MW West Texas wind project generate a positive P50 NPV? → Select project, set WACC and term, sweep strike slider."],
                ["PE / Underwriter", "What is the P10/P90 NPV spread — how wide is the distribution? → High spread indicates high curtailment or basis uncertainty in that zone."],
                ["Investor / LP", "Which project among three ERCOT solar candidates offers the best risk-adjusted NPV? → Run NPV on each with the same WACC and compare P50."],
                ["Originator", "What ITC vs PTC election maximises project NPV? → Toggle between solar (ITC 30%+10% DC) and wind (PTC $27.50/MWh × 10yr) — tax credit KPIs auto-update."],
              ].map(([role, a]) => (
                <li key={role} className="border-l-2 border-teal-500/30 pl-2">
                  <p className="text-slate-200 font-medium leading-tight">{role}</p>
                  <p className="text-slate-400 mt-0.5">{a}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card className="bg-slate-800/50 border-slate-700/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5 text-white">
              <FlaskConical className="h-4 w-4 text-purple-400" />
              Key Assumptions
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-slate-400 space-y-1.5">
            {[
              ["Contract structure", "VPPA: buyer pays fixed strike, receives floating hub DA settlement. Net cashflow = (DA − strike) × MWh."],
              ["Capture price", "CDR hub DA monthly averages × technology timing ratio (solar=0.724, wind=1.010, storage=1.797 for ERCOT) from ercot_hub_hourly."],
              ["P10/P50/P90", "Monte Carlo over price volatility, curtailment uncertainty, and basis risk. P10 = adverse 10th percentile; P90 = favourable."],
              ["Tax credits", "ITC: 30% base + 10% domestic content adder (solar, storage). PTC: $27.50/MWh base (2024) × 10yr for qualifying wind."],
              ["WACC", "Project-level real WACC (equity/debt blended). Nominal cashflows discounted at real WACC + inflation."],
              ["Gas forward", "Henry Hub daily spot from FRED DHHNGSP × 8.5 MMBtu/MWh heat rate → synthetic power price benchmark."],
              ["Score linkage", "All 8 dimension scores from Rankings feed directly: curtailment adj → output haircut; basis adj → price haircut; etc."],
            ].map(([k, v]) => (
              <div key={k}>
                <span className="text-slate-200 font-medium">{k}: </span>
                <span>{v}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
