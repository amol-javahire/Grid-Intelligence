import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  Legend, ResponsiveContainer, Cell, LineChart, Line,
  ReferenceLine,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { ChevronLeft, ChevronRight, Loader2, Zap, TrendingUp, Database, Activity } from "lucide-react";

// ── Palette ────────────────────────────────────────────────────────────────────
const C = {
  teal:   "#14b8a6",
  amber:  "#f59e0b",
  purple: "#8b5cf6",
  red:    "#ef4444",
  green:  "#22c55e",
  blue:   "#3b82f6",
  orange: "#f97316",
  slate:  "#64748b",
  tooltipBg: "#0f172a", tooltipBorder: "#1e293b", tooltipFg: "#f8fafc",
};

const FUEL_COLOR: Record<string, string> = {
  wind:        C.teal,
  solar:       C.amber,
  natural_gas: C.orange,
  coal:        C.slate,
  nuclear:     C.purple,
  storage:     C.blue,
  hydro:       C.green,
  other:       "#94a3b8",
};

const FUEL_LABEL: Record<string, string> = {
  wind:        "Wind",
  solar:       "Solar",
  natural_gas: "Natural Gas",
  coal:        "Coal",
  nuclear:     "Nuclear",
  storage:     "Storage",
  hydro:       "Hydro",
  other:       "Other",
};

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmtMonth = (y: number, m: number) => `${MONTHS[m-1]}'${String(y).slice(2)}`;

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
async function apiFetch<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

// ── Types ──────────────────────────────────────────────────────────────────────
interface SeedStatus {
  total_rows: number; total_resources: number;
  min_hour: string;   max_hour: string; days_seeded: number;
}

interface StackRow {
  resource_name:   string;
  resource_type:   string;
  avg_mw:          number;
  hsl:             number;
  offer_price_min: number | null;
  offer_price_max: number | null;
  offer_mw_total:  number | null;
  capacity_factor: number | null;
}

interface SummaryRow {
  year: number; month: number; resource_type: string;
  total_mwh: number; avg_cf: number; avg_offer_price: number; resource_count: number;
}

interface CFRow {
  resource_type: string; avg_cf: number;
  total_resources: number; avg_offer_price: number;
}

// ── Tooltip ───────────────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string; fill?: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded border p-2 text-xs shadow-lg"
         style={{ backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, color: C.tooltipFg }}>
      <p className="font-semibold mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color ?? p.fill }}>
          {p.name}: {p.value != null ? Number(p.value).toLocaleString("en-US", { maximumFractionDigits: 1 }) : "—"}
        </p>
      ))}
    </div>
  );
}

// ── Supply Stack Chart ─────────────────────────────────────────────────────────
function SupplyStack({ start, end }: { start: string; end: string }) {
  const isRange = start !== end;
  const queryKey = isRange ? ["ercot-supply-stack", start, end] : ["ercot-supply-stack", start];
  const url = isRange
    ? `/api/ercot/dispatch/supply-stack?start=${start}&end=${end}`
    : `/api/ercot/dispatch/supply-stack?date=${start}`;

  const { data, isLoading, error } = useQuery<StackRow[]>({
    queryKey,
    queryFn:  () => apiFetch(url),
    staleTime: 5 * 60_000,
    enabled:  !!start,
  });

  const chartData = useMemo(() => {
    if (!data) return [];
    // Build step-function merit order: cumulative MW on x-axis, offer price on y-axis
    let cumMw = 0;
    return data
      .filter(r => r.avg_mw > 0)
      .sort((a, b) => (a.offer_price_min ?? -999) - (b.offer_price_min ?? -999))
      .map(r => {
        const mw = Number(r.avg_mw);
        cumMw += mw;
        return {
          resource_name:  r.resource_name,
          resource_type:  r.resource_type,
          cumulative_mw:  Math.round(cumMw),
          offer_price:    r.offer_price_min != null ? Number(r.offer_price_min) : null,
          avg_mw:         mw,
          hsl:            Number(r.hsl),
          capacity_factor: r.capacity_factor != null ? Number(r.capacity_factor) : null,
        };
      });
  }, [data]);

  // Aggregate by fuel type for the bar chart
  const fuelAgg = useMemo(() => {
    if (!data) return [];
    const byType: Record<string, { avg_mw: number; hsl: number; count: number }> = {};
    data.forEach(r => {
      const t = r.resource_type;
      if (!byType[t]) byType[t] = { avg_mw: 0, hsl: 0, count: 0 };
      byType[t].avg_mw += Number(r.avg_mw);
      byType[t].hsl    += Number(r.hsl);
      byType[t].count  += 1;
    });
    return Object.entries(byType)
      .map(([type, v]) => ({
        type,
        label:  FUEL_LABEL[type] ?? type,
        avg_mw: Math.round(v.avg_mw),
        hsl:    Math.round(v.hsl),
        cf:     v.hsl > 0 ? Math.round((v.avg_mw / v.hsl) * 100) : 0,
        count:  v.count,
        color:  FUEL_COLOR[type] ?? "#94a3b8",
      }))
      .sort((a, b) => b.avg_mw - a.avg_mw);
  }, [data]);

  const totalMw    = fuelAgg.reduce((s, r) => s + r.avg_mw, 0);
  const totalCapMw = fuelAgg.reduce((s, r) => s + r.hsl,    0);

  const dateLabel = isRange ? `${start} → ${end}` : start;

  if (isLoading) return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="animate-spin text-teal-400" size={32} />
    </div>
  );
  if (error || !data?.length) return (
    <div className="flex items-center justify-center h-64 text-slate-400 text-sm">
      No dispatch data available for {dateLabel}. The seeder may still be loading historical dates.
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total Dispatch", value: `${(totalMw/1000).toFixed(1)} GW`,    sub: "avg over day" },
          { label: "Total Capacity", value: `${(totalCapMw/1000).toFixed(1)} GW`, sub: "HSL rated" },
          { label: "Fleet CF",       value: `${totalCapMw > 0 ? Math.round(totalMw/totalCapMw*100) : 0}%`, sub: "capacity factor" },
          { label: "Resources",      value: data.filter(r=>r.avg_mw>0).length.toLocaleString(), sub: "online units" },
        ].map((s, i) => (
          <Card key={i} className="bg-slate-800 border-slate-700">
            <CardContent className="p-3">
              <p className="text-slate-400 text-xs">{s.label}</p>
              <p className="text-white text-xl font-bold">{s.value}</p>
              <p className="text-slate-500 text-xs">{s.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Dispatch by fuel type */}
      <Card className="bg-slate-800 border-slate-700">
        <CardHeader className="pb-2">
          <CardTitle className="text-white text-sm">Generation by Fuel Type — {dateLabel}</CardTitle>
          <CardDescription className="text-slate-400 text-xs">
            Average MW dispatched (bar) vs. rated capacity HSL (lighter bar). Percentage = capacity factor.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={fuelAgg} layout="vertical" margin={{ left: 80, right: 60, top: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
              <XAxis type="number" tick={{ fill: "#94a3b8", fontSize: 10 }}
                     tickFormatter={v => `${(v/1000).toFixed(0)} GW`} />
              <YAxis type="category" dataKey="label" tick={{ fill: "#94a3b8", fontSize: 11 }} width={80} />
              <RechartsTooltip content={<ChartTooltip />}
                               contentStyle={{ backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder }} />
              <Bar dataKey="hsl" name="Capacity (HSL)" radius={[0,4,4,0]} fill="#1e293b">
                {fuelAgg.map((r, i) => <Cell key={i} fill={`${r.color}33`} />)}
              </Bar>
              <Bar dataKey="avg_mw" name="Avg Dispatch MW" radius={[0,4,4,0]}>
                {fuelAgg.map((r, i) => (
                  <Cell key={i} fill={r.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap gap-2 mt-2">
            {fuelAgg.map(r => (
              <div key={r.type} className="flex items-center gap-1">
                <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: r.color }} />
                <span className="text-xs text-slate-400">{r.label}</span>
                <Badge variant="outline" className="text-xs px-1 py-0 border-slate-600 text-slate-300">{r.cf}% CF</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Merit order scatter: offer price vs cumulative MW */}
      <Card className="bg-slate-800 border-slate-700">
        <CardHeader className="pb-2">
          <CardTitle className="text-white text-sm">Merit Order Supply Curve — {dateLabel}</CardTitle>
          <CardDescription className="text-slate-400 text-xs">
            Resources sorted by offer price. X-axis = cumulative MW dispatched (GW). Y-axis = $/MWh offer price.
            Each segment colored by fuel type.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={chartData} margin={{ left: 10, right: 10, top: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
              <XAxis dataKey="cumulative_mw"
                     tick={{ fill: "#94a3b8", fontSize: 9 }}
                     tickFormatter={v => `${(Number(v)/1000).toFixed(0)}GW`}
                     label={{ value: "Cumulative MW →", position: "insideBottomRight",
                              offset: -10, fill: "#64748b", fontSize: 10 }} />
              <YAxis domain={[-250, 400]}
                     tick={{ fill: "#94a3b8", fontSize: 10 }}
                     tickFormatter={v => `$${v}`}
                     label={{ value: "Offer $/MWh", angle: -90, position: "insideLeft",
                              offset: 10, fill: "#64748b", fontSize: 10 }} />
              <RechartsTooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.[0]) return null;
                  const d = payload[0].payload;
                  return (
                    <div className="rounded border p-2 text-xs shadow-lg"
                         style={{ backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, color: C.tooltipFg }}>
                      <p className="font-semibold truncate max-w-40">{d.resource_name}</p>
                      <p className="text-slate-400">{FUEL_LABEL[d.resource_type] ?? d.resource_type}</p>
                      <p>Dispatch: <span className="text-white">{d.avg_mw.toFixed(1)} MW</span></p>
                      <p>Offer: <span className="text-white">${d.offer_price?.toFixed(2) ?? "—"}/MWh</span></p>
                      <p>Cumul: <span className="text-white">{(d.cumulative_mw/1000).toFixed(2)} GW</span></p>
                    </div>
                  );
                }}
              />
              <ReferenceLine y={0} stroke="#475569" strokeDasharray="4 2" />
              <Bar dataKey="offer_price" name="Offer Price" maxBarSize={4}>
                {chartData.map((r, i) => (
                  <Cell key={i} fill={FUEL_COLOR[r.resource_type] ?? "#94a3b8"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Capacity Factor Chart ─────────────────────────────────────────────────────
function CapacityFactors() {
  const { data: cfData, isLoading } = useQuery<CFRow[]>({
    queryKey: ["ercot-cf-alltime"],
    queryFn:  () => apiFetch("/api/ercot/dispatch/capacity-factors?granularity=alltime"),
    staleTime: 10 * 60_000,
  });

  const { data: monthly, isLoading: mlLoading } = useQuery<SummaryRow[]>({
    queryKey: ["ercot-dispatch-summary"],
    queryFn:  () => apiFetch("/api/ercot/dispatch/summary?months=30"),
    staleTime: 10 * 60_000,
  });

  // Build monthly trend by fuel type
  const monthlyByFuel = useMemo(() => {
    if (!monthly) return {};
    const byFuel: Record<string, { label: string; data: { month: string; cf: number }[] }> = {};
    monthly.forEach(r => {
      if (!byFuel[r.resource_type]) {
        byFuel[r.resource_type] = { label: FUEL_LABEL[r.resource_type] ?? r.resource_type, data: [] };
      }
      byFuel[r.resource_type].data.push({
        month: fmtMonth(r.year, r.month),
        cf:    r.avg_cf != null ? Math.round(Number(r.avg_cf) * 100) : 0,
      });
    });
    return byFuel;
  }, [monthly]);

  // Combine monthly data into a single array keyed by month label
  const monthlyFlat = useMemo(() => {
    const allMonths: string[] = [];
    Object.values(monthlyByFuel).forEach(({ data }) =>
      data.forEach(d => { if (!allMonths.includes(d.month)) allMonths.push(d.month); })
    );
    return allMonths.sort().map(month => {
      const row: Record<string, unknown> = { month };
      Object.entries(monthlyByFuel).forEach(([type, { data }]) => {
        const found = data.find(d => d.month === month);
        row[type] = found?.cf ?? null;
      });
      return row;
    });
  }, [monthlyByFuel]);

  const fuelTypes = Object.keys(monthlyByFuel);

  if (isLoading || mlLoading) return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="animate-spin text-teal-400" size={32} />
    </div>
  );

  return (
    <div className="space-y-6">
      {/* All-time averages */}
      {cfData && (
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader className="pb-2">
            <CardTitle className="text-white text-sm">Capacity Factors by Fuel Type — Last 12 Months</CardTitle>
            <CardDescription className="text-slate-400 text-xs">
              CF = total MWh generated ÷ (nameplate capacity × available hours). Uses MAX(HSL) per resource as nameplate.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              {cfData.map(r => (
                <div key={r.resource_type} className="bg-slate-900 rounded p-3 border border-slate-700">
                  <div className="flex items-center gap-1.5 mb-1">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: FUEL_COLOR[r.resource_type] ?? "#94a3b8" }} />
                    <span className="text-slate-400 text-xs">{FUEL_LABEL[r.resource_type] ?? r.resource_type}</span>
                  </div>
                  <p className="text-white text-2xl font-bold">
                    {r.avg_cf != null ? `${Math.round(Number(r.avg_cf) * 100)}%` : "—"}
                  </p>
                  <p className="text-slate-500 text-xs mt-0.5">
                    {r.total_resources} resources
                    {r.avg_offer_price != null && (
                      <span className="ml-1">&middot; ${Number(r.avg_offer_price).toFixed(0)}/MWh avg offer</span>
                    )}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Monthly CF trend */}
      {monthlyFlat.length > 0 && (
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader className="pb-2">
            <CardTitle className="text-white text-sm">Capacity Factor Trend by Fuel Type</CardTitle>
            <CardDescription className="text-slate-400 text-xs">
              Monthly average capacity factor (%). Data expands as the seeder loads more history.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={monthlyFlat} margin={{ left: 0, right: 10, top: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="month" tick={{ fill: "#94a3b8", fontSize: 10 }} interval={2} />
                <YAxis tick={{ fill: "#94a3b8", fontSize: 10 }} tickFormatter={v => `${v}%`} domain={[0, 100]} />
                <RechartsTooltip
                  contentStyle={{ backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, color: C.tooltipFg }}
                  formatter={(v: unknown) => [`${Number(v).toFixed(0)}%`, ""]}
                />
                <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
                {fuelTypes.map(type => (
                  <Line key={type} type="monotone" dataKey={type}
                        name={FUEL_LABEL[type] ?? type}
                        stroke={FUEL_COLOR[type] ?? "#94a3b8"}
                        dot={false} strokeWidth={2}
                        connectNulls />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function ErcotDispatch() {
  const [tab,       setTab]       = useState("supply-stack");
  // Two indices into the dates[] array — same value = single date, different = range
  const [dateRange, setDateRange] = useState<[number, number]>([0, 0]);

  const { data: status } = useQuery<SeedStatus>({
    queryKey: ["ercot-dispatch-seed-status"],
    queryFn:  () => apiFetch("/api/ercot/dispatch/seed-status"),
    staleTime: 60 * 60_000,
  });

  const { data: dates } = useQuery<string[]>({
    queryKey: ["ercot-dispatch-dates"],
    queryFn:  () => apiFetch("/api/ercot/dispatch/dates"),
    staleTime: 60_000,
    select: (d) => d,
  });

  const maxIdx = Math.max(0, (dates?.length ?? 1) - 1);

  // Jump to last available date once dates load (only if still at initial position)
  useEffect(() => {
    if (dates && dates.length > 0) {
      setDateRange(prev =>
        prev[0] === 0 && prev[1] === 0 ? [maxIdx, maxIdx] : prev
      );
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dates?.length]);

  const startDate   = dates?.[dateRange[0]] ?? "";
  const endDate     = dates?.[dateRange[1]] ?? startDate;
  const isRangePick = dateRange[0] !== dateRange[1];

  const totalRows      = status?.total_rows     ?? 0;
  const totalResources = status?.total_resources ?? 0;
  const daysSeeded     = status?.days_seeded     ?? 0;

  const daysTotal = useMemo(() => {
    const start   = new Date("2024-01-01").getTime();
    const endMs   = Date.now() - 62 * 86_400_000;
    return Math.max(0, Math.floor((endMs - start) / 86_400_000) + 1);
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-white p-6">
      {/* Page header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Zap className="text-teal-400" size={20} />
            <h1 className="text-xl font-bold text-white">ERCOT Dispatch Intelligence</h1>
            <Badge className="bg-teal-900 text-teal-300 border-teal-700 text-xs">SCED Real Data</Badge>
          </div>
          <p className="text-slate-400 text-sm">
            Real hourly dispatch + offer curves from ERCOT NP3-965-ER SCED 60-day disclosure.
            1,100+ generation resources — actual merit order pricing.
          </p>
        </div>
        <div className="flex gap-6 text-right">
          <div>
            <p className="text-slate-400 text-xs">Rows Loaded</p>
            <p className="text-teal-400 font-bold">{(totalRows/1e6).toFixed(2)}M</p>
          </div>
          <div>
            <p className="text-slate-400 text-xs">Resources</p>
            <p className="text-white font-bold">{totalResources.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-slate-400 text-xs">Days Seeded</p>
            <p className="text-white font-bold">{daysSeeded} / {daysTotal}</p>
          </div>
        </div>
      </div>


      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-slate-800 border border-slate-700 mb-6">
          <TabsTrigger value="supply-stack" className="data-[state=active]:bg-teal-700 data-[state=active]:text-white">
            <Activity size={14} className="mr-1.5" /> Supply Stack
          </TabsTrigger>
          <TabsTrigger value="capacity-factors" className="data-[state=active]:bg-teal-700 data-[state=active]:text-white">
            <TrendingUp size={14} className="mr-1.5" /> Capacity Factors
          </TabsTrigger>
          <TabsTrigger value="about" className="data-[state=active]:bg-teal-700 data-[state=active]:text-white">
            <Database size={14} className="mr-1.5" /> Data Source
          </TabsTrigger>
        </TabsList>

        <TabsContent value="supply-stack">
          {/* Date range slider */}
          <div className="mb-6 bg-slate-800 border border-slate-700 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="text-white font-medium text-sm">
                  {isRangePick ? (
                    <>{startDate} <span className="text-teal-400">→</span> {endDate}
                      <span className="text-slate-400 text-xs ml-2">
                        ({dateRange[1] - dateRange[0] + 1} days avg)
                      </span>
                    </>
                  ) : startDate}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setDateRange(([s, e]) => {
                    const ns = Math.max(0, s - 1);
                    return [ns, s === e ? ns : e];
                  })}
                  disabled={dateRange[0] === 0}
                  className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white disabled:opacity-30"
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  onClick={() => setDateRange(([s, e]) => {
                    const ne = Math.min(maxIdx, e + 1);
                    return [s === e ? ne : s, ne];
                  })}
                  disabled={dateRange[1] >= maxIdx}
                  className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-white disabled:opacity-30"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>

            <Slider
              min={0}
              max={maxIdx}
              step={1}
              value={dateRange}
              onValueChange={(v) => setDateRange(v as [number, number])}
              className="my-2"
            />

            <div className="flex justify-between text-slate-500 text-xs mt-1">
              <span>{dates?.[0] ?? "Jan 2024"}</span>
              <span className="text-slate-600 text-xs">
                drag to select date or range · {dates?.length ?? 0} days available
              </span>
              <span>{dates?.[maxIdx] ?? "latest"}</span>
            </div>
          </div>

          <SupplyStack start={startDate} end={endDate} />
        </TabsContent>

        <TabsContent value="capacity-factors">
          <CapacityFactors />
        </TabsContent>

        <TabsContent value="about">
          <div className="grid md:grid-cols-2 gap-4">
            <Card className="bg-slate-800 border-slate-700">
              <CardHeader>
                <CardTitle className="text-white text-sm">Data Source — NP3-965-ER</CardTitle>
              </CardHeader>
              <CardContent className="text-slate-400 text-sm space-y-3">
                <p>
                  <span className="text-white font-medium">ERCOT SCED 60-Day Disclosure</span> — The Security
                  Constrained Economic Dispatch (SCED) data published by ERCOT with a 60-day lag under
                  market confidentiality rules. This is the actual real-time dispatch signal sent to every
                  generation resource in the ERCOT market, every 5 minutes.
                </p>
                <p>
                  Each 5-minute interval includes: telemetered net output (actual MW), high/low sustainable limits,
                  base point (instructed MW), and the full <strong className="text-white">SCED Offer Curve</strong> — a
                  step-function [MW, $/MWh] bid submitted by the generator's QSE for that interval.
                </p>
                <p>
                  Data is aggregated to hourly by resource, preserving the average dispatch MW, max dispatch,
                  HSL (rated capacity), LSL (minimum online), and the min/max offer price from the bid curve.
                </p>
              </CardContent>
            </Card>
            <Card className="bg-slate-800 border-slate-700">
              <CardHeader>
                <CardTitle className="text-white text-sm">Resource Types</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {[
                  ["WIND",   "wind",        "Wind generators"],
                  ["PVGR",   "solar",        "Photovoltaic solar"],
                  ["PWRSTR", "storage",      "Battery storage (bidirectional)"],
                  ["CCGT90", "natural_gas",  "Combined cycle gas turbine"],
                  ["SCGT90", "natural_gas",  "Simple cycle gas turbine (peaker)"],
                  ["CLLIG",  "coal",         "Lignite coal"],
                  ["NUC",    "nuclear",      "Nuclear (STP)"],
                  ["HYDRO",  "hydro",        "Hydroelectric"],
                ].map(([code, type, desc]) => (
                  <div key={code} className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full shrink-0"
                         style={{ backgroundColor: FUEL_COLOR[type] ?? "#94a3b8" }} />
                    <span className="text-slate-300 text-xs font-mono w-14">{code}</span>
                    <span className="text-slate-400 text-xs">{desc}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
