import { useState, useMemo, useEffect, useRef } from "react";
import {
  useListErcotNodeStats,
  useListCaisoNodeStats,
  useGetErcotBusShiftFactors,
  useGetErcotBusLoad,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, Legend, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { Loader2, Search, MapPin, Database } from "lucide-react";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const YEARS = [2026, 2025, 2024];

const ERCOT_ZONES = ["LZ_HOUSTON","LZ_NORTH","LZ_SOUTH","LZ_WEST","LZ_AEN","LZ_CPS","LZ_LCRA","LZ_RAYBN"];
const ERCOT_HUBS  = ["HB_HOUSTON","HB_NORTH","HB_SOUTH","HB_WEST","HB_BUSAVG","HB_HUBAVG","HB_PAN"];
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

// ── Searchable node picker ────────────────────────────────────────────────────
function NodePicker({ value, onChange, nodes, loading, placeholder = "Select node…" }: {
  value: string; onChange: (v: string) => void;
  nodes: string[]; loading: boolean; placeholder?: string;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    if (!search.trim()) return nodes;
    const q = search.toLowerCase();
    return nodes.filter(n => n.toLowerCase().includes(q));
  }, [nodes, search]);

  return (
    <Select value={value} onValueChange={v => { onChange(v); setSearch(""); }}>
      <SelectTrigger className="w-[190px] h-7 text-xs font-mono">
        {loading && !value
          ? <Loader2 className="h-3 w-3 animate-spin" />
          : value && nodes.length === 0
            ? <span className="truncate">{value}</span>
            : <SelectValue placeholder={placeholder} />
        }
      </SelectTrigger>
      <SelectContent className="max-h-72">
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border sticky top-0 bg-popover z-10">
          <Search className="h-3 w-3 text-muted-foreground shrink-0" />
          <input
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            placeholder="Search nodes…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => e.stopPropagation()}
          />
        </div>
        {filtered.length === 0 ? (
          <div className="text-xs text-muted-foreground px-3 py-2">No matches</div>
        ) : (
          filtered.slice(0, 200).map(n => (
            <SelectItem key={n} value={n} className="text-xs font-mono">{n}</SelectItem>
          ))
        )}
        {filtered.length > 200 && (
          <div className="text-xs text-muted-foreground px-3 py-1.5">
            {filtered.length - 200} more — refine search
          </div>
        )}
      </SelectContent>
    </Select>
  );
}

// ── ERCOT Node Comparison ─────────────────────────────────────────────────────
function NodeCompare({ year, priceType }: { year:number; priceType:PriceType }) {
  const [nodeA, setNodeA] = useState("7RNCHSLR_ALL");
  const [nodeB, setNodeB] = useState("ABINDUST_RN");
  const isDaRt = priceType === "DA-RT";

  // Fetch real resource node list from API (804 nodes from CDR 12301)
  const [nodeList, setNodeList] = useState<string[]>([]);
  const [nodeListLoading, setNodeListLoading] = useState(false);
  const nodeFetched = useRef(false);
  useEffect(() => {
    if (nodeFetched.current) return;
    nodeFetched.current = true;
    setNodeListLoading(true);
    fetch("/api/ercot-settlement-points")
      .then(r => r.json())
      .then((data: unknown) => {
        if (Array.isArray(data)) setNodeList(data as string[]);
        setNodeListLoading(false);
      })
      .catch(() => setNodeListLoading(false));
  }, []);

  const { data: aData=[], isLoading: la } = useListErcotNodeStats({ node: nodeA, year });
  const { data: bData=[], isLoading: lb } = useListErcotNodeStats({ node: isDaRt ? nodeA : nodeB, year });

  const chartData = useMemo(() => {
    if (!aData.length) return [];
    const bSrc = isDaRt ? aData : bData;
    return buildPairChart(aData, bSrc, priceType, nodeA, nodeB);
  }, [aData, bData, nodeA, nodeB, priceType, isDaRt]);

  const keys = isDaRt ? [`${nodeA} DA`, `${nodeA} RT`] : [nodeA, nodeB];
  const colors = [C.amber, C.red];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold">Node Comparison</CardTitle>
            {nodeList.length > 0 ? (
              <span className="text-xs text-muted-foreground">{nodeList.length.toLocaleString()} real nodes · CDR 12301</span>
            ) : null}
          </div>
          <div className="flex gap-2 flex-wrap">
            <NodePicker value={nodeA} onChange={setNodeA} nodes={nodeList} loading={nodeListLoading} />
            {!isDaRt && (
              <NodePicker value={nodeB} onChange={setNodeB} nodes={nodeList} loading={nodeListLoading} />
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <PairNodeChart
          title="Node" description="RT settlement prices · recent data (Apr–May 2026). Select year 2026."
          data={chartData} keys={keys} colors={colors}
          loading={la || lb}
        />
      </CardContent>
    </Card>
  );
}

// ── CAISO Zone Comparison ─────────────────────────────────────────────────────
function CaisoZoneCompare({ year, priceType }: { year:number; priceType:"DA"|"RT" }) {
  const [zoneA, setZoneA] = useState<"NP15"|"SP15"|"ZP26">("NP15");
  const [zoneB, setZoneB] = useState<"NP15"|"SP15"|"ZP26">("SP15");

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
      return { month: m, [zoneA]: av != null ? Number(Number(av).toFixed(2)) : null, [zoneB]: bv != null ? Number(Number(bv).toFixed(2)) : null };
    }).filter(r => r[zoneA] !== null || r[zoneB] !== null);
  }, [aData, bData, zoneA, zoneB, priceType]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm font-semibold">Zone Comparison</CardTitle>
          <div className="flex gap-2 flex-wrap">
            <Select value={zoneA} onValueChange={v=>setZoneA(v as typeof zoneA)}>
              <SelectTrigger className="w-[130px] h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{CAISO_ZONES.map(z=><SelectItem key={z} value={z} className="text-xs">{CAISO_LABELS[z]}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={zoneB} onValueChange={v=>setZoneB(v as typeof zoneB)}>
              <SelectTrigger className="w-[130px] h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>{CAISO_ZONES.map(z=><SelectItem key={z} value={z} className="text-xs">{CAISO_LABELS[z]}</SelectItem>)}</SelectContent>
            </Select>
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

// ── CAISO Node Comparison (resource nodes) ────────────────────────────────────
function CaisoNodeCompare({ year, priceType }: { year:number; priceType:"DA"|"RT"|"DA-RT" }) {
  const [nodeA, setNodeA] = useState("TEHACHAPI_WIND_1");
  const [nodeB, setNodeB] = useState("DESERT_SUNLIGHT_1");
  const isDaRt = priceType === "DA-RT";

  const [nodeList, setNodeList] = useState<string[]>([]);
  const [nodeListLoading, setNodeListLoading] = useState(false);
  const fetched = useRef(false);
  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    setNodeListLoading(true);
    fetch("/api/caiso-settlement-points")
      .then(r => r.json())
      .then((data: unknown) => {
        if (Array.isArray(data)) setNodeList(data as string[]);
        setNodeListLoading(false);
      })
      .catch(() => setNodeListLoading(false));
  }, []);

  const { data: aData=[], isLoading: la } = useListCaisoNodeStats({ node: nodeA as "NP15"|"SP15"|"ZP26", year });
  const { data: bData=[], isLoading: lb } = useListCaisoNodeStats({ node: (isDaRt ? nodeA : nodeB) as "NP15"|"SP15"|"ZP26", year });

  const chartData = useMemo(() => {
    if (!aData.length) return [];
    const bSrc = isDaRt ? aData : bData;
    return buildPairChart(aData, bSrc, priceType, nodeA, nodeB);
  }, [aData, bData, nodeA, nodeB, priceType, isDaRt]);

  const keys = isDaRt ? [`${nodeA} DA`, `${nodeA} RT`] : [nodeA, nodeB];
  const colors = [C.purple, C.green];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <CardTitle className="text-sm font-semibold">Node Comparison</CardTitle>
            {nodeList.length > 0 && (
              <span className="text-xs text-muted-foreground">{nodeList.length} nodes</span>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <NodePicker value={nodeA} onChange={setNodeA} nodes={nodeList} loading={nodeListLoading} />
            {!isDaRt && (
              <NodePicker value={nodeB} onChange={setNodeB} nodes={nodeList} loading={nodeListLoading} />
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

// ── ERCOT Resource Node Browser ───────────────────────────────────────────────
type NodeLocation = {
  nodeName: string; nodeType: string; loadZone: string | null; hub: string | null;
  substation: string | null; latitude: number | null; longitude: number | null;
  locationSource: string; eiaPlantName: string | null;
  avgDaPrice: number | null; avgRtPrice: number | null; monthsAvailable: number;
};

const ZONE_COLORS: Record<string, string> = {
  LZ_WEST: "#f59e0b", LZ_SOUTH: "#14b8a6", LZ_NORTH: "#8b5cf6", LZ_HOUSTON: "#3b82f6",
};

function NodeLocationsBrowser() {
  const [nodes, setNodes] = useState<NodeLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [zoneFilter, setZoneFilter] = useState<string>("ALL");
  const [sortBy, setSortBy] = useState<"da_price"|"node_name">("da_price");
  const fetched = useRef(false);

  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    fetch("/api/ercot-node-locations?nodeType=resource_node&limit=1000")
      .then(r => r.json())
      .then((d: unknown) => {
        if (Array.isArray(d)) setNodes(d as NodeLocation[]);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const zones = useMemo(() => {
    const zs = Array.from(new Set(nodes.map(n => n.loadZone).filter(Boolean))) as string[];
    return zs.sort();
  }, [nodes]);

  const filtered = useMemo(() => {
    let res = nodes;
    if (zoneFilter !== "ALL") res = res.filter(n => n.loadZone === zoneFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      res = res.filter(n =>
        n.nodeName.toLowerCase().includes(q) ||
        (n.substation ?? "").toLowerCase().includes(q) ||
        (n.eiaPlantName ?? "").toLowerCase().includes(q)
      );
    }
    if (sortBy === "da_price") return [...res].sort((a,b) => (b.avgDaPrice??0) - (a.avgDaPrice??0));
    return [...res].sort((a,b) => a.nodeName.localeCompare(b.nodeName));
  }, [nodes, zoneFilter, search, sortBy]);

  const stats = useMemo(() => {
    const exact = nodes.filter(n => n.locationSource === "eia_name_match").length;
    const fuzzy = nodes.filter(n => n.locationSource === "eia_fuzzy_match").length;
    const cent = nodes.filter(n => n.locationSource === "zone_centroid").length;
    return { total: nodes.length, exact, fuzzy, geo: exact + fuzzy, cent };
  }, [nodes]);

  const priceColor = (p: number | null) => {
    if (p == null) return C.mutedFg;
    if (p > 60) return "#ef4444";
    if (p > 40) return "#f59e0b";
    if (p > 25) return "#14b8a6";
    return "#64748b";
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Database className="h-4 w-4 text-teal-400" />
              ERCOT Resource Node Browser
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              {stats.total} nodes · ERCOT Bus Mapping (CDR 10008) via gridstatus ·{" "}
              <span className="text-teal-400">{stats.geo} geo-located</span>{" "}
              <span className="text-muted-foreground">({stats.exact} exact · {stats.fuzzy} fuzzy EIA match)</span> ·{" "}
              <span className="text-muted-foreground">{stats.cent} zone centroid</span> · Apr–May 2026 pricing
            </CardDescription>
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            <button onClick={()=>setSortBy(sortBy==="da_price"?"node_name":"da_price")}
              className="text-xs px-3 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors">
              Sort: {sortBy === "da_price" ? "DA Price ↓" : "Name A–Z"}
            </button>
          </div>
        </div>

        {/* Zone filter tabs */}
        <div className="flex gap-1 flex-wrap mt-2">
          {["ALL", ...zones].map(z => (
            <button key={z} onClick={() => setZoneFilter(z)}
              className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors border ${
                zoneFilter === z
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
              style={zoneFilter === z && z !== "ALL" ? { backgroundColor: ZONE_COLORS[z], borderColor: ZONE_COLORS[z] } : {}}>
              {z === "ALL" ? `All (${nodes.length})` : `${z} (${nodes.filter(n=>n.loadZone===z).length})`}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex items-center gap-1.5 mt-2 bg-muted/30 border border-border rounded-md px-2.5 py-1.5">
          <Search className="h-3 w-3 text-muted-foreground shrink-0" />
          <input
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            placeholder="Search node, substation, or EIA plant name…"
            value={search} onChange={e => setSearch(e.target.value)}
          />
          {search && <button onClick={()=>setSearch("")} className="text-muted-foreground hover:text-foreground text-xs">✕</button>}
        </div>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="h-32 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="text-xs text-muted-foreground mb-2">
              Showing {Math.min(filtered.length, 100)} of {filtered.length} nodes
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="text-left py-1.5 pr-3 font-medium">Node</th>
                    <th className="text-left py-1.5 pr-3 font-medium">Zone</th>
                    <th className="text-left py-1.5 pr-3 font-medium">Substation</th>
                    <th className="text-right py-1.5 pr-3 font-medium">DA Avg</th>
                    <th className="text-right py-1.5 pr-3 font-medium">RT Avg</th>
                    <th className="text-left py-1.5 font-medium">Location</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 100).map(n => (
                    <tr key={n.nodeName} className="border-b border-border/40 hover:bg-muted/20 transition-colors">
                      <td className="py-1.5 pr-3 font-mono text-foreground">{n.nodeName}</td>
                      <td className="py-1.5 pr-3">
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                          style={{ backgroundColor: `${ZONE_COLORS[n.loadZone??""]}22`, color: ZONE_COLORS[n.loadZone??""] ?? C.mutedFg }}>
                          {n.loadZone ?? "—"}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 text-muted-foreground font-mono">{n.substation ?? "—"}</td>
                      <td className="py-1.5 pr-3 text-right font-medium tabular-nums"
                        style={{ color: priceColor(n.avgDaPrice) }}>
                        {n.avgDaPrice != null ? `$${n.avgDaPrice.toFixed(2)}` : "—"}
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                        {n.avgRtPrice != null ? `$${n.avgRtPrice.toFixed(2)}` : "—"}
                      </td>
                      <td className="py-1.5">
                        {n.locationSource === "eia_name_match" ? (
                          <span className="flex items-center gap-1 text-teal-400">
                            <MapPin className="h-2.5 w-2.5" />
                            <span className="text-[10px]">{n.eiaPlantName ? n.eiaPlantName.slice(0, 22) : "EIA exact"}</span>
                          </span>
                        ) : n.locationSource === "eia_fuzzy_match" ? (
                          <span className="flex items-center gap-1 text-amber-400/80">
                            <MapPin className="h-2.5 w-2.5" />
                            <span className="text-[10px]">{n.eiaPlantName ? n.eiaPlantName.slice(0, 22) : "EIA fuzzy"}</span>
                          </span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">{n.loadZone} centroid</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filtered.length > 100 && (
              <div className="mt-2 text-xs text-muted-foreground text-center">
                {filtered.length - 100} more — refine search or filter by zone
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── CAISO Pricing Node Browser ────────────────────────────────────────────────
type CaisoNodeLocation = {
  nodeName: string; nodeType: string; caisoZone: string | null;
  latitude: number | null; longitude: number | null;
  locationSource: string; eiaPlantName: string | null;
  avgDaPrice: number | null; monthsAvailable: number;
};

const CAISO_ZONE_COLORS: Record<string, string> = {
  NP15: "#14b8a6", SP15: "#8b5cf6", ZP26: "#f59e0b",
};
const CAISO_ZONE_DA: Record<string, number> = { NP15: 43.86, SP15: 38.24, ZP26: 32.41 };

function CaisoNodeLocationsBrowser() {
  const [nodes, setNodes] = useState<CaisoNodeLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [zoneFilter, setZoneFilter] = useState<string>("ALL");
  const [sortBy, setSortBy] = useState<"node_name"|"zone">("node_name");
  const fetched = useRef(false);

  useEffect(() => {
    if (fetched.current) return;
    fetched.current = true;
    fetch("/api/caiso-node-locations?nodeType=resource_node&limit=2000")
      .then(r => r.json())
      .then((d: unknown) => {
        if (Array.isArray(d)) setNodes(d as CaisoNodeLocation[]);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    let res = nodes;
    if (zoneFilter !== "ALL") res = res.filter(n => n.caisoZone === zoneFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      res = res.filter(n =>
        n.nodeName.toLowerCase().includes(q) ||
        (n.eiaPlantName ?? "").toLowerCase().includes(q)
      );
    }
    if (sortBy === "zone") return [...res].sort((a,b) => (a.caisoZone??'').localeCompare(b.caisoZone??'') || a.nodeName.localeCompare(b.nodeName));
    return [...res].sort((a,b) => a.nodeName.localeCompare(b.nodeName));
  }, [nodes, zoneFilter, search, sortBy]);

  const stats = useMemo(() => ({
    total: nodes.length,
    eia: nodes.filter(n => n.locationSource === "eia_name_match").length,
    np15: nodes.filter(n => n.caisoZone === "NP15").length,
    sp15: nodes.filter(n => n.caisoZone === "SP15").length,
    zp26: nodes.filter(n => n.caisoZone === "ZP26").length,
  }), [nodes]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Database className="h-4 w-4 text-purple-400" />
              CAISO Pricing Node Browser
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              {stats.total} nodes · CAISO OASIS ATL_PNODE_MAP (public) ·{" "}
              <span className="text-teal-400">{stats.eia} EIA-geolocated</span> ·{" "}
              <span className="text-muted-foreground">{stats.total - stats.eia} zone centroid</span>
              {" "}· Zone DA: NP15 ${CAISO_ZONE_DA.NP15} · SP15 ${CAISO_ZONE_DA.SP15} · ZP26 ${CAISO_ZONE_DA.ZP26}/MWh
            </CardDescription>
          </div>
          <button onClick={()=>setSortBy(sortBy==="node_name"?"zone":"node_name")}
            className="text-xs px-3 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors self-start">
            Sort: {sortBy === "node_name" ? "Name A–Z" : "Zone"}
          </button>
        </div>

        {/* Zone tabs */}
        <div className="flex gap-1 flex-wrap mt-2">
          {[
            { key: "ALL", label: `All (${stats.total})` },
            { key: "NP15", label: `NP15 North (${stats.np15})` },
            { key: "SP15", label: `SP15 South (${stats.sp15})` },
            { key: "ZP26", label: `ZP26 Central (${stats.zp26})` },
          ].map(z => (
            <button key={z.key} onClick={() => setZoneFilter(z.key)}
              className={`text-xs px-2.5 py-1 rounded-md font-medium transition-colors border ${
                zoneFilter === z.key ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"
              }`}
              style={zoneFilter === z.key && z.key !== "ALL"
                ? { backgroundColor: CAISO_ZONE_COLORS[z.key], borderColor: CAISO_ZONE_COLORS[z.key], color: "#fff" }
                : {}}>
              {z.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex items-center gap-1.5 mt-2 bg-muted/30 border border-border rounded-md px-2.5 py-1.5">
          <Search className="h-3 w-3 text-muted-foreground shrink-0" />
          <input
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            placeholder="Search node name or EIA plant…"
            value={search} onChange={e => setSearch(e.target.value)}
          />
          {search && <button onClick={()=>setSearch("")} className="text-muted-foreground hover:text-foreground text-xs">✕</button>}
        </div>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="h-32 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="text-xs text-muted-foreground mb-2">
              Showing {Math.min(filtered.length, 150)} of {filtered.length} nodes
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="text-left py-1.5 pr-3 font-medium">Node</th>
                    <th className="text-left py-1.5 pr-3 font-medium">Zone</th>
                    <th className="text-right py-1.5 pr-3 font-medium">Zone DA</th>
                    <th className="text-left py-1.5 font-medium">Location</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 150).map(n => (
                    <tr key={n.nodeName} className="border-b border-border/40 hover:bg-muted/20 transition-colors">
                      <td className="py-1.5 pr-3 font-mono text-foreground">{n.nodeName}</td>
                      <td className="py-1.5 pr-3">
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                          style={{ backgroundColor: `${CAISO_ZONE_COLORS[n.caisoZone??""]}22`, color: CAISO_ZONE_COLORS[n.caisoZone??""] ?? C.mutedFg }}>
                          {n.caisoZone ?? "—"}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 text-right font-medium tabular-nums text-teal-400">
                        {n.caisoZone ? `$${CAISO_ZONE_DA[n.caisoZone].toFixed(2)}` : "—"}
                      </td>
                      <td className="py-1.5">
                        {n.locationSource === "eia_name_match" ? (
                          <span className="flex items-center gap-1 text-teal-400">
                            <MapPin className="h-2.5 w-2.5 shrink-0" />
                            <span className="text-[10px] truncate max-w-[180px]">{n.eiaPlantName ?? "EIA match"}</span>
                          </span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">{n.caisoZone} centroid</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filtered.length > 150 && (
              <div className="mt-2 text-xs text-muted-foreground text-center">
                {filtered.length - 150} more — refine search or filter by zone
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── ERCOT Bus Load Explorer (PTDF-derived hourly approximation) ───────────────
const EIA_ZONE_COLORS: Record<string,string> = {
  NCEN:"#14b8a6", COAS:"#3b82f6", NRTH:"#8b5cf6",
  EAST:"#22c55e", SCEN:"#f59e0b", SOUT:"#ef4444",
  FWES:"#06b6d4", WEST:"#a855f7",
};

function BusLoadExplorer({ year }: { year: number }) {
  const [search, setSearch]         = useState("");
  const [selectedBus, setSelectedBus] = useState<string | null>(null);
  const [month, setMonth]           = useState(8);

  const { data: allBuses = [], isLoading: bLoading } = useGetErcotBusShiftFactors({});

  const { data: busLoad = [], isLoading: lLoading } = useGetErcotBusLoad(
    { bus: selectedBus ?? "", year, month },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { query: { enabled: !!selectedBus } as any },
  );

  const filtered = useMemo(() => {
    if (!allBuses.length) return [];
    if (!search) return allBuses.slice(0, 40);
    const q = search.toLowerCase();
    return allBuses.filter(b =>
      b.busName.toLowerCase().includes(q) ||
      (b.eiaZone ?? "").toLowerCase().includes(q) ||
      (b.ercotZone ?? "").toLowerCase().includes(q),
    ).slice(0, 50);
  }, [allBuses, search]);

  const selectedMeta = selectedBus ? allBuses.find(b => b.busName === selectedBus) : null;

  // Average daily 24-hour load curve across all days in month
  const chartData = useMemo(() => {
    if (!busLoad.length) return [];
    const byHour: Record<number, number[]> = {};
    for (const row of busLoad) {
      if (!byHour[row.hour]) byHour[row.hour] = [];
      byHour[row.hour].push(row.loadMwApprox);
    }
    return Array.from({ length: 24 }, (_, h) => ({
      hour: `H${String(h).padStart(2,"0")}`,
      avgMw: byHour[h] ? +(busLoad.filter(r=>r.hour===h).reduce((s,r)=>s+r.loadMwApprox,0)/busLoad.filter(r=>r.hour===h).length).toFixed(2) : null,
      peakMw: byHour[h] ? +Math.max(...busLoad.filter(r=>r.hour===h).map(r=>r.loadMwApprox)).toFixed(2) : null,
    }));
  }, [busLoad]);

  const zoneColor = selectedMeta ? (EIA_ZONE_COLORS[selectedMeta.eiaZone] ?? C.teal) : C.teal;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <CardTitle className="text-sm font-semibold">Bus-Level Load Explorer</CardTitle>
            <CardDescription className="text-xs">
              Hourly load estimated via DC PTDF shift factors · 340 ERCOT 345 kV buses · EIA-930 zone baseline
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Month:</span>
            <Select value={String(month)} onValueChange={v => setMonth(Number(v))}>
              <SelectTrigger className="w-[90px] h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => (
                  <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

          {/* ── Bus selector panel ───────────────────────────────────────── */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 bg-muted/30 border border-border rounded-md px-2.5 py-1.5">
              <Search className="h-3 w-3 text-muted-foreground shrink-0" />
              <input
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                placeholder="Search bus or zone…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              {search && (
                <button onClick={() => setSearch("")} className="text-muted-foreground hover:text-foreground text-xs">✕</button>
              )}
            </div>

            {bLoading ? (
              <div className="h-16 flex items-center justify-center">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="max-h-72 overflow-y-auto rounded-md border border-border">
                {filtered.map(b => (
                  <button
                    key={b.busName}
                    onClick={() => setSelectedBus(b.busName)}
                    className={`w-full text-left px-2.5 py-2 text-xs transition-colors border-b border-border/30 last:border-0
                      ${selectedBus === b.busName
                        ? "bg-primary/15 text-primary"
                        : "hover:bg-muted/30"}`}
                  >
                    <div className="font-mono font-medium truncate">{b.busName}</div>
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className="px-1 py-0 rounded text-[9px] font-semibold"
                        style={{ backgroundColor:`${EIA_ZONE_COLORS[b.eiaZone]??C.teal}22`, color: EIA_ZONE_COLORS[b.eiaZone]??C.teal }}>
                        {b.eiaZone}
                      </span>
                      <span className="text-muted-foreground text-[10px]">SF={b.shiftFactor.toFixed(4)}</span>
                    </div>
                  </button>
                ))}
                {!search && allBuses.length > 40 && (
                  <div className="px-2.5 py-2 text-xs text-muted-foreground text-center border-t border-border">
                    +{allBuses.length - 40} more · search to filter
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Chart panel ──────────────────────────────────────────────── */}
          <div className="md:col-span-2">
            {!selectedBus ? (
              <div className="h-full min-h-[220px] flex flex-col items-center justify-center text-muted-foreground gap-2">
                <Database className="h-8 w-8 opacity-30" />
                <div className="text-sm">Select a bus to view its hourly load profile</div>
                <div className="text-xs opacity-60">340 ERCOT 345 kV buses · PTDF-weighted shift factors</div>
              </div>
            ) : lLoading ? (
              <div className="h-52 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-3">
                {selectedMeta && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { label: "Bus",          val: selectedMeta.busName },
                      { label: "EIA Zone",     val: selectedMeta.eiaZone },
                      { label: "ERCOT Zone",   val: selectedMeta.ercotZone ?? "—" },
                      { label: "Shift Factor", val: selectedMeta.shiftFactor.toFixed(5) },
                    ].map(({ label, val }) => (
                      <div key={label} className="rounded border border-border p-2 bg-background">
                        <div className="text-[10px] text-muted-foreground">{label}</div>
                        <div className="text-xs font-mono font-semibold truncate">{val}</div>
                      </div>
                    ))}
                  </div>
                )}

                <div>
                  <div className="text-xs text-muted-foreground mb-1.5">
                    Avg daily 24h load curve · {MONTHS[month - 1]} {year}
                    {" · "}
                    <span style={{ color: zoneColor }}>{selectedMeta?.eiaZone} zone baseline</span>
                    {" · "}
                    <span className="opacity-60">method: {busLoad[0]?.method ?? "ptdf"}</span>
                  </div>
                  {chartData.length ? (
                    <ResponsiveContainer width="100%" height={200}>
                      <AreaChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                        <XAxis dataKey="hour" stroke={C.mutedFg}
                          tick={{ fill: C.mutedFg, fontSize: 9 }} interval={3} />
                        <YAxis stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 9 }} width={48}
                          tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(1)}GW` : `${Math.round(v)}MW`} />
                        <RechartsTooltip contentStyle={TS}
                          formatter={(v: unknown, name: string) => {
                            const n = Number(v);
                            return [n >= 1000 ? `${(n/1000).toFixed(2)} GW` : `${n.toFixed(1)} MW`, name];
                          }} />
                        <Area type="monotone" dataKey="peakMw" stroke={C.amber} strokeWidth={1}
                          fill={`${C.amber}18`} name="Peak MW" dot={false} />
                        <Area type="monotone" dataKey="avgMw" stroke={zoneColor} strokeWidth={2}
                          fill={`${zoneColor}25`} name="Avg MW" dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-36 flex items-center justify-center text-xs text-muted-foreground">
                      No load data for this bus / period
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function NodalAnalysis() {
  const [iso, setIso] = useState<"ERCOT"|"CAISO">("ERCOT");
  const [year, setYear] = useState<number>(2024);
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

          {/* Bus-Level Load Explorer — PTDF shift factors × EIA-930 hourly zone load */}
          <BusLoadExplorer year={year} />

          {/* Resource Node Browser — 804 nodes with zones from ERCOT bus mapping */}
          <NodeLocationsBrowser />
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

            <span className="text-sm font-medium text-muted-foreground ml-2">Price:</span>
            <div className="flex rounded-md overflow-hidden border border-border">
              {(["DA","RT","DA-RT"] as const).map(pt=>(
                <button key={pt} onClick={()=>setPriceType(pt)}
                  className={`px-4 py-1.5 text-sm font-medium transition-colors ${priceType===pt ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >{pt}</button>
              ))}
            </div>

            {priceType === "DA-RT" && (
              <span className="text-xs text-muted-foreground italic">Single node selected — shows DA vs RT</span>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <CaisoZoneCompare year={year} priceType={priceType === "DA-RT" ? "DA" : priceType} />
            <CaisoNodeCompare year={year} priceType={priceType} />
          </div>

          <CaisoSpreadSummary year={year} />

          {/* CAISO Pricing Node Browser — 1,771 nodes from ATL_PNODE_MAP */}
          <CaisoNodeLocationsBrowser />
        </>
      )}

    </div>
  );
}

// ── CAISO Spread Summary ──────────────────────────────────────────────────────
function CaisoSpreadSummary({ year }: { year:number }) {
  const { data: np15=[], isLoading: l1 } = useListCaisoNodeStats({ node:"NP15", year });
  const { data: sp15=[], isLoading: l2 } = useListCaisoNodeStats({ node:"SP15", year });
  const { data: zp26=[], isLoading: l3 } = useListCaisoNodeStats({ node:"ZP26", year });

  const loading = l1||l2||l3;

  const avgRow = (rows: typeof np15, label: string) => {
    if (!rows.length) return null;
    const da = rows.reduce((s,r)=>s+Number(r.avgDaPrice),0)/rows.length;
    const rt = rows.filter(r=>r.avgRtPrice!=null).reduce((s,r)=>s+Number(r.avgRtPrice),0)/Math.max(1,rows.filter(r=>r.avgRtPrice!=null).length);
    const spread = da - rt;
    const negPct = rows.reduce((s,r)=>s+Number(r.negPricePercent??0),0)/rows.length;
    const vol = rows.reduce((s,r)=>s+Number(r.volatility??0),0)/rows.length;
    return { label, da, rt, spread, negPct, vol };
  };

  const tableRows = [
    avgRow(np15, "NP15 (North)"),
    avgRow(sp15, "SP15 (South)"),
    avgRow(zp26, "ZP26 (Central)"),
  ].filter(Boolean).sort((a,b)=>(b!.da - a!.da));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">DA–RT Spread Summary — {year} Annual Avg</CardTitle>
        <CardDescription className="text-xs">Negative spread (RT &lt; DA) is common in CAISO due to solar oversupply; high negative % indicates curtailment risk</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="h-16 flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {tableRows.map(r=>(
              <div key={r!.label} className="rounded-md border border-border p-3 bg-background">
                <div className="font-mono text-xs font-semibold">{r!.label}</div>
                <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                  <span>DA <span className="text-foreground font-medium">${r!.da.toFixed(2)}</span></span>
                  <span>RT <span className="text-foreground font-medium">${r!.rt.toFixed(2)}</span></span>
                </div>
                <div className="mt-1 text-xs font-semibold" style={{ color: r!.spread < -5 ? C.red : r!.spread < 0 ? C.amber : C.teal }}>
                  Spread ${r!.spread.toFixed(2)}/MWh
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  Neg price: <span className="text-foreground">{r!.negPct.toFixed(1)}%</span>
                  &nbsp;·&nbsp;Vol: <span className="text-foreground">${r!.vol.toFixed(1)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
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
