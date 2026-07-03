import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, Flame, AlertTriangle, Zap, Activity, MapPin, FlaskConical, ShieldCheck, BookMarked, GitBranch, Info } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
  Tooltip as RechartsTooltip, Legend, ReferenceLine,
} from "recharts";

const MONTHS = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const TS = { backgroundColor:"#0f172a", borderColor:"#1e293b", color:"#f8fafc", fontSize:11 };

type Overview = {
  resourceNodes: number; hubZoneNodes: number; totalRecords: number;
  congestionEvents: number; severeEvents: number; extremeEvents: number;
  negPriceMonths: number; minPeriod: string; maxPeriod: string;
  monthly: { year:number; month:number; avgBasis:number|null; congestionCount:number; severeCount:number; extremeCount:number; rtCount:number }[];
};

function useCI<T>(endpoint: string, params: Record<string, string|number|undefined> = {}) {
  const qs = Object.entries(params).filter(([,v]) => v !== undefined && v !== "").map(([k,v]) => `${k}=${v}`).join("&");
  return useQuery<T>({ queryKey: ["ci",endpoint,params], queryFn: () => fetch(`/api/congestion-intel/${endpoint}${qs?"?"+qs:""}`).then(r=>r.json()), staleTime: 300_000 });
}

export default function CIOverview() {
  const [threshold, setThreshold] = useState(3);
  const [severe, setSevere]       = useState(15);
  const [extreme, setExtreme]     = useState(35);

  const { data, isLoading } = useCI<Overview>("overview", { threshold, severe, extreme });

  const chartData = useMemo(() => {
    if (!data?.monthly) return [];
    return data.monthly.map(m => ({
      label: `${m.year}-${MONTHS[m.month]}`,
      normal: Math.max(0, (m.rtCount ?? 0) - (m.congestionCount ?? 0)),
      congestion: Math.max(0, (m.congestionCount ?? 0) - (m.severeCount ?? 0)),
      severe: Math.max(0, (m.severeCount ?? 0) - (m.extremeCount ?? 0)),
      extreme: m.extremeCount ?? 0,
      avgBasis: m.avgBasis,
    }));
  }, [data]);

  return (
    <div className="p-6 h-full flex flex-col space-y-5">
      {/* Header */}
      <div className="shrink-0">
        <div className="flex items-center gap-3 mb-1">
          <Flame className="h-6 w-6 text-orange-400" />
          <h1 className="text-2xl font-bold tracking-tight">ERCOT Congestion Intelligence Engine</h1>
          <Badge variant="outline" className="text-xs border-emerald-500/50 text-emerald-400 ml-1">Phase 1</Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          Portfolio-grade congestion and basis risk analytics{data
            ? ` — ${(data.resourceNodes + data.hubZoneNodes).toLocaleString()} nodes · ${data.minPeriod}–${data.maxPeriod} · all real ERCOT CDR + API data`
            : ""}
        </p>
      </div>

      {/* Threshold config */}
      <div className="shrink-0 flex flex-wrap items-center gap-4 bg-card border border-border rounded-md px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 text-primary shrink-0" />
          <span className="font-medium text-foreground">Congestion thresholds (|RT−DA basis| $)</span>
        </div>
        {[
          { label: "Congestion", val: threshold, set: setThreshold, color: "text-amber-400" },
          { label: "Severe", val: severe, set: setSevere, color: "text-orange-400" },
          { label: "Extreme", val: extreme, set: setExtreme, color: "text-red-400" },
        ].map(({ label, val, set, color }) => (
          <div key={label} className="flex items-center gap-2">
            <span className={`text-xs font-medium ${color}`}>{label} &gt;</span>
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">$</span>
              <Input
                type="number" min={0} value={val}
                onChange={e => set(Number(e.target.value))}
                className="h-7 w-16 text-xs px-2 text-center"
              />
              <span className="text-xs text-muted-foreground">/MWh</span>
            </div>
          </div>
        ))}
      </div>

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : data ? (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 shrink-0">
            <Card>
              <CardHeader className="pb-1 pt-4 px-4"><CardDescription className="text-xs">Nodes Analyzed</CardDescription></CardHeader>
              <CardContent className="pb-4 px-4">
                <div className="text-3xl font-bold text-teal-400">{(data.resourceNodes + data.hubZoneNodes).toLocaleString()}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{data.resourceNodes.toLocaleString()} resource · {data.hubZoneNodes} hub/zone</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1 pt-4 px-4"><CardDescription className="text-xs">Congestion Events</CardDescription></CardHeader>
              <CardContent className="pb-4 px-4">
                <div className="text-3xl font-bold text-amber-400">{data.congestionEvents.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground mt-0.5">node-months with |basis| &gt; ${threshold}/MWh</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1 pt-4 px-4"><CardDescription className="text-xs">Severe Events</CardDescription></CardHeader>
              <CardContent className="pb-4 px-4">
                <div className="text-3xl font-bold text-orange-400">{data.severeEvents.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground mt-0.5">|basis| &gt; ${severe}/MWh · extreme: {data.extremeEvents.toLocaleString()}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1 pt-4 px-4"><CardDescription className="text-xs">Neg-Price Months</CardDescription></CardHeader>
              <CardContent className="pb-4 px-4">
                <div className="text-3xl font-bold text-purple-400">{data.negPriceMonths.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground mt-0.5">DA or RT &lt; $0 in at least one period</div>
              </CardContent>
            </Card>
          </div>

          {/* Monthly severity chart */}
          <Card className="shrink-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Monthly Congestion Severity Across All Nodes</CardTitle>
              <CardDescription className="text-xs">
                Each bar = count of node-months at each severity level. Basis = avg monthly RT − DA price.
              </CardDescription>
            </CardHeader>
            <CardContent style={{ height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top:0, right:8, left:0, bottom:0 }} barSize={8}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e2d3e" vertical={false} />
                  <XAxis dataKey="label" stroke="#64748b" tick={{ fill:"#64748b", fontSize:9 }} interval={2} />
                  <YAxis stroke="#64748b" tick={{ fill:"#64748b", fontSize:10 }} width={42} />
                  <RechartsTooltip contentStyle={TS} formatter={(v:number, n:string) => [v.toLocaleString()+" nodes", n]} />
                  <Legend wrapperStyle={{ fontSize:11 }} />
                  <Bar dataKey="normal"     stackId="a" fill="#22c55e"   name="Normal"     isAnimationActive={false} />
                  <Bar dataKey="congestion" stackId="a" fill="#f59e0b"   name={`Congestion (>$${threshold})`}   isAnimationActive={false} />
                  <Bar dataKey="severe"     stackId="a" fill="#f97316"   name={`Severe (>$${severe})`}     isAnimationActive={false} />
                  <Bar dataKey="extreme"    stackId="a" fill="#ef4444"   name={`Extreme (>$${extreme})`}    isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Feature cards */}
          <div className="shrink-0">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Explore the Engine</h2>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              {[
                { href:"/ci-heatmap",     icon:MapPin,        color:"text-teal-400",   title:"Congestion Heat Map",      desc:"All 1,123 nodes ranked by basis risk, volatility, and event frequency" },
                { href:"/ci-node",        icon:Activity,      color:"text-blue-400",   title:"Node Detail",              desc:"Time-series drill-down for any ERCOT node: DA/RT prices, basis, volatility" },
                { href:"/ci-basis",       icon:GitBranch,     color:"text-purple-400", title:"Basis Risk Analyzer",      desc:"Compare any two nodes: correlation, P5/P95, hedge effectiveness" },
                { href:"/ci-backtest",    icon:FlaskConical,  color:"text-amber-400",  title:"2026 Backtest",            desc:"Seasonal model trained on 2024–2025, tested on held-out 2026 actuals" },
                { href:"/ci-quality",     icon:ShieldCheck,   color:"text-emerald-400",title:"Data Quality",             desc:"Record completeness by year, node type, and market" },
                { href:"/ci-methodology", icon:BookMarked,    color:"text-orange-400", title:"Methodology & Case Study", desc:"Portfolio-grade walkthrough for energy analytics interviews" },
              ].map(f => (
                <Link key={f.href} href={f.href}>
                  <div className="bg-card border border-border rounded-md p-4 hover:border-primary/50 hover:bg-muted/20 transition-colors cursor-pointer h-full">
                    <div className="flex items-center gap-2 mb-2">
                      <f.icon className={`h-4 w-4 ${f.color}`} />
                      <span className="font-semibold text-sm">{f.title}</span>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{f.desc}</p>
                  </div>
                </Link>
              ))}
            </div>
          </div>

          {/* Footer */}
          <div className="shrink-0 text-xs text-muted-foreground flex items-center gap-2 pt-1">
            <Info className="h-3.5 w-3.5 text-primary" />
            Data: {data.minPeriod} → {data.maxPeriod} · {data.totalRecords.toLocaleString()} monthly node-records ·
            Source: ERCOT CDR reports 13061/13060 (hub/zone) + ERCOT API bundles np6-905-cd/np4-190-cd (resource nodes)
          </div>
        </>
      ) : null}
    </div>
  );
}
