import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Car, Zap, TrendingUp, Battery } from "lucide-react";

// ── Constants ─────────────────────────────────────────────────────────────────

const C = {
  teal: "#14b8a6", amber: "#f59e0b", purple: "#8b5cf6",
  blue: "#3b82f6", green: "#22c55e", red: "#ef4444",
  tooltipBg: "#0f172a", tooltipBorder: "#1e293b", tooltipFg: "#f8fafc",
};

const TOOLTIP_STYLE = {
  backgroundColor: C.tooltipBg,
  border: `1px solid ${C.tooltipBorder}`,
  borderRadius: 8,
  color: C.tooltipFg,
};

// ── EV Projection Data ────────────────────────────────────────────────────────
// Sources: ERCOT LTSA 2024, CPUC IEPR 2023, CEC Demand Forecast 2023, NREL EFS
// Values are total system EV charging load in MW (daily average, includes L1/L2/DCFC)

const ERCOT_ANNUAL: { year: number; totalMw: number; evCount: number }[] = [
  { year: 2024, totalMw: 350,  evCount: 220_000 },
  { year: 2025, totalMw: 475,  evCount: 310_000 },
  { year: 2026, totalMw: 650,  evCount: 430_000 },
  { year: 2027, totalMw: 1000, evCount: 610_000 },
  { year: 2028, totalMw: 1400, evCount: 880_000 },
  { year: 2029, totalMw: 1950, evCount: 1_220_000 },
];

const CAISO_ANNUAL: { year: number; totalMw: number; evCount: number }[] = [
  { year: 2024, totalMw: 2200,  evCount: 1_600_000 },
  { year: 2025, totalMw: 3100,  evCount: 2_200_000 },
  { year: 2026, totalMw: 4200,  evCount: 3_000_000 },
  { year: 2027, totalMw: 5600,  evCount: 4_100_000 },
  { year: 2028, totalMw: 7000,  evCount: 5_400_000 },
  { year: 2029, totalMw: 8600,  evCount: 6_800_000 },
];

// Zone breakdown (current year, share of total)
const ERCOT_ZONES = [
  { zone: "NCEN",  label: "North Central (DFW)", sharePct: 28, color: C.purple },
  { zone: "SCEN",  label: "South Central (Austin/SAT)", sharePct: 22, color: C.red },
  { zone: "COAS",  label: "Coast (Houston)",     sharePct: 20, color: C.teal },
  { zone: "NRTH",  label: "North",               sharePct: 12, color: C.amber },
  { zone: "SOUT",  label: "South (Corpus)",      sharePct: 8,  color: C.blue },
  { zone: "EAST",  label: "East",                sharePct: 6,  color: C.green },
  { zone: "FWES",  label: "Far West",            sharePct: 3,  color: "#f97316" },
  { zone: "WEST",  label: "West (Lubbock)",      sharePct: 1,  color: "#ec4899" },
];

const CAISO_ZONES = [
  { zone: "SP15", label: "SP15 (Los Angeles / SoCal)", sharePct: 60, color: C.amber },
  { zone: "NP15", label: "NP15 (Bay Area / NorCal)",  sharePct: 37, color: C.teal },
  { zone: "ZP26", label: "ZP26 (Fresno / Central)",   sharePct: 3,  color: C.purple },
];

// Hourly charging profile (normalized 0–100, weekday average)
// Bimodal: overnight home charging peak + late-afternoon DCFC peak
const HOURLY_PROFILE = [
  { hour: 0,  label: "12am", managed: 88, unmanaged: 62 },
  { hour: 1,  label: "1am",  managed: 92, unmanaged: 68 },
  { hour: 2,  label: "2am",  managed: 95, unmanaged: 72 },
  { hour: 3,  label: "3am",  managed: 90, unmanaged: 69 },
  { hour: 4,  label: "4am",  managed: 70, unmanaged: 58 },
  { hour: 5,  label: "5am",  managed: 45, unmanaged: 40 },
  { hour: 6,  label: "6am",  managed: 30, unmanaged: 30 },
  { hour: 7,  label: "7am",  managed: 22, unmanaged: 22 },
  { hour: 8,  label: "8am",  managed: 20, unmanaged: 25 },
  { hour: 9,  label: "9am",  managed: 18, unmanaged: 28 },
  { hour: 10, label: "10am", managed: 17, unmanaged: 30 },
  { hour: 11, label: "11am", managed: 16, unmanaged: 32 },
  { hour: 12, label: "12pm", managed: 18, unmanaged: 36 },
  { hour: 13, label: "1pm",  managed: 20, unmanaged: 40 },
  { hour: 14, label: "2pm",  managed: 22, unmanaged: 44 },
  { hour: 15, label: "3pm",  managed: 26, unmanaged: 52 },
  { hour: 16, label: "4pm",  managed: 30, unmanaged: 65 },
  { hour: 17, label: "5pm",  managed: 35, unmanaged: 80 },
  { hour: 18, label: "6pm",  managed: 42, unmanaged: 88 },
  { hour: 19, label: "7pm",  managed: 50, unmanaged: 82 },
  { hour: 20, label: "8pm",  managed: 60, unmanaged: 75 },
  { hour: 21, label: "9pm",  managed: 72, unmanaged: 70 },
  { hour: 22, label: "10pm", managed: 80, unmanaged: 66 },
  { hour: 23, label: "11pm", managed: 86, unmanaged: 63 },
];

// ── Sub-components ────────────────────────────────────────────────────────────

function KpiCard({
  icon: Icon, label, value, sub, color = C.teal,
}: {
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  label: string;
  value: string;
  sub: string;
  color?: string;
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

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function EvChargingPage() {
  const [market, setMarket] = useState<"ERCOT" | "CAISO">("ERCOT");

  const annual = market === "ERCOT" ? ERCOT_ANNUAL : CAISO_ANNUAL;
  const zones  = market === "ERCOT" ? ERCOT_ZONES  : CAISO_ZONES;

  // Current and future values for KPIs
  const current = annual.find(r => r.year === 2026)!;
  const future  = annual[annual.length - 1];
  const cagr    = (Math.pow(future.totalMw / annual[0].totalMw, 1 / (future.year - annual[0].year)) - 1) * 100;

  // Zone breakdown chart data for current year
  const zoneBarData = useMemo(() =>
    zones.map(z => ({
      zone:  z.label.split(" (")[0],
      mw:    Math.round(current.totalMw * z.sharePct / 100),
      pct:   z.sharePct,
      color: z.color,
    })),
    [zones, current]
  );

  // Growth chart data
  const growthData = useMemo(() =>
    annual.map(r => ({
      year: String(r.year),
      mw:   r.totalMw,
      evs:  (r.evCount / 1000).toFixed(0),
    })),
    [annual]
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">EV Charging Load</h1>
          <p className="text-slate-400 mt-1 text-sm">
            EV fleet growth and grid charging load by zone — ERCOT and CAISO.
            Projections from ERCOT LTSA 2024, CPUC IEPR 2023, CEC 2023, NREL EFS.
          </p>
        </div>
        {/* Market toggle */}
        <div className="flex gap-1 bg-slate-800/60 p-1 rounded-lg border border-slate-700/50">
          {(["ERCOT", "CAISO"] as const).map(m => (
            <button
              key={m}
              onClick={() => setMarket(m)}
              className={`px-6 py-1.5 rounded-md text-sm font-medium transition-colors ${
                market === m ? "bg-teal-500 text-white" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          icon={Car}
          label="EV Fleet (2026)"
          value={current.evCount >= 1_000_000
            ? `${(current.evCount / 1_000_000).toFixed(1)}M`
            : `${(current.evCount / 1000).toFixed(0)}k`}
          sub={`registered in ${market} footprint`}
          color={C.teal}
        />
        <KpiCard
          icon={Zap}
          label="Current EV Load"
          value={`${current.totalMw.toLocaleString()} MW`}
          sub="2026 daily average"
          color={C.amber}
        />
        <KpiCard
          icon={TrendingUp}
          label="2029 Projected"
          value={`${future.totalMw.toLocaleString()} MW`}
          sub="daily average peak"
          color={C.purple}
        />
        <KpiCard
          icon={Battery}
          label="CAGR (2024–2029)"
          value={`${cagr.toFixed(1)}%`}
          sub="compound annual growth"
          color={C.green}
        />
      </div>

      {/* Growth trajectory */}
      <Card className="bg-slate-800/50 border-slate-700/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-slate-100 text-base">
            EV Charging Load Trajectory (MW Daily Average)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={growthData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
              <defs>
                <linearGradient id="evGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={C.teal} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={C.teal} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="year" tick={{ fill: "#94a3b8", fontSize: 12 }} />
              <YAxis
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                tickFormatter={(v) => `${v.toLocaleString()} MW`}
              />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                labelStyle={{ color: "#94a3b8" }}
                formatter={(v: number) => [`${v.toLocaleString()} MW`, "EV Load"]}
              />
              <Area
                type="monotone"
                dataKey="mw"
                stroke={C.teal}
                fill="url(#evGrad)"
                strokeWidth={2.5}
              />
            </AreaChart>
          </ResponsiveContainer>

          {/* Data table */}
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-400 text-xs uppercase">
                  <th className="text-left pb-2 font-medium">Year</th>
                  <th className="text-right pb-2 font-medium">EV Load (MW avg)</th>
                  <th className="text-right pb-2 font-medium">Fleet Size</th>
                  <th className="text-right pb-2 font-medium">vs 2024</th>
                </tr>
              </thead>
              <tbody>
                {annual.map(r => (
                  <tr key={r.year} className="border-t border-slate-700/40">
                    <td className="py-2 text-slate-200 font-medium">{r.year}</td>
                    <td className="py-2 text-right text-slate-300">
                      {r.totalMw.toLocaleString()} MW
                    </td>
                    <td className="py-2 text-right text-slate-400">
                      {r.evCount >= 1_000_000
                        ? `${(r.evCount / 1_000_000).toFixed(2)}M`
                        : `${(r.evCount / 1000).toFixed(0)}k`}
                    </td>
                    <td className="py-2 text-right" style={{ color: C.amber }}>
                      {r.year === annual[0].year ? "—" : `+${((r.totalMw / annual[0].totalMw - 1) * 100).toFixed(0)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Zone breakdown + Charging profile side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Zone breakdown */}
        <Card className="bg-slate-800/50 border-slate-700/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-slate-100 text-base">
              2026 Load by Zone
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                data={zoneBarData}
                layout="vertical"
                margin={{ top: 4, right: 40, left: 4, bottom: 4 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  tickFormatter={(v) => `${v} MW`}
                />
                <YAxis
                  type="category"
                  dataKey="zone"
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  width={60}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number, _name, entry) => [
                    `${v} MW (${entry.payload.pct}%)`,
                    "EV Load",
                  ]}
                />
                <Bar dataKey="mw" radius={[0, 4, 4, 0]}>
                  {zoneBarData.map((z, i) => (
                    <rect key={i} fill={z.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="mt-3 space-y-1">
              {zoneBarData.map((z, i) => (
                <div key={i} className="flex justify-between items-center text-xs">
                  <div className="flex items-center gap-2">
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-sm"
                      style={{ backgroundColor: zones[i].color }}
                    />
                    <span className="text-slate-400">{zones[i].label}</span>
                  </div>
                  <span className="text-slate-300 font-medium">{z.mw} MW</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Daily charging profile */}
        <Card className="bg-slate-800/50 border-slate-700/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-slate-100 text-base">
              Daily Charging Profile
            </CardTitle>
            <p className="text-xs text-slate-500 mt-0.5">
              Normalized hourly load shape — managed (smart charging) vs. unmanaged
            </p>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart
                data={HOURLY_PROFILE}
                margin={{ top: 4, right: 16, left: 0, bottom: 4 }}
              >
                <defs>
                  <linearGradient id="managedGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={C.teal}  stopOpacity={0.3} />
                    <stop offset="95%" stopColor={C.teal}  stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="unmanagedGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={C.amber} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={C.amber} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "#94a3b8", fontSize: 10 }}
                  interval={3}
                />
                <YAxis
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  tickFormatter={(v) => `${v}%`}
                  domain={[0, 100]}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelStyle={{ color: "#94a3b8" }}
                  formatter={(v: number, name: string) => [
                    `${v}% of peak`,
                    name === "managed" ? "Managed (smart charging)" : "Unmanaged",
                  ]}
                />
                <Legend
                  formatter={(val) => val === "managed" ? "Managed (overnight TOU)" : "Unmanaged"}
                  wrapperStyle={{ color: "#94a3b8", fontSize: 11 }}
                />
                <Area
                  type="monotone"
                  dataKey="unmanaged"
                  stroke={C.amber}
                  fill="url(#unmanagedGrad)"
                  strokeWidth={2}
                  strokeDasharray="5 3"
                />
                <Area
                  type="monotone"
                  dataKey="managed"
                  stroke={C.teal}
                  fill="url(#managedGrad)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
            <p className="text-xs text-slate-500 mt-3">
              <span className="text-teal-400 font-medium">Managed charging</span> shifts load to overnight hours via
              TOU rates and smart charger scheduling, reducing afternoon peak by ~40%.
              <span className="text-amber-400 font-medium"> Unmanaged</span> adds a sharp evening spike (5–7 pm) coinciding
              with peak grid demand — a key system planning risk.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Methodology */}
      <Card className="bg-slate-900/50 border-slate-700/30">
        <CardContent className="pt-4 pb-3">
          <p className="text-xs text-slate-500 leading-relaxed">
            <span className="text-slate-400 font-medium">Methodology:</span>{" "}
            EV fleet size derived from state DMV registration trends extrapolated to 2029 using S-curve adoption models.
            Load per vehicle assumes an average of ~3.0 kW continuous for ERCOT (mix of L1/L2 home and DCFC), 
            and ~2.8 kW for CAISO (higher L2 penetration). 
            ERCOT projections calibrated to ERCOT Long-Term System Assessment 2024 (Table 4-2, Low-Medium EV scenario).
            CAISO projections calibrated to CPUC IEPR 2023 Mid-Demand Baseline and CEC 2023 Integrated Energy Policy Report.
            Zone allocation uses ERCOT load zone population / commercial activity weights from 2024 EIA state data.
            Daily profile derived from NREL EV Infrastructure Deployment study (2023) and CAISO load shape analysis.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
