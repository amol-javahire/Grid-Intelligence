import { useState, useMemo } from "react";
import {
  useListErcotNodeStats,
  useListErcotNodalStats,
  useListCaisoNodeStats,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, Legend, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { Loader2 } from "lucide-react";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const YEARS = [2022, 2023, 2024, 2025, 2026];

const ERCOT_ZONES = ["LZ_HOUSTON","LZ_NORTH","LZ_SOUTH","LZ_WEST"];
const ERCOT_HUBS  = ["HB_HOUSTON","HB_NORTH","HB_SOUTH","HB_WEST"];
const ERCOT_NODES = [
  "BES_DALLAS","BES_HOUSTON_N","BES_HOUSTON_S",
  "HB_HOUSTON","HB_NORTH","HB_WEST",
  "LZ_HOUSTON","LZ_NORTH","LZ_SOUTH","LZ_WEST",
  "SUN_MIDLAND","SUN_PERMIAN","SUN_RIO_GRANDE",
  "WTG_ABILENE","WTG_AMARILLO","WTG_LUBBOCK","WTG_ODESSA",
];
const CAISO_ZONES = ["NP15","SP15","ZP26"];
const CAISO_LABELS: Record<string,string> = { NP15:"NP15 (North)", SP15:"SP15 (South)", ZP26:"ZP26 (Central)" };

const C = {
  teal:"#14b8a6", amber:"#f59e0b", purple:"#8b5cf6", red:"#ef4444",
  green:"#22c55e", blue:"#3b82f6",
  border:"#1e2d3e", mutedFg:"#64748b",
  tooltipBg:"#0f172a", tooltipBorder:"#1e293b", tooltipFg:"#f8fafc",
};
const TS = { backgroundColor:C.tooltipBg, borderColor:C.tooltipBorder, color:C.tooltipFg };

type PriceType = "DA" | "RT" | "DA-RT";

// ── Helpers ──────────────────────────────────────────────────────────────────
function getPrice(row: { avgDaPrice?: number; avgRtPrice?: number | null }, type: "DA" | "RT"): number | null {
  if (type === "DA") return row.avgDaPrice ?? null;
  return row.avgRtPrice ?? null;
}

function buildPairChart(
  aData: { month: number; avgDaPrice: number; avgRtPrice?: number | null }[],
  bData: { month: number; avgDaPrice: number; avgRtPrice?: number | null }[],
  priceType: PriceType,
  labelA: string,
  labelB: string,
) {
  return MONTHS.map((m, i) => {
    const month = i + 1;
    const a = aData.find(r => r.month === month);
    const b = bData.find(r => r.month === month);
    if (priceType === "DA-RT") {
      return {
        month: m,
        [`${labelA} DA`]: a ? Number(a.avgDaPrice.toFixed(2)) : null,
        [`${labelA} RT`]: a?.avgRtPrice != null ? Number(a.avgRtPrice.toFixed(2)) : null,
      };
    }
    return {
      month: m,
      [labelA]: a ? Number(getPrice(a, priceType)?.toFixed(2)) : null,
      [labelB]: b ? Number(getPrice(b, priceType)?.toFixed(2)) : null,
    };
  }).filter(r => Object.values(r).some((v, i) => i > 0 && v !== null));
}

// ── Subcomponents ─────────────────────────────────────────────────────────────
function PairNodeChart({
  title, description, data, keys, colors, loading,
}: {
  title: string; description: string;
  data: Record<string,unknown>[]; keys: string[]; colors: string[];
  loading: boolean;
}) {
  if (loading) return (
    <div className="h-full flex items-center justify-center">
      <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
    </div>
  );
  if (!data.length) return (
    <div className="h-full flex items-center justify-center text-muted-foreground text-sm">No data for this period</div>
  );
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-2">{description}</p>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 4, right: 24, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
          <XAxis dataKey="month" stroke={C.mutedFg} tick={{ fill:C.mutedFg, fontSize:11 }} />
          <YAxis stroke={C.mutedFg} tick={{ fill:C.mutedFg, fontSize:11 }} tickFormatter={v=>`$${v}`} width={52} />
          <RechartsTooltip contentStyle={TS} formatter={(v:number,name:string)=>[`$${v}/MWh`,name]} />
          <ReferenceLine y={0} stroke={C.border} strokeDasharray="2 2" />
          <Legend formatter={v=><span style={{color:C.tooltipFg,fontSize:11}}>{v}</span>} />
          {keys.map((k,i)=>(
            <Line key={k} isAnimationActive={false} type="monotone" dataKey={k}
              stroke={colors[i]} strokeWidth={2}
              dot={{ r:3, fill:colors[i] }}
              strokeDasharray={i===1 ? "5 3" : undefined}
              connectNulls={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ── ERCOT Zone Comparison ─────────────────────────────────────────────────────
function ZoneCompare({ year, priceType }: { year:number; priceType:PriceType }) {
  const [zoneA, setZoneA] = useState("LZ_NORTH");
  const [zoneB, setZoneB] = useState("LZ_HOUSTON");
  const isDaRt = priceType === "DA-RT";

  const { data: aData=[], isLoading: la } = useListErcotNodeStats({ node: zoneA, year });
  const { data: bData=[], isLoading: lb } = useListErcotNodeStats({ node: isDaRt ? zoneA : zoneB, year });

  const chartData = useMemo(() => {
    if (!aData.length) return [];
    const bSrc = isDaRt ? aData : bData;
    return buildPairChart(aData, bSrc, priceType, zoneA, zoneB);
  }, [aData, bData, zoneA, zoneB, priceType, isDaRt]);

  const keys = isDaRt ? [`${zoneA} DA`, `${zoneA} RT`] : [zoneA, zoneB];
  const colors = [C.teal, C.amber];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm font-semibold">Zone Comparison</CardTitle>
          <div className="flex gap-2">
            <Select value={zoneA} onValueChange={setZoneA}>
              <SelectTrigger className="w-[130px] h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{ERCOT_ZONES.map(z=><SelectItem key={z} value={z} className="text-xs">{z}</SelectItem>)}</SelectContent>
            </Select>
            {!isDaRt && (
              <Select value={zoneB} onValueChange={setZoneB}>
                <SelectTrigger className="w-[130px] h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{ERCOT_ZONES.map(z=><SelectItem key={z} value={z} className="text-xs">{z}</SelectItem>)}</SelectContent>
              </Select>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <PairNodeChart
          title="Zone" description=""
          data={chartData} keys={keys} colors={colors}
          loading={la || lb}
        />
      </CardContent>
    </Card>
  );
}

// ── ERCOT Hub Comparison ──────────────────────────────────────────────────────
function HubCompare({ year, priceType }: { year:number; priceType:PriceType }) {
  const [hubA, setHubA] = useState("HB_NORTH");
  const [hubB, setHubB] = useState("HB_HOUSTON");
  const isDaRt = priceType === "DA-RT";

  const { data: aData=[], isLoading: la } = useListErcotNodeStats({ node: hubA, year });
  const { data: bData=[], isLoading: lb } = useListErcotNodeStats({ node: isDaRt ? hubA : hubB, year });

  const chartData = useMemo(() => {
    if (!aData.length) return [];
    const bSrc = isDaRt ? aData : bData;
    return buildPairChart(aData, bSrc, priceType, hubA, hubB);
  }, [aData, bData, hubA, hubB, priceType, isDaRt]);

  const keys = isDaRt ? [`${hubA} DA`, `${hubA} RT`] : [hubA, hubB];
  const colors = [C.purple, C.blue];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm font-semibold">Hub Comparison</CardTitle>
          <div className="flex gap-2">
            <Select value={hubA} onValueChange={setHubA}>
              <SelectTrigger className="w-[130px] h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{ERCOT_HUBS.map(h=><SelectItem key={h} value={h} className="text-xs">{h}</SelectItem>)}</SelectContent>
            </Select>
            {!isDaRt && (
              <Select value={hubB} onValueChange={setHubB}>
                <SelectTrigger className="w-[130px] h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{ERCOT_HUBS.map(h=><SelectItem key={h} value={h} className="text-xs">{h}</SelectItem>)}</SelectContent>
              </Select>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <PairNodeChart
          title="Hub" description=""
          data={chartData} keys={keys} colors={colors}
          loading={la || lb}
        />
      </CardContent>
    </Card>
  );
}

// ── ERCOT Node Comparison ─────────────────────────────────────────────────────
function NodeCompare({ year, priceType }: { year:number; priceType:PriceType }) {
  const [nodeA, setNodeA] = useState("SUN_PERMIAN");
  const [nodeB, setNodeB] = useState("WTG_AMARILLO");
  const isDaRt = priceType === "DA-RT";

  const { data: aData=[], isLoading: la } = useListErcotNodalStats({ settlementPoint: nodeA, year });
  const { data: bData=[], isLoading: lb } = useListErcotNodalStats({ settlementPoint: isDaRt ? nodeA : nodeB, year });

  const chartData = useMemo(() => {
    if (!aData.length) return [];
    const bSrc = isDaRt ? aData : bData;
    return buildPairChart(
      aData.map(r => ({ ...r, avgRtPrice: r.avgRtPrice })),
      bSrc.map(r => ({ ...r, avgRtPrice: r.avgRtPrice })),
      priceType, nodeA, nodeB,
    );
  }, [aData, bData, nodeA, nodeB, priceType, isDaRt]);

  const keys = isDaRt ? [`${nodeA} DA`, `${nodeA} RT`] : [nodeA, nodeB];
  const colors = [C.amber, C.red];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm font-semibold">Node Comparison</CardTitle>
          <div className="flex gap-2">
            <Select value={nodeA} onValueChange={setNodeA}>
              <SelectTrigger className="w-[150px] h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{ERCOT_NODES.map(n=><SelectItem key={n} value={n} className="text-xs">{n}</SelectItem>)}</SelectContent>
            </Select>
            {!isDaRt && (
              <Select value={nodeB} onValueChange={setNodeB}>
                <SelectTrigger className="w-[150px] h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{ERCOT_NODES.map(n=><SelectItem key={n} value={n} className="text-xs">{n}</SelectItem>)}</SelectContent>
              </Select>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <PairNodeChart
          title="Node" description=""
          data={chartData} keys={keys} colors={colors}
          loading={la || lb}
        />
      </CardContent>
    </Card>
  );
}

// ── CAISO Zone Comparison ─────────────────────────────────────────────────────
function CaisoCompare({ year }: { year:number }) {
  const [zoneA, setZoneA] = useState<"NP15"|"SP15"|"ZP26">("NP15");
  const [zoneB, setZoneB] = useState<"NP15"|"SP15"|"ZP26">("SP15");
  const [priceType, setPriceType] = useState<"DA"|"RT">("DA");

  const { data: aData=[], isLoading: la } = useListCaisoNodeStats({ node: zoneA, year });
  const { data: bData=[], isLoading: lb } = useListCaisoNodeStats({ node: zoneB, year });

  const chartData = useMemo(() => {
    if (!aData.length) return [];
    return MONTHS.map((m, i) => {
      const month = i + 1;
      const a = aData.find(r => r.month === month);
      const b = bData.find(r => r.month === month);
      const av = priceType === "DA" ? a?.avgDaPrice : a?.avgRtPrice;
      const bv = priceType === "DA" ? b?.avgDaPrice : b?.avgRtPrice;
      return { month: m, [zoneA]: av != null ? Number(av.toFixed(2)) : null, [zoneB]: bv != null ? Number(bv.toFixed(2)) : null };
    }).filter(r => r[zoneA] !== null || r[zoneB] !== null);
  }, [aData, bData, zoneA, zoneB, priceType]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="text-base">CAISO Zone Comparison</CardTitle>
            <CardDescription className="text-xs mt-0.5">{priceType === "DA" ? "Day-Ahead" : "Real-Time"} LMP · {year}</CardDescription>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Select value={zoneA} onValueChange={v=>setZoneA(v as typeof zoneA)}>
              <SelectTrigger className="w-[150px] h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{CAISO_ZONES.map(z=><SelectItem key={z} value={z} className="text-xs">{CAISO_LABELS[z]}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={zoneB} onValueChange={v=>setZoneB(v as typeof zoneB)}>
              <SelectTrigger className="w-[150px] h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{CAISO_ZONES.map(z=><SelectItem key={z} value={z} className="text-xs">{CAISO_LABELS[z]}</SelectItem>)}</SelectContent>
            </Select>
            <div className="flex rounded-md overflow-hidden border border-border">
              {(["DA","RT"] as const).map(pt=>(
                <button key={pt} onClick={()=>setPriceType(pt)}
                  className={`px-3 py-1 text-xs font-medium transition-colors ${priceType===pt?"bg-primary text-primary-foreground":"text-muted-foreground hover:text-foreground"}`}
                >{pt}</button>
              ))}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <PairNodeChart
          title="CAISO" description=""
          data={chartData} keys={[zoneA, zoneB]} colors={[C.teal, C.amber]}
          loading={la || lb}
        />
      </CardContent>
    </Card>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function NodalAnalysis() {
  const [iso, setIso] = useState<"ERCOT"|"CAISO">("ERCOT");
  const [year, setYear] = useState<number>(2025);
  const [priceType, setPriceType] = useState<PriceType>("DA");

  return (
    <div className="p-8 h-full overflow-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Nodal Analysis</h1>
          <p className="text-muted-foreground">LMP spread analysis — compare zones, hubs, and settlement points across ISOs.</p>
        </div>

        {/* ISO toggle */}
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg overflow-hidden border border-border">
            {(["ERCOT","CAISO"] as const).map(i=>(
              <button key={i} onClick={()=>setIso(i)}
                className={`px-5 py-2 text-sm font-semibold transition-colors ${iso===i ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >{i}</button>
            ))}
          </div>
        </div>
      </div>

      {/* ERCOT Section */}
      {iso === "ERCOT" && (
        <>
          {/* ERCOT controls */}
          <div className="flex flex-wrap gap-3 items-center">
            <span className="text-sm font-medium text-muted-foreground">Year:</span>
            <Select value={String(year)} onValueChange={v=>setYear(Number(v))}>
              <SelectTrigger className="w-[100px]"><SelectValue /></SelectTrigger>
              <SelectContent>{YEARS.map(y=><SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
            </Select>

            <span className="text-sm font-medium text-muted-foreground ml-2">Price:</span>
            <div className="flex rounded-md overflow-hidden border border-border">
              {(["DA","RT","DA-RT"] as const).map(pt=>(
                <button key={pt} onClick={()=>setPriceType(pt)}
                  className={`px-4 py-1.5 text-sm font-medium transition-colors ${priceType===pt ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >{pt}</button>
              ))}
            </div>

            {priceType === "DA-RT" && (
              <span className="text-xs text-muted-foreground italic">Single node selected — shows DA vs RT for that node</span>
            )}
          </div>

          {/* Three comparison cards */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <ZoneCompare year={year} priceType={priceType} />
            <HubCompare  year={year} priceType={priceType} />
            <NodeCompare year={year} priceType={priceType} />
          </div>

          {/* Spread summary table */}
          <SpreadSummary year={year} />
        </>
      )}

      {/* CAISO Section */}
      {iso === "CAISO" && (
        <>
          <div className="flex flex-wrap gap-3 items-center">
            <span className="text-sm font-medium text-muted-foreground">Year:</span>
            <Select value={String(year)} onValueChange={v=>setYear(Number(v))}>
              <SelectTrigger className="w-[100px]"><SelectValue /></SelectTrigger>
              <SelectContent>{YEARS.map(y=><SelectItem key={y} value={String(y)}>{y}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <CaisoCompare year={year} />
        </>
      )}
    </div>
  );
}

// ── Spread Summary (annual avg per zone, sorted) ──────────────────────────────
function SpreadSummary({ year }: { year:number }) {
  const { data: north=[],  isLoading: l1 } = useListErcotNodeStats({ node:"LZ_NORTH",   year });
  const { data: south=[],  isLoading: l2 } = useListErcotNodeStats({ node:"LZ_SOUTH",   year });
  const { data: houston=[], isLoading: l3 } = useListErcotNodeStats({ node:"LZ_HOUSTON", year });
  const { data: west=[],   isLoading: l4 } = useListErcotNodeStats({ node:"LZ_WEST",    year });
  const { data: hnorth=[], isLoading: l5 } = useListErcotNodeStats({ node:"HB_NORTH",   year });
  const { data: hhous=[],  isLoading: l6 } = useListErcotNodeStats({ node:"HB_HOUSTON", year });
  const { data: hwest=[],  isLoading: l7 } = useListErcotNodeStats({ node:"HB_WEST",    year });
  const { data: hsouth=[], isLoading: l8 } = useListErcotNodeStats({ node:"HB_SOUTH",   year });

  const loading = l1||l2||l3||l4||l5||l6||l7||l8;

  const avgRow = (rows: typeof north, label: string) => {
    if (!rows.length) return null;
    const da = rows.reduce((s,r)=>s+Number(r.avgDaPrice),0)/rows.length;
    const rt = rows.filter(r=>r.avgRtPrice).reduce((s,r)=>s+Number(r.avgRtPrice),0)/Math.max(1,rows.filter(r=>r.avgRtPrice).length);
    const spread = da - rt;
    return { label, da, rt, spread };
  };

  const tableRows = [
    avgRow(north, "LZ_NORTH"), avgRow(south, "LZ_SOUTH"),
    avgRow(houston, "LZ_HOUSTON"), avgRow(west, "LZ_WEST"),
    avgRow(hnorth, "HB_NORTH"), avgRow(hhous, "HB_HOUSTON"),
    avgRow(hwest, "HB_WEST"), avgRow(hsouth, "HB_SOUTH"),
  ].filter(Boolean).sort((a,b)=>(b!.spread - a!.spread));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">DA–RT Spread Summary — {year} Annual Avg</CardTitle>
        <CardDescription className="text-xs">Positive spread = DA &gt; RT (typical in ERCOT); high spread indicates congestion or curtailment</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="h-16 flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {tableRows.map(r=>(
              <div key={r!.label} className="rounded-md border border-border p-3 bg-background">
                <div className="font-mono text-xs font-semibold">{r!.label}</div>
                <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                  <span>DA <span className="text-foreground font-medium">${r!.da.toFixed(2)}</span></span>
                  <span>RT <span className="text-foreground font-medium">${r!.rt.toFixed(2)}</span></span>
                </div>
                <div className="mt-1 text-xs font-semibold" style={{ color: r!.spread > 3 ? C.amber : r!.spread > 1 ? C.teal : C.mutedFg }}>
                  Spread ${r!.spread.toFixed(2)}/MWh
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
