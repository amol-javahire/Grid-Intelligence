import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Loader2, Flame, AlertTriangle, ShieldAlert } from "lucide-react";
import { useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
  Tooltip as RechartsTooltip, Cell, RadarChart, Radar, PolarGrid,
  PolarAngleAxis, PolarRadiusAxis,
} from "recharts";

const BASE = "/pypsa";
const TS = { backgroundColor: "#0f172a", borderColor: "#1e293b", color: "#f8fafc", fontSize: 11 };

const SCARCITY_COLORS: Record<string, { bg: string; border: string; text: string; badge: string }> = {
  NORMAL:   { bg: "bg-emerald-500/10", border: "border-emerald-500/30", text: "text-emerald-300", badge: "border-emerald-500/40 text-emerald-400" },
  ELEVATED: { bg: "bg-amber-500/10",   border: "border-amber-500/30",   text: "text-amber-300",   badge: "border-amber-500/40 text-amber-400" },
  SEVERE:   { bg: "bg-orange-500/10",  border: "border-orange-500/30",  text: "text-orange-300",  badge: "border-orange-500/40 text-orange-400" },
  CRITICAL: { bg: "bg-red-500/10",     border: "border-red-500/30",     text: "text-red-300",     badge: "border-red-500/40 text-red-400" },
};

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

interface ScarcityResult {
  status: string;
  scarcity_level: "NORMAL" | "ELEVATED" | "SEVERE" | "CRITICAL";
  system_load_mw: number;
  total_available_mw: number;
  reserve_margin_pct: number;
  total_load_shed_mw: number;
  avg_lmp: number;
  max_lmp: number;
  lmp_spread: number;
  lmp: Record<string, number>;
  carrier_dispatch: Record<string, number>;
  zone_risk: Array<{
    zone: string; hub: string; lmp: number;
    load_mw: number; load_shed_mw: number; shed_pct: number;
  }>;
  lines: Array<{
    name: string; bus0: string; bus1: string;
    flow_mw: number; loading_pct: number; is_congested: boolean;
  }>;
  voll: number;
}

function lmpColor(lmp: number) {
  if (lmp >= 3000) return "#ef4444";
  if (lmp >= 300)  return "#f59e0b";
  if (lmp >= 100)  return "#fbbf24";
  return "#14b8a6";
}

function loadingColor(pct: number) {
  if (pct >= 95) return "#ef4444";
  if (pct >= 70) return "#f59e0b";
  return "#22c55e";
}

const CARRIER_COLORS: Record<string, string> = {
  gas: "#f59e0b", wind: "#14b8a6", solar: "#fbbf24", nuclear: "#8b5cf6", coal: "#94a3b8",
};

export default function PypsaScarcity() {
  const [loadMw,      setLoadMw]      = useState(70000);
  const [windCf,      setWindCf]      = useState(12);
  const [solarCf,     setSolarCf]     = useState(5);
  const [gasPrice,    setGasPrice]    = useState(500);
  const [gasDerate,   setGasDerate]   = useState(15);
  const [nukeDerate,  setNukeDerate]  = useState(0);
  const [voll,        setVoll]        = useState(5000);
  const [dirty, setDirty] = useState(false);
  const [result, setResult] = useState<ScarcityResult | null>(null);

  const mut = useMutation({
    mutationFn: (params: object) =>
      fetch(`${BASE}/scarcity`, {
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
      gas_derate_pct: gasDerate,
      nuclear_derate_pct: nukeDerate,
      voll,
    });
  }

  function getLine(a: string, b: string) {
    return result?.lines?.find(l => (l.bus0 === a && l.bus1 === b) || (l.bus0 === b && l.bus1 === a));
  }

  const level = result?.scarcity_level ?? "NORMAL";
  const levelColors = SCARCITY_COLORS[level];

  const carrierData = result
    ? Object.entries(result.carrier_dispatch).map(([carrier, mw]) => ({
        carrier,
        dispatch: Math.round(mw),
      }))
    : [];

  const zoneRadar = result?.zone_risk.map(z => ({
    zone: z.zone,
    shed_pct: Math.min(z.shed_pct, 100),
    lmp_norm: Math.min(z.lmp / (result.voll || 5000) * 100, 100),
  })) ?? [];

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Flame className="h-6 w-6 text-orange-400" />
            Scarcity &amp; Load Shedding Simulator
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Thermal derate · VOLL-priced load shedding · extreme grid stress scenarios · Uri / winter storm analogs
          </p>
        </div>
        <Badge variant="outline" className="border-orange-500/40 text-orange-400 text-xs">
          Stress Scenario
        </Badge>
      </div>

      {/* Controls */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Stress Scenario Parameters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-4">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Peak Load</span>
                <span className="font-mono text-red-400">{(loadMw/1000).toFixed(0)} GW</span>
              </div>
              <Slider min={45000} max={85000} step={1000} value={[loadMw]}
                onValueChange={([v]) => { setLoadMw(v); setDirty(true); }} />
              <p className="text-xs text-muted-foreground mt-0.5">ERCOT Aug 2023 peak: 85.5 GW</p>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Wind CF (stressed)</span>
                <span className="font-mono text-teal-400">{windCf}%</span>
              </div>
              <Slider min={0} max={40} step={1} value={[windCf]}
                onValueChange={([v]) => { setWindCf(v); setDirty(true); }} />
              <p className="text-xs text-muted-foreground mt-0.5">Uri winter: ~4%</p>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Gas Price</span>
                <span className="font-mono text-orange-400">${(gasPrice/100).toFixed(2)}/MMBtu</span>
              </div>
              <Slider min={200} max={1500} step={25} value={[gasPrice]}
                onValueChange={([v]) => { setGasPrice(v); setDirty(true); }} />
              <p className="text-xs text-muted-foreground mt-0.5">Uri peak: ~$400/MMBtu</p>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">VOLL</span>
                <span className="font-mono text-red-400">${voll.toLocaleString()}/MWh</span>
              </div>
              <Slider min={1000} max={15000} step={500} value={[voll]}
                onValueChange={([v]) => { setVoll(v); setDirty(true); }} />
              <p className="text-xs text-muted-foreground mt-0.5">Value of lost load cap</p>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Gas Capacity Derate</span>
                <span className="font-mono text-orange-400">−{gasDerate}%</span>
              </div>
              <Slider min={0} max={50} step={1} value={[gasDerate]}
                onValueChange={([v]) => { setGasDerate(v); setDirty(true); }} />
              <p className="text-xs text-muted-foreground mt-0.5">Freeze / maintenance outages</p>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Nuclear Derate</span>
                <span className="font-mono text-purple-400">−{nukeDerate}%</span>
              </div>
              <Slider min={0} max={100} step={5} value={[nukeDerate]}
                onValueChange={([v]) => { setNukeDerate(v); setDirty(true); }} />
              <p className="text-xs text-muted-foreground mt-0.5">South Texas Project offline</p>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Solar CF (stressed)</span>
                <span className="font-mono text-amber-400">{solarCf}%</span>
              </div>
              <Slider min={0} max={30} step={1} value={[solarCf]}
                onValueChange={([v]) => { setSolarCf(v); setDirty(true); }} />
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button size="sm" variant={dirty || !result ? "default" : "outline"}
              className={dirty || !result ? "bg-orange-600 hover:bg-orange-700" : ""}
              disabled={mut.isPending}
              onClick={runSim}>
              {mut.isPending
                ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Running stress scenario...</>
                : "Run Scarcity Scenario"}
            </Button>
            {!result && !mut.isPending && (
              <span className="text-xs text-muted-foreground">
                Models thermal derates + VOLL load shedding via PyPSA OPF
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {mut.isPending && (
        <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Running stressed grid scenario...</span>
        </div>
      )}

      {result && !mut.isPending && (
        <>
          {/* Scarcity alert banner */}
          <div className={`flex items-start gap-3 rounded-lg border ${levelColors.border} ${levelColors.bg} px-4 py-3`}>
            <ShieldAlert className={`h-5 w-5 mt-0.5 shrink-0 ${levelColors.text}`} />
            <div>
              <span className={`font-semibold text-base ${levelColors.text}`}>
                Grid Status: {result.scarcity_level}
              </span>
              <p className="text-sm text-muted-foreground mt-0.5">
                Reserve margin {result.reserve_margin_pct.toFixed(1)}% ·{" "}
                Max LMP ${result.max_lmp.toLocaleString()}/MWh ·{" "}
                {result.total_load_shed_mw > 0
                  ? `${(result.total_load_shed_mw/1000).toFixed(1)} GW unserved (VOLL dispatch)`
                  : "No load shedding — all demand served"}
              </p>
            </div>
            <Badge variant="outline" className={`ml-auto shrink-0 ${levelColors.badge}`}>
              {result.scarcity_level}
            </Badge>
          </div>

          {/* KPI strip */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label: "Peak Load", value: `${(result.system_load_mw/1000).toFixed(0)} GW`, sub: "system total", color: "text-red-400" },
              { label: "Available", value: `${(result.total_available_mw/1000).toFixed(0)} GW`, sub: "after derates", color: "text-amber-400" },
              { label: "Reserve Margin", value: `${result.reserve_margin_pct.toFixed(1)}%`, sub: "15% = adequate", color: result.reserve_margin_pct < 5 ? "text-red-400" : result.reserve_margin_pct < 15 ? "text-amber-400" : "text-emerald-400" },
              { label: "Load Shed", value: `${(result.total_load_shed_mw/1000).toFixed(1)} GW`, sub: "VOLL dispatch", color: result.total_load_shed_mw > 0 ? "text-red-400" : "text-emerald-400" },
              { label: "Max LMP", value: `$${result.max_lmp >= 1000 ? (result.max_lmp/1000).toFixed(1)+"k" : result.max_lmp.toFixed(0)}`, sub: "/MWh", color: lmpColor(result.max_lmp) === "#ef4444" ? "text-red-400" : "text-amber-400" },
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
            {/* Network schematic */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Network — Scarcity LMPs + Load Shed</CardTitle>
                <CardDescription className="text-xs">
                  Node color = LMP severity · red ring = load being shed
                </CardDescription>
              </CardHeader>
              <CardContent>
                <svg viewBox="0 0 540 420" className="w-full" style={{ background: "#0a1628", borderRadius: 8 }}>
                  {LINE_PAIRS.map(([a, b]) => {
                    const pa = BUS_POS[a], pb = BUS_POS[b];
                    const line = getLine(a, b);
                    const lp = line?.loading_pct ?? 0;
                    const color = loadingColor(lp);
                    const sw = Math.max(1.5, Math.min(7, lp / 12));
                    return (
                      <g key={`${a}-${b}`}>
                        <line x1={pa.cx} y1={pa.cy} x2={pb.cx} y2={pb.cy}
                          stroke={color} strokeWidth={sw} strokeOpacity={0.8} />
                        {line && (
                          <text x={(pa.cx+pb.cx)/2} y={(pa.cy+pb.cy)/2-4}
                            fontSize="9" fill={color} textAnchor="middle" fontFamily="monospace">
                            {line.loading_pct.toFixed(0)}%
                          </text>
                        )}
                      </g>
                    );
                  })}
                  {Object.entries(BUS_POS).map(([busId, pos]) => {
                    const zone = result.zone_risk.find(z => z.zone === busId);
                    const lmp = result.lmp[busId] ?? 0;
                    const shed = zone?.load_shed_mw ?? 0;
                    const color = lmpColor(lmp);
                    const hasShed = shed > 100;
                    return (
                      <g key={busId}>
                        {hasShed && (
                          <circle cx={pos.cx} cy={pos.cy} r={36}
                            fill="none" stroke="#ef4444" strokeWidth={2.5} strokeDasharray="5 3" strokeOpacity={0.7} />
                        )}
                        <circle cx={pos.cx} cy={pos.cy} r={26}
                          fill={color} fillOpacity={0.2} stroke={color} strokeWidth={2} />
                        <text x={pos.cx} y={pos.cy-10} fontSize="8" fill={color}
                          textAnchor="middle" fontWeight="bold" fontFamily="monospace">{busId}</text>
                        <text x={pos.cx} y={pos.cy+3} fontSize="9" fill="#f8fafc"
                          textAnchor="middle" fontWeight="bold" fontFamily="monospace">
                          ${lmp >= 1000 ? (lmp/1000).toFixed(1)+"k" : lmp.toFixed(0)}
                        </text>
                        {hasShed && (
                          <text x={pos.cx} y={pos.cy+16} fontSize="8" fill="#ef4444"
                            textAnchor="middle" fontFamily="monospace">
                            -{(shed/1000).toFixed(1)}GW
                          </text>
                        )}
                      </g>
                    );
                  })}
                  <g>
                    <text x={456} y={350} fontSize="8" fill="#94a3b8">LMP Scale:</text>
                    {[["#14b8a6","<$100"],["#fbbf24","$100–300"],["#f59e0b","$300–3k"],["#ef4444",">$3k"]].map(([c,l],i) => (
                      <g key={l}>
                        <circle cx={463} cy={362+i*13} r={5} fill={c} fillOpacity={0.4} stroke={c} strokeWidth={1.5} />
                        <text x={473} y={366+i*13} fontSize="7.5" fill={c}>{l}</text>
                      </g>
                    ))}
                    <text x={456} y={415} fontSize="8" fill="#94a3b8">Dashed = load shed</text>
                  </g>
                </svg>
              </CardContent>
            </Card>

            {/* Generation dispatch by carrier */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Generation Dispatch by Carrier</CardTitle>
                <CardDescription className="text-xs">
                  MW dispatched under stressed conditions
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[200px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={carrierData} margin={{ top: 4, right: 16, left: -10, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="carrier" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                      <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={v => `${(v/1000).toFixed(0)}GW`} />
                      <RechartsTooltip contentStyle={TS}
                        formatter={(v: number) => [`${(v/1000).toFixed(1)} GW`]} />
                      <Bar dataKey="dispatch" name="Dispatch" radius={[2,2,0,0]}>
                        {carrierData.map((c, i) => (
                          <Cell key={i} fill={CARRIER_COLORS[c.carrier] ?? "#64748b"} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {/* Zone risk table */}
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground border-b border-border">
                        <th className="text-left pb-1 font-normal">Zone</th>
                        <th className="text-right pb-1 font-normal">LMP</th>
                        <th className="text-right pb-1 font-normal">Load</th>
                        <th className="text-right pb-1 font-normal">Shed</th>
                        <th className="text-right pb-1 font-normal">Shed%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.zone_risk.map(z => (
                        <tr key={z.zone} className={`border-b border-border/40 ${z.load_shed_mw > 100 ? "bg-red-500/5" : ""}`}>
                          <td className={`py-1 font-mono ${z.load_shed_mw > 100 ? "text-red-400" : "text-muted-foreground"}`}>
                            {z.zone}{z.load_shed_mw > 100 ? " ⚡" : ""}
                          </td>
                          <td className="text-right font-mono" style={{ color: lmpColor(z.lmp) }}>
                            ${z.lmp >= 1000 ? (z.lmp/1000).toFixed(1)+"k" : z.lmp.toFixed(0)}
                          </td>
                          <td className="text-right text-muted-foreground">{(z.load_mw/1000).toFixed(1)} GW</td>
                          <td className={`text-right font-mono ${z.load_shed_mw > 0 ? "text-red-400" : "text-emerald-400"}`}>
                            {z.load_shed_mw > 0 ? `${(z.load_shed_mw/1000).toFixed(1)} GW` : "None"}
                          </td>
                          <td className={`text-right font-mono ${z.shed_pct > 5 ? "text-red-400" : "text-muted-foreground"}`}>
                            {z.shed_pct.toFixed(1)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Methodology note */}
          <Card className="bg-card border-border">
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">
                <span className="text-foreground font-medium">Methodology: </span>
                Thermal generators derated by the specified percentage (gas/nuclear separately).
                Each bus has an emergency peaker generator priced at VOLL (${result.voll.toLocaleString()}/MWh),
                representing demand response and voluntary load curtailment programs.
                When total available capacity falls below load, the OPF dispatches these at VOLL,
                driving nodal LMPs toward the price cap. The "load shed" figure equals VOLL-priced
                dispatch — this is the PyPSA analog of unserved energy, not actual rotating outages.
                Based on ERCOT 5-bus reduced-order model with CREZ transmission capacities.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
