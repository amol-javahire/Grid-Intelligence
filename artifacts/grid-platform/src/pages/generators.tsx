import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Flame, Zap, Wind, Sun, Battery, AlertTriangle, TrendingDown,
  Info, BarChart3, Settings2, Activity, BookOpen, Target, FlaskConical,
} from "lucide-react";
import {
  ComposedChart, Area, Line, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine, Cell,
  BarChart, PieChart, Pie,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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

// EIA 860 capacity factors by asset type (ERCOT 2024 actuals)
const CF_ERCOT: Record<string, number> = {
  natural_gas: 0.60, wind: 0.38, solar: 0.27,
  storage: 0.18, nuclear: 0.92, hydro: 0.40, biomass: 0.65,
};

const FUEL_TABS = [
  { id: "gas",     label: "Gas",     icon: Flame,    color: "#f97316", assetType: "natural_gas" },
  { id: "wind",    label: "Wind",    icon: Wind,     color: "#3b82f6", assetType: "wind"        },
  { id: "solar",   label: "Solar",   icon: Sun,      color: "#f59e0b", assetType: "solar"       },
  { id: "storage", label: "Storage", icon: Battery,  color: "#8b5cf6", assetType: "storage"     },
  { id: "nuclear", label: "Nuclear", icon: Zap,      color: "#22c55e", assetType: "nuclear"     },
  { id: "hydro",   label: "Hydro",   icon: Activity, color: "#14b8a6", assetType: "hydro"       },
  { id: "biomass", label: "Biomass", icon: AlertTriangle, color: "#84cc16", assetType: "biomass" },
] as const;
type FuelTab = typeof FUEL_TABS[number]["id"];

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

interface EiaGenerator {
  id: number;
  name: string;
  asset_type: string;
  capacity_mw: string;
  state: string | null;
  county: string | null;
  commissioning_year: number | null;
  interconnection_node: string | null;
  pricing_hub_node: string | null;
  curtailment_score: string | null;
  price_score: string | null;
  overall_score: string;
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
  const [iso]          = useState<"ERCOT">("ERCOT");
  // Gas price: Henry Hub + Waha basis
  const [hhPrice,   setHhPrice]   = useState(3.20);   // Henry Hub $/MMBtu
  const [wahaBasis, setWahaBasis] = useState(-0.50);  // Waha vs HH spread
  const [co2Price,  setCo2Price]  = useState(0);
  const [systemLoadGw, setSystemLoadGw] = useState(60); // Total ERCOT system load GW
  const [techFilter, setTechFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [fuelTab, setFuelTab] = useState<FuelTab>("gas");

  // Derived gas / demand values
  const wahaPrice        = Math.max(0.10, hhPrice + wahaBasis);
  const renewableOffsetMw = 35_000; // ~35 GW estimated wind+solar average output
  const thermalNetLoadMw  = Math.max(0, systemLoadGw * 1_000 - renewableOffsetMw);

  // ── API calls ──────────────────────────────────────────────────────────────
  const { data: meritData, isLoading: loadingMerit } = useQuery<MeritOrderResp>({
    queryKey: ["merit-order", iso, wahaPrice, co2Price],
    queryFn:  () => fetch(`/api/generators/merit-order?iso=${iso}&gas_price=${wahaPrice}&co2_price=${co2Price}`).then(r => r.json()),
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

  const activeTabDef = FUEL_TABS.find(t => t.id === fuelTab)!;
  const { data: eiaFleet = [], isLoading: loadingEia } = useQuery<EiaGenerator[]>({
    queryKey: ["eia-fleet", iso, activeTabDef.assetType],
    queryFn:  () => fetch(`/api/generators/eia-fleet?iso=${iso}&asset_type=${activeTabDef.assetType}`).then(r => r.json()),
    staleTime: 60 * 60_000,
    enabled: fuelTab !== "gas",
  });

  // ── Derived data ───────────────────────────────────────────────────────────
  const supplyCurve = useMemo(() =>
    meritData ? buildSupplyCurve(meritData.units) : [], [meritData]);

  const techBreakdown = useMemo(() =>
    meritData ? buildTechBreakdown(meritData.units) : [], [meritData]);

  // Clearing price: interpolate where cumulative_mw crosses thermalNetLoadMw
  const clearingPrice = useMemo(() => {
    if (!meritData) return null;
    const unit = meritData.units.find(u => u.end_mw >= thermalNetLoadMw);
    // If net load exceeds full thermal stack → scarcity
    if (!unit && thermalNetLoadMw > 0) return null;
    return unit ? unit.marginal_cost : null;
  }, [meritData, thermalNetLoadMw]);

  const isScarcity = meritData ? thermalNetLoadMw > (meritData.total_thermal_mw ?? 0) : false;

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
        const fuelCost = g.implied_fuel_cost_per_mmb ? parseFloat(g.implied_fuel_cost_per_mmb) : wahaPrice;
        const mc     = hr * fuelCost + vom;
        const spark  = g.fuel_primary === "NG" && clearingPrice ? clearingPrice - mc : null;
        return { ...g, mc: Math.round(mc * 100) / 100, spark, mw, efor };
      })
      .sort((a, b) => a.mc - b.mc);
  }, [allGenerators, techFilter, search, wahaPrice, clearingPrice]);

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
            Full ERCOT generating fleet — merit order dispatch, spark spreads, and EIA 860 plant data by fuel type.
            Sources: EIA Form 860 (2024), ERCOT NP3-965-ER (startup costs, ramp rates).
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          {meritData?.units.length ?? 0} thermal units · {Math.round((meritData?.total_thermal_mw ?? 0) / 1000)} GW available
        </div>
      </div>

      {/* Explainer panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="bg-slate-800/50 border-slate-700/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5 text-slate-100">
              <BookOpen className="h-4 w-4 text-orange-400" />
              What This Tool Does
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-slate-400 space-y-2">
            <p>
              Visualises the <span className="text-slate-200 font-medium">ERCOT thermal merit-order dispatch stack</span> using
              real heat rates and capacities from EIA Form 860 (2024) and EIA 923. Drag the system load slider to see which
              units are dispatched at any net demand level and what the marginal clearing price is.
            </p>
            <p>
              Covers 31 ERCOT thermal plants across CCGT, combustion turbine, and steam technologies.
              The <span className="text-slate-200 font-medium">gas price slider</span> adjusts every unit's marginal cost
              in real time, showing how fuel shocks shift the dispatch order and spark spreads.
            </p>
            <p>
              Browse by fuel type (Gas, Wind, Solar, Storage, Nuclear, Hydro, Biomass) to explore technology economics,
              capacity factors, and CO₂ intensity across the full EIA 860 fleet.
            </p>
          </CardContent>
        </Card>

        <Card className="bg-slate-800/50 border-slate-700/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5 text-slate-100">
              <Target className="h-4 w-4 text-amber-400" />
              Use Cases
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-slate-400 space-y-2">
            <ul className="space-y-1.5 list-none">
              {[
                ["Trader / Analyst", "What is the clearing price at 22 GW net load with $5 gas? → Drag both sliders — read clearing price KPI and marginal unit name."],
                ["Developer / New Entrant", "Which retiring steam plants create headroom for new capacity? → Identify high-HR steam units at the top of the merit stack."],
                ["IPP", "Where does a new 800 MW CCGT sit in the merit order vs the existing fleet? → Match its heat rate to the stack to see when it would be marginal."],
                ["PE / Credit Analyst", "What are real EIA-reported heat rates and CO₂ rates for ERCOT thermal benchmark plants? → Browse the plant detail table."],
              ].map(([role, a]) => (
                <li key={role} className="border-l-2 border-orange-500/30 pl-2">
                  <p className="text-slate-200 font-medium leading-tight">{role}</p>
                  <p className="text-slate-400 mt-0.5">{a}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card className="bg-slate-800/50 border-slate-700/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5 text-slate-100">
              <FlaskConical className="h-4 w-4 text-purple-400" />
              Key Assumptions
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-slate-400 space-y-1.5">
            {[
              ["Fleet", "31 real ERCOT thermal plants from EIA 860 (2024) — CCGT, CT, steam. Real design heat rates from EIA 923."],
              ["Demand slider", "Net thermal load = total system demand minus variable renewable (wind + solar) output at selected CF."],
              ["Dispatch model", "Pure merit-order (economic dispatch). No unit commitment, ramp constraints, or minimum run times."],
              ["Marginal cost", "MC = HH price × design heat rate + $2/MWh VOM. Start-up costs shown separately but not in dispatch."],
              ["Wind / Solar", "Zero marginal cost must-run in merit-order model. Output = nameplate × CF slider (wind 0–75%, solar 0–50%)."],
              ["Coal at risk", "Steam / lignite units with heat rates >12 MMBtu/MWh are flagged — most are uneconomic vs CCGT at >$3 gas."],
              ["CO₂ rate", "From EIA 923 reported emissions ÷ net generation (lbs/MWh), converted to short tons/MWh."],
            ].map(([k, v]) => (
              <div key={k}>
                <span className="text-slate-200 font-medium">{k}: </span>
                <span>{v}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { icon: Flame,        label: "Total Thermal Fleet",  value: `${Math.round(totalThermalMw / 1000)} GW`,    sub: "ERCOT operating",            color: C.orange },
          { icon: Activity,     label: "CCGT Fleet",           value: `${Math.round(parseInt(ccgtMw) / 1000)} GW`,  sub: `Avg HR ${avgCCGTHR} MMBtu/MWh`, color: C.teal   },
          { icon: BarChart3,    label: "Clearing Price",
            value: isScarcity ? "SCARCITY" : clearingPrice ? `$${clearingPrice.toFixed(2)}/MWh` : "—",
            sub: isScarcity ? "Net load exceeds thermal fleet" : `${systemLoadGw} GW load · ${Math.round(thermalNetLoadMw/1000)} GW net thermal`,
            color: isScarcity ? C.red : C.amber },
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">

            {/* Henry Hub Price */}
            <div>
              <div className="flex items-center justify-between mb-2 text-xs">
                <span className="text-slate-400 flex items-center gap-1.5">
                  <Flame className="h-3 w-3 text-orange-400" /> Henry Hub
                </span>
                <span className="font-bold text-orange-400">${hhPrice.toFixed(2)}/MMBtu</span>
              </div>
              <Slider value={[hhPrice]} onValueChange={([v]: number[]) => setHhPrice(Math.round(v * 10) / 10)}
                min={2.00} max={6.00} step={0.10} />
              <div className="flex justify-between text-[10px] text-slate-600 mt-0.5">
                <span>$2.00</span><span>$6.00</span>
              </div>
            </div>

            {/* Waha Basis vs HH */}
            <div>
              <div className="flex items-center justify-between mb-2 text-xs">
                <span className="text-slate-400 flex items-center gap-1.5">
                  <TrendingDown className="h-3 w-3 text-orange-300" /> Waha Basis vs HH
                </span>
                <span className={`font-bold ${wahaBasis >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {wahaBasis >= 0 ? "+" : ""}{wahaBasis.toFixed(2)} → <span className="text-orange-400">${wahaPrice.toFixed(2)}</span>
                </span>
              </div>
              <Slider value={[wahaBasis]} onValueChange={([v]: number[]) => setWahaBasis(Math.round(v * 4) / 4)}
                min={-15} max={5} step={0.25} />
              <div className="flex justify-between text-[10px] text-slate-600 mt-0.5">
                <span>-$15 (deep discount)</span><span>+$5 (premium)</span>
              </div>
            </div>

            {/* CO2 Price */}
            <div>
              <div className="flex items-center justify-between mb-2 text-xs">
                <span className="text-slate-400 flex items-center gap-1.5">
                  <Zap className="h-3 w-3 text-teal-400" /> CO₂ Price
                </span>
                <span className="font-bold text-teal-400">${co2Price.toFixed(0)}/ton</span>
              </div>
              <Slider value={[co2Price]} onValueChange={([v]: number[]) => setCo2Price(Math.round(v / 5) * 5)}
                min={0} max={100} step={5} />
              <div className="flex justify-between text-[10px] text-slate-600 mt-0.5">
                <span>$0</span>
                <span className="text-slate-500">CA ~$28 · 2030 est. $65+</span>
                <span>$100</span>
              </div>
            </div>

            {/* ERCOT System Load */}
            <div>
              <div className="flex items-center justify-between mb-2 text-xs">
                <span className="text-slate-400 flex items-center gap-1.5">
                  <Activity className="h-3 w-3 text-amber-400" /> ERCOT System Load
                </span>
                <span className="font-bold text-amber-400">{systemLoadGw} GW</span>
              </div>
              <Slider value={[systemLoadGw]} onValueChange={([v]: number[]) => setSystemLoadGw(Math.round(v))}
                min={40} max={100} step={1} />
              <div className="flex justify-between text-[10px] text-slate-600 mt-0.5">
                <span>40 GW</span>
                <span className="text-slate-500">avg 60–85 · 2026 peak 92</span>
                <span>100 GW</span>
              </div>
            </div>
          </div>

          {/* Computed summary row */}
          <div className="mt-4 flex items-center gap-4 flex-wrap border-t border-slate-700/40 pt-3">
            <div className="text-xs text-slate-500">
              Net thermal load: <span className="text-amber-300 font-semibold">{Math.round(thermalNetLoadMw / 1000)} GW</span>
              <span className="text-slate-600"> ({systemLoadGw} GW total − ~35 GW wind+solar est.)</span>
            </div>
            {isScarcity ? (
              <div className="flex items-center gap-1.5 text-xs text-red-400 font-semibold">
                <AlertTriangle className="h-3 w-3" />
                Thermal net load exceeds fleet — ORDC scarcity pricing applies ($5,000/MWh cap)
              </div>
            ) : clearingPrice ? (
              <>
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="w-8 h-px border-t-2 border-dashed border-amber-400 inline-block" />
                  <span className="text-amber-300 font-medium">Clearing: ${clearingPrice.toFixed(2)}/MWh</span>
                </div>
                <div className="text-xs text-slate-500">
                  CCGT spark spread:{" "}
                  <span className={clearingPrice - parseFloat(avgCCGTHR || "7") * wahaPrice - 4.5 > 0 ? "text-green-400 font-medium" : "text-red-400 font-medium"}>
                    ${(clearingPrice - parseFloat(avgCCGTHR || "7") * wahaPrice - 4.5).toFixed(2)}/MWh
                  </span>
                </div>
                {co2Price > 0 && (
                  <div className="text-xs text-slate-500">
                    CO₂ premium coal vs CCGT:{" "}
                    <span className="text-teal-400 font-medium">${((0.95 - 0.40) * co2Price).toFixed(2)}/MWh</span>
                  </div>
                )}
              </>
            ) : null}
          </div>
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
                    x={thermalNetLoadMw}
                    stroke={C.amber}
                    strokeDasharray="4 3"
                    strokeWidth={1.5}
                    label={{ value: `${Math.round(thermalNetLoadMw/1000)} GW net thermal`, position: "top", fill: C.amber, fontSize: 10 }}
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
                <p className="text-xs font-semibold text-slate-300">Spark Spread @ ${wahaPrice.toFixed(2)} Waha</p>
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
            <span className="text-xs font-semibold text-teal-300">Marginal Setter at {Math.round(thermalNetLoadMw/1000)} GW net thermal</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            {isScarcity
              ? `At ${systemLoadGw} GW total load (${Math.round(thermalNetLoadMw/1000)} GW thermal net), demand exceeds the ${Math.round((meritData?.total_thermal_mw ?? 0)/1000)} GW thermal fleet. ORDC scarcity pricing applies — up to $5,000/MWh.`
              : clearingPrice && meritData ? (() => {
              const u = meritData.units.find(u => u.end_mw >= thermalNetLoadMw);
              return u
                ? `${u.plant_name} (${u.technology}, ${u.load_zone}) sets the clearing price at $${clearingPrice.toFixed(2)}/MWh. Heat rate ${u.design_heat_rate.toFixed(2)} × $${wahaPrice.toFixed(2)} Waha + $${u.vom_per_mwh.toFixed(2)} VOM.`
                : "No marginal unit found.";
            })() : "Adjust system load and gas sliders above."}
          </p>
        </div>

        <div className="bg-amber-900/20 border border-amber-500/20 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Settings2 className="h-4 w-4 text-amber-400" />
            <span className="text-xs font-semibold text-amber-300">Retirement Risk Screening</span>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            At ${wahaPrice.toFixed(2)}/MMBtu Waha gas:{" "}
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

      {/* Generator Characteristics — full ERCOT fleet, tabbed by fuel type */}
      <Card className="bg-slate-800/50 border-slate-700/50">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="text-slate-100 text-sm">Generator Characteristics — ERCOT Fleet</CardTitle>
              <p className="text-xs text-slate-500 mt-0.5">
                {fuelTab === "gas"
                  ? `${tableRows.length} thermal units · EIA 860 + ERCOT NP3-965-ER dispatch parameters`
                  : `${eiaFleet.filter(g => !search || g.name.toLowerCase().includes(search.toLowerCase())).length} of ${eiaFleet.length} ${activeTabDef.label.toLowerCase()} generators · EIA Form 860 (2024)`}
              </p>
            </div>
            {/* Fuel type tabs */}
            <div className="flex items-center gap-1 flex-wrap">
              {FUEL_TABS.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => { setFuelTab(tab.id); setTechFilter(null); setSearch(""); }}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors border ${
                    fuelTab === tab.id ? "" : "border-transparent text-slate-400 hover:text-slate-200"
                  }`}
                  style={fuelTab === tab.id ? {
                    backgroundColor: `${tab.color}20`,
                    borderColor: `${tab.color}50`,
                    color: tab.color,
                  } : {}}
                >
                  <tab.icon className="h-3 w-3" />
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Sub-filter row */}
          <div className="flex items-center gap-2 flex-wrap mt-2">
            {fuelTab === "gas" && ["All", "CCGT", "CT", "STEAM"].map(t => (
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
              placeholder="Search plant…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="bg-slate-900/60 border border-slate-600/50 rounded px-3 py-1 text-xs text-slate-200 placeholder-slate-500 w-44 focus:outline-none focus:border-teal-500/50 ml-auto"
            />
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <div className="overflow-x-auto">
            {fuelTab === "gas" ? (
              /* ── Thermal / Gas: full dispatch parameters ── */
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
                    <th className="text-right px-3 py-2.5 font-medium">CO₂ t/MWh</th>
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
                      <td className="px-3 py-2.5 text-right text-slate-300">{parseFloat(g.nameplate_mw).toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-right text-slate-300">{g.design_heat_rate ? parseFloat(g.design_heat_rate).toFixed(2) : "—"}</td>
                      <td className="px-3 py-2.5 text-right text-slate-400">${g.vom_per_mwh ? parseFloat(g.vom_per_mwh).toFixed(2) : "—"}</td>
                      <td className="px-3 py-2.5 text-right font-medium" style={{ color: TECH_COLORS[g.technology] }}>${g.mc.toFixed(2)}</td>
                      <td className="px-3 py-2.5 text-right font-semibold">
                        {g.spark !== null
                          ? <span className={g.spark > 0 ? "text-green-400" : "text-red-400"}>{g.spark > 0 ? "+" : ""}{g.spark.toFixed(2)}</span>
                          : <span className="text-slate-600">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right text-slate-400">{g.co2_rate_tons_mwh ? parseFloat(g.co2_rate_tons_mwh).toFixed(3) : "—"}</td>
                      <td className="px-3 py-2.5 text-right text-slate-400">{g.startup_cost_cold ? `$${Math.round(parseFloat(g.startup_cost_cold) / 1000)}k` : "—"}</td>
                      <td className="px-3 py-2.5 text-right text-slate-400">{g.ramp_rate_mw_min ? `${parseFloat(g.ramp_rate_mw_min).toFixed(1)} MW/m` : "—"}</td>
                      <td className="px-3 py-2.5 text-right text-slate-500">{g.commissioning_year ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : loadingEia ? (
              <div className="text-center py-12 text-slate-500 text-sm">Loading {activeTabDef.label} generators…</div>
            ) : (
              /* ── Non-thermal: EIA 860 fleet table ── */
              (() => {
                const cf = CF_ERCOT[activeTabDef.assetType] ?? 0.30;
                const filtered = eiaFleet.filter(g =>
                  !search || g.name.toLowerCase().includes(search.toLowerCase()) ||
                  (g.county ?? "").toLowerCase().includes(search.toLowerCase())
                );
                return (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-slate-500 uppercase tracking-wide border-b border-slate-700/50">
                        <th className="text-left px-4 py-2.5 font-medium">Plant / Project</th>
                        <th className="text-right px-3 py-2.5 font-medium">MW</th>
                        <th className="text-left px-3 py-2.5 font-medium">Node / Hub</th>
                        <th className="text-left px-3 py-2.5 font-medium">County</th>
                        <th className="text-right px-3 py-2.5 font-medium">COD Year</th>
                        <th className="text-right px-3 py-2.5 font-medium">Cap Factor</th>
                        <th className="text-right px-3 py-2.5 font-medium">Annual GWh</th>
                        <th className="text-right px-3 py-2.5 font-medium">Curt. Score</th>
                        <th className="text-right px-3 py-2.5 font-medium">Overall Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map(g => {
                        const mw  = parseFloat(g.capacity_mw);
                        const gwh = Math.round(mw * cf * 8760 / 1000);
                        const cs  = g.curtailment_score ? parseFloat(g.curtailment_score) : null;
                        const os  = parseFloat(g.overall_score);
                        const node = g.interconnection_node ?? g.pricing_hub_node ?? "—";
                        return (
                          <tr key={g.id} className="border-t border-slate-700/30 hover:bg-slate-700/20">
                            <td className="px-4 py-2.5">
                              <div className="font-medium text-slate-200 whitespace-nowrap">{g.name}</div>
                              <div className="text-slate-500 text-[10px]">{g.state ?? "TX"} · EIA 860</div>
                            </td>
                            <td className="px-3 py-2.5 text-right text-slate-300 font-medium">{mw.toLocaleString()}</td>
                            <td className="px-3 py-2.5 text-left">
                              <span className="text-teal-400 font-mono text-[10px]">{node.length > 18 ? node.slice(0, 18) + "…" : node}</span>
                            </td>
                            <td className="px-3 py-2.5 text-left text-slate-400">{g.county ?? "—"}</td>
                            <td className="px-3 py-2.5 text-right text-slate-400">{g.commissioning_year ?? "—"}</td>
                            <td className="px-3 py-2.5 text-right text-slate-300">{(cf * 100).toFixed(0)}%</td>
                            <td className="px-3 py-2.5 text-right text-slate-300">{gwh.toLocaleString()}</td>
                            <td className="px-3 py-2.5 text-right">
                              {cs !== null ? (
                                <span className={cs >= 70 ? "text-green-400 font-medium" : cs >= 50 ? "text-amber-400" : "text-red-400"}>
                                  {cs.toFixed(0)}
                                </span>
                              ) : <span className="text-slate-600">—</span>}
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              <span className={os >= 70 ? "text-green-400 font-semibold" : os >= 50 ? "text-amber-400 font-medium" : "text-slate-400"}>
                                {os.toFixed(1)}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                );
              })()
            )}
            {fuelTab === "gas" && tableRows.length === 0 && (
              <div className="text-center py-8 text-slate-500 text-sm">No generators match filter</div>
            )}
            {fuelTab !== "gas" && !loadingEia && eiaFleet.length === 0 && (
              <div className="text-center py-8 text-slate-500 text-sm">No {activeTabDef.label} generators in ERCOT</div>
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
