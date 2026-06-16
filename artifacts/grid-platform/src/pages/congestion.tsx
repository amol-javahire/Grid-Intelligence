import { useState, useMemo } from "react";
import { useListErcotNodalStats, useListErcotNodeStats } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer, Cell,
  ReferenceLine, AreaChart, Area, Legend,
} from "recharts";
import { Loader2, TrendingDown, Zap, Activity, ArrowUpDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const YEARS = [2023, 2024, 2025, 2026];

const C = {
  teal:"#14b8a6", amber:"#f59e0b", purple:"#8b5cf6", red:"#ef4444",
  green:"#22c55e", blue:"#3b82f6", orange:"#f97316",
  border:"#1e2d3e", mutedFg:"#64748b",
  tooltipBg:"#0f172a", tooltipBorder:"#1e293b", tooltipFg:"#f8fafc",
};
const TS = { backgroundColor:C.tooltipBg, borderColor:C.tooltipBorder, color:C.tooltipFg };

const NODE_TYPE: Record<string, string> = {
  "BES_DALLAS":"bus", "BES_HOUSTON_N":"bus", "BES_HOUSTON_S":"bus",
  "HB_HOUSTON":"hub", "HB_NORTH":"hub", "HB_SOUTH":"hub", "HB_WEST":"hub",
  "HB_BUSAVG":"hub", "HB_HUBAVG":"hub", "HB_PAN":"hub",
  "LZ_HOUSTON":"zone", "LZ_NORTH":"zone", "LZ_SOUTH":"zone", "LZ_WEST":"zone",
  "LZ_AEN":"zone", "LZ_CPS":"zone", "LZ_LCRA":"zone", "LZ_RAYBN":"zone",
  "SUN_MIDLAND":"solar", "SUN_PERMIAN":"solar", "SUN_RIO_GRANDE":"solar",
  "WTG_ABILENE":"wind", "WTG_AMARILLO":"wind", "WTG_LUBBOCK":"wind", "WTG_ODESSA":"wind",
};

const NODE_TYPE_COLOR: Record<string, string> = {
  hub: C.purple, zone: C.teal, bus: C.blue, solar: C.amber, wind: C.green,
};
const NODE_TYPE_LABEL: Record<string, string> = {
  hub:"Hub", zone:"Load Zone", bus:"Bus Node", solar:"Solar Gen", wind:"Wind Gen",
};

function spreadColor(spread: number): string {
  if (spread <= 0) return "rgba(34,197,94,0.25)";
  if (spread < 2)  return "rgba(20,184,166,0.22)";
  if (spread < 4)  return "rgba(245,158,11,0.28)";
  if (spread < 7)  return "rgba(249,115,22,0.38)";
  if (spread < 12) return "rgba(239,68,68,0.48)";
  return "rgba(239,68,68,0.75)";
}
function spreadTextColor(spread: number): string {
  if (spread < 4) return C.mutedFg;
  if (spread < 7) return C.orange;
  return C.red;
}

function negPctColor(pct: number): string {
  if (pct === 0) return C.teal;
  if (pct < 5) return C.green;
  if (pct < 15) return C.amber;
  if (pct < 25) return C.orange;
  return C.red;
}

function volColor(vol: number): string {
  if (vol < 10) return C.teal;
  if (vol < 30) return C.amber;
  if (vol < 60) return C.orange;
  return C.red;
}

type SortMetric = "neg_price_percent" | "volatility" | "price_range" | "avg_rt_price";

const SORT_OPTIONS: { value: SortMetric; label: string; icon: React.ReactNode; desc: string }[] = [
  { value: "neg_price_percent", label: "Curtailment Risk", icon: <TrendingDown className="h-3.5 w-3.5" />, desc: "% hours with negative RT prices" },
  { value: "volatility",        label: "Price Volatility",  icon: <Activity className="h-3.5 w-3.5" />, desc: "RT price std deviation ($/MWh)" },
  { value: "price_range",       label: "Price Range",       icon: <ArrowUpDown className="h-3.5 w-3.5" />, desc: "Max − Min RT price ($/MWh)" },
  { value: "avg_rt_price",      label: "Avg RT Price",      icon: <Zap className="h-3.5 w-3.5" />, desc: "Average RT settlement price ($/MWh)" },
];

const RANK_MONTHS: { value: string; label: string }[] = [
  { value: "2024-12", label: "Dec 2024" },
  { value: "2025-6",  label: "Jun 2025" },
  { value: "2025-12", label: "Dec 2025" },
  { value: "2026-4",  label: "Apr 2026" },
];

export default function CongestionAnalysis() {
  const [year, setYear] = useState(2024);
  const [selectedNode, setSelectedNode] = useState("WTG_ODESSA");

  // Resource node ranking state
  const [rankSort, setRankSort] = useState<SortMetric>("neg_price_percent");
  const [rankPeriod, setRankPeriod] = useState("2024-12");
  const [showTop, setShowTop] = useState(50);

  const [rankYear, rankMonth] = rankPeriod.split("-").map(Number);

  const { data: allStats=[], isLoading } = useListErcotNodalStats({ year });
  const { data: nodeDetail=[] } = useListErcotNodalStats({ settlementPoint: selectedNode, year });

  // Resource node ranking — uses real CDR 12301 data
  const { data: resourceNodes=[], isLoading: rankLoading } = useListErcotNodeStats({
    nodeType: "resource_node",
    year: rankYear,
    month: rankMonth,
    sortBy: rankSort,
    limit: 200,
  });

  const spreadByNode = useMemo(() => {
    const nodeMap: Record<string, { da:number[]; rt:number[] }> = {};
    for (const row of allStats) {
      if (!nodeMap[row.settlementPoint]) nodeMap[row.settlementPoint] = { da:[], rt:[] };
      nodeMap[row.settlementPoint].da.push(Number(row.avgDaPrice));
      if (row.avgRtPrice != null) nodeMap[row.settlementPoint].rt.push(Number(row.avgRtPrice));
    }
    return Object.entries(nodeMap)
      .map(([node, { da, rt }]) => {
        const avgDa = da.reduce((s,v)=>s+v,0)/da.length;
        const avgRt = rt.length ? rt.reduce((s,v)=>s+v,0)/rt.length : avgDa;
        const spread = avgDa - avgRt;
        return { node, avgDa, avgRt, spread, type: NODE_TYPE[node] ?? "other" };
      })
      .sort((a, b) => b.spread - a.spread);
  }, [allStats]);

  const heatmap = useMemo(() => {
    const nodeMonthMap: Record<string, Record<number, number>> = {};
    for (const row of allStats) {
      if (!nodeMonthMap[row.settlementPoint]) nodeMonthMap[row.settlementPoint] = {};
      const da = Number(row.avgDaPrice);
      const rt = row.avgRtPrice != null ? Number(row.avgRtPrice) : da;
      nodeMonthMap[row.settlementPoint][row.month] = da - rt;
    }
    const orderedNodes = spreadByNode.map(r => r.node);
    return orderedNodes
      .filter(n => nodeMonthMap[n])
      .map(node => ({
        node,
        type: NODE_TYPE[node] ?? "other",
        months: MONTHS.map((_, i) => nodeMonthMap[node]?.[i+1] ?? null),
      }));
  }, [allStats, spreadByNode]);

  const detailChart = useMemo(() =>
    nodeDetail
      .sort((a, b) => a.month - b.month)
      .map(r => ({
        month: MONTHS[r.month - 1],
        DA: Number(r.avgDaPrice.toFixed(2)),
        RT: r.avgRtPrice != null ? Number(Number(r.avgRtPrice).toFixed(2)) : null,
        Spread: r.avgRtPrice != null ? Number((Number(r.avgDaPrice) - Number(r.avgRtPrice)).toFixed(2)) : null,
      })),
    [nodeDetail]
  );

  // Summary stats for resource nodes
  const rankSummary = useMemo(() => {
    if (!resourceNodes.length) return null;
    const negPcts = resourceNodes.map(r => Number(r.negPricePercent ?? 0));
    const vols = resourceNodes.map(r => Number(r.volatility ?? 0));
    const highCurtailment = resourceNodes.filter(r => Number(r.negPricePercent ?? 0) > 10).length;
    return {
      total: resourceNodes.length,
      avgNegPct: negPcts.reduce((s,v)=>s+v,0)/negPcts.length,
      avgVol: vols.reduce((s,v)=>s+v,0)/vols.length,
      highCurtailment,
      top: resourceNodes[0],
    };
  }, [resourceNodes]);

  return (
    <div className="p-8 h-full overflow-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Congestion Analysis</h1>
          <p className="text-muted-foreground">
            ERCOT DA–RT basis spread by settlement point — a proxy for transmission congestion and generation curtailment.
          </p>
        </div>
        <Select value={String(year)} onValueChange={v=>setYear(Number(v))}>
          <SelectTrigger className="w-[100px]"><SelectValue /></SelectTrigger>
          <SelectContent>{YEARS.map(y=><SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {/* Explainer strip */}
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        {Object.entries(NODE_TYPE_LABEL).map(([k,v])=>(
          <span key={k} className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{backgroundColor:NODE_TYPE_COLOR[k]}}/>
            {v}
          </span>
        ))}
        <span className="ml-auto italic">Positive spread = DA &gt; RT (curtailment / congestion). High spread → unfavorable for generators at that node.</span>
      </div>

      {/* Spread Ranking Bar Chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Annual Avg DA–RT Spread Ranking · {year}</CardTitle>
          <CardDescription className="text-xs">Sorted by congestion severity — higher spread = more constrained node</CardDescription>
        </CardHeader>
        <CardContent style={{ height: 310 }}>
          {isLoading ? (
            <div className="h-full flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
          ) : !spreadByNode.length ? (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm">No data for {year}</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={spreadByNode} layout="vertical" margin={{ top:4, right:60, left:120, bottom:4 }}
                onClick={e => e?.activePayload?.[0]?.payload && setSelectedNode(e.activePayload[0].payload.node)}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
                <XAxis type="number" stroke={C.mutedFg} tick={{ fill:C.mutedFg, fontSize:11 }} tickFormatter={v=>`$${v.toFixed(1)}`} />
                <YAxis dataKey="node" type="category" stroke={C.mutedFg} width={115} tick={{ fill:C.mutedFg, fontSize:11, fontFamily:"monospace" }} />
                <RechartsTooltip contentStyle={TS} formatter={(v:number,_:string, p:{payload:{node:string;avgDa:number;avgRt:number}}) => [
                  `$${v.toFixed(2)}/MWh  (DA $${p.payload.avgDa.toFixed(2)} · RT $${p.payload.avgRt.toFixed(2)})`, "DA–RT Spread"
                ]} />
                <ReferenceLine x={0} stroke={C.border} />
                <Bar dataKey="spread" name="DA–RT Spread" radius={[0, 4, 4, 0]} cursor="pointer">
                  {spreadByNode.map((entry, i) => (
                    <Cell key={i}
                      fill={entry.node === selectedNode ? "#ffffff" : (NODE_TYPE_COLOR[entry.type] ?? C.mutedFg)}
                      opacity={entry.node === selectedNode ? 1 : 0.8}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Node Detail + Heatmap row */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
        <Card className="xl:col-span-2">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <CardTitle className="text-sm">Node Detail — DA vs RT</CardTitle>
                <CardDescription className="text-xs">Monthly prices and basis spread · {year}</CardDescription>
              </div>
              <Select value={selectedNode} onValueChange={setSelectedNode}>
                <SelectTrigger className="w-[160px] h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {spreadByNode.map(n=>(
                    <SelectItem key={n.node} value={n.node} className="text-xs font-mono">{n.node}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent style={{ height: 300 }}>
            {detailChart.length === 0 ? (
              <div className="h-full flex items-center justify-center text-muted-foreground text-sm">Select a node</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={detailChart} margin={{ top:8, right:16, left:4, bottom:4 }}>
                  <defs>
                    <linearGradient id="spreadGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={C.red} stopOpacity={0.3}/>
                      <stop offset="95%" stopColor={C.red} stopOpacity={0.02}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis dataKey="month" stroke={C.mutedFg} tick={{ fill:C.mutedFg, fontSize:11 }} />
                  <YAxis stroke={C.mutedFg} tick={{ fill:C.mutedFg, fontSize:11 }} tickFormatter={v=>`$${v}`} width={46} />
                  <RechartsTooltip contentStyle={TS} formatter={(v:number,name:string)=>[`$${v}/MWh`,name]} />
                  <ReferenceLine y={0} stroke={C.border} strokeDasharray="2 2" />
                  <Legend formatter={v=><span style={{color:C.tooltipFg,fontSize:11}}>{v}</span>} />
                  <Area isAnimationActive={false} type="monotone" dataKey="DA" stroke={C.teal} strokeWidth={2} fill="none" dot={{ r:3, fill:C.teal }} />
                  <Area isAnimationActive={false} type="monotone" dataKey="RT" stroke={C.amber} strokeWidth={2} fill="none" dot={{ r:3, fill:C.amber }} strokeDasharray="5 3" />
                  <Area isAnimationActive={false} type="monotone" dataKey="Spread" stroke={C.red} strokeWidth={1.5} fill="url(#spreadGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="xl:col-span-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">DA–RT Spread Heatmap · {year} ($/MWh)</CardTitle>
            <CardDescription className="text-xs">Darker red = higher spread = more congested/curtailed</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="h-40 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr>
                      <th className="text-left font-mono text-muted-foreground pr-3 pb-2 w-32">Node</th>
                      {MONTHS.map(m=>(
                        <th key={m} className="text-center font-normal text-muted-foreground pb-2 min-w-[36px]">{m}</th>
                      ))}
                      <th className="text-center font-normal text-muted-foreground pb-2 pl-2">Avg</th>
                    </tr>
                  </thead>
                  <tbody>
                    {heatmap.map(row => {
                      const validSpreads = row.months.filter((v): v is number => v !== null);
                      const avg = validSpreads.length ? validSpreads.reduce((s,v)=>s+v,0)/validSpreads.length : null;
                      return (
                        <tr
                          key={row.node}
                          className={`cursor-pointer transition-opacity ${selectedNode === row.node ? "opacity-100 ring-1 ring-primary" : "opacity-80 hover:opacity-100"}`}
                          onClick={()=>setSelectedNode(row.node)}
                        >
                          <td className="font-mono pr-3 py-1 text-xs" style={{ color: NODE_TYPE_COLOR[row.type] ?? C.mutedFg }}>
                            {row.node}
                          </td>
                          {row.months.map((spread, i) => (
                            <td
                              key={i}
                              className="text-center py-1 rounded-sm"
                              style={{
                                backgroundColor: spread !== null ? spreadColor(spread) : "transparent",
                                color: spread !== null ? spreadTextColor(spread) : C.mutedFg,
                                fontWeight: spread !== null && spread > 5 ? 600 : 400,
                              }}
                            >
                              {spread !== null ? spread.toFixed(1) : "—"}
                            </td>
                          ))}
                          <td
                            className="text-center py-1 pl-2 font-semibold"
                            style={{ color: avg !== null ? spreadTextColor(avg) : C.mutedFg }}
                          >
                            {avg !== null ? avg.toFixed(1) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Spread stats summary */}
      {!isLoading && spreadByNode.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: "Most Congested", value: spreadByNode[0].node, sub: `$${spreadByNode[0].spread.toFixed(2)}/MWh spread`, color: C.red },
            { label: "Least Congested", value: spreadByNode[spreadByNode.length-1].node, sub: `$${spreadByNode[spreadByNode.length-1].spread.toFixed(2)}/MWh spread`, color: C.green },
            { label: "Avg Wind Curtailment", value: `$${(spreadByNode.filter(r=>r.type==="wind").reduce((s,r)=>s+r.spread,0)/Math.max(1,spreadByNode.filter(r=>r.type==="wind").length)).toFixed(2)}/MWh`, sub: `${spreadByNode.filter(r=>r.type==="wind").length} wind nodes`, color: C.amber },
            { label: "Avg Solar Curtailment", value: `$${(spreadByNode.filter(r=>r.type==="solar").reduce((s,r)=>s+r.spread,0)/Math.max(1,spreadByNode.filter(r=>r.type==="solar").length)).toFixed(2)}/MWh`, sub: `${spreadByNode.filter(r=>r.type==="solar").length} solar nodes`, color: C.orange },
          ].map(kpi => (
            <Card key={kpi.label}>
              <CardContent className="pt-4 pb-3">
                <div className="text-base font-bold font-mono" style={{ color: kpi.color }}>{kpi.value}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{kpi.sub}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{kpi.label}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ── RESOURCE NODE RANKING ─────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-2 border-t border-border">
        <div>
          <h2 className="text-lg font-semibold">Resource Node Risk Ranking</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            804 ERCOT settlement points · real RT data from CDR Report 12301 · ranked by basis risk signal
          </p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <Select value={rankPeriod} onValueChange={setRankPeriod}>
            <SelectTrigger className="h-7 w-[110px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{RANK_MONTHS.map(m=><SelectItem key={m.value} value={m.value} className="text-xs">{m.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={String(showTop)} onValueChange={v=>setShowTop(Number(v))}>
            <SelectTrigger className="h-7 w-[90px] text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[25,50,100,200].map(n=><SelectItem key={n} value={String(n)} className="text-xs">Top {n}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Sort metric tabs */}
      <div className="flex gap-2 flex-wrap">
        {SORT_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => setRankSort(opt.value)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors border ${
              rankSort === opt.value
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground"
            }`}
          >
            {opt.icon}
            {opt.label}
          </button>
        ))}
      </div>

      {/* Summary KPIs */}
      {rankSummary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-xl font-bold" style={{ color: C.red }}>{rankSummary.total}</div>
              <div className="text-xs text-muted-foreground mt-0.5">Total resource nodes</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-xl font-bold" style={{ color: negPctColor(rankSummary.avgNegPct) }}>
                {rankSummary.avgNegPct.toFixed(1)}%
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">Avg negative-price hours</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-xl font-bold" style={{ color: volColor(rankSummary.avgVol) }}>
                ${rankSummary.avgVol.toFixed(1)}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">Avg RT volatility (σ)</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-xl font-bold font-mono" style={{ color: C.orange }}>
                {rankSummary.highCurtailment}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">Nodes with &gt;10% neg-price hrs</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Ranking Table */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="text-sm">
                {SORT_OPTIONS.find(o=>o.value===rankSort)?.label} Ranking ·{" "}
                {RANK_MONTHS.find(m=>m.value===rankPeriod)?.label}
              </CardTitle>
              <CardDescription className="text-xs">
                {SORT_OPTIONS.find(o=>o.value===rankSort)?.desc} · showing top {showTop} of {resourceNodes.length} nodes
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-xs font-mono text-teal-400 border-teal-400/30">
              CDR 12301 · Real Data
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {rankLoading ? (
            <div className="h-40 flex items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : resourceNodes.length === 0 ? (
            <div className="h-40 flex items-center justify-center text-muted-foreground text-sm">
              No resource node data for this period
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-muted-foreground pb-2 pr-2 w-6">#</th>
                    <th className="text-left text-muted-foreground pb-2 pr-4 font-mono">Node</th>
                    <th className="text-right text-muted-foreground pb-2 pr-4">
                      <span title="% hours with negative RT price">Neg-Price %</span>
                    </th>
                    <th className="text-right text-muted-foreground pb-2 pr-4">
                      <span title="RT price standard deviation">Volatility σ</span>
                    </th>
                    <th className="text-right text-muted-foreground pb-2 pr-4">
                      <span title="Max - Min RT price">Price Range</span>
                    </th>
                    <th className="text-right text-muted-foreground pb-2 pr-4">Avg RT</th>
                    <th className="text-right text-muted-foreground pb-2 pr-4">On-Peak</th>
                    <th className="text-right text-muted-foreground pb-2">Off-Peak</th>
                  </tr>
                </thead>
                <tbody>
                  {resourceNodes.slice(0, showTop).map((row, i) => {
                    const negPct = Number(row.negPricePercent ?? 0);
                    const vol = Number(row.volatility ?? 0);
                    const minP = Number(row.minPrice ?? 0);
                    const maxP = Number(row.maxPrice ?? 0);
                    const range = maxP - minP;
                    const avgRt = Number(row.avgRtPrice ?? 0);
                    const onPeak = Number(row.onPeakAvg ?? 0);
                    const offPeak = Number(row.offPeakAvg ?? 0);
                    return (
                      <tr key={row.node} className="border-b border-border/40 hover:bg-white/5 transition-colors">
                        <td className="py-1.5 pr-2 text-muted-foreground">{i+1}</td>
                        <td className="py-1.5 pr-4 font-mono font-medium" style={{ color: C.teal }}>
                          {row.node}
                        </td>
                        <td className="py-1.5 pr-4 text-right font-semibold"
                            style={{ color: negPctColor(negPct) }}>
                          {negPct.toFixed(1)}%
                        </td>
                        <td className="py-1.5 pr-4 text-right"
                            style={{ color: volColor(vol) }}>
                          ${vol.toFixed(1)}
                        </td>
                        <td className="py-1.5 pr-4 text-right text-muted-foreground">
                          ${range.toFixed(0)}
                          <span className="text-muted-foreground/50 text-[10px] ml-1">
                            ({minP.toFixed(0)}→{maxP.toFixed(0)})
                          </span>
                        </td>
                        <td className="py-1.5 pr-4 text-right text-foreground">
                          ${avgRt.toFixed(2)}
                        </td>
                        <td className="py-1.5 pr-4 text-right" style={{ color: C.amber }}>
                          ${onPeak.toFixed(2)}
                        </td>
                        <td className="py-1.5 text-right" style={{ color: C.blue }}>
                          ${offPeak.toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
