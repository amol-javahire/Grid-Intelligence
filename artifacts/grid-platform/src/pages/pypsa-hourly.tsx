import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Clock, CheckCircle2 } from "lucide-react";
import { useState } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
  Tooltip as RechartsTooltip, Cell, Legend,
} from "recharts";

const TS = { backgroundColor: "#0f172a", borderColor: "#1e293b", color: "#f8fafc", fontSize: 11 };

const HUBS = [
  "HB_NORTH","HB_SOUTH","HB_WEST","HB_PAN","HB_HOUSTON","HB_BUSAVG","HB_HUBAVG",
  "LZ_NORTH","LZ_SOUTH","LZ_WEST","LZ_HOUSTON","LZ_AEN","LZ_CPS","LZ_LCRA","LZ_RAYBN",
];
const YEARS  = ["2024","2025"];
const MONTHS = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function hourLabel(h: number) {
  if (h === 0) return "12a";
  if (h < 12) return `${h}a`;
  if (h === 12) return "12p";
  return `${h - 12}p`;
}

function basisColor(v: number) {
  if (v > 25) return "#ef4444";
  if (v > 10) return "#f59e0b";
  if (v < -25) return "#ef4444";
  if (v < -10) return "#f59e0b";
  return "#14b8a6";
}

interface HourlyPoint {
  hour: number;
  label: string;
  daPrice: number;
  rtPrice: number;
  basis: number;
}

interface HourlyResponse {
  node: string;
  year: number;
  month: number;
  totalRows: number;
  hourly: { hour: number; daPrice: number; rtPrice: number }[];
}

export default function PypsaHourly() {
  const [node,  setNode]  = useState("HB_NORTH");
  const [year,  setYear]  = useState("2025");
  const [month, setMonth] = useState("7");

  const hourlyQ = useQuery<HourlyResponse>({
    queryKey: ["hub-hourly", node, year, month],
    queryFn: () =>
      fetch(`/api/ercot/hub-hourly?node=${encodeURIComponent(node)}&year=${year}&month=${month}`)
        .then(r => r.json()),
    staleTime: 300_000,
  });

  const data = hourlyQ.data;
  const totalRows = data?.totalRows ?? 0;
  const hasData = (data?.hourly?.length ?? 0) > 0;

  const chartData: HourlyPoint[] = (data?.hourly ?? []).map(r => ({
    hour: r.hour,
    label: hourLabel(r.hour),
    daPrice: r.daPrice,
    rtPrice: r.rtPrice,
    basis: parseFloat((r.rtPrice - r.daPrice).toFixed(4)),
  }));

  // Summary stats from the hourly data
  const summary = hasData ? (() => {
    const bases = chartData.map(r => r.basis);
    const avgBasis = (bases.reduce((s, v) => s + v, 0) / bases.length).toFixed(2);
    const sorted = [...bases].sort((a, b) => a - b);
    const p5  = sorted[Math.floor(sorted.length * 0.05)]?.toFixed(2) ?? "N/A";
    const p95 = sorted[Math.floor(sorted.length * 0.95)]?.toFixed(2) ?? "N/A";
    const avgDa = (chartData.reduce((s, r) => s + r.daPrice, 0) / chartData.length).toFixed(2);
    const avgRt = (chartData.reduce((s, r) => s + r.rtPrice, 0) / chartData.length).toFixed(2);
    const peakRtRaw = Math.max(...chartData.map(r => r.rtPrice));
    const peakRt = peakRtRaw.toFixed(2);
    const peakHour = chartData.find(r => r.rtPrice === peakRtRaw)?.label ?? "N/A";
    return { avgBasis, p5, p95, avgDa, avgRt, peakRt, peakHour };
  })() : null;

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Clock className="h-6 w-6 text-teal-400" />
            Hourly Price Data
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Real DA + RT hourly price profiles for ERCOT hub/zone nodes · 263,130 rows from CDR 13060/13061
          </p>
        </div>
        <div className="flex items-center gap-2">
          {totalRows > 0 && (
            <Badge variant="outline" className="border-teal-500/40 text-teal-400 text-xs flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" />
              {totalRows.toLocaleString()} rows loaded
            </Badge>
          )}
          <Badge variant="outline" className="border-teal-500/40 text-teal-400 text-xs">Hourly · Real</Badge>
        </div>
      </div>

      {/* Selectors */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Node:</span>
          <Select value={node} onValueChange={setNode}>
            <SelectTrigger className="w-40 h-8 text-xs border-border bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HUBS.map(n => <SelectItem key={n} value={n} className="text-xs">{n}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Year:</span>
          <Select value={year} onValueChange={setYear}>
            <SelectTrigger className="w-24 h-8 text-xs border-border bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {YEARS.map(y => <SelectItem key={y} value={y} className="text-xs">{y}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Month:</span>
          <Select value={month} onValueChange={setMonth}>
            <SelectTrigger className="w-24 h-8 text-xs border-border bg-background">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1,2,3,4,5,6,7,8,9,10,11,12].map(m => (
                <SelectItem key={m} value={String(m)} className="text-xs">{MONTHS[m]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {hourlyQ.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {/* Summary stats */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {[
            { label: "Avg DA", value: `$${summary.avgDa}`, color: "text-indigo-400" },
            { label: "Avg RT", value: `$${summary.avgRt}`, color: "text-teal-400" },
            { label: "Avg Basis (RT−DA)", value: `$${summary.avgBasis}`, color: "text-foreground" },
            { label: "Basis P5", value: `$${summary.p5}`, color: "text-slate-400" },
            { label: "Basis P95", value: `$${summary.p95}`, color: "text-slate-400" },
            { label: "Peak RT", value: `$${summary.peakRt}`, color: "text-amber-400" },
            { label: "Peak Hour", value: summary.peakHour, color: "text-amber-300" },
          ].map(s => (
            <Card key={s.label} className="bg-card border-border">
              <CardContent className="pt-3 pb-3">
                <div className="text-xs text-muted-foreground">{s.label}</div>
                <div className={`font-mono font-bold text-lg ${s.color}`}>{s.value}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!hasData && !hourlyQ.isLoading && (
        <Card className="bg-card border-border">
          <CardContent className="pt-6 pb-6 text-center text-muted-foreground text-sm">
            No data for {node} · {MONTHS[parseInt(month)]} {year}. Select a different month or node.
          </CardContent>
        </Card>
      )}

      {hasData && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Hourly DA vs RT price profile */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                Avg Hourly DA vs RT — {node} · {MONTHS[parseInt(month)]} {year}
              </CardTitle>
              <CardDescription className="text-xs">
                Average across all days in the selected month · Real CDR data
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 4, right: 16, left: -10, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#94a3b8" }} interval={2} />
                    <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={v => `$${v}`} />
                    <RechartsTooltip
                      contentStyle={TS}
                      formatter={(v: number, n: string) => [`$${v.toFixed(2)}/MWh`, n]}
                    />
                    <Legend wrapperStyle={{ fontSize: 10, color: "#94a3b8" }} />
                    <Line type="monotone" dataKey="daPrice" name="DA" stroke="#6366f1" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="rtPrice" name="RT" stroke="#14b8a6" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Hourly basis bar chart */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">
                Hourly Basis (RT − DA) — {node} · {MONTHS[parseInt(month)]} {year}
              </CardTitle>
              <CardDescription className="text-xs">
                Teal = favourable · Amber = moderate congestion · Red = severe
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[260px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 4, right: 16, left: -10, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#94a3b8" }} interval={2} />
                    <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={v => `$${v}`} />
                    <RechartsTooltip
                      contentStyle={TS}
                      formatter={(v: number) => [`$${v.toFixed(2)}/MWh`, "RT − DA Basis"]}
                    />
                    <Bar dataKey="basis" radius={[2,2,0,0]} isAnimationActive={false}>
                      {chartData.map((d, i) => (
                        <Cell key={i} fill={basisColor(d.basis)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* DA-only profile (full-width) */}
      {hasData && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Full Hourly Price Overlay — All 24 Hours</CardTitle>
            <CardDescription className="text-xs">
              DA (indigo) and RT (teal) for each hour of the day, averaged across all days in {MONTHS[parseInt(month)]} {year}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} barSize={16} margin={{ top: 4, right: 16, left: -10, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#94a3b8" }} />
                  <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={v => `$${v}`} />
                  <RechartsTooltip
                    contentStyle={TS}
                    formatter={(v: number, n: string) => [`$${v.toFixed(2)}/MWh`, n]}
                  />
                  <Legend wrapperStyle={{ fontSize: 10, color: "#94a3b8" }} />
                  <Bar dataKey="daPrice" name="DA" fill="#6366f1" radius={[2,2,0,0]} isAnimationActive={false} />
                  <Bar dataKey="rtPrice" name="RT" fill="#14b8a6" radius={[2,2,0,0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Data source note */}
      <Card className="bg-card/50 border-border/50">
        <CardContent className="pt-3 pb-3">
          <p className="text-xs text-muted-foreground">
            <span className="text-teal-400 font-medium">Data source:</span> ERCOT CDR Report 13061 (RTM — 15-min intervals averaged to hourly) and CDR Report 13060 (DAM — hourly).
            All 15 hub/zone nodes · 2024–2025 · 263,130 rows. Parsed via Python multiprocessing XML extractor from ERCOT annual XLSX bundles.
          </p>
        </CardContent>
      </Card>

    </div>
  );
}
