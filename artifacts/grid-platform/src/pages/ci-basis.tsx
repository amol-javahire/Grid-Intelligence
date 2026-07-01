import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, GitBranch, Info, ArrowRight } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
  Tooltip as RechartsTooltip, Legend, ReferenceLine,
} from "recharts";

const MONTHS = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const TS = { backgroundColor:"#0f172a", borderColor:"#1e293b", color:"#f8fafc", fontSize:11 };

type CompareResult = {
  nodeA: string; nodeB: string; correlation: number|null; alignedMonths: number;
  statsA: NodeStats|null; statsB: NodeStats|null;
  seriesA: { year:number; month:number; basis:number; da:number; rt:number }[];
  seriesB: { year:number; month:number; basis:number; da:number; rt:number }[];
};
type NodeStats = {
  mean:number; median:number; p5:number; p95:number; stddev:number;
  min:number; max:number; negFreq:number; congFreq:number; months:number;
};
type NodeListItem = { node:string; node_type:string };

const PRESETS = [
  { a:"HB_NORTH", b:"HB_WEST" }, { a:"HB_HOUSTON", b:"HB_SOUTH" },
  { a:"LZ_NORTH", b:"LZ_WEST" }, { a:"HB_NORTH", b:"LZ_NORTH" },
];

export default function CIBasis() {
  const [nodeA, setNodeA] = useState("HB_NORTH");
  const [nodeB, setNodeB] = useState("HB_WEST");

  const { data: nodeList } = useQuery<NodeListItem[]>({
    queryKey: ["ci","node-list"],
    queryFn:  () => fetch("/api/congestion-intel/node-list").then(r => r.json()),
    staleTime: 600_000,
  });

  const { data, isLoading } = useQuery<CompareResult>({
    queryKey: ["ci","basis-compare", nodeA, nodeB],
    queryFn:  () => fetch(`/api/congestion-intel/basis-compare?nodeA=${encodeURIComponent(nodeA)}&nodeB=${encodeURIComponent(nodeB)}`).then(r => r.json()),
    staleTime: 300_000,
    enabled: !!nodeA && !!nodeB && nodeA !== nodeB,
  });

  const chartData = useMemo(() => {
    if (!data) return [];
    const aMap = new Map((data.seriesA ?? []).map(r => [`${r.year}-${r.month}`, r.basis]));
    const bMap = new Map((data.seriesB ?? []).map(r => [`${r.year}-${r.month}`, r.basis]));
    const keys = new Set([...aMap.keys(), ...bMap.keys()]);
    return [...keys].sort().map(k => {
      const [yr, mo] = k.split("-").map(Number);
      return { label:`${yr}-${MONTHS[mo]}`, basisA: aMap.get(k) ?? null, basisB: bMap.get(k) ?? null };
    });
  }, [data]);

  const corrColor = (c: number|null) => {
    if (c == null) return "text-muted-foreground";
    if (c > 0.8) return "text-emerald-400";
    if (c > 0.5) return "text-teal-400";
    if (c > 0.2) return "text-amber-400";
    return "text-red-400";
  };

  const StatBox = ({ label, valA, valB, unit="$/MWh" }: { label:string; valA:number|string|undefined; valB:number|string|undefined; unit?:string }) => (
    <div className="bg-card border border-border rounded px-3 py-2">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="flex items-center gap-3">
        <span className="font-bold text-sm text-blue-400">{valA != null ? `${valA} ${unit}` : "—"}</span>
        <ArrowRight className="h-3 w-3 text-muted-foreground" />
        <span className="font-bold text-sm text-amber-400">{valB != null ? `${valB} ${unit}` : "—"}</span>
      </div>
    </div>
  );

  return (
    <div className="p-6 h-full flex flex-col space-y-4">
      <div className="shrink-0">
        <div className="flex items-center gap-2 mb-1">
          <GitBranch className="h-5 w-5 text-purple-400" />
          <h1 className="text-2xl font-bold">Basis Risk Analyzer</h1>
        </div>
        <p className="text-muted-foreground text-sm">
          Compare basis (RT−DA) between any two ERCOT nodes — correlation, percentile distribution, hedge effectiveness
        </p>
      </div>

      {/* Node selectors */}
      <div className="shrink-0 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-blue-400" />
          <span className="text-xs text-muted-foreground">Node A</span>
          <Select value={nodeA} onValueChange={setNodeA}>
            <SelectTrigger className="w-[220px] h-9 font-mono text-xs"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-72">
              {nodeList?.map(n => (
                <SelectItem key={n.node} value={n.node} className="font-mono text-xs">{n.node}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <span className="text-muted-foreground font-medium text-sm">vs</span>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-amber-400" />
          <span className="text-xs text-muted-foreground">Node B</span>
          <Select value={nodeB} onValueChange={setNodeB}>
            <SelectTrigger className="w-[220px] h-9 font-mono text-xs"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-72">
              {nodeList?.map(n => (
                <SelectItem key={n.node} value={n.node} className="font-mono text-xs">{n.node}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 ml-2">
          <span className="text-xs text-muted-foreground">Presets:</span>
          {PRESETS.map(p => (
            <button
              key={`${p.a}-${p.b}`}
              className="text-xs px-2 py-1 border border-border rounded hover:border-primary/50 hover:bg-muted/20 font-mono"
              onClick={() => { setNodeA(p.a); setNodeB(p.b); }}
            >
              {p.a} / {p.b}
            </button>
          ))}
        </div>
      </div>

      {nodeA === nodeB ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          Select two different nodes to compare
        </div>
      ) : isLoading ? (
        <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
      ) : data ? (
        <>
          {/* Correlation + alignment */}
          <div className="shrink-0 flex items-center gap-4 bg-card border border-border rounded-md px-4 py-3">
            <div>
              <div className="text-xs text-muted-foreground">Pearson Correlation (basis)</div>
              <div className={`text-2xl font-bold ${corrColor(data.correlation)}`}>
                {data.correlation != null ? data.correlation.toFixed(3) : "—"}
              </div>
            </div>
            <div className="h-10 w-px bg-border" />
            <div>
              <div className="text-xs text-muted-foreground">Aligned Months</div>
              <div className="text-xl font-bold">{data.alignedMonths}</div>
            </div>
            <div className="h-10 w-px bg-border" />
            <div>
              <div className="text-xs text-muted-foreground">Hedge Effectiveness</div>
              <div className="text-xl font-bold text-teal-400">
                {data.correlation != null ? `${(data.correlation ** 2 * 100).toFixed(1)}%` : "—"}
              </div>
              <div className="text-xs text-muted-foreground">R² = explained variance</div>
            </div>
            <div className="h-10 w-px bg-border" />
            <div className="flex-1">
              <div className="text-xs text-muted-foreground mb-0.5">Interpretation</div>
              <div className="text-xs text-foreground/80">
                {data.correlation == null ? "Insufficient data" :
                  data.correlation > 0.8 ? "Strong co-movement — can proxy one with the other for risk hedging" :
                  data.correlation > 0.5 ? "Moderate co-movement — partial hedge effectiveness" :
                  data.correlation > 0 ? "Weak positive correlation — limited hedging value" :
                  "Negative or zero correlation — spread positions may diverge"}
              </div>
            </div>
          </div>

          {/* Stats comparison */}
          <div className="shrink-0 grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatBox label="Mean Basis" valA={data.statsA?.mean} valB={data.statsB?.mean} />
            <StatBox label="P5 / P95" valA={`${data.statsA?.p5} / ${data.statsA?.p95}`} valB={`${data.statsB?.p5} / ${data.statsB?.p95}`} unit="" />
            <StatBox label="Std Deviation" valA={data.statsA?.stddev} valB={data.statsB?.stddev} />
            <StatBox label="Congestion Freq" valA={`${data.statsA?.congFreq}`} valB={`${data.statsB?.congFreq}`} unit="%" />
          </div>

          {/* Basis time series */}
          <Card className="shrink-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Monthly Basis Comparison — {nodeA} vs {nodeB}</CardTitle>
              <CardDescription className="text-xs">RT − DA basis. Reference lines at ±$10/MWh (congestion) and ±$25/MWh (severe).</CardDescription>
            </CardHeader>
            <CardContent className="pb-4">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={chartData} margin={{ top:0, right:8, left:0, bottom:0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e2d3e" vertical={false} />
                  <XAxis dataKey="label" stroke="#64748b" tick={{ fill:"#64748b", fontSize:9 }} interval={3} />
                  <YAxis stroke="#64748b" tick={{ fill:"#64748b", fontSize:10 }} width={42} tickFormatter={v=>`$${v}`} />
                  <ReferenceLine y={0}   stroke="#64748b" strokeDasharray="4 4" />
                  <ReferenceLine y={10}  stroke="#f59e0b" strokeDasharray="3 3" strokeOpacity={0.6} />
                  <ReferenceLine y={-10} stroke="#f59e0b" strokeDasharray="3 3" strokeOpacity={0.6} />
                  <ReferenceLine y={25}  stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.5} />
                  <ReferenceLine y={-25} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.5} />
                  <RechartsTooltip contentStyle={TS} formatter={(v:number,n:string) => [`$${v?.toFixed(2)}/MWh`, n]} />
                  <Legend wrapperStyle={{ fontSize:11 }} />
                  <Line type="monotone" dataKey="basisA" stroke="#3b82f6" dot={false} name={nodeA} isAnimationActive={false} strokeWidth={2} connectNulls={false} />
                  <Line type="monotone" dataKey="basisB" stroke="#f59e0b" dot={false} name={nodeB} isAnimationActive={false} strokeWidth={2} connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
