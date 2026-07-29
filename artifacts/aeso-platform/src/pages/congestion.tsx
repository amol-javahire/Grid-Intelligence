import { useState, useEffect, useCallback } from "react";
import { useGetAesoSmp, useGetAesoInterchange, useGetAesoTransmissionCorridors } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

interface OPFLine {
  name: string;
  flow_mw: number;
  limit_mw: number;
  loading_pct: number;
  near_limit?: boolean;
  binding?: boolean | null;
  congestion_basis?: string;
  congested: boolean;
}

interface OPFResult {
  status: string;
  model_label?: string;
  disclaimer?: string;
  solver_status?: string;
  termination_condition?: string;
  model_status?: string;
  unserved_load_mw?: number;
  energy_balance_residual_mw?: number;
  avg_lmp: number;
  avg_lmp_load_weighted?: number;
  avg_lmp_unweighted?: number;
  lmp_spread: number;
  total_cost_cad_hr: number;
  slack_cost_cad_hr?: number;
  system_load_mw: number;
  lmps: { SOUTH: number; CENTRAL: number; NORTH: number };
  congestion_active: boolean;
  congested_lines: string[];
  lines: OPFLine[];
  south_wind_curtailed_mw: number;
  solar_curtailed_mw: number;
  curtailment_pct: number;
}

const fmt = (n: number | null | undefined, decimals = 1) =>
  n != null ? n.toFixed(decimals) : "—";

const lmpColor = (lmp: number) => {
  if (lmp < 20) return "#22c55e";
  if (lmp < 40) return "#14b8a6";
  if (lmp < 60) return "#f59e0b";
  return "#ef4444";
};

export default function Congestion() {
  const [windCf, setWindCf] = useState(0.55);
  const [loadMw, setLoadMw] = useState(10500);
  const [opfResult, setOpfResult] = useState<OPFResult | null>(null);
  const [opfLoading, setOpfLoading] = useState(true);

  const { data: smpData, isLoading: smpLoading } = useGetAesoSmp();
  const { data: interchangeData, isLoading: interchangeLoading } = useGetAesoInterchange();
  const { data: corridors, isLoading: corridorsLoading } = useGetAesoTransmissionCorridors();

  const runOpf = useCallback(async (wf: number, load: number) => {
    setOpfLoading(true);
    try {
      const resp = await fetch("/pypsa/aeso/opf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wind_cf: wf, system_load_mw: load }),
      });
      if (resp.ok) setOpfResult(await resp.json() as OPFResult);
    } catch {
      // keep previous result
    } finally {
      setOpfLoading(false);
    }
  }, []);

  useEffect(() => { void runOpf(windCf, loadMw); }, [windCf, loadMw, runOpf]);

  const smpChartData = (smpData ?? []).map(d => ({
    month: d.month?.slice(0, 7) ?? "",
    "Pool Price": d.avgConstrained != null ? +d.avgConstrained.toFixed(2) : null,
    "Unconstrained SMP": d.avgUnconstrained != null ? +d.avgUnconstrained.toFixed(2) : null,
    "Congestion Rent": d.avgSpread != null ? +d.avgSpread.toFixed(2) : null,
  }));

  const months = [...new Set((interchangeData ?? []).map(d => d.month?.slice(0, 7) ?? ""))].sort();
  const interchangeChartData = months.map(month => {
    const bc = (interchangeData ?? []).find(
      d => d.month?.startsWith(month) && (d.intertieOrFlowgate?.toUpperCase().includes("BC") ?? false)
    );
    const sk = (interchangeData ?? []).find(
      d => d.month?.startsWith(month) && (d.intertieOrFlowgate?.toUpperCase().includes("SK") ?? false)
    );
    return {
      month,
      "BC (avg MW)": bc?.avgActualMw != null ? +bc.avgActualMw.toFixed(0) : null,
      "SK (avg MW)": sk?.avgActualMw != null ? +sk.avgActualMw.toFixed(0) : null,
    };
  });

  const centralNorth = opfResult?.lines.find(l => l.name === "CENTRAL-NORTH");
  const southCentral = opfResult?.lines.find(l => l.name === "SOUTH-CENTRAL");

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-3xl font-bold tracking-tight">Congestion & Nodal Analysis</h1>
          <Badge variant="outline" className="border-amber-500/50 text-amber-400 shrink-0">
            Illustrative model — not AESO data
          </Badge>
        </div>
        <p className="text-muted-foreground text-sm mt-1">
          {opfResult?.disclaimer ??
            "3-bus illustrative planning construct · not a validated or historical AESO result · BC/SK intertie · transmission corridors"}
        </p>
      </div>

      {/* Solver / model-health warning — only shown when the run actually leaned on
          the slack generator or the solver didn't cleanly report "optimal". This
          surfaces load-shedding instead of letting it silently balance the system. */}
      {opfResult && (opfResult.model_status !== "optimal" || (opfResult.unserved_load_mw ?? 0) > 1) && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 p-3">
          <p className="text-sm font-medium text-red-400">
            Model could not fully serve load from the modeled fleet
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {fmt(opfResult.unserved_load_mw, 0)} MW served by the balancing generator (not real Alberta
            supply) — solver status: {opfResult.solver_status ?? "unknown"} / {opfResult.termination_condition ?? "unknown"}.
            Treat this scenario's LMPs as unreliable.
          </p>
        </div>
      )}

      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">OPF Status</p>
            <p className={`text-xl font-bold mt-1 ${
              opfLoading || !opfResult
                ? ""
                : opfResult.model_status !== "optimal"
                  ? "text-red-400"
                  : opfResult.congestion_active ? "text-amber-400" : "text-green-400"
            }`}>
              {opfLoading || !opfResult
                ? "—"
                : opfResult.model_status !== "optimal"
                  ? "Load shed"
                  : opfResult.congestion_active ? "Congested" : "Uncongested"}
            </p>
            <p className="text-xs text-muted-foreground mt-1 truncate">
              {opfResult
                ? `solver: ${opfResult.solver_status ?? "?"} / ${opfResult.termination_condition ?? "?"}`
                : "No binding constraints"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Nodal Spread</p>
            <p className="text-xl font-bold mt-1">
              {opfLoading ? "—" : `$${fmt(opfResult?.lmp_spread)} /MWh`}
            </p>
            <p className="text-xs text-muted-foreground mt-1">SOUTH vs NORTH LMP delta</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">SMP Congestion Rent</p>
            <p className="text-xl font-bold mt-1">
              {smpLoading
                ? "—"
                : smpData && smpData.length > 0
                  ? `$${fmt(smpData[smpData.length - 1]?.avgSpread)} /MWh`
                  : "Awaiting data"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">Pool price vs unconstrained SMP</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Wind Curtailment</p>
            <p className={`text-xl font-bold mt-1 ${(opfResult?.curtailment_pct ?? 0) > 0 ? "text-amber-400" : ""}`}>
              {opfLoading ? "—" : `${fmt(opfResult?.curtailment_pct)}%`}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {fmt(opfResult?.south_wind_curtailed_mw, 0)} MW curtailed · SOUTH zone
            </p>
          </CardContent>
        </Card>
      </div>

      {/* PyPSA 3-Zone OPF */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="text-base font-semibold">
                {opfResult?.model_label ?? "Alberta 3-Bus Illustrative"} OPF
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                PyPSA DC-OPF (HiGHS) · SOUTH / CENTRAL / NORTH academic aggregation · adjust inputs to recompute —
                not AESO-published nodal prices
              </p>
            </div>
            {opfResult && (
              <Badge
                variant={opfResult.model_status !== "optimal" ? "destructive" : opfResult.congestion_active ? "outline" : "secondary"}
                className={`shrink-0 ml-4 ${opfResult.model_status !== "optimal" ? "" : opfResult.congestion_active ? "border-amber-500/50 text-amber-400" : ""}`}
              >
                {opfResult.model_status !== "optimal" ? "LOAD SHED" : opfResult.status.toUpperCase()}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
            {/* Zone diagram */}
            <div className="flex flex-col items-center gap-4">
              <svg viewBox="0 0 320 440" className="w-full max-w-[280px]">
                {/* CENTRAL-NORTH corridor */}
                <line x1="160" y1="95" x2="160" y2="185"
                  stroke={centralNorth?.congested ? "#ef4444" : "#14b8a6"}
                  strokeWidth="3"
                  strokeDasharray={centralNorth?.congested ? "6 3" : undefined} />
                <text x="174" y="135" fill="#64748b" fontSize="9">
                  {centralNorth ? `${fmt(centralNorth.loading_pct)}% of 1,400 MW` : "1,400 MW cap"}
                </text>
                {centralNorth?.congested && (
                  <text x="174" y="148" fill="#ef4444" fontSize="9" fontWeight="600">⚡ BINDING</text>
                )}

                {/* SOUTH-CENTRAL corridor */}
                <line x1="160" y1="240" x2="160" y2="325"
                  stroke={southCentral?.congested ? "#ef4444" : "#14b8a6"}
                  strokeWidth="3"
                  strokeDasharray={southCentral?.congested ? "6 3" : undefined} />
                <text x="174" y="280" fill="#64748b" fontSize="9">
                  {southCentral ? `${fmt(southCentral.loading_pct)}% of 2,800 MW` : "2,800 MW cap"}
                </text>

                {/* NORTH node */}
                <circle cx="160" cy="65" r="46"
                  fill={opfResult ? lmpColor(opfResult.lmps.NORTH) : "#1e293b"}
                  fillOpacity="0.18"
                  stroke={opfResult ? lmpColor(opfResult.lmps.NORTH) : "#334155"}
                  strokeWidth="2" />
                <text x="160" y="57" textAnchor="middle" fill="#94a3b8" fontSize="11" fontWeight="600">NORTH</text>
                <text x="160" y="74" textAnchor="middle" fontSize="15" fontWeight="700"
                  fill={opfResult ? lmpColor(opfResult.lmps.NORTH) : "#64748b"}>
                  {opfLoading ? "…" : `$${fmt(opfResult?.lmps.NORTH)}`}
                </text>
                <text x="160" y="88" textAnchor="middle" fill="#64748b" fontSize="9">/MWh</text>

                {/* CENTRAL node */}
                <circle cx="160" cy="212" r="46"
                  fill={opfResult ? lmpColor(opfResult.lmps.CENTRAL) : "#1e293b"}
                  fillOpacity="0.18"
                  stroke={opfResult ? lmpColor(opfResult.lmps.CENTRAL) : "#334155"}
                  strokeWidth="2" />
                <text x="160" y="204" textAnchor="middle" fill="#94a3b8" fontSize="11" fontWeight="600">CENTRAL</text>
                <text x="160" y="220" textAnchor="middle" fontSize="15" fontWeight="700"
                  fill={opfResult ? lmpColor(opfResult.lmps.CENTRAL) : "#64748b"}>
                  {opfLoading ? "…" : `$${fmt(opfResult?.lmps.CENTRAL)}`}
                </text>
                <text x="160" y="234" textAnchor="middle" fill="#64748b" fontSize="9">/MWh</text>

                {/* SOUTH node */}
                <circle cx="160" cy="358" r="46"
                  fill={opfResult ? lmpColor(opfResult.lmps.SOUTH) : "#1e293b"}
                  fillOpacity="0.18"
                  stroke={opfResult ? lmpColor(opfResult.lmps.SOUTH) : "#334155"}
                  strokeWidth="2" />
                <text x="160" y="350" textAnchor="middle" fill="#94a3b8" fontSize="11" fontWeight="600">SOUTH</text>
                <text x="160" y="366" textAnchor="middle" fontSize="15" fontWeight="700"
                  fill={opfResult ? lmpColor(opfResult.lmps.SOUTH) : "#64748b"}>
                  {opfLoading ? "…" : `$${fmt(opfResult?.lmps.SOUTH)}`}
                </text>
                <text x="160" y="380" textAnchor="middle" fill="#64748b" fontSize="9">/MWh</text>

                {/* Wind tag */}
                <text x="30" y="352" fill="#60a5fa" fontSize="9" fontWeight="500">💨 Wind</text>
                <text x="28" y="364" fill="#60a5fa" fontSize="9">{fmt(6200 * windCf, 0)} MW</text>
                <text x="24" y="376" fill="#64748b" fontSize="8">6,200 MW nom.</text>

                {/* Load tag */}
                <text x="216" y="204" fill="#fb923c" fontSize="9" fontWeight="500">🏭 Load</text>
                <text x="208" y="216" fill="#fb923c" fontSize="9">{loadMw.toLocaleString()} MW</text>
              </svg>

              {/* LMP color legend */}
              <div className="flex gap-4 text-xs text-muted-foreground flex-wrap justify-center">
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500 inline-block" />{"<$20/MWh"}</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-teal-500 inline-block" />$20–40</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500 inline-block" />$40–60</span>
                <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" />{">$60"}</span>
              </div>
            </div>

            {/* Controls + results */}
            <div className="space-y-6">
              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="font-medium">South Wind Capacity Factor</span>
                  <span className="font-mono text-teal-400">{(windCf * 100).toFixed(0)}%</span>
                </div>
                <Slider min={0.1} max={1.0} step={0.05} value={[windCf]}
                  onValueChange={([v]) => setWindCf(v)} className="w-full" />
                <p className="text-xs text-muted-foreground">
                  SOUTH generation: {fmt(6200 * windCf, 0)} MW wind + 225 MW solar active
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span className="font-medium">Alberta Internal Load (AIL)</span>
                  <span className="font-mono text-teal-400">{loadMw.toLocaleString()} MW</span>
                </div>
                <Slider min={8000} max={14000} step={100} value={[loadMw]}
                  onValueChange={([v]) => setLoadMw(v)} className="w-full" />
                <p className="text-xs text-muted-foreground">Historical AIL range: 8,000–14,000 MW</p>
              </div>

              {/* Line flow bars */}
              {opfResult && (
                <div className="space-y-3">
                  <p className="text-sm font-medium">Corridor Loading</p>
                  {opfResult.lines.map(line => (
                    <div key={line.name} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className={line.congested ? "text-red-400 font-semibold" : "text-muted-foreground"}>
                          {line.name}{line.congested ? " ⚡" : ""}
                        </span>
                        <span className="font-mono">
                          {fmt(Math.abs(line.flow_mw), 0)} / {fmt(line.limit_mw, 0)} MW
                        </span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-2">
                        <div
                          className={`h-2 rounded-full transition-all duration-300 ${line.congested ? "bg-red-500" : "bg-teal-500"}`}
                          style={{ width: `${Math.min(line.loading_pct, 100)}%` }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {fmt(line.loading_pct)}% loaded
                        {line.congestion_basis === "shadow_price_dual"
                          ? line.binding ? " · binding (shadow price > 0)" : " · near limit but not binding"
                          : " · loading-threshold heuristic (dual unavailable)"}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {/* Curtailment alert */}
              {opfResult && opfResult.south_wind_curtailed_mw > 0 && (
                <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3">
                  <p className="text-sm font-medium text-amber-400">Wind Curtailment Active</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {fmt(opfResult.south_wind_curtailed_mw, 0)} MW curtailed in SOUTH — SOUTH→CENTRAL corridor saturated.
                    SOUTH LMP collapses relative to NORTH.
                  </p>
                </div>
              )}

              {/* Summary table */}
              <div className="rounded-lg bg-muted/30 p-3 divide-y divide-border text-xs">
                {[
                  ["System load", `${loadMw.toLocaleString()} MW`],
                  ["Avg LMP (load-weighted)", `$${fmt(opfResult?.avg_lmp_load_weighted ?? opfResult?.avg_lmp)}/MWh`],
                  ["Avg LMP (simple mean)", `$${fmt(opfResult?.avg_lmp_unweighted)}/MWh`],
                  ["SOUTH–NORTH spread", `$${fmt(opfResult?.lmp_spread)}/MWh`],
                  ["System cost (incl. any load shed)", `$${fmt(opfResult?.total_cost_cad_hr, 0)}/hr`],
                  ["Unserved load", `${fmt(opfResult?.unserved_load_mw, 0)} MW`],
                  ["Energy balance residual", `${fmt(opfResult?.energy_balance_residual_mw, 2)} MW`],
                  ["Curtailment", `${fmt(opfResult?.curtailment_pct)}% (${fmt(opfResult?.south_wind_curtailed_mw, 0)} MW)`],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between py-1.5">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-mono font-medium">{opfLoading ? "—" : value}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* SMP Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">SMP vs Pool Price — Congestion Rent History</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Unconstrained SMP = shadow price of energy absent transmission limits.
            Positive spread (pool price &gt; SMP) = congestion rent extracted by constrained generators.
          </p>
        </CardHeader>
        <CardContent>
          {smpLoading ? (
            <Skeleton className="w-full h-64" />
          ) : smpChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={smpChartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                <defs>
                  <linearGradient id="gradConst" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#14b8a6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gradSmp" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="month" tick={{ fontSize: 10, fill: "#64748b" }} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: "#64748b" }} tickLine={false} axisLine={false}
                  tickFormatter={v => `$${v}`} width={52} />
                <Tooltip
                  contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", fontSize: 12 }}
                  formatter={(v: unknown) => [`$${v}`, ""]}
                />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
                <Area type="monotone" dataKey="Pool Price" stroke="#14b8a6" fill="url(#gradConst)"
                  strokeWidth={2} dot={false} connectNulls />
                <Area type="monotone" dataKey="Unconstrained SMP" stroke="#8b5cf6" fill="url(#gradSmp)"
                  strokeWidth={2} dot={false} connectNulls />
                <Area type="monotone" dataKey="Congestion Rent" stroke="#f59e0b" fill="none"
                  strokeWidth={2} strokeDasharray="4 2" dot={false} connectNulls />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-64 items-center justify-center text-center">
              <div className="space-y-2">
                <p className="text-muted-foreground text-sm">SMP data populates after running the real AESO seeder</p>
                <p className="text-xs text-muted-foreground">
                  Endpoint: <code className="bg-muted px-1 py-0.5 rounded">systemmarginalprice-api/v1.1/price/systemMarginalPrice</code>
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Intertie + Corridors */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">BC/SK Intertie Utilization</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Average hourly flows by month · positive = import into Alberta
            </p>
          </CardHeader>
          <CardContent>
            {interchangeLoading ? (
              <Skeleton className="w-full h-52" />
            ) : interchangeChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={interchangeChartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="month" tick={{ fontSize: 9, fill: "#64748b" }} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: "#64748b" }} tickLine={false} axisLine={false}
                    tickFormatter={v => `${v} MW`} width={52} />
                  <Tooltip contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", fontSize: 11 }} />
                  <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="BC (avg MW)" fill="#14b8a6" radius={[2, 2, 0, 0]} />
                  <Bar dataKey="SK (avg MW)" fill="#8b5cf6" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-52 items-center justify-center">
                <div className="text-center space-y-1.5 text-sm text-muted-foreground">
                  <p className="font-medium">Rated intertie capacities</p>
                  <p>BC: ~1,200 MW import / 1,800 MW export</p>
                  <p>SK: ~153 MW import / 153 MW export</p>
                  <p className="text-xs mt-2">Actual flows load after real seeder runs</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">Key Transmission Corridors</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">Ranked by historical congestion frequency</p>
          </CardHeader>
          <CardContent>
            {corridorsLoading ? (
              <Skeleton className="w-full h-52" />
            ) : corridors && corridors.length > 0 ? (
              <div className="space-y-2.5">
                {corridors.slice(0, 8).map(c => (
                  <div key={c.id} className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{c.corridorName}</p>
                      <p className="text-xs text-muted-foreground">
                        {[c.fromRegion, c.toRegion].filter(Boolean).join(" → ")}
                        {c.ratingMw ? ` · ${c.ratingMw.toLocaleString()} MW` : ""}
                      </p>
                    </div>
                    <div className="shrink-0">
                      {c.congestionFrequencyPct != null ? (
                        <Badge variant="outline" className={
                          c.congestionFrequencyPct > 15
                            ? "border-red-500/50 text-red-400"
                            : c.congestionFrequencyPct > 5
                              ? "border-amber-500/50 text-amber-400"
                              : "border-border text-muted-foreground"
                        }>
                          {c.congestionFrequencyPct}%
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex h-52 items-center justify-center text-muted-foreground text-sm">
                No corridor data
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Model methodology note */}
      <Card className="border-amber-500/20 bg-amber-500/5">
        <CardContent className="pt-4 pb-4">
          <p className="text-sm font-semibold text-amber-400 mb-2">Model Methodology — Illustrative, Not Validated</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-muted-foreground">
            <div>
              <p className="font-medium text-foreground mb-1">PyPSA OPF Engine</p>
              <p>
                3-bus DC linear OPF solved via HiGHS. SOUTH: 6,200 MW wind (Pincher Creek / Lethbridge area) + 900 MW
                solar + gas peakers. CENTRAL: ~9,000 MW gas + hydro + BC/SK interties + load centre.
                NORTH: oil-sands cogen + biomass. Bus boundaries are an academic aggregation of AESO's
                actual planning areas, not an official AESO zone definition.
              </p>
            </div>
            <div>
              <p className="font-medium text-foreground mb-1">What this is not</p>
              <p>
                This is not a reconstruction of any real AESO nodal price, and it has not been back-tested against
                historical congestion events. Alberta operates a single province-wide pool price today — nodal
                pricing only exists in AESO's planned Restructured Energy Market (targeted mid-2027). Treat spreads
                and curtailment shown here as directional, scenario-based outputs, not forecasts.
              </p>
            </div>
            <div>
              <p className="font-medium text-foreground mb-1">SMP Congestion Rent (real data)</p>
              <p>
                Unlike the 3-bus OPF above, this chart uses AESO's actually-published constrained pool price and
                unconstrained SMP. The spread is real, historical congestion rent — money transferred from load to
                generators that "benefit" from a binding constraint.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
