import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useListErcotNodeStats } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  Legend, ResponsiveContainer, Cell, PieChart, Pie,
} from "recharts";
import { Loader2 } from "lucide-react";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const C = {
  teal: "#14b8a6", amber: "#f59e0b", purple: "#8b5cf6",
  red: "#ef4444", green: "#22c55e", blue: "#3b82f6",
  border: "#1e2d3e", mutedFg: "#64748b",
  tooltipBg: "#0f172a", tooltipBorder: "#1e293b", tooltipFg: "#f8fafc",
};

const TOOLTIP_STYLE = {
  backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, color: C.tooltipFg,
};

const NODES = [
  "HB_HOUSTON","HB_NORTH","HB_SOUTH","HB_WEST","HB_PAN","HB_BUSAVG","HB_HUBAVG",
  "LZ_HOUSTON","LZ_NORTH","LZ_SOUTH","LZ_WEST","LZ_AEN","LZ_CPS","LZ_LCRA","LZ_RAYBN",
];

const ZONE_COLORS: Record<string, string> = {
  NCEN: "#f59e0b", COAS: "#14b8a6", FWES: "#8b5cf6",
  SCEN: "#22c55e", SOUT: "#06b6d4", NRTH: "#f97316",
  EAST: "#ec4899", WEST: "#3b82f6",
};
const ZONE_LABELS: Record<string, string> = {
  NCEN: "North Central", COAS: "Coast", FWES: "Far West",
  SCEN: "South Central", SOUT: "South", NRTH: "North",
  EAST: "East", WEST: "West",
};
const ZONES = Object.keys(ZONE_COLORS);

const FUEL_COLORS: Record<string, string> = {
  natural_gas: "#f59e0b", wind: "#14b8a6", solar: "#fbbf24",
  nuclear: "#8b5cf6", coal: "#78716c", hydro: "#06b6d4",
  storage: "#94a3b8", other: "#6b7280",
};
const FUELS = Object.keys(FUEL_COLORS);
const FUEL_LABELS: Record<string, string> = {
  natural_gas: "Natural Gas", wind: "Wind", solar: "Solar",
  nuclear: "Nuclear", coal: "Coal", hydro: "Hydro",
  storage: "Storage", other: "Other",
};

interface LoadRow  { month: number; zone: string;     avgMw: number; peakMw: number; }
interface FuelRow  { month: number; fuelType: string; avgMw: number; peakMw: number; }

function mwLabel(v: number) {
  return v >= 1000 ? `${(v / 1000).toFixed(1)} GW` : `${v.toFixed(0)} MW`;
}

export default function ErcotHistorical() {
  const [node, setNode]               = useState<string>("HB_HOUSTON");
  const [year, setYear]               = useState<number>(2024);
  const [compareYear, setCompareYear] = useState<number>(2023);
  const [showCompare, setShowCompare] = useState(false);

  // ── Prices (existing) ──────────────────────────────────────────────────────
  const { data: stats, isLoading: priceLoading } = useListErcotNodeStats({ node, year });
  const { data: compareStats } = useListErcotNodeStats({ node, year: compareYear });

  const priceData = stats?.sort((a, b) => a.month - b.month).map(s => {
    const comp = compareStats?.find(c => c.month === s.month);
    return {
      month:      MONTHS[s.month - 1],
      daPrice:    Number(s.avgDaPrice.toFixed(2)),
      rtPrice:    s.avgRtPrice      ? Number(s.avgRtPrice.toFixed(2))      : null,
      volatility: s.volatility      ? Number(s.volatility.toFixed(2))      : null,
      negPercent: s.negPricePercent ? Number(s.negPricePercent.toFixed(2)) : null,
      onPeak:     s.onPeakAvg       ? Number(s.onPeakAvg.toFixed(2))       : null,
      offPeak:    s.offPeakAvg      ? Number(s.offPeakAvg.toFixed(2))      : null,
      daComp:     comp              ? Number(comp.avgDaPrice.toFixed(2))   : undefined,
      rtComp:     comp?.avgRtPrice  ? Number(comp.avgRtPrice.toFixed(2))   : undefined,
    };
  }) || [];

  // ── Load by Zone ───────────────────────────────────────────────────────────
  const { data: loadRaw, isLoading: loadLoading } = useQuery<LoadRow[]>({
    queryKey: ["ercot-load-by-zone", year],
    queryFn: () => fetch(`/api/ercot/load-by-zone?year=${year}`).then(r => r.json()),
  });

  const loadData = useMemo(() => {
    if (!loadRaw) return [];
    const byMonth: Record<number, Record<string, number>> = {};
    for (const r of loadRaw) {
      if (!byMonth[r.month]) byMonth[r.month] = {};
      byMonth[r.month][r.zone] = r.avgMw;
    }
    return Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const entry: Record<string, unknown> = { month: MONTHS[i] };
      let total = 0;
      for (const z of ZONES) {
        const v = byMonth[m]?.[z] ?? 0;
        entry[z] = v;
        total += v;
      }
      entry.total = Math.round(total);
      return entry;
    }).filter(d => (d.total as number) > 0);
  }, [loadRaw]);

  const peakLoad = useMemo(() => {
    if (!loadRaw) return { zone: "—", mw: 0, month: "—" };
    const maxRow = loadRaw.reduce((best, r) => r.peakMw > best.peakMw ? r : best, loadRaw[0] ?? { peakMw: 0, zone: "—", month: 0 });
    return { zone: maxRow.zone, mw: maxRow.peakMw, month: MONTHS[(maxRow.month ?? 1) - 1] };
  }, [loadRaw]);

  // ── Fuel Mix ───────────────────────────────────────────────────────────────
  const { data: fuelRaw, isLoading: fuelLoading } = useQuery<FuelRow[]>({
    queryKey: ["ercot-fuel-mix", year],
    queryFn: () => fetch(`/api/ercot/fuel-mix?year=${year}`).then(r => r.json()),
  });

  const fuelData = useMemo(() => {
    if (!fuelRaw) return [];
    const byMonth: Record<number, Record<string, number>> = {};
    for (const r of fuelRaw) {
      if (!byMonth[r.month]) byMonth[r.month] = {};
      byMonth[r.month][r.fuelType] = r.avgMw;
    }
    return Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      const entry: Record<string, unknown> = { month: MONTHS[i] };
      for (const f of FUELS) entry[f] = byMonth[m]?.[f] ?? 0;
      return entry;
    }).filter(d => FUELS.some(f => (d[f] as number) > 0));
  }, [fuelRaw]);

  // Annual fuel mix for pie chart
  const fuelPie = useMemo(() => {
    if (!fuelRaw) return [];
    const totals: Record<string, number> = {};
    for (const r of fuelRaw) totals[r.fuelType] = (totals[r.fuelType] ?? 0) + r.avgMw;
    const grandTotal = Object.values(totals).reduce((a, b) => a + b, 0);
    return FUELS
      .filter(f => (totals[f] ?? 0) > 0)
      .map(f => ({ name: FUEL_LABELS[f] ?? f, value: Math.round(totals[f] ?? 0), pct: grandTotal > 0 ? ((totals[f] ?? 0) / grandTotal * 100).toFixed(1) : "0" }))
      .sort((a, b) => b.value - a.value);
  }, [fuelRaw]);

  // Renewable share
  const renewablePct = useMemo(() => {
    if (!fuelRaw || fuelRaw.length === 0) return 0;
    const total = fuelRaw.reduce((s, r) => s + r.avgMw, 0);
    const renew = fuelRaw.filter(r => ["wind", "solar", "hydro", "storage"].includes(r.fuelType)).reduce((s, r) => s + r.avgMw, 0);
    return total > 0 ? (renew / total * 100) : 0;
  }, [fuelRaw]);

  const priceEmpty = !priceLoading && priceData.length === 0;

  const YEARS = [2026, 2025, 2024, 2023, 2022];

  return (
    <div className="p-8 h-full overflow-auto space-y-6">

      {/* Header + controls */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">ERCOT Historical Analysis</h1>
          <p className="text-muted-foreground">Prices, demand, and generation by fuel type — monthly aggregated.</p>
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <Select value={node} onValueChange={setNode}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Select Node" />
            </SelectTrigger>
            <SelectContent>
              {NODES.map(n => <SelectItem key={n} value={n}>{n}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={year.toString()} onValueChange={v => setYear(parseInt(v))}>
            <SelectTrigger className="w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {YEARS.map(y => <SelectItem key={y} value={y.toString()}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" id="yoy" checked={showCompare}
              onChange={e => setShowCompare(e.target.checked)} className="accent-teal-500 cursor-pointer" />
            <label htmlFor="yoy" className="cursor-pointer">YoY vs</label>
          </div>
          <Select value={compareYear.toString()} onValueChange={v => setCompareYear(parseInt(v))} disabled={!showCompare}>
            <SelectTrigger className="w-[100px]" disabled={!showCompare}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {YEARS.map(y => <SelectItem key={y} value={y.toString()}>{y}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Tabs defaultValue="prices">
        <TabsList className="mb-4">
          <TabsTrigger value="prices">DA vs RT Prices</TabsTrigger>
          <TabsTrigger value="peak">On/Off-Peak Split</TabsTrigger>
          <TabsTrigger value="volatility">Volatility & Neg. Prices</TabsTrigger>
          <TabsTrigger value="load">Demand / Load</TabsTrigger>
          <TabsTrigger value="genmix">Generation Mix</TabsTrigger>
        </TabsList>

        {/* ── DA vs RT Prices ─────────────────────────────────────────────── */}
        <TabsContent value="prices">
          {priceLoading ? <LoadingState /> : priceEmpty ? <EmptyState /> : (
            <Card>
              <CardHeader>
                <CardTitle>DA vs RT Average Prices ($/MWh)</CardTitle>
                <CardDescription>{node} — {year}{showCompare ? ` vs ${compareYear}` : ""}</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={400}>
                  <LineChart data={priceData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                    <XAxis dataKey="month" stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                    <YAxis stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                    <RechartsTooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend />
                    <Line isAnimationActive={false} type="monotone" dataKey="daPrice" name={`DA ${year}`} stroke={C.teal} strokeWidth={2} dot={{ r: 3, fill: C.teal }} activeDot={{ r: 5 }} connectNulls />
                    <Line isAnimationActive={false} type="monotone" dataKey="rtPrice" name={`RT ${year}`} stroke={C.amber} strokeWidth={2} dot={{ r: 3, fill: C.amber }} activeDot={{ r: 5 }} connectNulls />
                    {showCompare && <Line isAnimationActive={false} type="monotone" dataKey="daComp" name={`DA ${compareYear}`} stroke={C.teal} strokeWidth={1.5} strokeDasharray="5 5" dot={false} connectNulls />}
                    {showCompare && <Line isAnimationActive={false} type="monotone" dataKey="rtComp" name={`RT ${compareYear}`} stroke={C.amber} strokeWidth={1.5} strokeDasharray="5 5" dot={false} connectNulls />}
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── On/Off-Peak Split ────────────────────────────────────────────── */}
        <TabsContent value="peak">
          {priceLoading ? <LoadingState /> : priceEmpty ? <EmptyState /> : (
            <Card>
              <CardHeader>
                <CardTitle>On-Peak vs Off-Peak Monthly Average ($/MWh)</CardTitle>
                <CardDescription>{node} — {year}</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={400}>
                  <BarChart data={priceData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                    <XAxis dataKey="month" stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                    <YAxis stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                    <RechartsTooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`$${v.toFixed(2)}/MWh`]} />
                    <Legend />
                    <Bar isAnimationActive={false} dataKey="onPeak"  name="On-Peak Avg"  fill={C.teal}   radius={[3, 3, 0, 0]} />
                    <Bar isAnimationActive={false} dataKey="offPeak" name="Off-Peak Avg" fill={C.purple} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Volatility & Neg Prices ──────────────────────────────────────── */}
        <TabsContent value="volatility">
          {priceLoading ? <LoadingState /> : priceEmpty ? <EmptyState /> : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Price Volatility (StdDev)</CardTitle>
                  <CardDescription>Monthly price standard deviation</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={priceData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                      <XAxis dataKey="month" stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                      <YAxis stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                      <RechartsTooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`$${v.toFixed(2)}`]} />
                      <Bar isAnimationActive={false} dataKey="volatility" name="Volatility" radius={[3, 3, 0, 0]}>
                        {priceData.map((entry, i) => (
                          <Cell key={i} fill={(entry.volatility || 0) > 10 ? C.red : (entry.volatility || 0) > 5 ? C.amber : C.teal} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Negative Price Frequency (%)</CardTitle>
                  <CardDescription>% of intervals below $0</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={priceData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                      <XAxis dataKey="month" stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                      <YAxis stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                      <RechartsTooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`${v.toFixed(1)}%`]} />
                      <Bar isAnimationActive={false} dataKey="negPercent" name="Neg. Price %" radius={[3, 3, 0, 0]}>
                        {priceData.map((entry, i) => (
                          <Cell key={i} fill={(entry.negPercent || 0) > 5 ? C.red : C.amber} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>

        {/* ── Demand / Load ────────────────────────────────────────────────── */}
        <TabsContent value="load" className="space-y-5">
          {loadLoading ? <LoadingState /> : loadData.length === 0 ? <EmptyState /> : (
            <>
              {/* KPI row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <KpiCard label="Peak System Load" value={mwLabel(peakLoad.mw)} sub={`${peakLoad.zone} · ${peakLoad.month}`} color="text-amber-400" />
                <KpiCard label="Avg Monthly Load" value={mwLabel(loadData.reduce((s, d) => s + (d.total as number), 0) / loadData.length)} sub="All zones combined" color="text-teal-400" />
                <KpiCard label="Largest Zone" value={peakLoad.zone ? (ZONE_LABELS[peakLoad.zone] ?? peakLoad.zone) : "NCEN"} sub="North Central — largest ERCOT zone" color="text-amber-400" />
                <KpiCard label="Zones Tracked" value={`${ZONES.length}`} sub="ERCOT load zones" color="text-teal-400" />
              </div>

              {/* Stacked area: total ERCOT demand by zone */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle>Monthly Average Demand by Zone — {year}</CardTitle>
                  <CardDescription>Average MW across all hours each month, stacked by load zone</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={380}>
                    <AreaChart data={loadData} margin={{ top: 10, right: 20, left: 20, bottom: 5 }}>
                      <defs>
                        {ZONES.map(z => (
                          <linearGradient key={z} id={`grad-${z}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%"  stopColor={ZONE_COLORS[z]} stopOpacity={0.7} />
                            <stop offset="95%" stopColor={ZONE_COLORS[z]} stopOpacity={0.15} />
                          </linearGradient>
                        ))}
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                      <XAxis dataKey="month" stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                      <YAxis stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} tickFormatter={v => `${(v/1000).toFixed(0)}GW`} />
                      <RechartsTooltip contentStyle={TOOLTIP_STYLE}
                        formatter={(v: number, name: string) => [mwLabel(v), name]} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {ZONES.map(z => (
                        <Area key={z} type="monotone" dataKey={z} name={ZONE_LABELS[z] ?? z} stackId="1"
                          stroke={ZONE_COLORS[z]} fill={`url(#grad-${z})`} strokeWidth={1.5} isAnimationActive={false} />
                      ))}
                    </AreaChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              {/* Bar chart: side-by-side zones per month */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle>Zone Load Comparison — {year}</CardTitle>
                  <CardDescription>Monthly average MW per zone — shows seasonal patterns by region</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={loadData} margin={{ top: 10, right: 20, left: 20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                      <XAxis dataKey="month" stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 11 }} />
                      <YAxis stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 11 }} tickFormatter={v => `${(v/1000).toFixed(0)}GW`} />
                      <RechartsTooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number, name: string) => [mwLabel(v), name]} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      {ZONES.map(z => (
                        <Bar key={z} dataKey={z} name={ZONE_LABELS[z] ?? z} stackId="a" fill={ZONE_COLORS[z]}
                          isAnimationActive={false} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* ── Generation Mix ───────────────────────────────────────────────── */}
        <TabsContent value="genmix" className="space-y-5">
          {fuelLoading ? <LoadingState /> : fuelData.length === 0 ? <EmptyState /> : (
            <>
              {/* KPI row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <KpiCard label="Renewable Share" value={`${renewablePct.toFixed(1)}%`} sub="Wind + Solar + Hydro" color="text-teal-400" />
                <KpiCard label="Top Fuel" value={fuelPie[0]?.name ?? "—"} sub={`${fuelPie[0]?.pct ?? 0}% of generation`} color="text-amber-400" />
                <KpiCard label="Wind Share" value={`${fuelPie.find(f => f.name === "Wind")?.pct ?? 0}%`} sub="Avg monthly dispatch" color="text-teal-400" />
                <KpiCard label="Solar Share" value={`${fuelPie.find(f => f.name === "Solar")?.pct ?? 0}%`} sub="Avg monthly dispatch" color="text-yellow-400" />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                {/* Stacked bar: monthly generation by fuel */}
                <div className="lg:col-span-2">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle>Monthly Generation by Fuel Type — {year}</CardTitle>
                      <CardDescription>Average MW output each month, stacked by fuel type</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <ResponsiveContainer width="100%" height={380}>
                        <BarChart data={fuelData} margin={{ top: 10, right: 10, left: 20, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                          <XAxis dataKey="month" stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                          <YAxis stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 11 }} tickFormatter={v => `${(v/1000).toFixed(0)}GW`} />
                          <RechartsTooltip contentStyle={TOOLTIP_STYLE}
                            formatter={(v: number, name: string) => [mwLabel(v), FUEL_LABELS[name] ?? name]} />
                          <Legend wrapperStyle={{ fontSize: 11 }}
                            formatter={(value) => FUEL_LABELS[value] ?? value} />
                          {FUELS.map(f => (
                            <Bar key={f} dataKey={f} name={f} stackId="a" fill={FUEL_COLORS[f]}
                              isAnimationActive={false} />
                          ))}
                        </BarChart>
                      </ResponsiveContainer>
                    </CardContent>
                  </Card>
                </div>

                {/* Pie: annual mix */}
                <Card className="flex flex-col">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Annual Generation Mix — {year}</CardTitle>
                    <CardDescription className="text-xs">Average MW share by fuel</CardDescription>
                  </CardHeader>
                  <CardContent className="flex-1 flex flex-col items-center justify-center gap-4">
                    <PieChart width={200} height={180}>
                      <Pie data={fuelPie} cx={100} cy={90} innerRadius={52} outerRadius={82}
                        paddingAngle={2} dataKey="value" isAnimationActive={false}>
                        {fuelPie.map((entry, i) => (
                          <Cell key={i} fill={FUEL_COLORS[FUELS.find(f => FUEL_LABELS[f] === entry.name) ?? ""] ?? "#6b7280"} />
                        ))}
                      </Pie>
                      <RechartsTooltip contentStyle={TOOLTIP_STYLE}
                        formatter={(v: number, _n: string, props) => [`${props.payload?.pct}% · ${mwLabel(v)} avg`, props.payload?.name]} />
                    </PieChart>
                    <div className="w-full space-y-1">
                      {fuelPie.map(f => (
                        <div key={f.name} className="flex items-center justify-between text-xs">
                          <span className="flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-sm inline-block flex-shrink-0"
                              style={{ background: FUEL_COLORS[FUELS.find(ff => FUEL_LABELS[ff] === f.name) ?? ""] ?? "#6b7280" }} />
                            {f.name}
                          </span>
                          <span className="font-mono text-muted-foreground">{f.pct}%</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Line chart: individual fuel trends */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle>Fuel Output Trend — {year}</CardTitle>
                  <CardDescription>Monthly average MW per fuel type — shows seasonality (wind peaks winter, solar peaks summer)</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={fuelData} margin={{ top: 10, right: 20, left: 20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                      <XAxis dataKey="month" stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                      <YAxis stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 11 }} tickFormatter={v => `${(v/1000).toFixed(0)}GW`} />
                      <RechartsTooltip contentStyle={TOOLTIP_STYLE}
                        formatter={(v: number, name: string) => [mwLabel(v), FUEL_LABELS[name] ?? name]} />
                      <Legend wrapperStyle={{ fontSize: 11 }} formatter={v => FUEL_LABELS[v] ?? v} />
                      {FUELS.filter(f => f !== "other" && f !== "storage").map(f => (
                        <Line key={f} type="monotone" dataKey={f} name={f}
                          stroke={FUEL_COLORS[f]} strokeWidth={2} dot={{ r: 2, fill: FUEL_COLORS[f] }}
                          isAnimationActive={false} connectNulls />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="h-[400px] flex items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="h-[400px] flex items-center justify-center border rounded-md border-dashed">
      <p className="text-muted-foreground">No data available for this selection.</p>
    </div>
  );
}

function KpiCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3 px-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`text-xl font-bold font-mono ${color}`}>{value}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>
      </CardContent>
    </Card>
  );
}
