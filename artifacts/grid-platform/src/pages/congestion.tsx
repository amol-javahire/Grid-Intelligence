import { useState, useMemo } from "react";
import {
  useListErcotNodalStats,
  useListErcotNodeStats,
  useListCaisoNodeStats,
} from "@workspace/api-client-react";
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
const YEARS = [2024, 2025, 2026];

const C = {
  teal:"#14b8a6", amber:"#f59e0b", purple:"#8b5cf6", red:"#ef4444",
  green:"#22c55e", blue:"#3b82f6", orange:"#f97316",
  border:"#1e2d3e", mutedFg:"#64748b",
  tooltipBg:"#0f172a", tooltipBorder:"#1e293b", tooltipFg:"#f8fafc",
};
const TS = { backgroundColor:C.tooltipBg, borderColor:C.tooltipBorder, color:C.tooltipFg };

// ── ERCOT settlement point metadata ────────────────────────────────────────────
const ERCOT_NODE_TYPE: Record<string, string> = {
  "BES_DALLAS":"bus", "BES_HOUSTON_N":"bus", "BES_HOUSTON_S":"bus",
  "HB_HOUSTON":"hub", "HB_NORTH":"hub", "HB_SOUTH":"hub", "HB_WEST":"hub",
  "HB_BUSAVG":"hub", "HB_HUBAVG":"hub", "HB_PAN":"hub",
  "LZ_HOUSTON":"zone", "LZ_NORTH":"zone", "LZ_SOUTH":"zone", "LZ_WEST":"zone",
  "LZ_AEN":"zone", "LZ_CPS":"zone", "LZ_LCRA":"zone", "LZ_RAYBN":"zone",
  "SUN_MIDLAND":"solar", "SUN_PERMIAN":"solar", "SUN_RIO_GRANDE":"solar",
  "WTG_ABILENE":"wind", "WTG_AMARILLO":"wind", "WTG_LUBBOCK":"wind", "WTG_ODESSA":"wind",
};

// ── CAISO node metadata ─────────────────────────────────────────────────────────
const CAISO_NODE_TYPE: Record<string, string> = {
  NP15: "zone", SP15: "zone", ZP26: "zone",
};
const CAISO_NODE_LABEL: Record<string, string> = {
  NP15: "NP15 (N. California)", SP15: "SP15 (S. California)", ZP26: "ZP26 (Central Valley)",
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
  { value: "2026-6",  label: "Jun 2026" },
  { value: "2026-4",  label: "Apr 2026" },
  { value: "2025-12", label: "Dec 2025" },
  { value: "2025-6",  label: "Jun 2025" },
  { value: "2024-12", label: "Dec 2024" },
];

// ── ISO Toggle ──────────────────────────────────────────────────────────────────
function IsoToggle({ value, onChange }: { value: "ERCOT" | "CAISO"; onChange: (v: "ERCOT" | "CAISO") => void }) {
  return (
    <div className="flex items-center gap-1 bg-muted/30 border border-border rounded-lg p-0.5">
      {(["ERCOT", "CAISO"] as const).map(iso => (
        <button
          key={iso}
          onClick={() => onChange(iso)}
          className={`px-4 py-1.5 rounded-md text-sm font-semibold transition-colors ${
            value === iso
              ? "bg-teal-600 text-white shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {iso}
        </button>
      ))}
    </div>
  );
}

export default function CongestionAnalysis() {
  const [iso, setIso] = useState<"ERCOT" | "CAISO">("ERCOT");
  const [year, setYear] = useState(2024);
  const [selectedNode, setSelectedNode] = useState("WTG_ODESSA");
  const [selectedCaisoNode, setSelectedCaisoNode] = useState("SP15");

  // ERCOT resource node ranking
  const [rankSort, setRankSort]   = useState<SortMetric>("neg_price_percent");
  const [rankPeriod, setRankPeriod] = useState("2026-6");
  const [showTop, setShowTop]     = useState(200);

  const [rankYear, rankMonth] = rankPeriod.split("-").map(Number);

  // ── ERCOT data ────────────────────────────────────────────────────────────────
  const { data: allErcotStats=[], isLoading: ercotLoading } = useListErcotNodalStats(
    iso === "ERCOT" ? { year } : undefined
  );
  const { data: ercotNodeDetail=[] } = useListErcotNodalStats(
    iso === "ERCOT" ? { settlementPoint: selectedNode, year } : undefined
  );
  // Fetch 500 — slice to showTop client-side so limit changes don't re-fetch
  const { data: resourceNodes=[], isLoading: rankLoading } = useListErcotNodeStats(
    iso === "ERCOT" ? {
      nodeType: "resource_node",
      year: rankYear,
      month: rankMonth,
      sortBy: rankSort,
      limit: 500,
    } : undefined
  );

  // ── CAISO data ────────────────────────────────────────────────────────────────
  const { data: allCaisoStats=[], isLoading: caisoLoading } = useListCaisoNodeStats(
    iso === "CAISO" ? {} : undefined  // all nodes, all months
  );
  const caisoNodeDetail = useMemo(
    () => allCaisoStats.filter(r => r.node === selectedCaisoNode),
    [allCaisoStats, selectedCaisoNode]
  );

  const isLoading = iso === "ERCOT" ? ercotLoading : caisoLoading;

  // ── ERCOT derived data ────────────────────────────────────────────────────────
  const ercotSpreadByNode = useMemo(() => {
    const nodeMap: Record<string, { da:number[]; rt:number[] }> = {};
    for (const row of allErcotStats) {
      if (!nodeMap[row.settlementPoint]) nodeMap[row.settlementPoint] = { da:[], rt:[] };
      nodeMap[row.settlementPoint].da.push(Number(row.avgDaPrice));
      if (row.avgRtPrice != null) nodeMap[row.settlementPoint].rt.push(Number(row.avgRtPrice));
    }
    return Object.entries(nodeMap)
      .map(([node, { da, rt }]) => {
        const avgDa = da.reduce((s,v)=>s+v,0)/da.length;
        const hasRt = rt.length > 0;
        const avgRt = hasRt ? rt.reduce((s,v)=>s+v,0)/rt.length : null;
        return { node, avgDa, avgRt, hasRt, spread: hasRt ? avgDa - (avgRt ?? avgDa) : null, type: ERCOT_NODE_TYPE[node] ?? "other" };
      })
      .sort((a, b) => (b.spread ?? 0) - (a.spread ?? 0));
  }, [allErcotStats]);

  const ercotRtAvailable = useMemo(() => ercotSpreadByNode.some(n => n.hasRt), [ercotSpreadByNode]);

  const ercotHeatmap = useMemo(() => {
    const nodeMonthMap: Record<string, Record<number, number | null>> = {};
    for (const row of allErcotStats) {
      if (!nodeMonthMap[row.settlementPoint]) nodeMonthMap[row.settlementPoint] = {};
      if (row.avgRtPrice != null) {
        nodeMonthMap[row.settlementPoint][row.month] = Number(row.avgDaPrice) - Number(row.avgRtPrice);
      }
    }
    return ercotSpreadByNode
      .filter(n => nodeMonthMap[n.node])
      .map(({ node, type }) => ({
        node, type,
        months: MONTHS.map((_, i) => nodeMonthMap[node]?.[i+1] ?? null),
      }));
  }, [allErcotStats, ercotSpreadByNode]);

  const ercotDetailChart = useMemo(() =>
    [...ercotNodeDetail]
      .sort((a, b) => a.month - b.month)
      .map(r => ({
        month: MONTHS[r.month - 1],
        DA: Number(r.avgDaPrice.toFixed(2)),
        RT: r.avgRtPrice != null ? Number(Number(r.avgRtPrice).toFixed(2)) : null,
        Spread: r.avgRtPrice != null ? Number((Number(r.avgDaPrice) - Number(r.avgRtPrice)).toFixed(2)) : null,
      })),
    [ercotNodeDetail]
  );

  // ── CAISO derived data ────────────────────────────────────────────────────────
  const caisoSpreadByNode = useMemo(() => {
    const nodeMap: Record<string, { da:number[]; rt:number[] }> = {};
    for (const row of allCaisoStats) {
      if (!nodeMap[row.node]) nodeMap[row.node] = { da:[], rt:[] };
      nodeMap[row.node].da.push(Number(row.avgDaPrice));
      if (row.avgRtPrice != null) nodeMap[row.node].rt.push(Number(row.avgRtPrice));
    }
    return Object.entries(nodeMap)
      .map(([node, { da, rt }]) => {
        const avgDa = da.reduce((s,v)=>s+v,0)/da.length;
        const avgRt = rt.length ? rt.reduce((s,v)=>s+v,0)/rt.length : avgDa;
        return { node, avgDa, avgRt, spread: avgDa - avgRt, type: CAISO_NODE_TYPE[node] ?? "zone" };
      })
      .sort((a, b) => b.spread - a.spread);
  }, [allCaisoStats]);

  const caisoHeatmap = useMemo(() => {
    // Group by node → month, across all years (show latest-year month if multiple)
    const nodeMonthMap: Record<string, Record<number, number>> = {};
    for (const row of allCaisoStats) {
      if (!nodeMonthMap[row.node]) nodeMonthMap[row.node] = {};
      const da = Number(row.avgDaPrice);
      const rt = row.avgRtPrice != null ? Number(row.avgRtPrice) : da;
      // For same month across years, average them
      const existing = nodeMonthMap[row.node][row.month];
      nodeMonthMap[row.node][row.month] = existing !== undefined
        ? (existing + (da - rt)) / 2
        : da - rt;
    }
    return caisoSpreadByNode.map(({ node, type }) => ({
      node, type,
      months: MONTHS.map((_, i) => nodeMonthMap[node]?.[i+1] ?? null),
    }));
  }, [allCaisoStats, caisoSpreadByNode]);

  const caisoDetailChart = useMemo(() =>
    [...caisoNodeDetail]
      .sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month)
      .map(r => ({
        month: `${MONTHS[r.month - 1]} ${r.year}`,
        DA: Number(Number(r.avgDaPrice).toFixed(2)),
        RT: r.avgRtPrice != null ? Number(Number(r.avgRtPrice).toFixed(2)) : null,
        Spread: r.avgRtPrice != null
          ? Number((Number(r.avgDaPrice) - Number(r.avgRtPrice)).toFixed(2))
          : null,
      })),
    [caisoNodeDetail]
  );

  // ── Summary stats for ERCOT resource nodes ─────────────────────────────────────
  const rankSummary = useMemo(() => {
    if (!resourceNodes.length) return null;
    const negPcts = resourceNodes.map(r => Number(r.negPricePercent ?? 0));
    const vols    = resourceNodes.map(r => Number(r.volatility ?? 0));
    return {
      total: resourceNodes.length,
      avgNegPct: negPcts.reduce((s,v)=>s+v,0)/negPcts.length,
      avgVol: vols.reduce((s,v)=>s+v,0)/vols.length,
      highCurtailment: resourceNodes.filter(r => Number(r.negPricePercent ?? 0) > 10).length,
    };
  }, [resourceNodes]);

  // ── Active spread/heatmap/detail data based on ISO ────────────────────────────
  const spreadByNode   = iso === "ERCOT" ? ercotSpreadByNode   : caisoSpreadByNode;
  const heatmap        = iso === "ERCOT" ? ercotHeatmap        : caisoHeatmap;
  const detailChart    = iso === "ERCOT" ? ercotDetailChart    : caisoDetailChart;
  const activeNode     = iso === "ERCOT" ? selectedNode        : selectedCaisoNode;
  const setActiveNode  = iso === "ERCOT"
    ? setSelectedNode
    : (n: string) => setSelectedCaisoNode(n);

  return (
    <div className="p-8 h-full overflow-auto space-y-6">

      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Congestion Analysis</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {iso === "ERCOT"
              ? "ERCOT DA–RT basis spread by settlement point — transmission congestion and generation curtailment proxy."
              : "CAISO DA–RT basis spread — NP15, SP15, ZP26 pricing zones. Real OASIS data."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <IsoToggle value={iso} onChange={v => {
            setIso(v);
            if (v === "CAISO") setSelectedCaisoNode("SP15");
          }} />
          {iso === "ERCOT" && (
            <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
              <SelectTrigger className="w-[90px]"><SelectValue /></SelectTrigger>
              <SelectContent>{YEARS.map(y => <SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
            </Select>
          )}
        </div>
      </div>

      {/* Node type legend */}
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        {Object.entries(NODE_TYPE_LABEL).map(([k,v]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: NODE_TYPE_COLOR[k] }} />
            {v}
          </span>
        ))}
        <span className="ml-auto italic">Positive spread = DA &gt; RT (curtailment / congestion).</span>
      </div>

      {/* DA-only notice when RT prices haven't been seeded */}
      {iso === "ERCOT" && !ercotLoading && allErcotStats.length > 0 && !ercotRtAvailable && (
        <div className="flex items-start gap-2 text-xs bg-amber-950/20 border border-amber-800/30 rounded-md px-3 py-2.5">
          <span className="text-amber-400 font-semibold shrink-0">⚠ DA prices only —</span>
          <span className="text-muted-foreground">Real-time (RT) prices are still loading in this environment. DA–RT spread will appear once the RT seed job completes. Heatmap cells will fill in automatically on next load.</span>
        </div>
      )}

      {/* ── Spread bar chart ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            {iso === "ERCOT"
              ? `Annual Avg DA–RT Spread Ranking · ${year}`
              : "All-Period Avg DA–RT Spread · CAISO Pricing Zones"}
          </CardTitle>
          <CardDescription className="text-xs">
            {iso === "ERCOT"
              ? "17 ERCOT settlement points — sorted by congestion severity"
              : "NP15 / SP15 / ZP26 — averaged across Jan 2024–May 2026"}
          </CardDescription>
        </CardHeader>
        <CardContent style={{ height: 310 }}>
          {isLoading ? (
            <div className="h-full flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
          ) : !spreadByNode.length ? (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm">No data</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={spreadByNode} layout="vertical"
                margin={{ top:4, right:60, left: iso === "CAISO" ? 160 : 120, bottom:4 }}
                onClick={e => e?.activePayload?.[0]?.payload && setActiveNode(e.activePayload[0].payload.node)}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
                <XAxis type="number" stroke={C.mutedFg} tick={{ fill:C.mutedFg, fontSize:11 }} tickFormatter={v=>`$${v.toFixed(1)}`} />
                <YAxis
                  dataKey="node" type="category" stroke={C.mutedFg} width={iso === "CAISO" ? 155 : 115}
                  tickFormatter={(v: string) => iso === "CAISO" ? (CAISO_NODE_LABEL[v] ?? v) : v}
                  tick={{ fill:C.mutedFg, fontSize:11, fontFamily:"monospace" }}
                />
                <RechartsTooltip contentStyle={TS} formatter={(v: number, _: string, p: {payload:{node:string;avgDa:number;avgRt:number|null;hasRt:boolean}}) => [
                  p.payload.hasRt
                    ? `$${v.toFixed(2)}/MWh  (DA $${p.payload.avgDa.toFixed(2)} · RT $${p.payload.avgRt?.toFixed(2) ?? "—"})`
                    : `DA $${p.payload.avgDa.toFixed(2)}/MWh (RT not yet loaded)`,
                  "DA–RT Spread"
                ]} />
                <ReferenceLine x={0} stroke={C.border} />
                <Bar dataKey="spread" name="DA–RT Spread" radius={[0,4,4,0]} cursor="pointer">
                  {spreadByNode.map((entry, i) => (
                    <Cell key={i}
                      fill={entry.node === activeNode ? "#ffffff" : (NODE_TYPE_COLOR[entry.type] ?? C.mutedFg)}
                      opacity={entry.node === activeNode ? 1 : 0.8}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* ── Node detail + heatmap row ── */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
        <Card className="xl:col-span-2">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <CardTitle className="text-sm">Node Detail — DA vs RT</CardTitle>
                <CardDescription className="text-xs">
                  {iso === "ERCOT" ? `Monthly prices and basis spread · ${year}` : "All months · Jan 2024 – May 2026"}
                </CardDescription>
              </div>
              <Select value={activeNode} onValueChange={setActiveNode}>
                <SelectTrigger className="w-[180px] h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {spreadByNode.map(n => (
                    <SelectItem key={n.node} value={n.node} className="text-xs font-mono">
                      {iso === "CAISO" ? (CAISO_NODE_LABEL[n.node] ?? n.node) : n.node}
                    </SelectItem>
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
                  <XAxis dataKey="month" stroke={C.mutedFg} tick={{ fill:C.mutedFg, fontSize:10 }} interval={iso === "CAISO" ? 3 : 0} />
                  <YAxis stroke={C.mutedFg} tick={{ fill:C.mutedFg, fontSize:11 }} tickFormatter={v=>`$${v}`} width={46} />
                  <RechartsTooltip contentStyle={TS} formatter={(v:number,name:string)=>[`$${v}/MWh`,name]} />
                  <ReferenceLine y={0} stroke={C.border} strokeDasharray="2 2" />
                  <Legend formatter={v=><span style={{ color:C.tooltipFg, fontSize:11 }}>{v}</span>} />
                  <Area isAnimationActive={false} type="monotone" dataKey="DA" stroke={C.teal} strokeWidth={2} fill="none" dot={{ r:2, fill:C.teal }} />
                  <Area isAnimationActive={false} type="monotone" dataKey="RT" stroke={C.amber} strokeWidth={2} fill="none" dot={{ r:2, fill:C.amber }} strokeDasharray="5 3" />
                  <Area isAnimationActive={false} type="monotone" dataKey="Spread" stroke={C.red} strokeWidth={1.5} fill="url(#spreadGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="xl:col-span-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              DA–RT Spread Heatmap{iso === "ERCOT" ? ` · ${year} ($/MWh)` : " · All-Period Monthly Avg ($/MWh)"}
            </CardTitle>
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
                      <th className="text-left font-mono text-muted-foreground pr-3 pb-2 w-36">Node</th>
                      {MONTHS.map(m => (
                        <th key={m} className="text-center font-normal text-muted-foreground pb-2 min-w-[34px]">{m}</th>
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
                          className={`cursor-pointer transition-opacity ${activeNode === row.node ? "opacity-100 ring-1 ring-primary" : "opacity-80 hover:opacity-100"}`}
                          onClick={() => setActiveNode(row.node)}
                        >
                          <td className="font-mono pr-3 py-1 text-xs" style={{ color: NODE_TYPE_COLOR[row.type] ?? C.mutedFg }}>
                            {iso === "CAISO" ? (CAISO_NODE_LABEL[row.node] ?? row.node) : row.node}
                          </td>
                          {row.months.map((spread, i) => (
                            <td key={i} className="text-center py-1 rounded-sm"
                              style={{
                                backgroundColor: spread !== null ? spreadColor(spread) : "transparent",
                                color: spread !== null ? spreadTextColor(spread) : C.mutedFg,
                                fontWeight: spread !== null && spread > 5 ? 600 : 400,
                              }}
                            >
                              {spread !== null ? spread.toFixed(1) : "—"}
                            </td>
                          ))}
                          <td className="text-center py-1 pl-2 font-semibold" style={{ color: avg !== null ? spreadTextColor(avg) : C.mutedFg }}>
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

      {/* ── Spread KPI summary ── */}
      {!isLoading && spreadByNode.length > 0 && (() => {
        const kpis = iso === "ERCOT" ? [
          { label: "Most Congested",        value: spreadByNode[0].node,                      sub: `$${(spreadByNode[0].spread??0).toFixed(2)}/MWh spread`,      color: C.red },
          { label: "Least Congested",       value: spreadByNode[spreadByNode.length-1].node,  sub: `$${(spreadByNode[spreadByNode.length-1].spread??0).toFixed(2)}/MWh spread`, color: C.green },
          { label: "Avg Wind Curtailment",  value: `$${(spreadByNode.filter(r=>r.type==="wind").reduce((s,r)=>s+(r.spread??0),0)/Math.max(1,spreadByNode.filter(r=>r.type==="wind").length)).toFixed(2)}/MWh`,  sub: `${spreadByNode.filter(r=>r.type==="wind").length} wind nodes`,  color: C.amber },
          { label: "Avg Solar Curtailment", value: `$${(spreadByNode.filter(r=>r.type==="solar").reduce((s,r)=>s+(r.spread??0),0)/Math.max(1,spreadByNode.filter(r=>r.type==="solar").length)).toFixed(2)}/MWh`, sub: `${spreadByNode.filter(r=>r.type==="solar").length} solar nodes`, color: C.orange },
        ] : [
          { label: "Highest Spread", value: spreadByNode[0].node,                     sub: `$${(spreadByNode[0].spread??0).toFixed(2)}/MWh avg DA–RT`,                                        color: C.red },
          { label: "Lowest Spread",  value: spreadByNode[spreadByNode.length-1].node, sub: `$${(spreadByNode[spreadByNode.length-1].spread??0).toFixed(2)}/MWh avg DA–RT`,                     color: C.green },
          { label: "NP15 Avg DA",    value: `$${caisoSpreadByNode.find(n=>n.node==="NP15")?.avgDa.toFixed(2) ?? "—"}/MWh`, sub: "N. California hub", color: C.teal },
          { label: "SP15 Avg DA",    value: `$${caisoSpreadByNode.find(n=>n.node==="SP15")?.avgDa.toFixed(2) ?? "—"}/MWh`, sub: "S. California hub", color: C.purple },
        ];
        return (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {kpis.map(kpi => (
              <Card key={kpi.label}>
                <CardContent className="pt-4 pb-3">
                  <div className="text-base font-bold font-mono" style={{ color: kpi.color }}>{kpi.value}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{kpi.sub}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{kpi.label}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        );
      })()}

      {/* ── ERCOT Resource Node Risk Ranking ── */}
      {iso === "ERCOT" && (
        <>
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-2 border-t border-border">
            <div>
              <h2 className="text-lg font-semibold">Resource Node Risk Ranking</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                ~1,108 ERCOT settlement points · real RT data from CDR 12301 bundle · ranked by basis risk signal
              </p>
            </div>
            <div className="flex gap-2 flex-wrap items-center">
              <Select value={rankPeriod} onValueChange={setRankPeriod}>
                <SelectTrigger className="h-7 w-[110px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{RANK_MONTHS.map(m => <SelectItem key={m.value} value={m.value} className="text-xs">{m.label}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={String(showTop)} onValueChange={v => setShowTop(Number(v))}>
                <SelectTrigger className="h-7 w-[100px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[100, 200, 500].map(n => (
                    <SelectItem key={n} value={String(n)} className="text-xs">Top {n}</SelectItem>
                  ))}
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
                {opt.icon}{opt.label}
              </button>
            ))}
          </div>

          {/* Summary KPIs */}
          {rankSummary && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Card><CardContent className="pt-4 pb-3">
                <div className="text-xl font-bold" style={{ color: C.red }}>{rankSummary.total}</div>
                <div className="text-xs text-muted-foreground mt-0.5">Total resource nodes</div>
              </CardContent></Card>
              <Card><CardContent className="pt-4 pb-3">
                <div className="text-xl font-bold" style={{ color: negPctColor(rankSummary.avgNegPct) }}>
                  {rankSummary.avgNegPct.toFixed(1)}%
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">Avg negative-price hours</div>
              </CardContent></Card>
              <Card><CardContent className="pt-4 pb-3">
                <div className="text-xl font-bold" style={{ color: volColor(rankSummary.avgVol) }}>
                  ${rankSummary.avgVol.toFixed(1)}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">Avg RT volatility (σ)</div>
              </CardContent></Card>
              <Card><CardContent className="pt-4 pb-3">
                <div className="text-xl font-bold font-mono" style={{ color: C.orange }}>
                  {rankSummary.highCurtailment}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">Nodes &gt;10% neg-price hrs</div>
              </CardContent></Card>
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
                        const vol    = Number(row.volatility ?? 0);
                        const minP   = Number(row.minPrice ?? 0);
                        const maxP   = Number(row.maxPrice ?? 0);
                        const range  = maxP - minP;
                        const avgRt  = Number(row.avgRtPrice ?? 0);
                        const onPeak = Number(row.onPeakAvg ?? 0);
                        const offPeak= Number(row.offPeakAvg ?? 0);
                        return (
                          <tr key={row.node} className="border-b border-border/40 hover:bg-white/5 transition-colors">
                            <td className="pr-2 py-1.5 text-muted-foreground">{i + 1}</td>
                            <td className="pr-4 py-1.5 font-mono font-medium truncate max-w-[200px]">{row.node}</td>
                            <td className="text-right pr-4 py-1.5" style={{ color: negPctColor(negPct) }}>
                              {negPct.toFixed(1)}%
                            </td>
                            <td className="text-right pr-4 py-1.5" style={{ color: volColor(vol) }}>
                              ${vol.toFixed(2)}
                            </td>
                            <td
                              className="text-right pr-4 py-1.5 text-muted-foreground"
                              title={`Max: $${maxP.toFixed(2)} · Min: $${minP.toFixed(2)}`}
                            >
                              ${range.toFixed(2)}
                            </td>
                            <td className="text-right pr-4 py-1.5 font-medium">
                              ${avgRt.toFixed(2)}
                            </td>
                            <td className="text-right pr-4 py-1.5 text-muted-foreground">
                              ${onPeak.toFixed(2)}
                            </td>
                            <td className="text-right py-1.5 text-muted-foreground">
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
        </>
      )}

      {/* ── CAISO context note ── */}
      {iso === "CAISO" && !isLoading && (
        <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">CAISO note:</span> CAISO publishes aggregate DA/RT prices for
          3 trading hub pricing nodes (NP15, SP15, ZP26) via public OASIS API. Individual resource-node settlement
          data equivalent to ERCOT CDR 12301 is not publicly available for CAISO. For granular CAISO nodal basis
          analysis, see the <strong>Nodal Analysis</strong> tab and the CAISO node locations map layer.
        </div>
      )}
    </div>
  );
}
