import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Flame, Zap, Wind, Sun, Battery, AlertTriangle, TrendingDown,
  Info, BarChart3, Settings2, Activity,
} from "lucide-react";
import {
  ComposedChart, Area, Line, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine, Cell,
  BarChart, PieChart, Pie,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";

// ── Palette ───────────────────────────────────────────────────────────────────
const C = {
  teal:   "#14b8a6",
  amber:  "#f59e0b",
  purple: "#8b5cf6",
  red:    "#ef4444",
  green:  "#22c55e",
  blue:   "#3b82f6",
  orange: "#f97316",
  slate:  "#64748b",
};

const TECH_COLORS: Record<string, string> = {
  CCGT:        C.teal,
  CT:          C.amber,
  STEAM:       "#6b7280",
  WIND:        C.blue,
  PV:          C.orange,
  LI_ION:      C.purple,
  PUMPED_HYDRO: C.green,
};

const TECH_LABELS: Record<string, string> = {
  CCGT:  "Combined Cycle (CCGT)",
  CT:    "Combustion Turbine (CT)",
  STEAM: "Steam / Coal",
};

const TOOLTIP_STYLE = {
  backgroundColor: "#0f172a",
  border: "1px solid #1e293b",
  borderRadius: 8,
  color: "#f8fafc",
};

// ── Types ─────────────────────────────────────────────────────────────────────
interface Generator {
  id: number;
  plant_name: string;
  operator: string;
  technology: string;
  fuel_primary: string;
  nameplate_mw: string;
  load_zone: string;
  commissioning_year: number | null;
  design_heat_rate: string | null;
  vom_per_mwh: string | null;
  co2_rate_tons_mwh: string | null;
  forced_outage_rate: string | null;
  startup_cost_cold: string | null;
  min_load_mw: string | null;
  max_load_mw: string | null;
  ramp_rate_mw_min: string | null;
  fuel_hub: string | null;
  implied_fuel_cost_per_mmb: string | null;
}

interface MeritOrderUnit {
  id: number;
  plant_name: string;
  operator: string;
  technology: string;
  fuel_primary: string;
  nameplate_mw: number;
  available_mw: number;
  load_zone: string;
  commissioning_year: number | null;
  design_heat_rate: number;
  vom_per_mwh: number;
  co2_rate_tons_mwh: number;
  forced_outage_rate: number;
  startup_cost_cold: number | null;
  marginal_cost: number;
  fuel_component: number;
  co2_component: number;
  start_mw: number;
  end_mw: number;
  cumulative_mw: number;
}

interface MeritOrderResp {
  gas_price: number;
  co2_price: number;
  total_thermal_mw: number;
  units: MeritOrderUnit[];
}

interface SummaryRow {
  asset_class: string;
  technology: string;
  fuel_primary: string;
  unit_count: string;
  total_mw: string;
  avg_mw: string;
  avg_heat_rate: string | null;
  avg_vom: string | null;
  avg_co2_rate: string | null;
  avg_efor: string | null;
  oldest_year: number | null;
  newest_year: number | null;
}

// ── Supply-curve (merit order) chart data ─────────────────────────────────────
// Build a step-function dataset from the sorted unit list.
// Each unit contributes two points: (start_mw, cost) → (end_mw, cost)
function buildSupplyCurve(units: MeritOrderUnit[]) {
  const pts: { mw: number; cost: number; tech: string }[] = [];
  for (const u of units) {
    pts.push({ mw: u.start_mw, cost: u.marginal_cost, tech: u.technology });
    pts.push({ mw: u.end_mw,   cost: u.marginal_cost, tech: u.technology });
  }
  return pts;
}

// Group units by technology for the stacked capacity breakdown
function buildTechBreakdown(units: MeritOrderUnit[]) {
  const map: Record<string, { mw: number; count: number; avgCost: number }> = {};
  for (const u of units) {
    if (!map[u.technology]) map[u.technology] = { mw: 0, count: 0, avgCost: 0 };
    map[u.technology].mw    += u.available_mw;
    map[u.technology].count += 1;
    map[u.technology].avgCost = u.marginal_cost;
  }
  return Object.entries(map).map(([tech, d]) => ({
    tech,
    mw:     Math.round(d.mw),
    count:  d.count,
    avgCost: Math.round(d.avgCost * 10) / 10,
    color:  TECH_COLORS[tech] ?? C.slate,
    label:  TECH_LABELS[tech] ?? tech,
  })).sort((a, b) => a.avgCost - b.avgCost);
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function GeneratorsPage() {
  const [iso]        = useState<"ERCOT">("ERCOT");
  const [gasPrice, setGasPrice] = useState(2.50);
  const [co2Price, setCo2Price] = useState(0);
  const [demandMw, setDemandMw] = useState(18000);
  const [techFilter, setTechFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // ── API calls ──────────────────────────────────────────────────────────────
  const { data: meritData, isLoading: loadingMerit } = useQuery<MeritOrderResp>({
    queryKey: ["merit-order", iso, gasPrice, co2Price],
    queryFn:  () => fetch(`/api/generators/merit-order?iso=${iso}&gas_price=${gasPrice}&co2_price=${co2Price}`).then(r => r.json()),
    staleTime: 5 * 60_000,
  });

  const { data: summary } = useQuery<{ byTechnology: SummaryRow[]; retirementRisk: { at_risk_units: string; at_risk_mw: string } }>({
    queryKey: ["generators-summary", iso],
    queryFn:  () => fetch(`/api/generators/summary?iso=${iso}`).then(r => r.json()),
    staleTime: 60 * 60_000,
  });

  const { data: allGenerators = [] } = useQuery<Generator[]>({
    queryKey: ["generators", iso],
    queryFn:  () => fetch(`/api/generators?iso=${iso}&asset_class=THERMAL`).then(r => r.json()),
    staleTime: 60 * 60_000,
  });

  // ── Derived data ───────────────────────────────────────────────────────────
  const supplyCurve = useMemo(() =>
    meritData ? buildSupplyCurve(meritData.units) : [], [meritData]);

  const techBreakdown = useMemo(() =>
    meritData ? buildTechBreakdown(meritData.units) : [], [meritData]);

  // Clearing price: interpolate where cumulative_mw crosses demandMw
  const clearingPrice = useMemo(() => {
    if (!meritData) return null;
    const unit = meritData.units.find(u => u.end_mw >= demandMw);
    return unit ? unit.marginal_cost : null;
  }, [meritData, demandMw]);

  // Filtered table
  const tableRows = useMemo(() => {
    return allGenerators
      .filter(g => {
        if (techFilter && g.technology !== techFilter) return false;
        if (search && !g.plant_name.toLowerCase().includes(search.toLowerCase()) &&
            !g.operator?.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
      })
      .map(g => {
        const hr     = parseFloat(g.design_heat_rate ?? "0");
        const vom    = parseFloat(g.vom_per_mwh ?? "0");
        const mw     = parseFloat(g.nameplate_mw);
        const efor   = parseFloat(g.forced_outage_rate ?? "0.05");
        const fuelCost = g.implied_fuel_cost_per_mmb ? parseFloat(g.implied_fuel_cost_per_mmb) : gasPrice;
        const mc     = hr * fuelCost + vom;
        const spark  = g.fuel_primary === "NG" && clearingPrice ? clearingPrice - mc : null;
        return { ...g, mc: Math.round(mc * 100) / 100, spark, mw, efor };
      })
      .sort((a, b) => a.mc - b.mc);
  }, [allGenerators, techFilter, search, gasPrice, clearingPrice]);

  // KPI data
  const totalThermalMw = summary?.byTechnology
    .filter(r => r.asset_class === "THERMAL")
    .reduce((s, r) => s + parseInt(r.total_mw), 0) ?? 0;

  const ccgtMw = summary?.byTechnology
    .find(r => r.technology === "CCGT")?.total_mw ?? "0";

  const avgCCGTHR = summary?.byTechnology
    .find(r => r.technology === "CCGT")?.avg_heat_rate ?? "—";

  const coalMw = summary?.byTechnology
    .find(r => r.technology === "STEAM")?.total_mw ?? "0";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            <Flame className="h-6 w-6 text-orange-400" />
            Generator Stack Intelligence
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            ERCOT thermal fleet — merit order, spark spreads, and heat rate analysis.
            Sources: EIA Form 860 (design specs), ERCOT NP3-965-ER (startup costs, ramp rates).
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          {meritData?.units.length ?? 0} thermal units · {Math.round((meritData?.total_thermal_mw ?? 0) / 1000)} GW available
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { icon: Flame,        label: "Total Thermal Fleet",  value: `${Math.round(totalThermalMw / 1000)} GW`,    sub: "ERCOT operating",            color: C.orange },
          { icon: Activity,     label: "CCGT Fleet",           value: `${Math.round(parseInt(ccgtMw) / 1000)} GW`,  sub: `Avg HR ${avgCCGTHR} MMBtu/MWh`, color: C.teal   },
          { icon: BarChart3,    label: "Clearing Price",       value: clearingPrice ? `$${clearingPrice.toFixed(2)}/MWh` : "—",
                                                                sub: `at ${(demandMw/1000).toFixed(0)} GW demand`,  color: C.amber  },
          { icon: TrendingDown, label: "Coal at Risk",         value: `${Math.round(parseInt(coalMw) / 1000)} GW`,  sub: "steam / lignite fleet",      color: C.red    },
        ].map(k => (
          <Card key={k.label} className="bg-slate-800/50 border-slate-700/50">
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="p-1.5 rounded-md" style={{ backgroundColor: `${k.color}22` }}>
                  <k.icon className="h-4 w-4" style={{ color: k.color }} />
                </div>
                <span className="text-xs text-slate-400 uppercase tracking-wide font-medium">{k.label}</span>
              </div>
              <div className="text-2xl font-bold text-slate-100">{k.value}</div>
              <div className="text-xs text-slate-500 mt-0.5">{k.sub}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Controls */}
      <Card className="bg-slate-800/50 border-slate-700/50">
        <CardContent className="pt-4 pb-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <div>
              <div className="flex items-center justify-between mb-2 text-xs">
                <span className="text-slate-400 flex items-center gap-1.5"><Flame className="h-3 w-3 text-orange-400" /> Waha Gas Price</span>
                <span className="font-bold text-orange-400">${gasPrice.toFixed(2)}/MMBtu</span>
              </div>
              <Slider value={[gasPrice]} onValueChange={([v]: number[]) => setGasPrice(Math.round(v * 20) / 20)}
                min={1.00} max={8.00} step={0.25} />
              <div className="flex justify-between text-[10px] text-slate-600 mt-0.5">
                <span>$1.00</span><span>$8.00</span>
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2 text-xs">
                <span className="text-slate-400 flex items-center gap-1.5"><Zap className="h-3 w-3 text-teal-400" /> CO₂ Price</span>
                <span className="font-bold text-teal-400">${co2Price.toFixed(0)}/ton</span>
              </div>
              <Slider value={[co2Price]} onValueChange={([v]: number[]) => setCo2Price(Math.round(v))}
                min={0} max={50} step={5} />
              <div className="flex justify-between text-[10px] text-slate-600 mt-0.5">
                <span>$0</span><span>$50/ton</span>
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2 text-xs">
                <span className="text-slate-400 flex items-center gap-1.5"><Activity className="h-3 w-3 text-amber-400" /> ERCOT Demand</span>
                <span className="font-bold text-amber-400">{(demandMw / 1000).toFixed(0)} GW</span>
              </div>
              <Slider value={[demandMw]} onValueChange={([v]: number[]) => setDemandMw(Math.round(v / 1000) * 1000)}
                min={5000} max={30000} step={1000} />
              <div className="flex justify-between text-[10px] text-slate-600 mt-0.5">
                <span>5 GW</span><span>30 GW (full thermal)</span>
              </div>
            </div>
          </div>

          {clearingPrice && (
            <div className="mt-4 flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="w-8 h-px border-t-2 border-dashed border-amber-400 inline-block" />
                <span className="text-amber-300 font-medium">Implied clearing: ${clearingPrice.toFixed(2)}/MWh at {(demandMw/1000).toFixed(0)} GW</span>
              </div>
              <div className="text-xs text-slate-500">
                CCGT spark spread: <span className={clearingPrice - parseFloat(avgCCGTHR) * gasPrice - 4.5 > 0 ? "text-green-400 font-medium" : "text-red-400 font-medium"}>
                  ${(clearingPrice - parseFloat(avgCCGTHR || "7") * gasPrice - 4.5).toFixed(2)}/MWh
                </span>
              </div>
              {co2Price > 0 && (
                <div className="text-xs text-slate-500">
                  CO₂ premium on coal vs CCGT: <span className="text-teal-400 font-medium">
                    ${((0.95 - 0.40) * co2Price).toFixed(2)}/MWh
                  </span>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Merit Order Chart + Technology Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Merit Order — supply curve */}
        <Card className="lg:col-span-2 bg-slate-800/50 border-slate-700/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-slate-100 text-sm flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-teal-400" />
              Merit Order Supply Curve — ERCOT Thermal Stack
            </CardTitle>
            <p className="text-xs text-slate-500">
              Each step = one generating unit, sorted by marginal cost (heat rate × gas price + VOM).
              Width = available MW capacity. Dashed line = ERCOT system load → implied clearing price.
            </p>
          </CardHeader>
          <CardContent>
            {loadingMerit ? (
              <div className="h-72 flex items-center justify-center text-slate-500 text-sm">
                Computing merit order…
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={supplyCurve} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis
                    dataKey="mw"
                    type="number"
                    domain={[0, meritData?.total_thermal_mw ?? 80000]}
                    tickFormatter={v => `${Math.round(v / 1000)}GW`}
                    tick={{ fill: "#94a3b8", fontSize: 10 }}
                    label={{ value: "Cumulative Capacity (GW)", position: "insideBottom", offset: -4, fill: "#64748b", fontSize: 10 }}
                  />
                  <YAxis
                    domain={[0, 120]}
                    tickFormatter={v => `$${v}`}
                    tick={{ fill: "#94a3b8", fontSize: 10 }}
                    label={{ value: "Marginal Cost ($/MWh)", angle: -90, position: "insideLeft", fill: "#64748b", fontSize: 10, offset: 10 }}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelFormatter={v => `Cumulative: ${Math.round(Number(v) / 1000)} GW`}
                    formatter={(v: number, name: string) => name === "cost" ? [`$${v.toFixed(2)}/MWh`, "Marginal Cost"] : [v, name]}
                  />
                  {/* Color bands by technology */}
                  {meritData?.units
                    .reduce<{tech: string; start: number; end: number}[]>((acc, u) => {
                      const last = acc[acc.length - 1];
                      if (last && last.tech === u.technology) { last.end = u.end_mw; return acc; }
                      acc.push({ tech: u.technology, start: u.start_mw, end: u.end_mw });
                      return acc;
                    }, [])
                    .map((band, i) => (
                      <Area
                        key={i}
                        type="stepAfter"
                        dataKey={undefined as unknown as string}
                        fill={TECH_COLORS[band.tech] ?? C.slate}
                        fillOpacity={0.08}
                        stroke="none"
                        activeDot={false}
                        legendType="none"
                      />
                    ))
                  }
                  <Line
                    type="stepAfter"
                    dataKey="cost"
                    stroke={C.teal}
                    strokeWidth={2.5}
                    dot={false}
                    activeDot={{ r: 3 }}
                    name="Marginal Cost"
                    legendType="none"
                  />
                  {clearingPrice && (
                    <ReferenceLine
                      y={clearingPrice}
                      stroke={C.amber}
                      strokeDasharray="4 3"
                      strokeWidth={1.5}
                      label={{ value: `$${clearingPrice.toFixed(0)}/MWh clearing`, position: "right", fill: C.amber, fontSize: 10 }}
                    />
                  )}
                  <ReferenceLine
                    x={demandMw}
                    stroke={C.amber}
                    strokeDasharray="4 3"
                    strokeWidth={1.5}
                    label={{ value: `${(demandMw/1000).toFixed(0)} GW demand`, position: "top", fill: C.amber, fontSize: 10 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            )}

            {/* Technology legend */}
            <div className="flex flex-wrap gap-3 mt-2">
              {Object.entries(TECH_LABELS).map(([tech, label]) => (
                <div key={tech} className="flex items-center gap-1.5 text-xs">
                  <div className="w-3 h-3 rounded-sm" style={{ backgroundColor: TECH_COLORS[tech] }} />
                  <span className="text-slate-400">{label}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Technology Capacity Breakdown */}
        <Card className="bg-slate-800/50 border-slate-700/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-slate-100 text-sm">Capacity by Technology</CardTitle>
            <p className="text-xs text-slate-500">Available MW after EFOR adjustment</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {techBreakdown.map(t => (
              <div key={t.tech}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-slate-300 font-medium">{t.label}</span>
                  <span className="text-slate-400">{(t.mw / 1000).toFixed(1)} GW</span>
                </div>
                <div className="h-5 bg-slate-700/50 rounded overflow-hidden">
                  <div
                    className="h-full rounded transition-all duration-500 flex items-center px-2"
                    style={{
                      width: `${Math.round(t.mw / (meritData?.total_thermal_mw ?? 1) * 100)}%`,
                      backgroundColor: t.color,
                      opacity: 0.8,
                    }}
                  >
                    <span className="text-[10px] font-bold text-white/90 whitespace-nowrap">
                      ${t.avgCost}/MWh
                    </span>
                  </div>
                </div>
              </div>
            ))}

            {/* Spark spread insight */}
            {clearingPrice && (
              <div className="mt-4 pt-3 border-t border-slate-700/50 space-y-2">
                <p className="text-xs font-semibold text-slate-300">Spark Spread @ ${gasPrice.toFixed(2)} Waha</p>
                {techBreakdown.map(t => {
                  const spread = clearingPrice - t.avgCost;
                  return (
                    <div key={t.tech} className="flex items-center justify-between text-xs">
                      <span className="text-slate-400">{t.tech}</span>
                      <span className={`font-medium ${spread > 0 ? "text-green-400" : "text-red-400"}`}>
                        {spread > 0 ? "+" : ""}{spread.toFixed(1)}/MWh
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Insights row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-teal-900/20 border border-teal-500/20 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="h-4 w-4 text-teal-400" />
            <span className="text-xs font-semibold text-teal-300">Marginal Setter at {(demandMw/1000).toFixed(0)} GW</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            {clearingPrice && meritData ? (() => {
              const u = meritData.units.find(u => u.end_mw >= demandMw);
              return u
                ? `${u.plant_name} (${u.technology}, ${u.load_zone}) sets the clearing price at $${clearingPrice.toFixed(2)}/MWh. Heat rate ${u.design_heat_rate.toFixed(2)} × $${gasPrice.toFixed(2)} Waha + $${u.vom_per_mwh.toFixed(2)} VOM.`
                : "No marginal unit found — demand exceeds thermal capacity.";
            })() : "Set demand level with the slider above."}
          </p>
        </div>

        <div className="bg-amber-900/20 border border-amber-500/20 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Settings2 className="h-4 w-4 text-amber-400" />
            <span className="text-xs font-semibold text-amber-300">Retirement Risk Screening</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            At ${gasPrice.toFixed(2)}/MMBtu Waha gas:{" "}
            {meritData ? (() => {
              const uneconomic = meritData.units.filter(u => u.marginal_cost > 60);
              const mw = uneconomic.reduce((s, u) => s + u.available_mw, 0);
              return `${uneconomic.length} units (${Math.round(mw / 1000)} GW) have marginal cost > $60/MWh — structural retirement candidates unless summer scarcity rents sustain them.`;
            })() : "Loading…"}
          </p>
        </div>

        <div className={`rounded-xl p-4 border ${co2Price > 0 ? "bg-green-900/20 border-green-500/20" : "bg-slate-800/50 border-slate-700/50"}`}>
          <div className="flex items-center gap-2 mb-2">
            <Wind className="h-4 w-4 text-green-400" />
            <span className="text-xs font-semibold text-green-300">Carbon Price Signal</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            {co2Price > 0
              ? `At $${co2Price}/ton CO₂: coal/lignite marginal cost rises $${(1.05 * co2Price).toFixed(2)}/MWh, CCGT rises $${(0.40 * co2Price).toFixed(2)}/MWh. Net advantage to CCGT over coal: $${((1.05 - 0.40) * co2Price).toFixed(2)}/MWh. This is the implicit "clean dispatch" signal.`
              : "Drag the CO₂ price slider above to see how a carbon price reshapes the merit order and favors gas over coal dispatch."}
          </p>
        </div>
      </div>

      {/* Generator Table */}
      <Card className="bg-slate-800/50 border-slate-700/50">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="text-slate-100 text-sm">Generator Characteristics</CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Technology filter */}
              {["All", "CCGT", "CT", "STEAM"].map(t => (
                <button
                  key={t}
                  onClick={() => setTechFilter(t === "All" ? null : t)}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    (t === "All" && !techFilter) || techFilter === t
                      ? "bg-teal-600/30 text-teal-300 border border-teal-500/40"
                      : "text-slate-400 hover:text-slate-200 border border-transparent"
                  }`}
                >
                  {t === "All" ? "All" : TECH_LABELS[t]?.split(" ")[0] ?? t}
                </button>
              ))}
              <input
                type="text"
                placeholder="Search plant or operator…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="bg-slate-900/60 border border-slate-600/50 rounded px-3 py-1 text-xs text-slate-200 placeholder-slate-500 w-48 focus:outline-none focus:border-teal-500/50"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-500 uppercase tracking-wide border-b border-slate-700/50">
                  <th className="text-left px-4 py-2.5 font-medium">Plant</th>
                  <th className="text-left px-3 py-2.5 font-medium">Type</th>
                  <th className="text-right px-3 py-2.5 font-medium">MW</th>
                  <th className="text-right px-3 py-2.5 font-medium">Heat Rate</th>
                  <th className="text-right px-3 py-2.5 font-medium">VOM</th>
                  <th className="text-right px-3 py-2.5 font-medium">Marg. Cost</th>
                  <th className="text-right px-3 py-2.5 font-medium">Spark Spread</th>
                  <th className="text-right px-3 py-2.5 font-medium">CO₂ (t/MWh)</th>
                  <th className="text-right px-3 py-2.5 font-medium">Cold Start</th>
                  <th className="text-right px-3 py-2.5 font-medium">Ramp</th>
                  <th className="text-right px-3 py-2.5 font-medium">Year</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map(g => (
                  <tr key={g.id} className="border-t border-slate-700/30 hover:bg-slate-700/20">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-200 whitespace-nowrap">{g.plant_name}</div>
                      <div className="text-slate-500">{g.operator}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold border"
                        style={{ color: TECH_COLORS[g.technology], borderColor: `${TECH_COLORS[g.technology]}40`, backgroundColor: `${TECH_COLORS[g.technology]}18` }}>
                        {g.technology}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-300">
                      {parseFloat(g.nameplate_mw).toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-300">
                      {g.design_heat_rate ? `${parseFloat(g.design_heat_rate).toFixed(2)}` : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-400">
                      ${g.vom_per_mwh ? parseFloat(g.vom_per_mwh).toFixed(2) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right font-medium" style={{ color: TECH_COLORS[g.technology] }}>
                      ${g.mc.toFixed(2)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold">
                      {g.spark !== null
                        ? <span className={g.spark > 0 ? "text-green-400" : "text-red-400"}>
                            {g.spark > 0 ? "+" : ""}{g.spark.toFixed(2)}
                          </span>
                        : <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-400">
                      {g.co2_rate_tons_mwh ? parseFloat(g.co2_rate_tons_mwh).toFixed(3) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-400">
                      {g.startup_cost_cold ? `$${Math.round(parseFloat(g.startup_cost_cold) / 1000)}k` : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-400">
                      {g.ramp_rate_mw_min ? `${parseFloat(g.ramp_rate_mw_min).toFixed(1)} MW/m` : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-500">
                      {g.commissioning_year ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {tableRows.length === 0 && (
              <div className="text-center py-8 text-slate-500 text-sm">No generators match filter</div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Methodology note */}
      <div className="bg-slate-800/30 border border-slate-700/30 rounded-xl p-4">
        <div className="flex items-start gap-2">
          <Info className="h-4 w-4 text-slate-500 mt-0.5 shrink-0" />
          <p className="text-xs text-slate-500 leading-relaxed">
            <strong className="text-slate-400">Data sources:</strong> Design heat rates from EIA Form 860 Schedule 3 (2024 annual survey, operable units).
            Startup costs ($k/start) and ramp rates (MW/min) from ERCOT NP3-965-ER 60-Day SCED disclosure — ranges validated against published ERCOT offer-curve data.
            VOM from FERC Form 1 O&M allocation. CO₂ rates from EPA CAMPD CEMS (tons/MWh net generation, 2023 actuals).
            Forced outage rates from NERC GADS 2023 (thermal, ERCOT region). Coal/lignite marginal costs use implied fuel costs from EIA Form 923 delivered coal prices — not sensitive to Waha gas price.
          </p>
        </div>
      </div>
    </div>
  );
}
