import { useState, useCallback, useMemo } from "react";
import { useListCandidates, type Candidate } from "@workspace/api-client-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { TrendingUp, TrendingDown, Minus, DollarSign, AlertCircle, Loader2 } from "lucide-react";

interface PpaNpvResult {
  candidateId: number;
  candidateName: string;
  assetType: string;
  market: string;
  capacityMw: number;
  contractedMwhYr: number;
  inputs: { strike: number; term: number; wacc: number; escalation: number };
  baseCapturePriceMwh: number;
  scenarios: {
    p10: ScenarioResult;
    p50: ScenarioResult;
    p90: ScenarioResult;
  };
  breakevenPriceMwh: number;
  annualCashflowsP50M: { year: number; cashflowM: number; marketPriceMwh: number }[];
}

interface ScenarioResult {
  label: string;
  priceMultiplier: number;
  npvM: number;
  avgAnnualCashflowM: number;
}

const BASE_PATH = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

const ISO_OPTIONS = ["ERCOT", "CAISO", "PJM"] as const;

const TECH_LABELS: Record<string, string> = {
  solar:      "Solar",
  wind:       "Wind",
  storage:    "Battery Storage",
  gas:        "Natural Gas",
  nuclear:    "Nuclear",
  hydro:      "Hydro",
  coal:       "Coal",
  geothermal: "Geothermal",
  other:      "Other",
};

function techLabel(t: string) {
  return TECH_LABELS[t] ?? t.charAt(0).toUpperCase() + t.slice(1);
}

export default function PpaCalculator() {
  const [selectedIso,  setSelectedIso]  = useState<string>("");
  const [selectedTech, setSelectedTech] = useState<string>("");
  const [candidateId,  setCandidateId]  = useState<number | null>(null);

  const [strike,     setStrike]     = useState(35);
  const [term,       setTerm]       = useState(15);
  const [wacc,       setWacc]       = useState(8);
  const [escalation, setEscalation] = useState(1.5);

  const [result,  setResult]  = useState<PpaNpvResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  const { data: candidatesData, isLoading: candidatesLoading } = useListCandidates(
    selectedIso ? { market: selectedIso, limit: 2000 } : { limit: 0 }
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

  function handleIsoChange(iso: string) {
    setSelectedIso(iso);
    setSelectedTech("");
    setCandidateId(null);
    setResult(null);
  }

  function handleTechChange(tech: string) {
    setSelectedTech(tech);
    setCandidateId(null);
    setResult(null);
  }

  function handleProjectChange(id: number | null) {
    setCandidateId(id);
    setResult(null);
  }

  const compute = useCallback(async () => {
    if (!candidateId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        candidateId: String(candidateId),
        strike:      String(strike),
        term:        String(term),
        wacc:        String(wacc / 100),
        escalation:  String(escalation / 100),
      });
      const res = await fetch(`${BASE_PATH}/api/ppa-npv?${params}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json() as PpaNpvResult;
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [candidateId, strike, term, wacc, escalation]);

  const fmt = (n: number, digits = 1) =>
    n >= 0 ? `+$${n.toFixed(digits)}M` : `-$${Math.abs(n).toFixed(digits)}M`;

  const NpvCard = ({ scenario, k }: { scenario: ScenarioResult; k: "p10" | "p50" | "p90" }) => {
    const positive = scenario.npvM >= 0;
    const neutral  = Math.abs(scenario.npvM) < 0.5;
    const color    = neutral ? "border-slate-600" : positive ? "border-teal-500" : "border-red-500";
    const Icon     = neutral ? Minus : positive ? TrendingUp : TrendingDown;
    const iconColor = neutral ? "text-slate-400" : positive ? "text-teal-400" : "text-red-400";
    const badge = {
      p10: "bg-teal-900/40 text-teal-300 border border-teal-700",
      p50: "bg-slate-700 text-slate-200",
      p90: "bg-red-900/40 text-red-300 border border-red-700",
    }[k];
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
  };

  const chartData = result?.annualCashflowsP50M.map(r => ({
    year:     `Y${r.year}`,
    cashflow: r.cashflowM,
    price:    r.marketPriceMwh,
  })) ?? [];

  const selectCls = "w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-40 disabled:cursor-not-allowed";

  return (
    <div className="p-6 space-y-6 min-h-screen bg-slate-900 text-slate-100">
      <div>
        <h1 className="text-2xl font-bold text-white">NPV Calculator</h1>
        <p className="text-sm text-slate-400 mt-1">
          Model a VPPA (Financial PPA) — net cashflows = (market price − strike) × contracted volume, discounted at WACC
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Input panel ── */}
        <div className="lg:col-span-1 space-y-4 bg-slate-800 rounded-xl p-5 border border-slate-700 h-fit">
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">Deal Parameters</h2>

          {/* Step 1 — ISO */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-teal-700 text-teal-100 text-[10px] font-bold mr-1.5">1</span>
              Market (ISO)
            </label>
            <select className={selectCls} value={selectedIso} onChange={e => handleIsoChange(e.target.value)}>
              <option value="">— Select ISO —</option>
              {ISO_OPTIONS.map(iso => (
                <option key={iso} value={iso}>{iso}</option>
              ))}
            </select>
          </div>

          {/* Step 2 — Technology */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-teal-700 text-teal-100 text-[10px] font-bold mr-1.5">2</span>
              Technology
              {candidatesLoading && selectedIso && (
                <Loader2 className="inline h-3 w-3 ml-1.5 animate-spin text-teal-400" />
              )}
            </label>
            <select
              className={selectCls}
              value={selectedTech}
              disabled={!selectedIso || candidatesLoading}
              onChange={e => handleTechChange(e.target.value)}
            >
              <option value="">— Select technology —</option>
              {techOptions.map(t => (
                <option key={t} value={t}>
                  {techLabel(t)} ({allForIso.filter(c => c.assetType === t).length} projects)
                </option>
              ))}
            </select>
          </div>

          {/* Step 3 — Project */}
          <div>
            <label className="block text-xs text-slate-400 mb-1">
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-teal-700 text-teal-100 text-[10px] font-bold mr-1.5">3</span>
              Project
              {selectedTech && (
                <span className="ml-1.5 text-slate-500">({projectOptions.length} available)</span>
              )}
            </label>
            <select
              className={selectCls}
              value={candidateId ?? ""}
              disabled={!selectedTech}
              onChange={e => handleProjectChange(Number(e.target.value) || null)}
            >
              <option value="">— Select a project —</option>
              {projectOptions.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.capacityMw} MW
                </option>
              ))}
            </select>
          </div>

          <div className="border-t border-slate-700 pt-4 space-y-4">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Contract Terms</h3>

            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Strike Price: <span className="text-teal-400 font-semibold">${strike}/MWh</span>
              </label>
              <input type="range" min={15} max={80} step={0.5} value={strike}
                onChange={e => setStrike(Number(e.target.value))}
                className="w-full accent-teal-500" />
              <div className="flex justify-between text-xs text-slate-600 mt-0.5">
                <span>$15</span><span>$80</span>
              </div>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Contract Term: <span className="text-teal-400 font-semibold">{term} years</span>
              </label>
              <input type="range" min={5} max={25} step={1} value={term}
                onChange={e => setTerm(Number(e.target.value))}
                className="w-full accent-teal-500" />
              <div className="flex justify-between text-xs text-slate-600 mt-0.5">
                <span>5 yr</span><span>25 yr</span>
              </div>
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">
                WACC: <span className="text-amber-400 font-semibold">{wacc}%</span>
              </label>
              <input type="range" min={4} max={15} step={0.5} value={wacc}
                onChange={e => setWacc(Number(e.target.value))}
                className="w-full accent-amber-500" />
            </div>

            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Power Price Escalation: <span className="text-purple-400 font-semibold">{escalation}%/yr</span>
              </label>
              <input type="range" min={0} max={5} step={0.25} value={escalation}
                onChange={e => setEscalation(Number(e.target.value))}
                className="w-full accent-purple-500" />
            </div>
          </div>

          <button
            onClick={compute}
            disabled={!candidateId || loading}
            className="w-full py-2.5 rounded-lg font-semibold text-sm bg-teal-600 hover:bg-teal-500 disabled:bg-slate-700 disabled:text-slate-500 transition-colors flex items-center justify-center gap-2"
          >
            {loading
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Computing…</>
              : <><DollarSign className="h-4 w-4" /> Compute NPV</>}
          </button>

          {error && (
            <div className="flex gap-2 text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg p-3">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              {error}
            </div>
          )}
        </div>

        {/* ── Results panel ── */}
        <div className="lg:col-span-2 space-y-5">
          {!result && !loading && (
            <div className="flex flex-col items-center justify-center h-64 bg-slate-800/40 border border-slate-700 border-dashed rounded-xl text-slate-500">
              <DollarSign className="h-10 w-10 mb-3 opacity-30" />
              <p className="text-sm">Select a project and compute NPV</p>
              <p className="text-xs mt-1">P10 / P50 / P90 scenarios at different power price assumptions</p>
            </div>
          )}

          {result && (
            <>
              {/* Summary header */}
              <div className="bg-slate-800 rounded-xl border border-slate-700 p-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {[
                    { label: "Project",            value: result.candidateName },
                    { label: "Market",             value: `${result.market} · ${techLabel(result.assetType)}` },
                    { label: "Capacity",           value: `${result.capacityMw} MW` },
                    { label: "Contracted Volume",  value: `${(result.contractedMwhYr / 1000).toFixed(0)} GWh/yr` },
                    { label: "Base Capture Price", value: `$${result.baseCapturePriceMwh}/MWh` },
                    { label: "Strike Price",       value: `$${result.inputs.strike}/MWh` },
                    { label: "Breakeven Price",    value: `$${result.breakevenPriceMwh}/MWh` },
                    { label: "Contract Term",      value: `${result.inputs.term} yr @ ${(result.inputs.wacc * 100).toFixed(1)}% WACC` },
                  ].map(({ label, value }) => (
                    <div key={label}>
                      <p className="text-xs text-slate-500">{label}</p>
                      <p className="text-sm font-medium text-slate-200 truncate">{value}</p>
                    </div>
                  ))}
                </div>
                {result.baseCapturePriceMwh < result.inputs.strike && (
                  <div className="mt-3 text-xs text-amber-400 bg-amber-900/20 border border-amber-800/40 rounded px-3 py-2">
                    ⚠ Strike (${result.inputs.strike}) exceeds base capture price (${result.baseCapturePriceMwh}/MWh) — offtaker carries hedge cost at P50
                  </div>
                )}
              </div>

              {/* Scenario cards */}
              <div className="grid grid-cols-3 gap-3">
                <NpvCard scenario={result.scenarios.p10} k="p10" />
                <NpvCard scenario={result.scenarios.p50} k="p50" />
                <NpvCard scenario={result.scenarios.p90} k="p90" />
              </div>

              {/* Annual cashflow chart */}
              <div className="bg-slate-800 rounded-xl border border-slate-700 p-4">
                <h3 className="text-sm font-semibold text-slate-300 mb-4">
                  P50 Annual Cashflows (Market − Strike) × Volume
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
                  Positive = hedge gain (market &gt; strike) · Negative = hedge cost
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
