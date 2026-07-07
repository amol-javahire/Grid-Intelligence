import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Loader2, Wind, AlertTriangle, TrendingDown } from "lucide-react";
import { useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
  Tooltip as RechartsTooltip, Cell, ComposedChart, Line,
} from "recharts";

const BASE = "/pypsa";
const TS = { backgroundColor: "#0f172a", borderColor: "#1e293b", color: "#f8fafc", fontSize: 11 };

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

interface CurtailResult {
  status: string;
  system_load_mw: number;
  wind_cf: number;
  solar_cf: number;
  total_curtailed_mw: number;
  curtail_pct: number;
  wind_curtailed_mw: number;
  solar_curtailed_mw: number;
  neg_price_buses: string[];
  neg_price_count: number;
  min_lmp: number;
  avg_lmp: number;
  lmp: Record<string, number>;
  curtailment: Array<{
    name: string; bus: string; carrier: string;
    available_mw: number; dispatched_mw: number;
    curtailed_mw: number; curtail_pct: number; lmp: number;
  }>;
  zone_summary: Array<{
    zone: string; hub: string; lmp: number;
    curtailed_mw: number; available_mw: number; curtail_pct: number;
  }>;
  lines: Array<{
    name: string; bus0: string; bus1: string;
    flow_mw: number; capacity_mw: number; loading_pct: number; is_congested: boolean;
  }>;
}

function loadingColor(pct: number) {
  if (pct >= 95) return "#ef4444";
  if (pct >= 70) return "#f59e0b";
  return "#22c55e";
}

function curtailColor(pct: number) {
  if (pct >= 40) return "#ef4444";
  if (pct >= 15) return "#f59e0b";
  return "#14b8a6";
}

export default function PypsaCurtailment() {
  const [windCf,  setWindCf]  = useState(55);
  const [solarCf, setSolarCf] = useState(28);
  const [gasPrice, setGasPrice] = useState(350);
  const [loadMw,  setLoadMw]  = useState(55000);
  const [westBonus, setWestBonus] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [result, setResult] = useState<CurtailResult | null>(null);

  const mut = useMutation({
    mutationFn: (params: object) =>
      fetch(`${BASE}/curtailment`, {
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
      west_wind_bonus_pct: westBonus,
    });
  }

  function getLine(a: string, b: string) {
    return result?.lines?.find(l => (l.bus0 === a && l.bus1 === b) || (l.bus0 === b && l.bus1 === a));
  }

  const chartData = result?.zone_summary?.map(z => ({
    zone: z.zone,
    available: z.available_mw,
    curtailed: z.curtailed_mw,
    dispatched: z.available_mw - z.curtailed_mw,
    lmp: z.lmp,
    curtail_pct: z.curtail_pct,
  })) ?? [];

  const genChart = result?.curtailment?.map(g => ({
    name: g.name.replace("N-Wind", "N-Wind").replace("W-Wind", "W-Wind"),
    available: Math.round(g.available_mw),
    dispatched: Math.round(g.dispatched_mw),
    curtailed: Math.round(g.curtailed_mw),
    curtail_pct: g.curtail_pct,
    carrier: g.carrier,
  })) ?? [];

  const scarcityLevel = result
    ? result.curtail_pct >= 30 ? "HIGH" : result.curtail_pct >= 10 ? "MODERATE" : "LOW"
    : null;

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Wind className="h-6 w-6 text-teal-400" />
            Renewable Curtailment Simulator
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            DC OPF-derived curtailment · 5-bus ERCOT model · negative price exposure by zone
          </p>
        </div>
        <Badge variant="outline" className="border-teal-500/40 text-teal-400 text-xs">PyPSA OPF</Badge>
      </div>

      {/* Controls */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Scenario Parameters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-6">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">System Load</span>
                <span className="font-mono text-teal-400">{(loadMw/1000).toFixed(0)} GW</span>
              </div>
              <Slider min={10000} max={100000} step={1000} value={[loadMw]}
                onValueChange={([v]) => { setLoadMw(v); setDirty(true); }} />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Wind CF (system)</span>
                <span className="font-mono text-teal-400">{windCf}%</span>
              </div>
              <Slider min={5} max={90} step={1} value={[windCf]}
                onValueChange={([v]) => { setWindCf(v); setDirty(true); }} />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Solar CF</span>
                <span className="font-mono text-amber-400">{solarCf}%</span>
              </div>
              <Slider min={0} max={45} step={1} value={[solarCf]}
                onValueChange={([v]) => { setSolarCf(v); setDirty(true); }} />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Gas Price</span>
                <span className="font-mono text-orange-400">${(gasPrice/100).toFixed(2)}/MMBtu</span>
              </div>
              <Slider min={50} max={1300} step={25} value={[gasPrice]}
                onValueChange={([v]) => { setGasPrice(v); setDirty(true); }} />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">West Wind Overbuild</span>
                <span className="font-mono text-purple-400">+{westBonus}%</span>
              </div>
              <Slider min={0} max={100} step={5} value={[westBonus]}
                onValueChange={([v]) => { setWestBonus(v); setDirty(true); }} />
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button size="sm" variant={dirty || !result ? "default" : "outline"}
              className={dirty || !result ? "bg-teal-600 hover:bg-teal-700" : ""}
              disabled={mut.isPending}
              onClick={runSim}>
              {mut.isPending
                ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Running OPF...</>
                : "Run Curtailment Sim"}
            </Button>
            {dirty && <span className="text-xs text-muted-foreground">Parameters changed — click to update</span>}
            {!result && !mut.isPending && (
              <span className="text-xs text-muted-foreground">Click to run simulation</span>
            )}
          </div>
        </CardContent>
      </Card>

      {mut.isPending && (
        <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Running DC optimal power flow...</span>
        </div>
      )}

      {result && !mut.isPending && (
        <>
          {/* KPI strip */}
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
            {[
              {
                label: "Total Curtailed",
                value: `${(result.total_curtailed_mw/1000).toFixed(1)} GW`,
                sub: `${result.curtail_pct.toFixed(1)}% of available`,
                color: curtailColor(result.curtail_pct),
              },
              {
                label: "Wind Curtailed",
                value: `${(result.wind_curtailed_mw/1000).toFixed(1)} GW`,
                sub: "wind fleet",
                color: "text-teal-400",
              },
              {
                label: "Solar Curtailed",
                value: `${(result.solar_curtailed_mw/1000).toFixed(1)} GW`,
                sub: "solar fleet",
                color: "text-amber-400",
              },
              {
                label: "Neg-Price Zones",
                value: result.neg_price_count.toString(),
                sub: result.neg_price_buses.join(", ") || "none",
                color: result.neg_price_count > 0 ? "text-red-400" : "text-emerald-400",
              },
              {
                label: "Min LMP",
                value: `$${result.min_lmp.toFixed(2)}`,
                sub: "/MWh",
                color: result.min_lmp < 0 ? "text-red-400" : "text-teal-400",
              },
              {
                label: "Avg LMP",
                value: `$${result.avg_lmp.toFixed(2)}`,
                sub: "/MWh system",
                color: "text-teal-400",
              },
            ].map(kpi => (
              <Card key={kpi.label} className="bg-card border-border">
                <CardContent className="pt-3 pb-2 px-3">
                  <div className="text-xs text-muted-foreground">{kpi.label}</div>
                  <div className={`text-xl font-bold font-mono ${kpi.color}`}>{kpi.value}</div>
                  <div className="text-xs text-muted-foreground truncate">{kpi.sub}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Alert banner */}
          {result.neg_price_count > 0 && (
            <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm">
              <AlertTriangle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />
              <div>
                <span className="font-medium text-red-300">Negative price detected</span>
                <span className="text-muted-foreground ml-2">
                  Zones {result.neg_price_buses.join(", ")} are showing LMP &lt; $0 — renewable oversupply
                  is exceeding export capacity on constrained transmission paths.
                  {result.wind_curtailed_mw > 1000 && ` ${(result.wind_curtailed_mw/1000).toFixed(1)} GW of wind cannot be absorbed.`}
                </span>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Zone curtailment bar chart */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Curtailment by Zone</CardTitle>
                <CardDescription className="text-xs">
                  Available vs dispatched renewable MW · stacked by curtailed fraction
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[240px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 4, right: 16, left: -10, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="zone" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                      <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={v => `${(v/1000).toFixed(0)}GW`} />
                      <RechartsTooltip contentStyle={TS}
                        formatter={(v: number, name: string) => [`${(v/1000).toFixed(2)} GW`, name]} />
                      <Bar dataKey="dispatched" name="Dispatched" stackId="a" fill="#14b8a6" radius={[0,0,0,0]} />
                      <Bar dataKey="curtailed" name="Curtailed" stackId="a" fill="#ef4444" radius={[2,2,0,0]} />
                      <Line type="monotone" dataKey="lmp" name="LMP ($/MWh)" stroke="#f59e0b"
                        strokeWidth={2} dot={{ r: 3 }} yAxisId={0} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                {/* Zone table */}
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground border-b border-border">
                        <th className="text-left pb-1 font-normal">Zone</th>
                        <th className="text-right pb-1 font-normal">Available</th>
                        <th className="text-right pb-1 font-normal">Curtailed</th>
                        <th className="text-right pb-1 font-normal">Curt %</th>
                        <th className="text-right pb-1 font-normal">LMP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.zone_summary.map(z => (
                        <tr key={z.zone} className="border-b border-border/40">
                          <td className="py-1 font-mono text-teal-400">{z.zone}</td>
                          <td className="text-right text-muted-foreground">{(z.available_mw/1000).toFixed(1)} GW</td>
                          <td className="text-right font-mono" style={{ color: curtailColor(z.curtail_pct) }}>
                            {(z.curtailed_mw/1000).toFixed(1)} GW
                          </td>
                          <td className="text-right font-mono" style={{ color: curtailColor(z.curtail_pct) }}>
                            {z.curtail_pct.toFixed(1)}%
                          </td>
                          <td className={`text-right font-mono ${z.lmp < 0 ? "text-red-400" : "text-teal-400"}`}>
                            ${z.lmp.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>

            {/* Network map with curtailment overlay */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Network — Curtailment + LMP Overlay</CardTitle>
                <CardDescription className="text-xs">
                  Node color = curtailment severity. Line thickness = loading %.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <svg viewBox="0 0 540 420" className="w-full" style={{ background: "#0a1628", borderRadius: 8 }}>
                  {LINE_PAIRS.map(([a, b]) => {
                    const pa = BUS_POS[a], pb = BUS_POS[b];
                    const line = getLine(a, b);
                    const lp = line?.loading_pct ?? 0;
                    const color = loadingColor(lp);
                    const sw = Math.max(1.5, Math.min(6, lp / 15));
                    return (
                      <g key={`${a}-${b}`}>
                        <line x1={pa.cx} y1={pa.cy} x2={pb.cx} y2={pb.cy}
                          stroke={color} strokeWidth={sw} strokeOpacity={0.8} />
                        {line && (
                          <text x={(pa.cx+pb.cx)/2} y={(pa.cy+pb.cy)/2-5}
                            fontSize="9" fill={color} textAnchor="middle" fontFamily="monospace">
                            {line.loading_pct.toFixed(0)}%
                          </text>
                        )}
                      </g>
                    );
                  })}
                  {Object.entries(BUS_POS).map(([busId, pos]) => {
                    const zone = result.zone_summary.find(z => z.zone === busId);
                    const curtPct = zone?.curtail_pct ?? 0;
                    const lmp = result.lmp[busId] ?? 0;
                    const color = curtailColor(curtPct);
                    const isNeg = lmp < 0;
                    return (
                      <g key={busId}>
                        <circle cx={pos.cx} cy={pos.cy} r={30}
                          fill={color} fillOpacity={0.2}
                          stroke={isNeg ? "#ef4444" : color} strokeWidth={isNeg ? 3 : 2}
                          strokeDasharray={isNeg ? "4 2" : undefined} />
                        <text x={pos.cx} y={pos.cy-12} fontSize="9" fill={color}
                          textAnchor="middle" fontWeight="bold" fontFamily="monospace">{busId}</text>
                        <text x={pos.cx} y={pos.cy+2} fontSize="10" fill="#f8fafc"
                          textAnchor="middle" fontWeight="bold" fontFamily="monospace">
                          {curtPct.toFixed(0)}% curt
                        </text>
                        <text x={pos.cx} y={pos.cy+14} fontSize="9"
                          fill={lmp < 0 ? "#ef4444" : "#94a3b8"}
                          textAnchor="middle" fontFamily="monospace">
                          ${lmp.toFixed(1)}
                        </text>
                      </g>
                    );
                  })}
                  <g>
                    <text x={460} y={355} fontSize="8" fill="#94a3b8">Curtailment:</text>
                    {[["#14b8a6","<10%"],["#f59e0b","10–40%"],["#ef4444",">40%"]].map(([c,l],i) => (
                      <g key={l}>
                        <circle cx={467} cy={366+i*13} r={5} fill={c} fillOpacity={0.4} stroke={c} strokeWidth={1.5} />
                        <text x={477} y={370+i*13} fontSize="8" fill={c}>{l}</text>
                      </g>
                    ))}
                    <text x={460} y={412} fontSize="8" fill="#94a3b8">Dashed = neg LMP</text>
                  </g>
                </svg>
              </CardContent>
            </Card>
          </div>

          {/* Per-generator curtailment */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Per-Generator Curtailment</CardTitle>
              <CardDescription className="text-xs">
                Available vs dispatched MW for all wind and solar generators
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={genChart} margin={{ top: 4, right: 16, left: -10, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="name" tick={{ fontSize: 9, fill: "#94a3b8" }}
                      tickFormatter={v => v.replace(/-Wind|-Solar/g, '').trim()} />
                    <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={v => `${(v/1000).toFixed(0)}GW`} />
                    <RechartsTooltip contentStyle={TS}
                      formatter={(v: number, name: string) => [`${(v/1000).toFixed(2)} GW`, name]} />
                    <Bar dataKey="dispatched" name="Dispatched" stackId="a" fill="#14b8a6" />
                    <Bar dataKey="curtailed" name="Curtailed" stackId="a" radius={[2,2,0,0]}>
                      {genChart.map((g, i) => (
                        <Cell key={i} fill={g.carrier === "wind" ? "#ef4444" : "#f59e0b"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span><span className="inline-block w-2 h-2 rounded-full bg-teal-400 mr-1" />Dispatched</span>
                <span><span className="inline-block w-2 h-2 rounded-full bg-red-400 mr-1" />Wind curtailed</span>
                <span><span className="inline-block w-2 h-2 rounded-full bg-amber-400 mr-1" />Solar curtailed</span>
                <span className="ml-auto">
                  <TrendingDown className="inline h-3 w-3 mr-1 text-red-400" />
                  High curtailment = transmission bottleneck on CREZ corridors (NORTH-WEST, WEST-PAN)
                </span>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
