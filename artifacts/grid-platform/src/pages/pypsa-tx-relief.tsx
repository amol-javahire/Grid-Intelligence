import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Loader2, GitBranch, ArrowRight, TrendingDown, TrendingUp } from "lucide-react";
import { useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
  Tooltip as RechartsTooltip, Cell,
} from "recharts";

const BASE = "/pypsa";
const TS = { backgroundColor: "#0f172a", borderColor: "#1e293b", color: "#f8fafc", fontSize: 11 };

const LINES = [
  "NORTH-HOUSTON",
  "NORTH-WEST",
  "NORTH-SOUTH",
  "WEST-PAN",
  "WEST-SOUTH",
  "SOUTH-HOUSTON",
];

const BUS_POS: Record<string, { cx: number; cy: number }> = {
  NORTH:   { cx: 300, cy: 100 },
  WEST:    { cx: 110, cy: 210 },
  PAN:     { cx: 80,  cy: 90  },
  SOUTH:   { cx: 180, cy: 320 },
  HOUSTON: { cx: 440, cy: 260 },
};

const LINE_PAIRS = [
  ["NORTH", "HOUSTON"],
  ["NORTH", "WEST"],
  ["NORTH", "SOUTH"],
  ["WEST",  "PAN"],
  ["WEST",  "SOUTH"],
  ["SOUTH", "HOUSTON"],
];

interface OPFSnapshot {
  lmp: Record<string, number>;
  lmp_spread: number;
  avg_lmp: number;
  "total_congestion_rent_k$": number;
  congested_lines: number;
  total_curtailed_mw: number;
  lines: Array<{
    name: string; bus0: string; bus1: string;
    flow_mw: number; capacity_mw: number; loading_pct: number;
    "congestion_rent_k$": number; is_congested: boolean;
  }>;
}

interface TxResult {
  status: string;
  upgrade_line: string;
  upgrade_pct: number;
  baseline: OPFSnapshot;
  upgraded: OPFSnapshot;
  lmp_delta: Record<string, number>;
  spread_reduction: number;
  "cong_rent_reduction_k$": number;
  curtailment_reduction_mw: number;
}

function loadingColor(pct: number) {
  if (pct >= 95) return "#ef4444";
  if (pct >= 70) return "#f59e0b";
  return "#22c55e";
}

function deltaColor(v: number) {
  if (v < -1) return "text-emerald-400";
  if (v > 1)  return "text-red-400";
  return "text-muted-foreground";
}

export default function PypsaTxRelief() {
  const [loadMw, setLoadMw]     = useState(55000);
  const [windCf, setWindCf]     = useState(35);
  const [solarCf, setSolarCf]   = useState(22);
  const [gasPrice, setGasPrice] = useState(350);
  const [upgradeLine, setUpgradeLine] = useState("NORTH-WEST");
  const [upgradePct, setUpgradePct]   = useState(50);
  const [dirty, setDirty] = useState(false);
  const [result, setResult] = useState<TxResult | null>(null);

  const mut = useMutation({
    mutationFn: (params: object) =>
      fetch(`${BASE}/tx-relief`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      }).then(r => r.json()),
    onSuccess: (data) => { setResult(data); setDirty(false); },
  });

  function runSim() {
    mut.mutate({
      system_load_mw: loadMw,
      wind_cf: windCf / 100,
      solar_cf: solarCf / 100,
      gas_price_mmbtu: gasPrice / 100,
      upgrade_line: upgradeLine,
      upgrade_pct: upgradePct,
    });
  }

  function getLineData(snap: OPFSnapshot, a: string, b: string) {
    return snap.lines.find(l => (l.bus0 === a && l.bus1 === b) || (l.bus0 === b && l.bus1 === a));
  }

  const lmpCompare = result
    ? Object.keys(result.lmp_delta).map(bus => ({
        bus,
        baseline: result.baseline.lmp[bus] ?? 0,
        upgraded: result.upgraded.lmp[bus] ?? 0,
        delta: result.lmp_delta[bus],
      }))
    : [];

  const lineCompare = result
    ? result.baseline.lines.map(bl => {
        const up = result.upgraded.lines.find(l => l.name === bl.name);
        return {
          name: bl.name.replace("NORTH","N").replace("HOUSTON","HOU").replace("SOUTH","S").replace("WEST","W"),
          baseline_loading: bl.loading_pct,
          upgraded_loading: up?.loading_pct ?? 0,
          baseline_rent: bl["congestion_rent_k$"],
          upgraded_rent: up?.["congestion_rent_k$"] ?? 0,
          is_upgraded: bl.name === result.upgrade_line,
        };
      })
    : [];

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <GitBranch className="h-6 w-6 text-purple-400" />
            Transmission Constraint Relief
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Before / after OPF comparison · upgrade any CREZ corridor · measure LMP spread and congestion rent reduction
          </p>
        </div>
        <Badge variant="outline" className="border-purple-500/40 text-purple-400 text-xs">DC OPF × 2</Badge>
      </div>

      {/* Controls */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Scenario Parameters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-6 mb-4">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">System Load</span>
                <span className="font-mono text-teal-400">{(loadMw/1000).toFixed(0)} GW</span>
              </div>
              <Slider min={30000} max={75000} step={1000} value={[loadMw]}
                onValueChange={([v]) => { setLoadMw(v); setDirty(true); }} />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Wind CF</span>
                <span className="font-mono text-teal-400">{windCf}%</span>
              </div>
              <Slider min={5} max={75} step={1} value={[windCf]}
                onValueChange={([v]) => { setWindCf(v); setDirty(true); }} />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Gas Price</span>
                <span className="font-mono text-orange-400">${(gasPrice/100).toFixed(2)}/MMBtu</span>
              </div>
              <Slider min={200} max={800} step={10} value={[gasPrice]}
                onValueChange={([v]) => { setGasPrice(v); setDirty(true); }} />
            </div>
          </div>

          {/* Line selector + upgrade % */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <p className="text-xs text-muted-foreground mb-2">Select line to upgrade</p>
              <div className="flex flex-wrap gap-2">
                {LINES.map(l => (
                  <button key={l} onClick={() => { setUpgradeLine(l); setDirty(true); }}
                    className={`px-3 py-1 rounded text-xs font-mono border transition-colors ${
                      upgradeLine === l
                        ? "border-purple-500 bg-purple-500/20 text-purple-300"
                        : "border-border text-muted-foreground hover:border-purple-500/40 hover:text-purple-400"
                    }`}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Capacity Upgrade</span>
                <span className="font-mono text-purple-400">+{upgradePct}%</span>
              </div>
              <Slider min={10} max={150} step={5} value={[upgradePct]}
                onValueChange={([v]) => { setUpgradePct(v); setDirty(true); }} />
              <p className="text-xs text-muted-foreground mt-1">
                {upgradeLine} capacity: {
                  LINES.indexOf(upgradeLine) >= 0
                    ? ["5,000", "3,500", "2,000", "2,800", "1,500", "3,200"][LINES.indexOf(upgradeLine)]
                    : "—"
                } MW → {
                  (() => {
                    const caps = [5000, 3500, 2000, 2800, 1500, 3200];
                    const base = caps[LINES.indexOf(upgradeLine)] ?? 0;
                    return Math.round(base * (1 + upgradePct / 100)).toLocaleString();
                  })()
                } MW after upgrade
              </p>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <Button size="sm" variant={dirty || !result ? "default" : "outline"}
              className={dirty || !result ? "bg-purple-600 hover:bg-purple-700" : ""}
              disabled={mut.isPending}
              onClick={runSim}>
              {mut.isPending
                ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Running 2× OPF...</>
                : "Run TX Relief Analysis"}
            </Button>
            {!result && !mut.isPending && (
              <span className="text-xs text-muted-foreground">Runs OPF twice (baseline + upgraded) and compares</span>
            )}
          </div>
        </CardContent>
      </Card>

      {mut.isPending && (
        <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Running baseline + upgraded OPF...</span>
        </div>
      )}

      {result && !mut.isPending && (
        <>
          {/* Impact summary strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              {
                label: "LMP Spread Reduction",
                value: `${result.spread_reduction >= 0 ? "−" : "+"}$${Math.abs(result.spread_reduction).toFixed(2)}`,
                sub: `${result.baseline.lmp_spread.toFixed(2)} → ${result.upgraded.lmp_spread.toFixed(2)} $/MWh`,
                color: result.spread_reduction > 0 ? "text-emerald-400" : "text-red-400",
                icon: result.spread_reduction > 0 ? TrendingDown : TrendingUp,
              },
              {
                label: "Congestion Rent Saved",
                value: `$${Math.abs(result["cong_rent_reduction_k$"]).toFixed(1)}k/hr`,
                sub: `${result.baseline["total_congestion_rent_k$"].toFixed(1)} → ${result.upgraded["total_congestion_rent_k$"].toFixed(1)} k$/hr`,
                color: result["cong_rent_reduction_k$"] > 0 ? "text-emerald-400" : "text-red-400",
                icon: TrendingDown,
              },
              {
                label: "Curtailment Reduced",
                value: `${(Math.abs(result.curtailment_reduction_mw)/1000).toFixed(1)} GW`,
                sub: `${(result.baseline.total_curtailed_mw/1000).toFixed(1)} → ${(result.upgraded.total_curtailed_mw/1000).toFixed(1)} GW`,
                color: result.curtailment_reduction_mw > 0 ? "text-emerald-400" : "text-muted-foreground",
                icon: TrendingDown,
              },
              {
                label: "Upgrade Line",
                value: result.upgrade_line.replace("NORTH", "N").replace("HOUSTON", "HOU"),
                sub: `+${result.upgrade_pct}% capacity`,
                color: "text-purple-400",
                icon: GitBranch,
              },
            ].map(kpi => (
              <Card key={kpi.label} className="bg-card border-border">
                <CardContent className="pt-3 pb-2 px-3">
                  <div className="text-xs text-muted-foreground">{kpi.label}</div>
                  <div className={`text-xl font-bold font-mono ${kpi.color}`}>{kpi.value}</div>
                  <div className="text-xs text-muted-foreground">{kpi.sub}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* LMP before/after by zone */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Nodal LMP — Before vs After</CardTitle>
                <CardDescription className="text-xs">
                  Upgrading {result.upgrade_line} redistributes LMPs across all zones
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[220px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={lmpCompare} margin={{ top: 4, right: 16, left: -10, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="bus" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                      <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={v => `$${v}`} />
                      <RechartsTooltip contentStyle={TS}
                        formatter={(v: number, name: string) => [`$${v.toFixed(2)}/MWh`, name]} />
                      <Bar dataKey="baseline" name="Baseline LMP" fill="#64748b" radius={[2,2,0,0]} />
                      <Bar dataKey="upgraded" name="Upgraded LMP" fill="#a855f7" radius={[2,2,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground border-b border-border">
                        <th className="text-left pb-1 font-normal">Zone</th>
                        <th className="text-right pb-1 font-normal">Baseline</th>
                        <th className="text-right pb-1 font-normal">Upgraded</th>
                        <th className="text-right pb-1 font-normal">Δ LMP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lmpCompare.map(z => (
                        <tr key={z.bus} className="border-b border-border/40">
                          <td className="py-1 font-mono text-purple-400">{z.bus}</td>
                          <td className="text-right font-mono text-muted-foreground">${z.baseline.toFixed(2)}</td>
                          <td className="text-right font-mono">${z.upgraded.toFixed(2)}</td>
                          <td className={`text-right font-mono ${deltaColor(z.delta)}`}>
                            {z.delta >= 0 ? "+" : ""}{z.delta.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            {/* Network maps side by side */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Line Loading — Baseline vs Upgraded</CardTitle>
                <CardDescription className="text-xs">
                  Purple = upgraded line; loading % shown on each corridor
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { label: "Baseline", snap: result.baseline },
                    { label: "Upgraded", snap: result.upgraded },
                  ].map(({ label, snap }) => (
                    <div key={label}>
                      <p className="text-xs text-center text-muted-foreground mb-1">{label}</p>
                      <svg viewBox="0 0 540 420" className="w-full" style={{ background: "#0a1628", borderRadius: 6 }}>
                        {LINE_PAIRS.map(([a, b]) => {
                          const pa = BUS_POS[a], pb = BUS_POS[b];
                          const line = getLineData(snap, a, b);
                          const lp = line?.loading_pct ?? 0;
                          const lineName = line?.name ?? "";
                          const isUpgraded = lineName === result.upgrade_line;
                          const color = isUpgraded ? "#a855f7" : loadingColor(lp);
                          const sw = Math.max(1.5, Math.min(7, lp / 12));
                          return (
                            <g key={`${a}-${b}`}>
                              <line x1={pa.cx} y1={pa.cy} x2={pb.cx} y2={pb.cy}
                                stroke={color} strokeWidth={sw} strokeOpacity={0.85} />
                              {line && (
                                <text x={(pa.cx+pb.cx)/2} y={(pa.cy+pb.cy)/2-4}
                                  fontSize="10" fill={color} textAnchor="middle" fontFamily="monospace">
                                  {line.loading_pct.toFixed(0)}%
                                </text>
                              )}
                            </g>
                          );
                        })}
                        {Object.entries(BUS_POS).map(([busId, pos]) => {
                          const lmp = snap.lmp[busId] ?? 0;
                          return (
                            <g key={busId}>
                              <circle cx={pos.cx} cy={pos.cy} r={24} fill="#14b8a6" fillOpacity={0.15} stroke="#14b8a6" strokeWidth={1.5} />
                              <text x={pos.cx} y={pos.cy-4} fontSize="8" fill="#94a3b8" textAnchor="middle" fontFamily="monospace">{busId}</text>
                              <text x={pos.cx} y={pos.cy+8} fontSize="10" fill="#f8fafc" textAnchor="middle" fontWeight="bold" fontFamily="monospace">${lmp.toFixed(0)}</text>
                            </g>
                          );
                        })}
                      </svg>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Line loading comparison table */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Line-by-Line Comparison</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[180px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={lineCompare} margin={{ top: 4, right: 24, left: -10, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: "#94a3b8" }} />
                    <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={v => `${v}%`} domain={[0, 110]} />
                    <RechartsTooltip contentStyle={TS}
                      formatter={(v: number, name: string) => [`${v.toFixed(1)}%`, name]} />
                    <Bar dataKey="baseline_loading" name="Baseline loading %" fill="#64748b" radius={[2,2,0,0]} />
                    <Bar dataKey="upgraded_loading" name="Upgraded loading %">
                      {lineCompare.map((l, i) => (
                        <Cell key={i} fill={l.is_upgraded ? "#a855f7" : loadingColor(l.upgraded_loading)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border">
                      <th className="text-left pb-1 font-normal">Line</th>
                      <th className="text-right pb-1 font-normal">Baseline Load%</th>
                      <th className="text-right pb-1 font-normal">Upgraded Load%</th>
                      <th className="text-right pb-1 font-normal">Baseline Rent</th>
                      <th className="text-right pb-1 font-normal">Upgraded Rent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.baseline.lines.map(bl => {
                      const up = result.upgraded.lines.find(l => l.name === bl.name);
                      const isUp = bl.name === result.upgrade_line;
                      return (
                        <tr key={bl.name} className={`border-b border-border/40 ${isUp ? "bg-purple-500/5" : ""}`}>
                          <td className={`py-1 font-mono ${isUp ? "text-purple-400" : "text-muted-foreground"}`}>
                            {bl.name}{isUp ? " ★" : ""}
                          </td>
                          <td className="text-right font-mono" style={{ color: loadingColor(bl.loading_pct) }}>
                            {bl.loading_pct.toFixed(1)}%
                          </td>
                          <td className="text-right font-mono" style={{ color: loadingColor(up?.loading_pct ?? 0) }}>
                            {up?.loading_pct.toFixed(1) ?? "—"}%
                          </td>
                          <td className="text-right text-muted-foreground">${bl["congestion_rent_k$"].toFixed(1)}k</td>
                          <td className="text-right text-emerald-400">${(up?.["congestion_rent_k$"] ?? 0).toFixed(1)}k</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
