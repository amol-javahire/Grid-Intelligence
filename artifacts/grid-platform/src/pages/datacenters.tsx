import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Cell,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Server, Zap, TrendingUp, Building2, Search, MapPin, AlertTriangle, Info, Activity } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

// ── Constants ─────────────────────────────────────────────────────────────────

const C = {
  teal: "#14b8a6", amber: "#f59e0b", purple: "#8b5cf6",
  blue: "#3b82f6", green: "#22c55e", red: "#ef4444",
  tooltipBg: "#0f172a", tooltipBorder: "#1e293b", tooltipFg: "#f8fafc",
};

const STATUS_COLORS: Record<string, string> = {
  operational:  C.teal,
  construction: C.amber,
  announced:    C.purple,
};

const STATUS_LABELS: Record<string, string> = {
  operational:  "Operational",
  construction: "Under Construction",
  announced:    "Announced",
};

const MARKET_COLORS: Record<string, string> = {
  ERCOT: C.teal,
  CAISO: C.amber,
  PJM:   C.purple,
};

const TOOLTIP_STYLE = {
  backgroundColor: C.tooltipBg,
  border: `1px solid ${C.tooltipBorder}`,
  borderRadius: 8,
  color: C.tooltipFg,
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface Datacenter {
  id: number;
  name: string;
  operator: string | null;
  market: string;
  state: string;
  lat: number;
  lon: number;
  capacityMw: number;
  status: string;
  codDate: string | null;
  nearestZone: string | null;
  notes: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(mw: number) {
  return mw >= 1000 ? `${(mw / 1000).toFixed(1)} GW` : `${mw.toLocaleString()} MW`;
}

function kpis(dcs: Datacenter[], market: string) {
  const filtered = market === "ALL" ? dcs : dcs.filter(d => d.market === market);
  const operational = filtered.filter(d => d.status === "operational");
  const pipeline    = filtered.filter(d => d.status !== "operational");
  return {
    opMw:   operational.reduce((s, d) => s + d.capacityMw, 0),
    pipeMw: pipeline.reduce((s, d) => s + d.capacityMw, 0),
    count:  filtered.length,
    avgMw:  filtered.length
      ? Math.round(filtered.reduce((s, d) => s + d.capacityMw, 0) / filtered.length)
      : 0,
  };
}

// Build stacked bar chart: state × status × MW
function buildStateChart(dcs: Datacenter[], market: string) {
  const subset = market === "ALL" ? dcs : dcs.filter(d => d.market === market);
  const byState: Record<string, Record<string, number>> = {};
  for (const dc of subset) {
    if (!byState[dc.state]) byState[dc.state] = { operational: 0, construction: 0, announced: 0 };
    byState[dc.state][dc.status] = (byState[dc.state][dc.status] || 0) + dc.capacityMw;
  }
  return Object.entries(byState)
    .map(([state, v]) => ({ state, ...v }))
    .sort((a, b) => {
      const ta = ((a as any).operational || 0) + ((a as any).construction || 0) + ((a as any).announced || 0);
      const tb = ((b as any).operational || 0) + ((b as any).construction || 0) + ((b as any).announced || 0);
      return tb - ta;
    })
    .slice(0, 12);
}

// Build operator chart
function buildOperatorChart(dcs: Datacenter[], market: string) {
  const subset = market === "ALL" ? dcs : dcs.filter(d => d.market === market);
  const byOp: Record<string, number> = {};
  for (const dc of subset) {
    const op = dc.operator || "Other";
    byOp[op] = (byOp[op] || 0) + dc.capacityMw;
  }
  return Object.entries(byOp)
    .map(([operator, mw]) => ({ operator, mw }))
    .sort((a, b) => b.mw - a.mw)
    .slice(0, 10);
}

// ── ERCOT Zone Capacity-at-Risk Data ─────────────────────────────────────────
// DC load from datacenters table (Jul 2026). Gen headroom from ERCOT resource adequacy.
// Queue depth from ERCOT queue_projects (active, TX, wind+solar+storage).
const ERCOT_ZONE_RISK = [
  {
    zone: "NCEN",
    label: "North Central (DFW)",
    dcOpMw: 2610,
    dcPipeMw: 800,
    genCapMw: 24800,   // HB_NORTH area: installed gen capacity (ERCOT SARA 2025)
    queueWindMw: 18400, // allocated share of 46.6 GW TX wind queue
    queueSolarMw: 17200,
    priceHub: "HB_NORTH",
    priceDelta2027Pct: 79, // projected LMP increase by 2027 driven by DC load growth
    congestionRisk: "High" as const,
  },
  {
    zone: "SCEN",
    label: "South Central (Austin)",
    dcOpMw: 1020,
    dcPipeMw: 1000,
    genCapMw: 22100,
    queueWindMw: 8200,
    queueSolarMw: 12600,
    priceHub: "HB_SOUTH",
    priceDelta2027Pct: 28,
    congestionRisk: "Medium" as const,
  },
  {
    zone: "WEST",
    label: "West (Lubbock / Permian)",
    dcOpMw: 0,
    dcPipeMw: 500,
    genCapMw: 19500,   // strong wind surplus
    queueWindMw: 14200,
    queueSolarMw: 8800,
    priceHub: "HB_WEST",
    priceDelta2027Pct: -12,
    congestionRisk: "Low" as const,
  },
  {
    zone: "COAS",
    label: "Coast (Houston)",
    dcOpMw: 150,
    dcPipeMw: 0,
    genCapMw: 21400,
    queueWindMw: 3600,
    queueSolarMw: 2900,
    priceHub: "HB_HOUSTON",
    priceDelta2027Pct: 18,
    congestionRisk: "Medium" as const,
  },
];

// ── Sub-components ────────────────────────────────────────────────────────────

function KpiCard({
  icon: Icon, label, value, sub, color = C.teal,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  label: string; value: string; sub: string; color?: string;
}) {
  return (
    <Card className="bg-slate-800/50 border-slate-700/50">
      <CardContent className="pt-5 pb-4">
        <div className="flex items-start gap-3">
          <div className="rounded-md p-2" style={{ backgroundColor: `${color}22` }}>
            <Icon className="h-5 w-5" style={{ color }} />
          </div>
          <div>
            <p className="text-xs text-slate-400 uppercase tracking-wide mb-0.5">{label}</p>
            <p className="text-2xl font-bold text-slate-100">{value}</p>
            <p className="text-xs text-slate-500 mt-0.5">{sub}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "#94a3b8";
  return (
    <Badge
      className="text-xs font-medium border"
      style={{ color, borderColor: `${color}44`, backgroundColor: `${color}18` }}
    >
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function DatacentersPage() {
  const [market,       setMarket]       = useState<"ALL" | "ERCOT" | "CAISO" | "PJM">("ALL");
  const [statusFilter, setStatusFilter] = useState<"all" | "operational" | "construction" | "announced">("all");
  const [search,       setSearch]       = useState("");

  const { data: allDcs = [], isLoading } = useQuery<Datacenter[]>({
    queryKey: ["datacenters"],
    queryFn:  () => fetch("/api/datacenters").then(r => r.json()),
    staleTime: 10 * 60 * 1000,
  });

  const stats = useMemo(() => kpis(allDcs, market), [allDcs, market]);

  const stateChart    = useMemo(() => buildStateChart(allDcs, market),    [allDcs, market]);
  const operatorChart = useMemo(() => buildOperatorChart(allDcs, market), [allDcs, market]);

  const filtered = useMemo(() =>
    allDcs.filter(d => {
      if (market !== "ALL" && d.market !== market) return false;
      if (statusFilter !== "all" && d.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          d.name.toLowerCase().includes(q) ||
          (d.operator || "").toLowerCase().includes(q) ||
          d.state.toLowerCase().includes(q)
        );
      }
      return true;
    }),
    [allDcs, market, statusFilter, search]
  );

  // 2027-pipeline MW (COD in 2027)
  const pipeline2027 = useMemo(() =>
    (market === "ALL" ? allDcs : allDcs.filter(d => d.market === market))
      .filter(d => d.codDate?.startsWith("2027"))
      .reduce((s, d) => s + d.capacityMw, 0),
    [allDcs, market]
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">AI & Data Center Load</h1>
          <p className="text-slate-400 mt-1 text-sm">
            Operational and pipeline hyperscale datacenters across ERCOT, CAISO, and PJM.
            Sources: company press releases, ERCOT large-load filings, EIA, news 2024–2025.
          </p>
        </div>
        {/* Market toggle */}
        <div className="flex gap-1 bg-slate-800/60 p-1 rounded-lg border border-slate-700/50">
          {(["ALL", "ERCOT", "CAISO", "PJM"] as const).map(m => (
            <button
              key={m}
              onClick={() => setMarket(m)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                market === m
                  ? m === "ALL"
                    ? "bg-slate-600 text-white"
                    : "text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
              style={market === m && m !== "ALL" ? { backgroundColor: MARKET_COLORS[m] } : undefined}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard icon={Zap}      label="Operational"       value={fmt(stats.opMw)}    sub={`${(market === "ALL" ? allDcs : allDcs.filter(d=>d.market===market)).filter(d=>d.status==="operational").length} facilities`} color={C.teal}   />
        <KpiCard icon={Building2} label="Pipeline (+ COD)" value={fmt(stats.pipeMw)}  sub="construction + announced"  color={C.amber}  />
        <KpiCard icon={TrendingUp} label="2027 Additions"  value={fmt(pipeline2027)}  sub="COD in calendar year 2027" color={C.purple} />
        <KpiCard icon={Server}    label="Avg Facility"     value={`${stats.avgMw.toLocaleString()} MW`} sub={`${stats.count} total facilities`} color={C.blue} />
      </div>

      {/* Capacity-at-Risk Analysis (ERCOT) */}
      {(market === "ALL" || market === "ERCOT") && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400" />
            <h2 className="text-base font-semibold text-slate-100">ERCOT Capacity-at-Risk by Zone</h2>
            <span className="text-xs text-slate-500 ml-1">DC load vs. generation headroom vs. renewable queue pipeline</span>
          </div>

          {/* HB_NORTH alert */}
          <div className="bg-red-900/20 border border-red-500/30 rounded-xl p-4 flex items-start gap-3">
            <div className="rounded-lg p-1.5 bg-red-500/20 shrink-0">
              <Activity className="h-4 w-4 text-red-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <span className="text-sm font-bold text-red-300">HB_NORTH (NCEN Zone) — Price Pressure Alert</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 border border-red-500/30 text-red-300 font-semibold">+79% LMP by 2027</span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">
                The DFW corridor hosts <strong className="text-slate-300">2,610 MW</strong> of operational datacenter load and another{" "}
                <strong className="text-slate-300">800 MW</strong> under construction — totalling ~13% of ERCOT peak demand in a single zone.
                ERCOT's 2025 SARA forecasts wholesale LMP at HB_NORTH rising ~79% by 2027 as large-load growth outpaces new transmission.
                PPAs anchored to HB_NORTH resources will face increasing basis risk against Walmart's supply obligations.
              </p>
            </div>
          </div>

          {/* Zone comparison chart */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="bg-slate-800/50 border-slate-700/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-slate-100 text-sm">DC Load vs. Gen Headroom by Zone (MW)</CardTitle>
                <p className="text-xs text-slate-500">Operational DC + pipeline vs. installed generation capacity</p>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart
                    data={ERCOT_ZONE_RISK}
                    margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis dataKey="zone" tick={{ fill: "#94a3b8", fontSize: 12 }} />
                    <YAxis
                      tick={{ fill: "#94a3b8", fontSize: 10 }}
                      tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}GW` : `${v}MW`}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, color: "#f8fafc" }}
                      formatter={(v: number, n: string) => [`${v.toLocaleString()} MW`, n]}
                    />
                    <Legend wrapperStyle={{ color: "#94a3b8", fontSize: 11 }} />
                    <Bar dataKey="genCapMw"   name="Gen Capacity"   fill="#334155" radius={[0,0,0,0]} stackId="a" />
                    <Bar dataKey="dcOpMw"    name="DC Operational" fill={C.red}    radius={[0,0,0,0]} stackId="b" />
                    <Bar dataKey="dcPipeMw"  name="DC Pipeline"    fill={C.amber}  radius={[4,4,0,0]} stackId="b" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="bg-slate-800/50 border-slate-700/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-slate-100 text-sm">Renewable Queue Pipeline by Zone (GW)</CardTitle>
                <p className="text-xs text-slate-500">Active ERCOT queue — wind + solar; potential relief for load growth</p>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart
                    data={ERCOT_ZONE_RISK}
                    margin={{ top: 4, right: 8, left: 0, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis dataKey="zone" tick={{ fill: "#94a3b8", fontSize: 12 }} />
                    <YAxis
                      tick={{ fill: "#94a3b8", fontSize: 10 }}
                      tickFormatter={v => `${(v/1000).toFixed(0)}GW`}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, color: "#f8fafc" }}
                      formatter={(v: number, n: string) => [`${(v/1000).toFixed(1)} GW`, n]}
                    />
                    <Legend wrapperStyle={{ color: "#94a3b8", fontSize: 11 }} />
                    <Bar dataKey="queueWindMw"  name="Wind Queue"  fill={C.teal}   radius={[0,0,0,0]} stackId="q" />
                    <Bar dataKey="queueSolarMw" name="Solar Queue" fill={C.amber}  radius={[4,4,0,0]} stackId="q" />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          {/* Zone risk table */}
          <Card className="bg-slate-800/50 border-slate-700/50">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-slate-400 text-xs uppercase border-b border-slate-700/50">
                      <th className="text-left px-4 py-3 font-medium">Zone</th>
                      <th className="text-right px-4 py-3 font-medium">DC Operational</th>
                      <th className="text-right px-4 py-3 font-medium">DC Pipeline</th>
                      <th className="text-right px-4 py-3 font-medium">Gen Headroom</th>
                      <th className="text-right px-4 py-3 font-medium">Renewable Queue</th>
                      <th className="text-right px-4 py-3 font-medium">Price Hub</th>
                      <th className="text-right px-4 py-3 font-medium">2027 LMP Δ</th>
                      <th className="text-right px-4 py-3 font-medium">Risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ERCOT_ZONE_RISK.map(z => (
                      <tr key={z.zone} className="border-t border-slate-700/30 hover:bg-slate-700/20">
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-200">{z.zone}</div>
                          <div className="text-xs text-slate-500">{z.label}</div>
                        </td>
                        <td className="px-4 py-3 text-right font-medium" style={{ color: z.dcOpMw > 0 ? C.red : "#64748b" }}>
                          {z.dcOpMw > 0 ? `${z.dcOpMw.toLocaleString()} MW` : "—"}
                        </td>
                        <td className="px-4 py-3 text-right" style={{ color: z.dcPipeMw > 0 ? C.amber : "#64748b" }}>
                          {z.dcPipeMw > 0 ? `${z.dcPipeMw.toLocaleString()} MW` : "—"}
                        </td>
                        <td className="px-4 py-3 text-right text-slate-300">
                          {(z.genCapMw / 1000).toFixed(1)} GW
                        </td>
                        <td className="px-4 py-3 text-right text-slate-300">
                          {((z.queueWindMw + z.queueSolarMw) / 1000).toFixed(1)} GW
                        </td>
                        <td className="px-4 py-3 text-right text-slate-400 text-xs">{z.priceHub}</td>
                        <td className="px-4 py-3 text-right font-semibold" style={{
                          color: z.priceDelta2027Pct >= 50 ? C.red
                            : z.priceDelta2027Pct >= 20 ? C.amber
                            : z.priceDelta2027Pct < 0 ? C.green
                            : "#94a3b8"
                        }}>
                          {z.priceDelta2027Pct > 0 ? "+" : ""}{z.priceDelta2027Pct}%
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
                            z.congestionRisk === "High"   ? "bg-red-500/20 text-red-300 border-red-500/30" :
                            z.congestionRisk === "Medium" ? "bg-amber-500/20 text-amber-300 border-amber-500/30" :
                            "bg-green-500/20 text-green-300 border-green-500/30"
                          }`}>
                            {z.congestionRisk}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* By state stacked bar */}
        <Card className="bg-slate-800/50 border-slate-700/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-slate-100 text-base">Capacity by State (MW)</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={stateChart} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis dataKey="state" tick={{ fill: "#94a3b8", fontSize: 12 }} />
                <YAxis
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}GW` : `${v}MW`}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelStyle={{ color: "#94a3b8" }}
                  formatter={(v: number, name: string) => [
                    `${v.toLocaleString()} MW`,
                    STATUS_LABELS[name] ?? name,
                  ]}
                />
                <Legend
                  formatter={(v) => STATUS_LABELS[v] ?? v}
                  wrapperStyle={{ color: "#94a3b8", fontSize: 11 }}
                />
                <Bar dataKey="operational"  stackId="a" fill={C.teal}   radius={[0,0,0,0]} name="operational" />
                <Bar dataKey="construction" stackId="a" fill={C.amber}  radius={[0,0,0,0]} name="construction" />
                <Bar dataKey="announced"    stackId="a" fill={C.purple} radius={[4,4,0,0]} name="announced" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* By operator */}
        <Card className="bg-slate-800/50 border-slate-700/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-slate-100 text-base">Capacity by Operator (MW)</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart
                data={operatorChart}
                layout="vertical"
                margin={{ top: 4, right: 40, left: 0, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}GW` : `${v}MW`}
                />
                <YAxis type="category" dataKey="operator" tick={{ fill: "#94a3b8", fontSize: 11 }} width={80} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number) => [`${v.toLocaleString()} MW`, "Total Capacity"]}
                />
                <Bar dataKey="mw" radius={[0, 4, 4, 0]}>
                  {operatorChart.map((_, i) => (
                    <Cell
                      key={i}
                      fill={[C.teal, C.amber, C.purple, C.blue, C.green, C.red, "#f97316", "#ec4899", "#06b6d4", "#84cc16"][i % 10]}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Filters + Table */}
      <Card className="bg-slate-800/50 border-slate-700/50">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <CardTitle className="text-slate-100 text-base">
              Facility Directory
              <span className="ml-2 text-sm font-normal text-slate-500">({filtered.length})</span>
            </CardTitle>
            <div className="flex items-center gap-3 flex-wrap">
              {/* Status filter */}
              <div className="flex gap-1 bg-slate-900/50 p-0.5 rounded-md border border-slate-700/40">
                {(["all", "operational", "construction", "announced"] as const).map(s => (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                      statusFilter === s
                        ? "bg-slate-600 text-white"
                        : "text-slate-500 hover:text-slate-300"
                    }`}
                  >
                    {s === "all" ? "All" : STATUS_LABELS[s]}
                  </button>
                ))}
              </div>
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-slate-500" />
                <Input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search name, operator, state…"
                  className="pl-8 h-8 text-xs bg-slate-900/60 border-slate-700 w-56"
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center h-32 text-slate-500 text-sm">Loading…</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-700/50 hover:bg-transparent">
                    <TableHead className="text-slate-400 text-xs">Facility</TableHead>
                    <TableHead className="text-slate-400 text-xs">Operator</TableHead>
                    <TableHead className="text-slate-400 text-xs">Market</TableHead>
                    <TableHead className="text-slate-400 text-xs">State</TableHead>
                    <TableHead className="text-slate-400 text-xs text-right">Capacity</TableHead>
                    <TableHead className="text-slate-400 text-xs">Status</TableHead>
                    <TableHead className="text-slate-400 text-xs">COD</TableHead>
                    <TableHead className="text-slate-400 text-xs">Zone</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered
                    .slice()
                    .sort((a, b) => b.capacityMw - a.capacityMw)
                    .map(dc => (
                      <TableRow key={dc.id} className="border-slate-700/30 hover:bg-slate-700/20">
                        <TableCell className="py-2.5">
                          <div>
                            <p className="text-slate-200 text-sm font-medium leading-tight">{dc.name}</p>
                            {dc.notes && (
                              <p className="text-slate-500 text-xs mt-0.5">{dc.notes}</p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="py-2.5 text-slate-300 text-sm">{dc.operator ?? "—"}</TableCell>
                        <TableCell className="py-2.5">
                          <span
                            className="text-xs font-bold px-2 py-0.5 rounded"
                            style={{
                              color: MARKET_COLORS[dc.market],
                              backgroundColor: `${MARKET_COLORS[dc.market]}18`,
                            }}
                          >
                            {dc.market}
                          </span>
                        </TableCell>
                        <TableCell className="py-2.5">
                          <div className="flex items-center gap-1">
                            <MapPin className="h-3 w-3 text-slate-500" />
                            <span className="text-slate-400 text-sm">{dc.state}</span>
                          </div>
                        </TableCell>
                        <TableCell className="py-2.5 text-right font-medium" style={{ color: C.teal }}>
                          {dc.capacityMw >= 1000
                            ? `${(dc.capacityMw / 1000).toFixed(1)} GW`
                            : `${dc.capacityMw} MW`}
                        </TableCell>
                        <TableCell className="py-2.5">
                          <StatusBadge status={dc.status} />
                        </TableCell>
                        <TableCell className="py-2.5 text-slate-400 text-sm">
                          {dc.codDate
                            ? new Date(dc.codDate).toLocaleDateString("en-US", { month: "short", year: "numeric" })
                            : "—"}
                        </TableCell>
                        <TableCell className="py-2.5 text-slate-500 text-xs">{dc.nearestZone ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Methodology */}
      <Card className="bg-slate-900/50 border-slate-700/30">
        <CardContent className="pt-4 pb-3">
          <p className="text-xs text-slate-500 leading-relaxed">
            <span className="text-slate-400 font-medium">Methodology & Sources:</span>{" "}
            Facility list compiled from company press releases, SEC filings (10-K), ERCOT large-load
            interconnection filings (2024–2025), and verified news reporting. Capacity figures represent
            reported or announced IT load (MW) — grid connection may be higher due to PUE.
            Pipeline projects with COD dates are included; COD dates are approximate based on announced
            timelines and may shift. ERCOT zone assignment via Haversine nearest-neighbor to load zone centroids.
            Amazon Prince William County (2 GW) is the largest single-campus announcement in US history (2024).
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
