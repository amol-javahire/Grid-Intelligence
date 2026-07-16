import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Activity, Info } from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
  Tooltip as RechartsTooltip, ReferenceLine, Legend, Cell,
} from "recharts";

const MONTHS = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const TS = { backgroundColor:"#0f172a", borderColor:"#1e293b", color:"#f8fafc", fontSize:11 };

type NodeSeries = {
  year:number; month:number; avgDa:number; avgRt:number|null; basis:number|null;
  volatility:number|null; negPricePct:number|null; minPrice:number|null; maxPrice:number|null;
};
type NodeListItem = { node:string; node_type:string };

function basisColor(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 50) return "#ef4444";
  if (abs >= 25) return "#f97316";
  if (abs >= 10) return "#f59e0b";
  if (abs >= 3)  return "#14b8a6";
  return "#22c55e";
}

export default function CINode() {
  const params = new URLSearchParams(window.location.search);
  const [selectedNode, setSelectedNode] = useState(params.get("node") ?? "");

  const { data: nodeList } = useQuery<NodeListItem[]>({
    queryKey: ["ci","node-list"],
    queryFn:  () => fetch("/api/congestion-intel/node-list").then(r => r.json()),
    staleTime: 600_000,
  });

  const { data: series, isLoading } = useQuery<NodeSeries[]>({
    queryKey: ["ci","node-series", selectedNode],
    queryFn:  () => fetch(`/api/congestion-intel/node-series?node=${encodeURIComponent(selectedNode)}`).then(r => r.json()),
    staleTime: 300_000,
    enabled: !!selectedNode,
  });

  const chartData = useMemo(() => {
    if (!series) return [];
    return series.map(s => ({
      label: `${s.year}-${MONTHS[s.month]}`,
      DA: s.avgDa != null ? Number(s.avgDa.toFixed(2)) : null,
      RT: s.avgRt != null ? Number(s.avgRt.toFixed(2)) : null,
      basis: s.basis != null ? Number(s.basis.toFixed(2)) : null,
      volatility: s.volatility != null ? Number(s.volatility.toFixed(2)) : null,
      negPct: s.negPricePct ?? null,
      year: s.year,
    }));
  }, [series]);

  const stats = useMemo(() => {
    if (!series?.length) return null;
    const bases = series.filter(s => s.basis != null).map(s => s.basis!).sort((a,b) => a-b);
    if (!bases.length) return null;
    const mean = bases.reduce((a,b)=>a+b,0)/bases.length;
    return {
      mean: mean.toFixed(2),
      median: bases[Math.floor(bases.length/2)].toFixed(2),
      p5: bases[Math.floor(bases.length*0.05)].toFixed(2),
      p95: bases[Math.floor(bases.length*0.95)].toFixed(2),
      min: bases[0].toFixed(2),
      max: bases[bases.length-1].toFixed(2),
      months: bases.length,
      congMonths: bases.filter(b => Math.abs(b) > 10).length,
      severeMonths: bases.filter(b => Math.abs(b) > 25).length,
      negMonths: series.filter(s => (s.negPricePct ?? 0) > 0).length,
    };
  }, [series]);

  const nodeType = nodeList?.find(n => n.node === selectedNode)?.node_type ?? "";

  return (
    <div className="p-6 h-full flex flex-col space-y-4">
      <div className="shrink-0 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Activity className="h-5 w-5 text-blue-400" />
            <h1 className="text-2xl font-bold">Node Detail</h1>
            {selectedNode && nodeType && (
              <Badge variant="outline" className="text-xs capitalize">{nodeType.replace(/_/g," ")}</Badge>
            )}
          </div>
          <p className="text-muted-foreground text-sm">
            Monthly DA/RT prices, basis (RT−DA), volatility, and negative-price exposure for any ERCOT node
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">Node:</span>
          <Select value={selectedNode} onValueChange={setSelectedNode}>
            <SelectTrigger className="w-[260px] h-9 font-mono text-xs">
              <SelectValue placeholder="Select a node…" />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              {nodeList?.map(n => (
                <SelectItem key={n.node} value={n.node} className="font-mono text-xs">
                  <span className="text-muted-foreground text-xs mr-2">{n.node_type.replace(/_/g," ")}</span>
                  {n.node}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!selectedNode ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Select a node above to see its congestion history
        </div>
      ) : isLoading ? (
        <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
      ) : series && stats ? (
        <>
          {/* Stats cards */}
          <div className="grid grid-cols-3 lg:grid-cols-6 gap-3 shrink-0">
            {[
              { label:"Avg Basis",   val:`$${stats.mean}/MWh`,  desc:"Mean RT−DA" },
              { label:"Median",      val:`$${stats.median}/MWh`, desc:"Median basis" },
              { label:"P5",          val:`$${stats.p5}/MWh`,    desc:"5th percentile" },
              { label:"P95",         val:`$${stats.p95}/MWh`,   desc:"95th percentile" },
              { label:"Cong Months", val:`${stats.congMonths}/${stats.months}`, desc:"|basis|>$10" },
              { label:"Neg-Price",   val:`${stats.negMonths} mo`, desc:"Months w/ neg prices" },
            ].map(s => (
              <div key={s.label} className="bg-card border border-border rounded-md px-3 py-2">
                <div className="text-xs text-muted-foreground">{s.label}</div>
                <div className="font-bold text-sm mt-0.5">{s.val}</div>
                <div className="text-xs text-muted-foreground/70">{s.desc}</div>
              </div>
            ))}
          </div>

          {/* DA / RT price chart */}
          <Card className="shrink-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">DA vs RT Monthly Average Price — {selectedNode}</CardTitle>
              <CardDescription className="text-xs">Area chart · 2024 = dark · 2025 = mid · 2026 = light</CardDescription>
            </CardHeader>
            <CardContent style={{ height: 180 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top:0, right:8, left:0, bottom:0 }}>
                  <defs>
                    <linearGradient id="daGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.4}/>
                      <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="rtGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.4}/>
                      <stop offset="95%" stopColor="#14b8a6" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e2d3e" vertical={false} />
                  <XAxis dataKey="label" stroke="#64748b" tick={{ fill:"#64748b", fontSize:9 }} interval={3} />
                  <YAxis stroke="#64748b" tick={{ fill:"#64748b", fontSize:10 }} width={42} tickFormatter={v=>`$${v}`} />
                  <RechartsTooltip contentStyle={TS} formatter={(v:number) => [`$${v?.toFixed(2)}`]} />
                  <Legend wrapperStyle={{ fontSize:11 }} />
                  <Area type="monotone" dataKey="DA" stroke="#8b5cf6" fill="url(#daGrad)" dot={false} name="DA Price" isAnimationActive={false} />
                  <Area type="monotone" dataKey="RT" stroke="#14b8a6" fill="url(#rtGrad)" dot={false} name="RT Price" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Basis bar */}
          <Card className="shrink-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Monthly Basis (RT − DA) — {selectedNode}</CardTitle>
              <CardDescription className="text-xs">
                Green = favourable (RT &lt; DA) · Amber = moderate congestion · Red = severe basis risk
              </CardDescription>
            </CardHeader>
            <CardContent style={{ height: 160 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top:0, right:8, left:0, bottom:0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e2d3e" vertical={false} />
                  <XAxis dataKey="label" stroke="#64748b" tick={{ fill:"#64748b", fontSize:9 }} interval={3} />
                  <YAxis stroke="#64748b" tick={{ fill:"#64748b", fontSize:10 }} width={42} tickFormatter={v=>`$${v}`} />
                  <ReferenceLine y={0} stroke="#64748b" strokeDasharray="4 4" />
                  <ReferenceLine y={10}  stroke="#f59e0b" strokeDasharray="3 3" label={{ value:"$10", fill:"#f59e0b", fontSize:9, position:"right" }} />
                  <ReferenceLine y={-10} stroke="#f59e0b" strokeDasharray="3 3" />
                  <ReferenceLine y={25}  stroke="#ef4444" strokeDasharray="3 3" label={{ value:"$25", fill:"#ef4444", fontSize:9, position:"right" }} />
                  <ReferenceLine y={-25} stroke="#ef4444" strokeDasharray="3 3" />
                  <RechartsTooltip contentStyle={TS} formatter={(v:number) => [`$${v?.toFixed(2)}/MWh`, "Basis"]} />
                  <Bar dataKey="basis" isAnimationActive={false} name="Basis">
                    {chartData.map((d, i) => (
                      <Cell key={i} fill={basisColor(d.basis ?? 0)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Monthly table */}
          <div className="border rounded-md flex-1 overflow-auto bg-card">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card z-10 shadow-sm">
                <tr className="border-b border-border text-muted-foreground">
                  <th className="px-3 py-2 text-left">Period</th>
                  <th className="px-3 py-2 text-right">Avg DA</th>
                  <th className="px-3 py-2 text-right">Avg RT</th>
                  <th className="px-3 py-2 text-right">Basis</th>
                  <th className="px-3 py-2 text-right">|Basis|</th>
                  <th className="px-3 py-2 text-right">Volatility</th>
                  <th className="px-3 py-2 text-right">Neg Price %</th>
                  <th className="px-3 py-2 text-right">Min</th>
                  <th className="px-3 py-2 text-right">Max</th>
                </tr>
              </thead>
              <tbody>
                {series.map(r => {
                  const b = r.basis;
                  const isYear2026 = r.year === 2026;
                  return (
                    <tr key={`${r.year}-${r.month}`} className={`border-b border-border/40 hover:bg-muted/20 ${isYear2026 ? "bg-blue-950/20" : ""}`}>
                      <td className="px-3 py-1.5 font-medium">{r.year}-{MONTHS[r.month]}{isYear2026 && <span className="ml-1 text-blue-400 text-xs">2026</span>}</td>
                      <td className="px-3 py-1.5 text-right text-muted-foreground">${r.avgDa.toFixed(2)}</td>
                      <td className="px-3 py-1.5 text-right text-muted-foreground">{r.avgRt != null ? `$${r.avgRt.toFixed(2)}` : "—"}</td>
                      <td className="px-3 py-1.5 text-right font-medium" style={{ color: b != null ? basisColor(b) : "#64748b" }}>
                        {b != null ? `$${b.toFixed(2)}` : "—"}
                      </td>
                      <td className="px-3 py-1.5 text-right">{b != null ? `$${Math.abs(b).toFixed(2)}` : "—"}</td>
                      <td className="px-3 py-1.5 text-right text-muted-foreground">{r.volatility != null ? `$${r.volatility.toFixed(2)}` : "—"}</td>
                      <td className="px-3 py-1.5 text-right text-muted-foreground">{r.negPricePct != null ? `${r.negPricePct.toFixed(1)}%` : "—"}</td>
                      <td className="px-3 py-1.5 text-right text-muted-foreground">{r.minPrice != null ? `$${r.minPrice.toFixed(2)}` : "—"}</td>
                      <td className="px-3 py-1.5 text-right text-muted-foreground">{r.maxPrice != null ? `$${r.maxPrice.toFixed(2)}` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
