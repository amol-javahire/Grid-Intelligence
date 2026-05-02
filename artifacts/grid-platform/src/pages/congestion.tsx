import { useState, useMemo } from "react";
import { useListErcotNodalStats } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, ResponsiveContainer, Cell,
  LineChart, Line, Legend, ReferenceLine, AreaChart, Area,
} from "recharts";
import { Loader2 } from "lucide-react";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const YEARS = [2023, 2024, 2025, 2026];

const C = {
  teal:"#14b8a6", amber:"#f59e0b", purple:"#8b5cf6", red:"#ef4444",
  green:"#22c55e", blue:"#3b82f6", orange:"#f97316",
  border:"#1e2d3e", mutedFg:"#64748b",
  tooltipBg:"#0f172a", tooltipBorder:"#1e293b", tooltipFg:"#f8fafc",
};
const TS = { backgroundColor:C.tooltipBg, borderColor:C.tooltipBorder, color:C.tooltipFg };

// Node type classification
const NODE_TYPE: Record<string, string> = {
  "BES_DALLAS":"bus", "BES_HOUSTON_N":"bus", "BES_HOUSTON_S":"bus",
  "HB_HOUSTON":"hub", "HB_NORTH":"hub", "HB_WEST":"hub",
  "LZ_HOUSTON":"zone", "LZ_NORTH":"zone", "LZ_SOUTH":"zone", "LZ_WEST":"zone",
  "SUN_MIDLAND":"solar", "SUN_PERMIAN":"solar", "SUN_RIO_GRANDE":"solar",
  "WTG_ABILENE":"wind", "WTG_AMARILLO":"wind", "WTG_LUBBOCK":"wind", "WTG_ODESSA":"wind",
};

const NODE_TYPE_COLOR: Record<string, string> = {
  hub: C.purple, zone: C.teal, bus: C.blue, solar: C.amber, wind: C.green,
};
const NODE_TYPE_LABEL: Record<string, string> = {
  hub:"Hub", zone:"Load Zone", bus:"Bus Node", solar:"Solar Gen", wind:"Wind Gen",
};

// Heatmap cell color based on spread value
function spreadColor(spread: number): string {
  if (spread <= 0) return "rgba(34,197,94,0.25)";   // negative/zero = green (RT > DA)
  if (spread < 2)  return "rgba(20,184,166,0.22)";  // tiny spread = teal
  if (spread < 4)  return "rgba(245,158,11,0.28)";  // small = amber
  if (spread < 7)  return "rgba(249,115,22,0.38)";  // moderate = orange
  if (spread < 12) return "rgba(239,68,68,0.48)";   // high = red
  return "rgba(239,68,68,0.75)";                     // extreme = bright red
}
function spreadTextColor(spread: number): string {
  if (spread < 4) return C.mutedFg;
  if (spread < 7) return C.orange;
  return C.red;
}

export default function CongestionAnalysis() {
  const [year, setYear] = useState(2025);
  const [selectedNode, setSelectedNode] = useState("WTG_ODESSA");

  // Fetch all settlement point data for the year in one call
  const { data: allStats=[], isLoading } = useListErcotNodalStats({ year });
  // Fetch selected node full year for detail chart
  const { data: nodeDetail=[] } = useListErcotNodalStats({ settlementPoint: selectedNode, year });

  // Compute annual avg DA-RT spread per node
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

  // Monthly spread heatmap data: node → month → spread
  const heatmap = useMemo(() => {
    const nodeMonthMap: Record<string, Record<number, number>> = {};
    for (const row of allStats) {
      if (!nodeMonthMap[row.settlementPoint]) nodeMonthMap[row.settlementPoint] = {};
      const da = Number(row.avgDaPrice);
      const rt = row.avgRtPrice != null ? Number(row.avgRtPrice) : da;
      nodeMonthMap[row.settlementPoint][row.month] = da - rt;
    }
    // Sort nodes by annual avg spread descending
    const orderedNodes = spreadByNode.map(r => r.node);
    return orderedNodes
      .filter(n => nodeMonthMap[n])
      .map(node => ({
        node,
        type: NODE_TYPE[node] ?? "other",
        months: MONTHS.map((_, i) => nodeMonthMap[node]?.[i+1] ?? null),
      }));
  }, [allStats, spreadByNode]);

  // Detail chart for selected node
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

  const maxSpread = spreadByNode[0]?.spread ?? 10;

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
        {/* Node Detail */}
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

        {/* Heatmap */}
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
    </div>
  );
}
