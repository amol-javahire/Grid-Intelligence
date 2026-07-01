import { useState, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ComposedChart, Area,
  AreaChart,
} from "recharts";
import { useQuery } from "@tanstack/react-query";
import {
  useGetTemperature,
  useGetTemperatureStats,
  useGetTemperatureForecast,
  useGetTemperatureForecastOverview,
} from "@workspace/api-client-react";

// ── Zone colour palettes ──────────────────────────────────────────────────────
const ERCOT_ZONES: Record<string, { label: string; color: string }> = {
  COAS: { label: "Coast (Houston)",       color: "#14b8a6" },
  NCEN: { label: "North Central (DFW)",   color: "#8b5cf6" },
  NRTH: { label: "North",                 color: "#f59e0b" },
  EAST: { label: "East",                  color: "#22c55e" },
  SCEN: { label: "South Central (SAT)",   color: "#ef4444" },
  SOUT: { label: "South (Corpus)",        color: "#3b82f6" },
  FWES: { label: "Far West (Midland)",    color: "#f97316" },
  WEST: { label: "West (Lubbock)",        color: "#ec4899" },
};

const CAISO_ZONES: Record<string, { label: string; color: string }> = {
  NP15: { label: "NP15 (Sacramento)", color: "#14b8a6" },
  SP15: { label: "SP15 (Los Angeles)", color: "#f59e0b" },
  ZP26: { label: "ZP26 (Fresno)",     color: "#8b5cf6" },
};

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const FORECAST_START_YEAR  = 2026;
const FORECAST_START_MONTH = 7;   // July 2026
const FORECAST_END_YEAR    = 2029;
const FORECAST_END_MONTH   = 6;   // June 2029

// ── Helpers (actuals) ─────────────────────────────────────────────────────────
function buildDailyAvg(
  rows: { zone: string; day: number; hour: number; tempF: number }[],
  zones: Record<string, { label: string; color: string }>,
): { day: number; [zone: string]: number }[] {
  const byDay: Record<number, Record<string, number[]>> = {};
  for (const r of rows) {
    if (!byDay[r.day]) byDay[r.day] = {};
    if (!byDay[r.day][r.zone]) byDay[r.day][r.zone] = [];
    byDay[r.day][r.zone].push(r.tempF);
  }
  return Object.entries(byDay)
    .map(([day, zoneMap]) => {
      const pt: { day: number; [k: string]: number } = { day: Number(day) };
      for (const z of Object.keys(zones)) {
        const arr = zoneMap[z];
        if (arr?.length) pt[z] = Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10;
      }
      return pt;
    })
    .sort((a, b) => a.day - b.day);
}

function buildHourlyProfile(
  rows: { zone: string; day: number; hour: number; tempF: number }[],
  zones: Record<string, { label: string; color: string }>,
): { hour: number; [zone: string]: number }[] {
  const byHour: Record<number, Record<string, number[]>> = {};
  for (const r of rows) {
    if (!byHour[r.hour]) byHour[r.hour] = {};
    if (!byHour[r.hour][r.zone]) byHour[r.hour][r.zone] = [];
    byHour[r.hour][r.zone].push(r.tempF);
  }
  return Object.entries(byHour)
    .map(([h, zoneMap]) => {
      const pt: { hour: number; [k: string]: number } = { hour: Number(h) };
      for (const z of Object.keys(zones)) {
        const arr = zoneMap[z];
        if (arr?.length) pt[z] = Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10;
      }
      return pt;
    })
    .sort((a, b) => a.hour - b.hour);
}

// ── Helpers (forecast) ────────────────────────────────────────────────────────
function buildOverviewChart(
  rows: { zone: string; year: number; month: number; avgMeanF: number; avgMinF: number; avgMaxF: number }[],
  zones: Record<string, { label: string; color: string }>,
): Record<string, number | string>[] {
  const byLabel: Record<string, Record<string, number | string>> = {};

  let yr = FORECAST_START_YEAR;
  let mo = FORECAST_START_MONTH;
  while (yr < FORECAST_END_YEAR || (yr === FORECAST_END_YEAR && mo <= FORECAST_END_MONTH)) {
    const label = `${MONTHS[mo - 1]} '${String(yr).slice(2)}`;
    byLabel[label] = { label };
    mo++;
    if (mo > 12) { mo = 1; yr++; }
  }

  for (const r of rows) {
    const label = `${MONTHS[r.month - 1]} '${String(r.year).slice(2)}`;
    if (!byLabel[label]) continue;
    const band = Math.max(0, r.avgMaxF - r.avgMinF);
    byLabel[label][`${r.zone}_mean`] = r.avgMeanF;
    byLabel[label][`${r.zone}_min`]  = r.avgMinF;
    byLabel[label][`${r.zone}_band`] = Math.round(band * 10) / 10;
  }

  return Object.values(byLabel);
}

function buildDailyForecastChart(
  rows: { zone: string; day: number; meanF: number; minF: number; maxF: number }[],
  zones: Record<string, { label: string; color: string }>,
): Record<string, number>[] {
  const byDay: Record<number, Record<string, number>> = {};
  for (const r of rows) {
    if (!byDay[r.day]) byDay[r.day] = { day: r.day };
    const band = Math.max(0, r.maxF - r.minF);
    byDay[r.day][`${r.zone}_mean`] = r.meanF;
    byDay[r.day][`${r.zone}_min`]  = r.minF;
    byDay[r.day][`${r.zone}_band`] = Math.round(band * 10) / 10;
  }
  return Object.values(byDay).sort((a, b) => a.day - b.day);
}

// ── Sub-components (actuals) ──────────────────────────────────────────────────
function TempChart({
  data,
  xKey,
  xLabel,
  zones,
}: {
  data: Record<string, number>[];
  xKey: string;
  xLabel: string;
  zones: Record<string, { label: string; color: string }>;
}) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
        <XAxis
          dataKey={xKey}
          tick={{ fill: "#94a3b8", fontSize: 11 }}
          label={{ value: xLabel, position: "insideBottom", offset: -2, fill: "#94a3b8", fontSize: 11 }}
        />
        <YAxis
          tick={{ fill: "#94a3b8", fontSize: 11 }}
          tickFormatter={(v) => `${v}°F`}
          domain={[20, 110]}
          ticks={[20, 30, 40, 50, 60, 70, 80, 90, 100, 110]}
        />
        <Tooltip
          contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8 }}
          labelStyle={{ color: "#94a3b8" }}
          formatter={(v: number, name: string) => {
            const z = String(name);
            return [`${v}°F`, zones[z]?.label || z];
          }}
        />
        <Legend
          formatter={(val) => zones[val]?.label || val}
          wrapperStyle={{ color: "#94a3b8", fontSize: 11 }}
        />
        {Object.entries(zones).map(([z, meta]) => (
          <Line
            key={z}
            type="monotone"
            dataKey={z}
            stroke={meta.color}
            dot={false}
            strokeWidth={1.5}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function StatsTable({
  stats,
  year,
  month,
  zones,
}: {
  stats: { zone: string; year: number; month: number; avgF: number; minF: number; maxF: number }[];
  iso: string;
  year: number;
  month: number;
  zones: Record<string, { label: string; color: string }>;
}) {
  const filtered = stats
    .filter(s => s.year === year && s.month === month)
    .sort((a, b) => b.avgF - a.avgF);

  if (!filtered.length) {
    return <p className="text-slate-500 text-sm">No stats for this period.</p>;
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-700 text-slate-400">
          <th className="text-left py-2 pr-4">Zone</th>
          <th className="text-right py-2 pr-4">Avg</th>
          <th className="text-right py-2 pr-4">Min</th>
          <th className="text-right">Max</th>
        </tr>
      </thead>
      <tbody>
        {filtered.map(s => (
          <tr key={s.zone} className="border-b border-slate-800 hover:bg-slate-800/30">
            <td className="py-2 pr-4 font-medium" style={{ color: zones[s.zone]?.color || "#94a3b8" }}>
              {zones[s.zone]?.label || s.zone}
            </td>
            <td className="text-right py-2 pr-4 text-slate-200">{s.avgF}°F</td>
            <td className="text-right py-2 pr-4 text-blue-400">{s.minF}°F</td>
            <td className="text-right text-red-400">{s.maxF}°F</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Sub-components (forecast) ─────────────────────────────────────────────────

// 3-year monthly overview: lines for mean, shaded band for min/max
function ForecastOverviewChart({
  data,
  zones,
}: {
  data: Record<string, number | string>[];
  zones: Record<string, { label: string; color: string }>;
}) {
  const zoneKeys = Object.keys(zones);
  const tickInterval = Math.max(1, Math.floor(data.length / 12)) - 1;

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
        <XAxis
          dataKey="label"
          tick={{ fill: "#94a3b8", fontSize: 10 }}
          interval={tickInterval}
          angle={-35}
          textAnchor="end"
          height={40}
        />
        <YAxis
          tick={{ fill: "#94a3b8", fontSize: 11 }}
          tickFormatter={(v) => `${v}°F`}
          domain={[20, 110]}
          ticks={[20, 30, 40, 50, 60, 70, 80, 90, 100, 110]}
        />
        <Tooltip
          contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8 }}
          labelStyle={{ color: "#94a3b8", fontWeight: 600 }}
          formatter={(v: number, name: string) => {
            if (name.endsWith("_band") || name.endsWith("_min")) return [null, null];
            const z = name.replace("_mean", "");
            return [`${v}°F`, zones[z]?.label || z];
          }}
        />
        <Legend
          formatter={(val) => {
            if (val.endsWith("_band") || val.endsWith("_min")) return null;
            const z = val.replace("_mean", "");
            return zones[z]?.label || z;
          }}
          wrapperStyle={{ color: "#94a3b8", fontSize: 11 }}
        />
        {zoneKeys.map(z => {
          const color = zones[z].color;
          return [
            <Area
              key={`${z}_min`}
              type="monotone"
              dataKey={`${z}_min`}
              stroke="none"
              fill="none"
              fillOpacity={0}
              stackId={`${z}_band`}
              legendType="none"
              isAnimationActive={false}
            />,
            <Area
              key={`${z}_band`}
              type="monotone"
              dataKey={`${z}_band`}
              stroke="none"
              fill={color}
              fillOpacity={0.08}
              stackId={`${z}_band`}
              legendType="none"
              isAnimationActive={false}
            />,
            <Line
              key={`${z}_mean`}
              type="monotone"
              dataKey={`${z}_mean`}
              stroke={color}
              strokeWidth={1.5}
              dot={false}
              connectNulls
            />,
          ];
        }).flat()}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// Monthly detail: daily mean ± min/max band for a single zone or all zones
function ForecastDailyChart({
  data,
  zones,
}: {
  data: Record<string, number>[];
  zones: Record<string, { label: string; color: string }>;
}) {
  const zoneKeys = Object.keys(zones);

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
        <XAxis
          dataKey="day"
          tick={{ fill: "#94a3b8", fontSize: 11 }}
          label={{ value: "Day of Month", position: "insideBottom", offset: -2, fill: "#94a3b8", fontSize: 11 }}
        />
        <YAxis
          tick={{ fill: "#94a3b8", fontSize: 11 }}
          tickFormatter={(v) => `${v}°F`}
          domain={[20, 110]}
          ticks={[20, 30, 40, 50, 60, 70, 80, 90, 100, 110]}
        />
        <Tooltip
          contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8 }}
          labelStyle={{ color: "#94a3b8" }}
          formatter={(v: number, name: string) => {
            if (name.endsWith("_band") || name.endsWith("_min")) return [null, null];
            const z = name.replace("_mean", "");
            return [`${v}°F`, zones[z]?.label || z];
          }}
        />
        <Legend
          formatter={(val) => {
            if (val.endsWith("_band") || val.endsWith("_min")) return null;
            const z = val.replace("_mean", "");
            return zones[z]?.label || z;
          }}
          wrapperStyle={{ color: "#94a3b8", fontSize: 11 }}
        />
        {zoneKeys.map(z => {
          const color = zones[z].color;
          return [
            <Area
              key={`${z}_min`}
              type="monotone"
              dataKey={`${z}_min`}
              stroke="none"
              fill="none"
              fillOpacity={0}
              stackId={`${z}_band`}
              legendType="none"
              isAnimationActive={false}
            />,
            <Area
              key={`${z}_band`}
              type="monotone"
              dataKey={`${z}_band`}
              stroke="none"
              fill={color}
              fillOpacity={0.12}
              stackId={`${z}_band`}
              legendType="none"
              isAnimationActive={false}
            />,
            <Line
              key={`${z}_mean`}
              type="monotone"
              dataKey={`${z}_mean`}
              stroke={color}
              strokeWidth={1.5}
              dot={false}
              connectNulls
            />,
          ];
        }).flat()}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// Forecast monthly stats table
function ForecastStatsTable({
  rows,
  zones,
}: {
  rows: { zone: string; day: number; meanF: number; minF: number; maxF: number }[];
  zones: Record<string, { label: string; color: string }>;
}) {
  const byZone = Object.keys(zones).map(z => {
    const zRows = rows.filter(r => r.zone === z);
    if (!zRows.length) return null;
    const means = zRows.map(r => r.meanF);
    const mins  = zRows.map(r => r.minF);
    const maxs  = zRows.map(r => r.maxF);
    const avg = (arr: number[]) => Math.round((arr.reduce((s,v)=>s+v,0)/arr.length)*10)/10;
    return { zone: z, avgMean: avg(means), avgMin: avg(mins), avgMax: avg(maxs) };
  }).filter(Boolean) as { zone: string; avgMean: number; avgMin: number; avgMax: number }[];

  if (!byZone.length) return <p className="text-slate-500 text-sm">No data yet for this period.</p>;

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-700 text-slate-400">
          <th className="text-left py-2 pr-4">Zone</th>
          <th className="text-right py-2 pr-4">Avg Mean</th>
          <th className="text-right py-2 pr-4">Avg Min</th>
          <th className="text-right">Avg Max</th>
        </tr>
      </thead>
      <tbody>
        {byZone.sort((a,b) => b.avgMean - a.avgMean).map(s => (
          <tr key={s.zone} className="border-b border-slate-800 hover:bg-slate-800/30">
            <td className="py-2 pr-4 font-medium" style={{ color: zones[s.zone]?.color || "#94a3b8" }}>
              {zones[s.zone]?.label || s.zone}
            </td>
            <td className="text-right py-2 pr-4 text-slate-200">{s.avgMean}°F</td>
            <td className="text-right py-2 pr-4 text-blue-400">{s.avgMin}°F</td>
            <td className="text-right text-red-400">{s.avgMax}°F</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── ISO Sections ──────────────────────────────────────────────────────────────
function ActualsSection({
  iso,
  year,
  month,
  zones,
}: {
  iso: "ERCOT" | "CAISO";
  year: number;
  month: number;
  zones: Record<string, { label: string; color: string }>;
}) {
  const { data: hourly = [], isLoading } = useGetTemperature({ iso, year, month });
  const { data: stats = [] } = useGetTemperatureStats({ iso });

  const dailyAvg   = useMemo(() => buildDailyAvg(hourly,   zones), [hourly,   zones]);
  const hourlyProf = useMemo(() => buildHourlyProfile(hourly, zones), [hourly, zones]);

  if (isLoading) {
    return <div className="flex items-center justify-center h-48 text-slate-500">Loading…</div>;
  }

  if (!hourly.length) {
    return (
      <div className="flex items-center justify-center h-48 text-slate-500">
        No data for {iso} {MONTHS[month - 1]} {year}.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50">
        <h3 className="text-sm font-semibold text-slate-300 mb-4">
          Daily Average Temperature — {MONTHS[month - 1]} {year}
        </h3>
        <TempChart data={dailyAvg} xKey="day" xLabel="Day" zones={zones} />
      </div>
      <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50">
        <h3 className="text-sm font-semibold text-slate-300 mb-4">
          Average Hour-of-Day Profile — {MONTHS[month - 1]} {year}
        </h3>
        <TempChart data={hourlyProf} xKey="hour" xLabel="Hour (local)" zones={zones} />
      </div>
      <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50">
        <h3 className="text-sm font-semibold text-slate-300 mb-4">
          Monthly Summary — {MONTHS[month - 1]} {year}
        </h3>
        <StatsTable stats={stats} iso={iso} year={year} month={month} zones={zones} />
      </div>
    </div>
  );
}

function ForecastSection({
  iso,
  zones,
}: {
  iso: "ERCOT" | "CAISO";
  zones: Record<string, { label: string; color: string }>;
}) {
  const [year,  setYear]  = useState(FORECAST_START_YEAR);
  const [month, setMonth] = useState(FORECAST_START_MONTH);

  const { data: overview = [], isLoading: ovLoading } = useGetTemperatureForecastOverview({ iso });
  const { data: daily   = [], isLoading: dayLoading  } = useGetTemperatureForecast({ iso, year, month });

  const overviewChart = useMemo(() => buildOverviewChart(overview, zones), [overview, zones]);
  const dailyChart    = useMemo(() => buildDailyForecastChart(daily, zones), [daily, zones]);

  // Build valid year/month options within forecast range
  const periodOptions: { year: number; month: number; label: string }[] = useMemo(() => {
    const opts = [];
    let yr = FORECAST_START_YEAR;
    let mo = FORECAST_START_MONTH;
    while (yr < FORECAST_END_YEAR || (yr === FORECAST_END_YEAR && mo <= FORECAST_END_MONTH)) {
      opts.push({ year: yr, month: mo, label: `${MONTHS[mo - 1]} ${yr}` });
      mo++;
      if (mo > 12) { mo = 1; yr++; }
    }
    return opts;
  }, []);

  return (
    <div className="space-y-6">
      {/* 3-year overview */}
      <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-300">
              3-Year Temperature Outlook — Monthly Mean with Min/Max Band
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Source: Open-Meteo Climate API · EC-Earth3P-HR (CMIP6) · Jul 2026 – Jun 2029
            </p>
          </div>
        </div>
        {ovLoading ? (
          <div className="flex items-center justify-center h-48 text-slate-500">Loading forecast…</div>
        ) : overview.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-slate-500">
            No forecast data yet — run seed-temperature-forecast.py
          </div>
        ) : (
          <ForecastOverviewChart data={overviewChart} zones={zones} />
        )}
      </div>

      {/* Monthly detail */}
      <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <h3 className="text-sm font-semibold text-slate-300">
            Daily Forecast — {MONTHS[month - 1]} {year}
          </h3>
          <select
            value={`${year}-${month}`}
            onChange={e => {
              const [y, m] = e.target.value.split("-").map(Number);
              setYear(y);
              setMonth(m);
            }}
            className="bg-slate-700 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-200"
          >
            {periodOptions.map(o => (
              <option key={`${o.year}-${o.month}`} value={`${o.year}-${o.month}`}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {dayLoading ? (
          <div className="flex items-center justify-center h-48 text-slate-500">Loading…</div>
        ) : daily.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-slate-500">
            No forecast data for this period yet.
          </div>
        ) : (
          <ForecastDailyChart data={dailyChart} zones={zones} />
        )}
      </div>

      {/* Monthly stats */}
      {daily.length > 0 && (
        <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50">
          <h3 className="text-sm font-semibold text-slate-300 mb-4">
            Zone Summary — {MONTHS[month - 1]} {year}
          </h3>
          <ForecastStatsTable rows={daily} zones={zones} />
        </div>
      )}

      {/* Methodology note */}
      <div className="bg-slate-900/60 rounded-lg p-3 border border-slate-700/30">
        <p className="text-xs text-slate-500 leading-relaxed">
          <span className="text-slate-400 font-medium">Methodology:</span> Daily mean, min, and max
          from EC-Earth3P-HR (CMIP6 scenario SSP5-8.5). Shaded bands show projected daily temperature range.
          For hourly profiles, future work will apply the historical monthly diurnal cycle (from 2024–2025
          actuals) shifted to match each forecast day's projected mean — preserving realistic day/night
          swing amplitude.
        </p>
      </div>
    </div>
  );
}

// ── Load Forecast Section ─────────────────────────────────────────────────────

interface LoadForecastRow {
  zone: string; year: number; month: number;
  baseMw: number; evMw: number; dcMw: number; totalMw: number; peakMw: number;
}

const LOAD_ZONE_COLORS: Record<string, string> = {
  COAS: "#14b8a6", NCEN: "#8b5cf6", NRTH: "#f59e0b",
  EAST: "#22c55e", SCEN: "#ef4444", SOUT: "#3b82f6",
  FWES: "#f97316", WEST: "#ec4899",
};

function LoadForecastSection() {
  const [selectedZone, setSelectedZone] = useState("NCEN");
  const [showEv,       setShowEv]       = useState(true);
  const [showDc,       setShowDc]       = useState(true);

  const { data: rows = [], isLoading } = useQuery<LoadForecastRow[]>({
    queryKey: ["load-forecast-overview"],
    queryFn:  () => fetch("/api/load-forecast/overview").then(r => r.json()),
    staleTime: 10 * 60 * 1000,
  });

  const zoneData = useMemo(() =>
    rows
      .filter(r => r.zone === selectedZone)
      .map(r => ({
        label:   `${MONTHS[r.month - 1]} '${String(r.year).slice(2)}`,
        base:    Math.round(r.baseMw),
        ev:      Math.round(r.evMw),
        dc:      Math.round(r.dcMw),
        total:   Math.round(r.totalMw),
        peak:    Math.round(r.peakMw),
      })),
    [rows, selectedZone]
  );

  // All-zone comparison (annual avg)
  const allZoneComparison = useMemo(() => {
    const byZone: Record<string, { zone: string; avg2027: number; avg2029: number }> = {};
    for (const r of rows) {
      if (!byZone[r.zone]) byZone[r.zone] = { zone: r.zone, avg2027: 0, avg2029: 0 };
    }
    for (const zone of Object.keys(byZone)) {
      const data2027 = rows.filter(r => r.zone === zone && r.year === 2027);
      const data2029 = rows.filter(r => r.zone === zone && r.year === 2029);
      byZone[zone].avg2027 = data2027.length
        ? Math.round(data2027.reduce((s, r) => s + r.totalMw, 0) / data2027.length)
        : 0;
      byZone[zone].avg2029 = data2029.length
        ? Math.round(data2029.reduce((s, r) => s + r.totalMw, 0) / data2029.length)
        : 0;
    }
    return Object.values(byZone).sort((a, b) => b.avg2029 - a.avg2029);
  }, [rows]);

  const zones = Object.keys(LOAD_ZONE_COLORS);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500">
        Loading load forecast…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Zone selector + overlay toggles */}
      <div className="flex items-center gap-6 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400 uppercase tracking-wide">Zone</span>
          <div className="flex gap-1 bg-slate-800/60 p-1 rounded-lg border border-slate-700/50">
            {zones.map(z => (
              <button
                key={z}
                onClick={() => setSelectedZone(z)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  selectedZone === z
                    ? "text-white"
                    : "text-slate-400 hover:text-slate-200"
                }`}
                style={selectedZone === z ? { backgroundColor: LOAD_ZONE_COLORS[z] } : undefined}
              >
                {z}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowEv(!showEv)}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border transition-colors ${
              showEv
                ? "border-amber-500/50 bg-amber-500/15 text-amber-400"
                : "border-slate-700 text-slate-500"
            }`}
          >
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-400" />
            EV Charging
          </button>
          <button
            onClick={() => setShowDc(!showDc)}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border transition-colors ${
              showDc
                ? "border-purple-500/50 bg-purple-500/15 text-purple-400"
                : "border-slate-700 text-slate-500"
            }`}
          >
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-purple-400" />
            Datacenter Pipeline
          </button>
        </div>
      </div>

      {/* Stacked area chart */}
      <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-slate-300">
            3-Year Load Forecast — {selectedZone} Zone
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Temperature regression (OLS) applied to CMIP6 climate forecast · Jul 2026 – Jun 2029
          </p>
        </div>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={zoneData} margin={{ top: 4, right: 16, left: 10, bottom: 4 }}>
            <defs>
              <linearGradient id="baseGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={LOAD_ZONE_COLORS[selectedZone] ?? "#14b8a6"} stopOpacity={0.3} />
                <stop offset="95%" stopColor={LOAD_ZONE_COLORS[selectedZone] ?? "#14b8a6"} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="label"
              tick={{ fill: "#94a3b8", fontSize: 10 }}
              interval={2}
            />
            <YAxis
              tick={{ fill: "#94a3b8", fontSize: 11 }}
              tickFormatter={(v) => `${(v / 1000).toFixed(0)}GW`}
              width={42}
            />
            <Tooltip
              contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8 }}
              labelStyle={{ color: "#94a3b8" }}
              formatter={(v: number, name: string) => {
                const labels: Record<string, string> = {
                  base: "Base (Regression)", ev: "EV Charging +", dc: "Datacenter +",
                };
                return [`${v.toLocaleString()} MW`, labels[name] ?? name];
              }}
            />
            <Legend
              formatter={(val) => ({ base: "Base Load (Regression)", ev: "EV Charging Increment", dc: "Datacenter Pipeline" })[val] ?? val}
              wrapperStyle={{ color: "#94a3b8", fontSize: 11 }}
            />
            <Area
              type="monotone"
              dataKey="base"
              stackId="1"
              stroke={LOAD_ZONE_COLORS[selectedZone] ?? "#14b8a6"}
              fill="url(#baseGrad)"
              strokeWidth={1.5}
            />
            {showEv && (
              <Area
                type="monotone"
                dataKey="ev"
                stackId="1"
                stroke="#f59e0b"
                fill="#f59e0b"
                fillOpacity={0.35}
                strokeWidth={1}
              />
            )}
            {showDc && (
              <Area
                type="monotone"
                dataKey="dc"
                stackId="1"
                stroke="#8b5cf6"
                fill="#8b5cf6"
                fillOpacity={0.35}
                strokeWidth={1}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* All-zone 2027 vs 2029 comparison */}
      <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50">
        <h3 className="text-sm font-semibold text-slate-300 mb-4">
          Zone Comparison — Avg Daily Load (MW incl. EV + DC)
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-slate-400 text-xs uppercase">
                <th className="text-left pb-2 font-medium">Zone</th>
                <th className="text-right pb-2 font-medium">2027 Avg MW</th>
                <th className="text-right pb-2 font-medium">2029 Avg MW</th>
                <th className="text-right pb-2 font-medium">Growth</th>
              </tr>
            </thead>
            <tbody>
              {allZoneComparison.map(r => (
                <tr key={r.zone} className="border-t border-slate-700/40">
                  <td className="py-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-sm"
                        style={{ backgroundColor: LOAD_ZONE_COLORS[r.zone] ?? "#94a3b8" }}
                      />
                      <span className="text-slate-200 font-medium">{r.zone}</span>
                      <span className="text-slate-500 text-xs">
                        {ERCOT_ZONES[r.zone]?.label.split("(")[1]?.replace(")", "") ?? ""}
                      </span>
                    </div>
                  </td>
                  <td className="py-2 text-right text-slate-300 font-mono">
                    {r.avg2027.toLocaleString()}
                  </td>
                  <td className="py-2 text-right font-mono" style={{ color: LOAD_ZONE_COLORS[r.zone] ?? "#14b8a6" }}>
                    {r.avg2029.toLocaleString()}
                  </td>
                  <td className="py-2 text-right text-amber-400 text-xs">
                    {r.avg2027 > 0
                      ? `+${((r.avg2029 / r.avg2027 - 1) * 100).toFixed(1)}%`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Methodology */}
      <div className="bg-slate-900/60 rounded-lg p-3 border border-slate-700/30">
        <p className="text-xs text-slate-500 leading-relaxed">
          <span className="text-slate-400 font-medium">Methodology:</span>{" "}
          Base load forecast fits an OLS regression per ERCOT zone on 2.5 years of hourly EIA-930 data:
          Load_MW ≈ β₀ + β₁·Temp + β₂·Temp² + β₃·sin(2πm/12) + β₄·cos(2πm/12) + β₅·IsWeekend.
          R² = 0.88–0.92 for NCEN, COAS, SCEN (major load zones); lower for FWES/WEST (flat, industry-dominated).
          Coefficients applied to EC-Earth3P-HR CMIP6 temperature forecast (Jul 2026–Jun 2029).
          EV increment above Jun-2026 baseline per ERCOT LTSA 2024; zone shares via EIA vehicle registration data.
          Datacenter increment uses announced pipeline COD dates from company filings.
        </p>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function WeatherPage() {
  const [mode,      setMode]      = useState<"actuals" | "forecast" | "load">("actuals");
  const [activeIso, setActiveIso] = useState<"ERCOT" | "CAISO">("ERCOT");

  // Actuals selectors
  const [year,  setYear]  = useState(2025);
  const [month, setMonth] = useState(7);

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: currentYear - 2023 }, (_, i) => 2024 + i);

  const zones = activeIso === "ERCOT" ? ERCOT_ZONES : CAISO_ZONES;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Temperature</h1>
          <p className="text-slate-400 mt-1 text-sm">
            Actuals: Open-Meteo archive API, hourly by zone, Jan 2024–Jun 2026.
            Forecast: EC-Earth3P-HR climate model (CMIP6), daily, Jul 2026–Jun 2029.
          </p>
        </div>

        {/* Actuals year/month selectors — only shown in actuals mode */}
        {mode === "actuals" && (
          <div className="flex items-center gap-2 flex-shrink-0">
            <select
              value={year}
              onChange={e => setYear(Number(e.target.value))}
              className="bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-200"
            >
              {years.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <select
              value={month}
              onChange={e => setMonth(Number(e.target.value))}
              className="bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-200"
            >
              {MONTHS.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
            </select>
          </div>
        )}
      </div>

      {/* ── Toggles row ── */}
      <div className="flex items-center gap-8 flex-wrap">
        <div className="flex gap-1 bg-slate-800/60 p-1 rounded-lg border border-slate-700/50">
          {(["actuals", "forecast", "load"] as const).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-5 py-1.5 rounded-md text-sm font-medium transition-colors ${
                mode === m
                  ? m === "forecast"
                    ? "bg-amber-500 text-white"
                    : m === "load"
                      ? "bg-blue-600 text-white"
                      : "bg-teal-500 text-white"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {m === "actuals" ? "Temp Actuals" : m === "forecast" ? "Temp Forecast" : "Load Forecast"}
            </button>
          ))}
        </div>

        {mode !== "load" && (
          <div className="flex gap-1 bg-slate-800/40 p-1 rounded-lg border border-slate-700/30">
            {(["ERCOT", "CAISO"] as const).map(iso => (
              <button
                key={iso}
                onClick={() => setActiveIso(iso)}
                className={`px-5 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  activeIso === iso
                    ? "bg-slate-600 text-white"
                    : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {iso}
              </button>
            ))}
          </div>
        )}

        {mode === "load" && (
          <span className="text-xs text-slate-500 bg-slate-800/40 px-3 py-1.5 rounded border border-slate-700/30">
            ERCOT only · 8 zones · Jul 2026 – Jun 2029
          </span>
        )}
      </div>

      {/* ── Content ── */}
      {mode === "actuals" ? (
        <ActualsSection iso={activeIso} year={year} month={month} zones={zones} />
      ) : mode === "forecast" ? (
        <ForecastSection iso={activeIso} zones={zones} />
      ) : (
        <LoadForecastSection />
      )}
    </div>
  );
}
