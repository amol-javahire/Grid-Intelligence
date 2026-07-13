import { useState, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  Legend, ResponsiveContainer, ReferenceLine, Scatter, ScatterChart, Cell,
} from "recharts";
import { Loader2, TrendingUp, TrendingDown, Zap, Flame, AlertTriangle, Upload, X, CheckCircle2 } from "lucide-react";

// ── palette ───────────────────────────────────────────────────────────────
const C = {
  teal:   "#14b8a6", amber:  "#f59e0b", purple: "#8b5cf6",
  red:    "#ef4444", green:  "#22c55e", blue:   "#3b82f6",
  orange: "#f97316", pink:   "#ec4899",
  tooltipBg: "#0f172a", tooltipBorder: "#1e293b", tooltipFg: "#f8fafc",
};
const TOOLTIP_STYLE = {
  backgroundColor: C.tooltipBg, borderColor: C.tooltipBorder, color: C.tooltipFg,
};

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmtMonth = (y: number, m: number) => `${MONTHS[m-1]} '${String(y).slice(2)}`;

const HUB_NODES = [
  "HB_HOUSTON","HB_NORTH","HB_SOUTH","HB_WEST","HB_PAN",
  "LZ_HOUSTON","LZ_NORTH","LZ_SOUTH","LZ_WEST","LZ_AEN","LZ_CPS","LZ_LCRA",
];

// ── API helpers ───────────────────────────────────────────────────────────
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
async function apiFetch<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json() as Promise<T>;
}

interface GasRow  { hub: string; date: string; price: number; source: string }
interface SpreadRow {
  year: number; month: number;
  powerPrice: number; gasPrice: number | null; sparkSpread: number | null; heatRate: number;
}
interface HeatRateRow {
  year: number; month: number;
  powerPrice: number; gasPrice: number | null; impliedHeatRate: number | null;
}
interface ForwardRow {
  label: string; dateKey: string; type: "forward";
  forwardPrice: number; source: string;
  syntheticPowerPrice: number;
  seasonalMult: number;
  sparkBase: number | null; sparkHigh: number | null; sparkLow: number | null;
}
interface HistoricalSpotRow {
  label: string; dateKey: string; type: "historical";
  spotPrice: number; powerPrice: number | null; sparkSpread: number | null;
}
interface ForwardCurveResponse {
  asOfDate: string | null;
  node: string;
  heatRate: number;
  latestSpot: number | null;
  promptForward: number | null;
  avgPowerFwd: number | null;
  avgSyntheticPowerFwd: number | null;
  curveShape: "contango" | "backwardation" | "flat";
  curveSteepness: number;
  sourceCounts: Record<string, number>;
  historicalSpot: HistoricalSpotRow[];
  forwardStrip: ForwardRow[];
}
interface BasisRow {
  year: number; month: number;
  hhAvg: number | null; wahaAvg: number | null; wahaBasis: number | null;
  powerDaAvg: number | null; powerRtAvg: number | null;
  powerBasis: number | null; negPricePct: number | null;
}
interface SummaryNode {
  node: string; year: number; month: number;
  powerPrice: number; gasPrice: number | null;
  sparkSpread: number | null; impliedHR: number | null;
}
interface Summary {
  latestGas: Record<string, { date: string; price: number; source?: string }>;
  nodes: SummaryNode[];
  benchmarks: Record<string, { label: string; minHR: number; maxHR: number }>;
}

// ── Custom tooltip ────────────────────────────────────────────────────────
function CustomTooltip({ active, payload, label, unit = "" }: {
  active?: boolean; payload?: { name: string; value: number; color: string }[];
  label?: string; unit?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded border p-2 text-xs" style={TOOLTIP_STYLE}>
      <p className="font-semibold mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color }}>
          {p.name}: {p.value != null ? `${Number(p.value).toFixed(2)}${unit}` : "—"}
        </p>
      ))}
    </div>
  );
}

// ── CSV parser for Bloomberg / CME strip paste ─────────────────────────────
const MON_ABB: Record<string, number> = {
  jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
  jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

function parseCsvStrip(text: string): { deliveryMonth: string; settlePrice: number }[] {
  const rows: { deliveryMonth: string; settlePrice: number }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // Split on comma, tab, pipe, or 2+ spaces
    const parts = line.split(/[,\t|]|\s{2,}/).map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) continue;

    const [col1, col2] = parts;
    // Parse price — try second column first, then last column
    const priceStr = col2 ?? parts[parts.length - 1];
    const price = parseFloat(priceStr.replace(/[^0-9.-]/g, ""));
    if (isNaN(price) || price <= 0 || price > 50) continue;

    // Parse delivery month from col1
    // Formats: "Aug-26", "Aug 2026", "AUG26", "2026-08", "2026-08-01"
    let deliveryMonth: string | null = null;
    const c1 = col1.replace(/\s+/g, "").toLowerCase();

    // ISO date
    const isoMatch = c1.match(/^(\d{4})-?(\d{2})(-\d{2})?$/);
    if (isoMatch) {
      deliveryMonth = `${isoMatch[1]}-${isoMatch[2]}-01`;
    }
    if (!deliveryMonth) {
      // Mon-YY or Mon-YYYY or MonYY or Mon YYYY
      const monMatch = col1.replace(/\s+/g, "").toLowerCase().match(/^([a-z]{3})-?(\d{2,4})$/);
      if (monMatch) {
        const mon = MON_ABB[monMatch[1]];
        if (mon) {
          const yr = monMatch[2].length === 2 ? `20${monMatch[2]}` : monMatch[2];
          deliveryMonth = `${yr}-${String(mon).padStart(2, "0")}-01`;
        }
      }
    }
    if (!deliveryMonth) continue;

    rows.push({ deliveryMonth, settlePrice: price });
  }
  return rows;
}

// ── Main page ─────────────────────────────────────────────────────────────
export default function ErcotGasPage() {
  // State
  const [node,     setNode]     = useState("HB_HOUSTON");
  const [heatRate, setHeatRate] = useState(8.5);
  const [gasHub,   setGasHub]   = useState("henry_hub");

  // Upload strip state
  const [uploadOpen,   setUploadOpen]   = useState(false);
  const [csvText,      setCsvText]      = useState("");
  const [uploadStatus, setUploadStatus] = useState<"idle"|"parsing"|"uploading"|"done"|"error">("idle");
  const [uploadMsg,    setUploadMsg]    = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const queryClient = useQueryClient();

  // Queries
  const { data: gasPrices, isLoading: gasLoading } = useQuery<GasRow[]>({
    queryKey: ["gas-prices"],
    queryFn: () => apiFetch("/api/gas-prices"),
    staleTime: 5 * 60_000,
  });

  const { data: sparkData, isLoading: sparkLoading } = useQuery<{ data: SpreadRow[] }>({
    queryKey: ["spark-spread", node, heatRate, gasHub],
    queryFn: () => apiFetch(`/api/gas-prices/spark-spread?node=${node}&heat_rate=${heatRate}&gas_hub=${gasHub}`),
    staleTime: 5 * 60_000,
  });

  const { data: hrData, isLoading: hrLoading } = useQuery<{ data: HeatRateRow[] }>({
    queryKey: ["implied-heat-rate", node, gasHub],
    queryFn: () => apiFetch(`/api/gas-prices/implied-heat-rate?node=${node}&gas_hub=${gasHub}`),
    staleTime: 5 * 60_000,
  });

  const { data: basisData, isLoading: basisLoading } = useQuery<{ data: BasisRow[] }>({
    queryKey: ["waha-basis"],
    queryFn: () => apiFetch("/api/gas-prices/waha-basis"),
    staleTime: 5 * 60_000,
  });

  const { data: summary } = useQuery<Summary>({
    queryKey: ["gas-summary"],
    queryFn: () => apiFetch("/api/gas-prices/summary"),
    staleTime: 5 * 60_000,
  });

  const { data: fwdData, isLoading: fwdLoading } = useQuery<ForwardCurveResponse>({
    queryKey: ["forward-curve", node, heatRate],
    queryFn: () => apiFetch(`/api/gas-prices/forward-curve?node=${node}&heat_rate=${heatRate}`),
    staleTime: 30 * 60_000,
  });

  // Upload Bloomberg/CME strip handler
  async function handleUpload() {
    if (!csvText.trim()) return;
    setUploadStatus("parsing");
    setUploadMsg("");
    const rows = parseCsvStrip(csvText);
    if (rows.length === 0) {
      setUploadStatus("error");
      setUploadMsg("No valid rows parsed. Check format: 'Aug-26, 3.250' or '2026-08, 3.250'");
      return;
    }
    setUploadStatus("uploading");
    try {
      const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
      const res = await fetch(`${BASE}/api/gas-prices/forward-curve/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, source: "user_csv" }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as { message?: string }).message ?? `HTTP ${res.status}`);
      }
      const json = await res.json() as { upserted: number; asOfDate: string };
      setUploadStatus("done");
      setUploadMsg(`✓ ${json.upserted} months uploaded as of ${json.asOfDate}`);
      setCsvText("");
      // Invalidate forward curve queries so charts refresh
      await queryClient.invalidateQueries({ queryKey: ["forward-curve"] });
      await queryClient.invalidateQueries({ queryKey: ["forward-curve-ppa"] });
    } catch (err) {
      setUploadStatus("error");
      setUploadMsg(err instanceof Error ? err.message : "Upload failed");
    }
  }

  // ── Derived data ─────────────────────────────────────────────────────────
  const priceHistory = useMemo(() => {
    if (!gasPrices) return [];
    const byDate: Record<string, { date: string; henry_hub?: number; waha?: number }> = {};
    for (const r of gasPrices) {
      if (!byDate[r.date]) byDate[r.date] = { date: r.date };
      byDate[r.date][r.hub as "henry_hub" | "waha"] = Number(r.price);
    }
    return Object.values(byDate)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(r => ({
        ...r,
        wahaBasis: r.henry_hub != null && r.waha != null
          ? +(r.waha - r.henry_hub).toFixed(3) : undefined,
      }));
  }, [gasPrices]);

  // Monthly averages for price chart
  const monthlyPrices = useMemo(() => {
    if (!gasPrices) return [];
    const map: Record<string, { label: string; henry_hub: number[]; waha: number[] }> = {};
    for (const r of gasPrices) {
      const d = new Date(r.date);
      const y = d.getFullYear(), m = d.getMonth() + 1;
      const k = `${y}-${String(m).padStart(2,"0")}`;
      if (!map[k]) map[k] = { label: fmtMonth(y, m), henry_hub: [], waha: [] };
      map[k][r.hub as "henry_hub" | "waha"].push(Number(r.price));
    }
    return Object.entries(map)
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([,v]) => ({
        label:      v.label,
        henry_hub:  v.henry_hub.length ? +(v.henry_hub.reduce((a,b)=>a+b,0)/v.henry_hub.length).toFixed(3) : undefined,
        waha:       v.waha.length      ? +(v.waha.reduce((a,b)=>a+b,0)/v.waha.length).toFixed(3)          : undefined,
        wahaBasis:  (v.henry_hub.length && v.waha.length)
          ? +((v.waha.reduce((a,b)=>a+b,0)/v.waha.length) - (v.henry_hub.reduce((a,b)=>a+b,0)/v.henry_hub.length)).toFixed(3)
          : undefined,
      }));
  }, [gasPrices]);

  const spreadRows = useMemo(() => (sparkData?.data ?? []).map(r => ({
    ...r,
    label: fmtMonth(r.year, r.month),
    spreadColor: (r.sparkSpread ?? 0) > 10 ? C.green : (r.sparkSpread ?? 0) < 0 ? C.red : C.amber,
  })), [sparkData]);

  const hrRows = useMemo(() => (hrData?.data ?? []).map(r => ({
    ...r, label: fmtMonth(r.year, r.month),
  })), [hrData]);

  const basisRows = useMemo(() => (basisData?.data ?? []).map(r => ({
    ...r, label: fmtMonth(r.year, r.month),
  })), [basisData]);

  // Summary stats
  const hhLatest  = summary?.latestGas?.henry_hub;
  const wahaLatest= summary?.latestGas?.waha;
  const wahaBasisLatest = (hhLatest && wahaLatest)
    ? (wahaLatest.price - hhLatest.price).toFixed(2) : null;

  const latestSpread = [...spreadRows].reverse().find(r => r.sparkSpread != null) ?? spreadRows.at(-1);

  const noData = !gasLoading && (!gasPrices || gasPrices.length === 0);

  return (
    <div className="p-6 space-y-6 max-w-screen-2xl mx-auto">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-foreground">ERCOT Gas & Power Fundamentals</h1>
        <p className="text-muted-foreground text-sm">
          Henry Hub + Waha daily prices, spark spreads, implied heat rates, and basis analysis.
          Gas price drives ~70% of ERCOT's thermal dispatch and sets the power price floor.
        </p>
      </div>

      {/* KPI bar */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-card border-border">
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Henry Hub (latest)</p>
            <p className="text-2xl font-bold text-teal-400">
              {hhLatest ? `$${hhLatest.price.toFixed(2)}` : "—"}
              <span className="text-sm font-normal text-muted-foreground ml-1">/MMBtu</span>
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">{hhLatest?.date ?? "no data"}</p>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              Waha Hub (latest)
              {wahaLatest?.source === "model" && <span className="text-[10px] bg-slate-700 text-slate-400 px-1 rounded">model</span>}
            </p>
            <p className={`text-2xl font-bold ${wahaLatest && wahaLatest.price < 0 ? "text-red-400" : "text-amber-400"}`}>
              {wahaLatest ? `$${wahaLatest.price.toFixed(2)}` : "N/A"}
              <span className="text-sm font-normal text-muted-foreground ml-1">/MMBtu</span>
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">{wahaLatest ? wahaLatest.date : "Not seeded"}</p>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              Waha−HH Basis (latest)
              {wahaLatest?.source === "model" && <span className="text-[10px] bg-slate-700 text-slate-400 px-1 rounded">model</span>}
            </p>
            <p className={`text-2xl font-bold ${wahaBasisLatest && Number(wahaBasisLatest) < -2 ? "text-red-400" : "text-purple-400"}`}>
              {wahaBasisLatest ? `$${wahaBasisLatest}` : "N/A"}
              <span className="text-sm font-normal text-muted-foreground ml-1">/MMBtu</span>
            </p>
            {wahaBasisLatest && Number(wahaBasisLatest) < -3 && (
              <p className="text-xs text-red-400 mt-0.5 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> Extreme negative basis
              </p>
            )}
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">
              {node} Spark Spread (latest mo.)
            </p>
            <p className={`text-2xl font-bold ${(latestSpread?.sparkSpread ?? 0) > 10 ? "text-green-400" : (latestSpread?.sparkSpread ?? 0) < 0 ? "text-red-400" : "text-amber-400"}`}>
              {latestSpread?.sparkSpread != null ? `$${latestSpread.sparkSpread.toFixed(1)}` : "—"}
              <span className="text-sm font-normal text-muted-foreground ml-1">/MWh</span>
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">HR {heatRate} MMBtu/MWh</p>
          </CardContent>
        </Card>
      </div>

      {/* No data banner */}
      {noData && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="pt-4 text-sm text-amber-400">
            <strong>Gas price data not yet seeded.</strong> Run{" "}
            <code className="font-mono bg-muted px-1 rounded">pnpm --filter @workspace/scripts run seed-gas-prices</code>{" "}
            to fetch Henry Hub (FRED) prices since Jan 2024.
          </CardContent>
        </Card>
      )}

      {/* Waha data note */}
      {!noData && wahaLatest && (
        <div className="flex items-center gap-2 px-3 py-2 rounded text-xs text-muted-foreground border border-border/40 bg-muted/20">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500/70 shrink-0" />
          <span>
            <strong className="text-foreground/70">Waha Hub: real prices from Feb 2025 (NGI via oilpriceapi.com).</strong>{" "}
            Pre-Feb 2025 dates use a model-based estimate (Henry Hub + seasonal basis). Days marked{" "}
            <span className="bg-slate-700 text-slate-400 px-1 rounded text-[10px]">model</span> are estimated.
          </span>
        </div>
      )}
      {/* Waha not seeded note */}
      {!noData && !wahaLatest && (
        <div className="flex items-center gap-2 px-3 py-2 rounded text-xs text-muted-foreground border border-border/40 bg-muted/20">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500/70 shrink-0" />
          <span>
            <strong className="text-foreground/70">Waha Hub prices not seeded.</strong>{" "}
            Run <code className="font-mono bg-muted px-1 rounded">seed-gas-prices</code> to generate model-based Waha prices from Henry Hub.
          </span>
        </div>
      )}

      {/* Main tabs */}
      <Tabs defaultValue="prices" className="space-y-4">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="prices">Price History</TabsTrigger>
          <TabsTrigger value="spark">Spark Spread</TabsTrigger>
          <TabsTrigger value="heatrate">Implied Heat Rate</TabsTrigger>
          <TabsTrigger value="basis">Waha Basis</TabsTrigger>
          <TabsTrigger value="context">Market Context</TabsTrigger>
          <TabsTrigger value="forward">Forward Curve</TabsTrigger>
        </TabsList>

        {/* ── Tab 1: Price History ───────────────────────────────────────── */}
        <TabsContent value="prices" className="space-y-4">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base">Henry Hub vs Waha — Monthly Average ($/MMBtu)</CardTitle>
              <CardDescription>
                Henry Hub: real daily (FRED DHHNGSP). Waha: real from Feb 2025 (NGI via oilpriceapi), model-estimated before.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {gasLoading ? (
                <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-teal-400" /></div>
              ) : (
                <ResponsiveContainer width="100%" height={320}>
                  <ComposedChart data={monthlyPrices} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={v => `$${v}`} />
                    <RechartsTooltip content={<CustomTooltip unit="/MMBtu" />} />
                    <Legend />
                    <Line dataKey="henry_hub" name="Henry Hub" stroke={C.teal}  dot={false} strokeWidth={2} connectNulls />
                    <Line dataKey="waha"       name="Waha"       stroke={C.amber} dot={false} strokeWidth={2} connectNulls />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base">Waha−HH Basis ($/MMBtu)</CardTitle>
              <CardDescription>
                Negative = Waha discount. When deeply negative, West Texas gas is stranded
                and power plants near Waha run at near-zero fuel cost.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {gasLoading ? (
                <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-teal-400" /></div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={monthlyPrices} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={v => `$${v}`} />
                    <RechartsTooltip content={<CustomTooltip unit="/MMBtu" />} />
                    <ReferenceLine y={0} stroke="#64748b" strokeDasharray="4 2" />
                    <Bar dataKey="wahaBasis" name="Waha−HH Basis" fill={C.purple}>
                      {monthlyPrices.map((entry, index) => (
                        <Cell
                          key={index}
                          fill={(entry.wahaBasis ?? 0) < -3 ? C.red : (entry.wahaBasis ?? 0) < 0 ? C.amber : C.green}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Daily price table (last 30 days) */}
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base">Recent Daily Prices</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="text-left py-2">Date</th>
                      <th className="text-right py-2">Henry Hub</th>
                      <th className="text-right py-2">Waha</th>
                      <th className="text-right py-2">Basis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {priceHistory.slice(-30).reverse().map((r, i) => (
                      <tr key={i} className="border-b border-border/40 hover:bg-muted/20">
                        <td className="py-1.5 font-mono">{r.date}</td>
                        <td className="py-1.5 text-right text-teal-400">
                          {r.henry_hub != null ? `$${r.henry_hub.toFixed(3)}` : "—"}
                        </td>
                        <td className={`py-1.5 text-right ${r.waha != null && r.waha < 0 ? "text-red-400" : "text-amber-400"}`}>
                          {r.waha != null ? `$${r.waha.toFixed(3)}` : "—"}
                        </td>
                        <td className={`py-1.5 text-right ${r.wahaBasis != null && r.wahaBasis < 0 ? "text-red-400" : "text-muted-foreground"}`}>
                          {r.wahaBasis != null ? `$${r.wahaBasis.toFixed(3)}` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 2: Spark Spread Calculator ──────────────────────────── */}
        <TabsContent value="spark" className="space-y-4">
          {/* Controls */}
          <Card className="bg-card border-border">
            <CardContent className="pt-4">
              <div className="flex flex-wrap gap-6 items-end">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Power Node</label>
                  <Select value={node} onValueChange={setNode}>
                    <SelectTrigger className="w-40 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {HUB_NODES.map(n => (
                        <SelectItem key={n} value={n} className="text-xs">{n}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Gas Price Hub</label>
                  <Select value={gasHub} onValueChange={setGasHub}>
                    <SelectTrigger className="w-36 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="henry_hub" className="text-xs">Henry Hub</SelectItem>
                      <SelectItem value="waha"       className="text-xs">Waha Hub</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 min-w-[200px]">
                  <label className="text-xs text-muted-foreground">
                    Heat Rate: <span className="text-foreground font-semibold">{heatRate.toFixed(1)}</span> MMBtu/MWh
                  </label>
                  <Slider
                    min={6} max={14} step={0.5}
                    value={[heatRate]}
                    onValueChange={([v]) => setHeatRate(v)}
                    className="w-48"
                  />
                  <p className="text-xs text-muted-foreground">
                    {heatRate <= 7.5 ? "CCGT (efficient)" : heatRate <= 9 ? "Combined cycle" : heatRate <= 11 ? "Gas CT (peaker)" : "Old steam / oil"}
                  </p>
                </div>
                <div className="text-xs text-muted-foreground">
                  Spark Spread = Power Price − (Gas Price × Heat Rate)
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base">
                Monthly Spark Spread — {node} vs {gasHub === "henry_hub" ? "Henry Hub" : "Waha"} (HR {heatRate})
              </CardTitle>
              <CardDescription>
                Green &gt;$10/MWh = gas plant profitable. Red &lt;$0 = plant is underwater.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {sparkLoading ? (
                <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-teal-400" /></div>
              ) : (
                <ResponsiveContainer width="100%" height={320}>
                  <ComposedChart data={spreadRows} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} interval="preserveStartEnd" />
                    <YAxis yAxisId="power" tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={v => `$${v}`} />
                    <YAxis yAxisId="gas"  orientation="right" tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={v => `$${v}`} />
                    <RechartsTooltip content={<CustomTooltip unit="/MWh" />} />
                    <Legend />
                    <ReferenceLine yAxisId="power" y={0}  stroke="#64748b" strokeDasharray="4 2" />
                    <ReferenceLine yAxisId="power" y={10} stroke={C.green} strokeDasharray="3 3" strokeOpacity={0.5} label={{ value: "$10 threshold", fontSize: 10, fill: C.green }} />
                    <Bar yAxisId="power" dataKey="sparkSpread" name="Spark Spread ($/MWh)" fill={C.green}>
                      {spreadRows.map((entry, index) => (
                        <Cell
                          key={index}
                          fill={(entry.sparkSpread ?? 0) > 10 ? C.green : (entry.sparkSpread ?? 0) < 0 ? C.red : C.amber}
                        />
                      ))}
                    </Bar>
                    <Line  yAxisId="power" dataKey="powerPrice" name="Power Price ($/MWh)" stroke={C.teal}  dot={false} strokeWidth={1.5} />
                    <Line  yAxisId="gas"   dataKey="gasPrice"   name={`Gas ($/MMBtu)`}     stroke={C.amber} dot={false} strokeWidth={1.5} strokeDasharray="5 3" />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Spark spread table */}
          {spreadRows.length > 0 && (
            <Card className="bg-card border-border">
              <CardHeader><CardTitle className="text-base">Monthly Spark Spread Table</CardTitle></CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="text-left py-2">Month</th>
                        <th className="text-right py-2">Power ($/MWh)</th>
                        <th className="text-right py-2">Gas ($/MMBtu)</th>
                        <th className="text-right py-2">Fuel Cost ($/MWh)</th>
                        <th className="text-right py-2">Spark Spread</th>
                        <th className="text-right py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...spreadRows].reverse().map((r, i) => {
                        const fuelCost = r.gasPrice != null ? r.gasPrice * heatRate : null;
                        const spread   = r.sparkSpread;
                        return (
                          <tr key={i} className="border-b border-border/40 hover:bg-muted/20">
                            <td className="py-1.5">{r.label}</td>
                            <td className="py-1.5 text-right text-teal-400">${r.powerPrice.toFixed(2)}</td>
                            <td className="py-1.5 text-right text-amber-400">
                              {r.gasPrice != null ? `$${r.gasPrice.toFixed(3)}` : "—"}
                            </td>
                            <td className="py-1.5 text-right text-muted-foreground">
                              {fuelCost != null ? `$${fuelCost.toFixed(2)}` : "—"}
                            </td>
                            <td className={`py-1.5 text-right font-semibold ${spread == null ? "" : spread > 10 ? "text-green-400" : spread < 0 ? "text-red-400" : "text-amber-400"}`}>
                              {spread != null ? `$${spread.toFixed(2)}` : "—"}
                            </td>
                            <td className="py-1.5 text-right">
                              {spread == null ? "—" :
                               spread > 10  ? <Badge className="bg-green-500/20 text-green-400 text-xs border-0">Profitable</Badge> :
                               spread > 0   ? <Badge className="bg-amber-500/20 text-amber-400 text-xs border-0">Marginal</Badge> :
                                              <Badge className="bg-red-500/20  text-red-400  text-xs border-0">Underwater</Badge>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Tab 3: Implied Heat Rate ────────────────────────────────── */}
        <TabsContent value="heatrate" className="space-y-4">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base">Implied Heat Rate — {node} ÷ {gasHub === "henry_hub" ? "Henry Hub" : "Waha"}</CardTitle>
              <CardDescription>
                Implied HR = Power Price ÷ Gas Price. Above 12 → scarcity. Below 7 → renewables dominating.
                This is the market's signal of gas plant optionality value.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {hrLoading ? (
                <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-teal-400" /></div>
              ) : (
                <ResponsiveContainer width="100%" height={340}>
                  <ComposedChart data={hrRows} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} interval="preserveStartEnd" />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} domain={[0, "auto"]}
                           tickFormatter={v => `${v}`} label={{ value: "MMBtu/MWh", angle: -90, position: "insideLeft", fontSize: 11, fill: "#64748b" }} />
                    <RechartsTooltip content={<CustomTooltip unit=" MMBtu/MWh" />} />
                    <Legend />
                    <ReferenceLine y={7}  stroke={C.green}  strokeDasharray="4 2" label={{ value: "7 CCGT efficient", fontSize: 10, fill: C.green,  position: "right" }} />
                    <ReferenceLine y={9}  stroke={C.amber}  strokeDasharray="4 2" label={{ value: "9 typical peaker", fontSize: 10, fill: C.amber,  position: "right" }} />
                    <ReferenceLine y={12} stroke={C.red}    strokeDasharray="4 2" label={{ value: "12 scarcity zone",  fontSize: 10, fill: C.red,    position: "right" }} />
                    <Area dataKey="impliedHeatRate" name="Implied Heat Rate" stroke={C.purple} fill={C.purple} fillOpacity={0.15} dot={false} strokeWidth={2} connectNulls />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <div className="grid md:grid-cols-3 gap-4">
            {[
              { label: "CCGT (efficient)", range: "6.5 – 7.5", color: "text-green-400", desc: "Renewables displacing gas; low-cost dispatch" },
              { label: "Gas CT (peaker)",  range: "9.0 – 11.0", color: "text-amber-400", desc: "Normal gas-dominated dispatch; peakers in merit" },
              { label: "Scarcity zone",    range: "≥ 12.0",     color: "text-red-400",   desc: "Grid stress; demand outpacing cheap supply" },
            ].map(b => (
              <Card key={b.label} className="bg-card border-border">
                <CardContent className="pt-4">
                  <p className={`text-sm font-semibold ${b.color}`}>{b.label}</p>
                  <p className="text-xl font-bold text-foreground">{b.range}</p>
                  <p className="text-xs text-muted-foreground mt-1">{b.desc}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* ── Tab 4: Waha Basis Analysis ──────────────────────────────── */}
        <TabsContent value="basis" className="space-y-4">
          {!basisData?.data?.some(r => r.wahaAvg != null) && !basisLoading && (
            <Card className="border-amber-500/30 bg-amber-500/5">
              <CardContent className="pt-4 text-sm text-amber-400">
                Waha price data not yet seeded. Henry Hub is available. Run{" "}
                <code className="font-mono bg-muted px-1 rounded">pnpm --filter @workspace/scripts run seed-gas-prices</code>{" "}
                to also fetch Waha from EIA.
              </CardContent>
            </Card>
          )}

          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base">Waha−HH Basis alongside LZ_WEST Power Basis</CardTitle>
              <CardDescription>
                The Waha gas discount and West Texas power discount share the same root cause:
                Permian takeaway capacity bottleneck. They move together — Waha basis is a
                leading indicator for ERCOT West Texas power congestion.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {basisLoading ? (
                <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-teal-400" /></div>
              ) : (
                <ResponsiveContainer width="100%" height={340}>
                  <ComposedChart data={basisRows} margin={{ top: 5, right: 40, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} interval="preserveStartEnd" />
                    <YAxis yAxisId="gas"   tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={v => `$${v}`}
                           label={{ value: "$/MMBtu", angle: -90, position: "insideLeft", fontSize: 11, fill: "#64748b" }} />
                    <YAxis yAxisId="power" orientation="right" tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={v => `$${v}`}
                           label={{ value: "$/MWh", angle: 90, position: "insideRight", fontSize: 11, fill: "#64748b" }} />
                    <RechartsTooltip content={<CustomTooltip />} />
                    <Legend />
                    <ReferenceLine yAxisId="gas" y={0} stroke="#64748b" strokeDasharray="4 2" />
                    <Bar  yAxisId="gas"   dataKey="wahaBasis"  name="Waha−HH Basis ($/MMBtu)" fill={C.purple} fillOpacity={0.7} />
                    <Line yAxisId="power" dataKey="powerBasis" name="LZ_WEST RT−DA Basis ($/MWh)" stroke={C.amber} dot={false} strokeWidth={2} connectNulls />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <div className="grid md:grid-cols-2 gap-4">
            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle className="text-base">HH vs Waha Monthly Averages</CardTitle>
              </CardHeader>
              <CardContent>
                {basisLoading ? <Loader2 className="h-6 w-6 animate-spin text-teal-400" /> : (
                  <ResponsiveContainer width="100%" height={240}>
                    <LineChart data={basisRows} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#64748b" }} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10, fill: "#64748b" }} tickFormatter={v => `$${v}`} />
                      <RechartsTooltip content={<CustomTooltip unit="/MMBtu" />} />
                      <Legend />
                      <ReferenceLine y={0} stroke="#64748b" strokeDasharray="4 2" />
                      <Line dataKey="hhAvg"   name="Henry Hub" stroke={C.teal}  dot={false} strokeWidth={2} connectNulls />
                      <Line dataKey="wahaAvg" name="Waha"      stroke={C.amber} dot={false} strokeWidth={2} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle className="text-base">Waha Basis vs LZ_WEST Neg Price %</CardTitle>
                <CardDescription className="text-xs">
                  Correlation: when Waha blows negative, LZ_WEST negative price frequency rises.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {basisLoading ? <Loader2 className="h-6 w-6 animate-spin text-teal-400" /> : (
                  <ResponsiveContainer width="100%" height={240}>
                    <ScatterChart margin={{ top: 5, right: 20, bottom: 20, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="wahaBasis"  name="Waha Basis" tick={{ fontSize: 10, fill: "#64748b" }}
                             label={{ value: "Waha Basis ($/MMBtu)", position: "insideBottom", offset: -10, fontSize: 11, fill: "#64748b" }}
                             tickFormatter={v => `$${v}`} />
                      <YAxis dataKey="negPricePct" name="Neg Price %" tick={{ fontSize: 10, fill: "#64748b" }}
                             label={{ value: "Neg Price %", angle: -90, position: "insideLeft", fontSize: 11, fill: "#64748b" }} />
                      <RechartsTooltip cursor={{ strokeDasharray: "3 3" }}
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const d = payload[0]?.payload as BasisRow & { label: string };
                          return (
                            <div className="rounded border p-2 text-xs" style={TOOLTIP_STYLE}>
                              <p className="font-semibold">{d.label}</p>
                              <p>Waha Basis: {d.wahaBasis != null ? `$${d.wahaBasis.toFixed(2)}` : "—"}</p>
                              <p>LZ_WEST Neg Price: {d.negPricePct != null ? `${d.negPricePct.toFixed(1)}%` : "—"}</p>
                            </div>
                          );
                        }}
                      />
                      <Scatter
                        data={basisRows.filter(r => r.wahaBasis != null && r.negPricePct != null)}
                        fill={C.purple} fillOpacity={0.8}
                      />
                    </ScatterChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Context callout */}
          <Card className="border-red-500/30 bg-red-500/5">
            <CardContent className="pt-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-red-400 mt-0.5 shrink-0" />
                <div className="text-sm">
                  <p className="font-semibold text-red-400 mb-1">Current Waha Market Condition (mid-2026)</p>
                  <p className="text-muted-foreground">
                    Waha has been deeply negative — prompt month fixed price hit <strong className="text-foreground">−$5.69/MMBtu</strong>,
                    basis vs Henry Hub at <strong className="text-foreground">−$8.25/MMBtu</strong> — the longest-ever streak of consecutive
                    negative trading sessions (89+). Targa + Kinetik shut in 620 MMcf/d from the Permian due to lack of
                    pipeline takeaway. This directly suppresses LZ_WEST power prices and explains elevated West Texas curtailment.
                    Gas plants near Waha effectively run at negative fuel cost.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 5: Market Context ────────────────────────────────────── */}
        <TabsContent value="context" className="space-y-4">
          {/* Spark spread by node at current gas prices */}
          {summary && (
            <Card className="bg-card border-border">
              <CardHeader>
                <CardTitle className="text-base">Current Spark Spread by Node (HR 8.5 MMBtu/MWh)</CardTitle>
                <CardDescription>
                  West Texas nodes use Waha pricing; all others use Henry Hub. Based on latest monthly averages.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="text-left py-2">Node</th>
                        <th className="text-right py-2">Power ($/MWh)</th>
                        <th className="text-right py-2">Gas Used</th>
                        <th className="text-right py-2">Gas Price</th>
                        <th className="text-right py-2">Fuel Cost</th>
                        <th className="text-right py-2">Spark Spread</th>
                        <th className="text-right py-2">Implied HR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.nodes
                        .filter(n => n.node.startsWith("HB_") || n.node.startsWith("LZ_"))
                        .map((n, i) => {
                          const isWest = n.node === "LZ_WEST" || n.node === "HB_PAN";
                          const fuelCost = n.gasPrice != null ? n.gasPrice * 8.5 : null;
                          return (
                            <tr key={i} className="border-b border-border/40 hover:bg-muted/20">
                              <td className="py-1.5 font-mono font-semibold">{n.node}</td>
                              <td className="py-1.5 text-right text-teal-400">${n.powerPrice.toFixed(2)}</td>
                              <td className="py-1.5 text-right text-muted-foreground text-xs">
                                {isWest ? "Waha" : "HH"}
                              </td>
                              <td className={`py-1.5 text-right ${n.gasPrice != null && n.gasPrice < 0 ? "text-red-400" : "text-amber-400"}`}>
                                {n.gasPrice != null ? `$${n.gasPrice.toFixed(2)}` : "—"}
                              </td>
                              <td className="py-1.5 text-right text-muted-foreground">
                                {fuelCost != null ? `$${fuelCost.toFixed(2)}` : "—"}
                              </td>
                              <td className={`py-1.5 text-right font-semibold ${n.sparkSpread == null ? "" : n.sparkSpread > 10 ? "text-green-400" : n.sparkSpread < 0 ? "text-red-400" : "text-amber-400"}`}>
                                {n.sparkSpread != null ? `$${n.sparkSpread.toFixed(2)}` : "—"}
                              </td>
                              <td className={`py-1.5 text-right ${n.impliedHR == null ? "" : n.impliedHR > 12 ? "text-red-400" : n.impliedHR < 7 ? "text-green-400" : "text-muted-foreground"}`}>
                                {n.impliedHR != null ? n.impliedHR.toFixed(1) : "—"}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Heat rate benchmarks */}
          <div className="grid md:grid-cols-2 gap-4">
            <Card className="bg-card border-border">
              <CardHeader><CardTitle className="text-base">Heat Rate Benchmarks by Technology</CardTitle></CardHeader>
              <CardContent>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="text-left py-2">Technology</th>
                      <th className="text-right py-2">Heat Rate (MMBtu/MWh)</th>
                      <th className="text-right py-2">At HH $3.50</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { tech: "CCGT (new)",    hr: 6.5,  },
                      { tech: "CCGT (avg)",    hr: 7.2,  },
                      { tech: "CCGT (old)",    hr: 7.8,  },
                      { tech: "Gas CT",        hr: 9.5,  },
                      { tech: "Gas CT (old)",  hr: 11.0, },
                      { tech: "Oil/Gas steam", hr: 13.0, },
                      { tech: "Oil peaker",    hr: 15.0, },
                    ].map(r => (
                      <tr key={r.tech} className="border-b border-border/40">
                        <td className="py-1.5">{r.tech}</td>
                        <td className="py-1.5 text-right text-teal-400">{r.hr}</td>
                        <td className="py-1.5 text-right text-muted-foreground">${(r.hr * 3.50).toFixed(2)}/MWh</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            <Card className="bg-card border-border">
              <CardHeader><CardTitle className="text-base">Analytical Use Cases</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-3 text-xs">
                  {[
                    {
                      icon: <Flame className="h-4 w-4 text-orange-400" />,
                      title: "Spark Spread = Gas Plant P&L",
                      desc: "Spark Spread = Power − (Gas × HR). When LZ_WEST DA is $22 and Waha is −$5, spark spread = $22 − (−$5 × 8.5) = $64.50/MWh.",
                    },
                    {
                      icon: <TrendingUp className="h-4 w-4 text-teal-400" />,
                      title: "Implied HR = Market's Gas Optionality Signal",
                      desc: "Strips out the gas price component. Spikes during scarcity (Uri-style). Below 7 = renewables dominating. Cleaner signal than raw power price.",
                    },
                    {
                      icon: <TrendingDown className="h-4 w-4 text-red-400" />,
                      title: "Waha Basis = Congestion Leading Indicator",
                      desc: "Waha discount widens → stranded Permian gas → cheap West Texas power → higher curtailment risk for solar/wind. Gas basis predicts power basis.",
                    },
                    {
                      icon: <Zap className="h-4 w-4 text-amber-400" />,
                      title: "Gas Price Sets the Power Floor",
                      desc: "HH × 8.5 HR = ~$29.75/MWh at $3.50 gas. When DA drops below this, gas backs off and renewables dominate — but transmission constrains them.",
                    },
                  ].map((u, i) => (
                    <div key={i} className="flex gap-2">
                      <div className="shrink-0 mt-0.5">{u.icon}</div>
                      <div>
                        <p className="font-semibold text-foreground">{u.title}</p>
                        <p className="text-muted-foreground mt-0.5">{u.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── Tab 6: Forward Curve ────────────────────────────────────── */}
        <TabsContent value="forward" className="space-y-4">
          {/* Controls bar */}
          <div className="flex flex-wrap gap-3 items-center">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Node:</span>
              <Select value={node} onValueChange={setNode}>
                <SelectTrigger className="w-36 h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HUB_NODES.map(n => (
                    <SelectItem key={n} value={n} className="text-xs">{n}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">Heat Rate:</span>
              <Slider
                min={6} max={15} step={0.5}
                value={[heatRate]}
                onValueChange={([v]) => setHeatRate(v)}
                className="w-28"
              />
              <span className="text-xs font-mono text-teal-400">{heatRate} MMBtu/MWh</span>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {fwdData?.asOfDate && (
                <Badge variant="outline" className="text-xs text-muted-foreground">
                  Curve as of {fwdData.asOfDate}
                  {(fwdData.sourceCounts["user_csv"] ?? 0) > 0 && (
                    <span className="ml-1 text-teal-400">· Bloomberg</span>
                  )}
                </Badge>
              )}
              <button
                onClick={() => { setUploadOpen(v => !v); setUploadStatus("idle"); setUploadMsg(""); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600 transition-colors"
              >
                <Upload className="h-3.5 w-3.5" />
                Upload Strip
              </button>
            </div>
          </div>

          {/* ── Upload expand panel ── */}
          {uploadOpen && (
            <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                  <Upload className="h-3.5 w-3.5 text-teal-400" />
                  Paste Bloomberg / CME Natural Gas Strip
                </p>
                <button onClick={() => setUploadOpen(false)} className="text-slate-500 hover:text-slate-300">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Paste two columns: <span className="font-mono text-slate-400">Month, Price</span>.
                Accepted formats: <span className="font-mono">Aug-26, 3.250</span> · <span className="font-mono">AUG26  3.250</span> · <span className="font-mono">2026-08, 3.250</span>
                {" "}(comma, tab, pipe, or 2+ spaces as delimiter). One row per line. Upserts today as <em>user_csv</em> source.
              </p>
              <textarea
                ref={textareaRef}
                value={csvText}
                onChange={e => { setCsvText(e.target.value); setUploadStatus("idle"); setUploadMsg(""); }}
                placeholder={"Aug-26\t3.250\nSep-26\t3.180\nOct-26\t3.350\n..."}
                rows={8}
                spellCheck={false}
                className="w-full font-mono text-[11px] bg-slate-800 border border-slate-600 rounded px-3 py-2 text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-teal-500 resize-y"
              />
              <div className="flex items-center gap-3">
                <button
                  onClick={handleUpload}
                  disabled={!csvText.trim() || uploadStatus === "uploading"}
                  className="px-4 py-1.5 rounded-md bg-teal-600 hover:bg-teal-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold transition-colors"
                >
                  {uploadStatus === "uploading" ? "Uploading…" : uploadStatus === "parsing" ? "Parsing…" : "Upload Strip"}
                </button>
                {csvText.trim() && uploadStatus === "idle" && (
                  <span className="text-[11px] text-slate-500">
                    {parseCsvStrip(csvText).length} rows parsed
                  </span>
                )}
                {uploadStatus === "done" && (
                  <span className="flex items-center gap-1 text-[11px] text-teal-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />{uploadMsg}
                  </span>
                )}
                {uploadStatus === "error" && (
                  <span className="text-[11px] text-red-400">{uploadMsg}</span>
                )}
              </div>
            </div>
          )}

          {/* KPI row */}
          {fwdData && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card className="bg-card border-border">
                <CardContent className="pt-3 pb-3">
                  <p className="text-xs text-muted-foreground">HH Spot (latest)</p>
                  <p className="text-xl font-bold text-teal-400">
                    {fwdData.latestSpot != null ? `$${fwdData.latestSpot.toFixed(2)}` : "—"}
                    <span className="text-xs font-normal text-muted-foreground ml-1">/MMBtu</span>
                  </p>
                </CardContent>
              </Card>
              <Card className="bg-card border-border">
                <CardContent className="pt-3 pb-3">
                  <p className="text-xs text-muted-foreground">Prompt Month Forward</p>
                  <p className="text-xl font-bold text-amber-400">
                    {fwdData.promptForward != null ? `$${fwdData.promptForward.toFixed(2)}` : "—"}
                    <span className="text-xs font-normal text-muted-foreground ml-1">/MMBtu</span>
                  </p>
                </CardContent>
              </Card>
              <Card className="bg-card border-border">
                <CardContent className="pt-3 pb-3">
                  <p className="text-xs text-muted-foreground">Curve Shape</p>
                  <p className={`text-xl font-bold capitalize ${
                    fwdData.curveShape === "contango" ? "text-blue-400" :
                    fwdData.curveShape === "backwardation" ? "text-red-400" : "text-muted-foreground"
                  }`}>
                    {fwdData.curveShape}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {fwdData.curveSteepness > 0 ? "+" : ""}{fwdData.curveSteepness.toFixed(2)} $/MMBtu (5Y slope)
                  </p>
                </CardContent>
              </Card>
              <Card className="bg-card border-border">
                <CardContent className="pt-3 pb-3">
                  <p className="text-xs text-muted-foreground">{node} Fwd Spark (HR {heatRate})</p>
                  {(() => {
                    const fwdSpark = fwdData.forwardStrip[0]?.sparkBase;
                    return (
                      <p className={`text-xl font-bold ${fwdSpark == null ? "text-muted-foreground" : fwdSpark > 10 ? "text-green-400" : fwdSpark < 0 ? "text-red-400" : "text-amber-400"}`}>
                        {fwdSpark != null ? `$${fwdSpark.toFixed(1)}` : "—"}
                        <span className="text-xs font-normal text-muted-foreground ml-1">/MWh</span>
                      </p>
                    );
                  })()}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Main chart: historical spot + forward strip overlay */}
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base">Henry Hub: Historical Spot vs Forward Strip</CardTitle>
              <CardDescription>
                Last 30 months of realized spot prices overlaid with the current 5-year forward strip.
                Contango = back months priced above prompt; backwardation = market expects supply relief.
                {fwdData && (
                  <span className="ml-2">
                    Data: {Object.entries(fwdData.sourceCounts).map(([src, n]) => (
                      <span key={src} className={`ml-1 text-[10px] px-1 rounded ${
                        src === "user_csv" ? "bg-teal-900 text-teal-300" :
                        src === "model" ? "bg-slate-700 text-slate-400" :
                        "bg-blue-900/40 text-blue-300"
                      }`}>
                        {src === "user_csv" ? "📋 Bloomberg" : src === "eia_steo" ? "EIA STEO" : src === "fred" ? "FRED" : "model"} {n}mo
                      </span>
                    ))}
                    {(fwdData.sourceCounts["model"] ?? 0) > 0 && !fwdData.sourceCounts["user_csv"] && (
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        (seasonal shape + $3.50 mean-reversion — upload Bloomberg strip to override)
                      </span>
                    )}
                  </span>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {fwdLoading ? (
                <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-teal-400" /></div>
              ) : fwdData ? (() => {
                // Merge historical + forward into single timeline
                const histData = fwdData.historicalSpot.map(r => ({
                  label: r.label,
                  spot: r.spotPrice,
                  forward: undefined as number | undefined,
                }));
                const fwdChartData = fwdData.forwardStrip.map(r => ({
                  label: r.label,
                  spot: undefined as number | undefined,
                  forward: r.forwardPrice,
                }));
                // Stitch: last hist point shared as first forward point for visual continuity
                const stitchPrice = fwdData.historicalSpot.at(-1)?.spotPrice;
                const stitchLabel = fwdData.historicalSpot.at(-1)?.label ?? "";
                const allData = [
                  ...histData,
                  // bridge point connecting the two series
                  { label: stitchLabel, spot: stitchPrice, forward: stitchPrice },
                  ...fwdChartData,
                ];
                return (
                  <ResponsiveContainer width="100%" height={340}>
                    <ComposedChart data={allData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#64748b" }} interval={3} angle={-30} textAnchor="end" height={40} />
                      <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={v => `$${v}`} domain={["auto","auto"]} />
                      <RechartsTooltip content={<CustomTooltip unit="/MMBtu" />} />
                      <Legend />
                      <Line dataKey="spot"    name="HH Spot (historical)" stroke={C.teal}  dot={false} strokeWidth={2} connectNulls />
                      <Line dataKey="forward" name="HH Forward Strip"     stroke={C.amber} dot={false} strokeWidth={2} strokeDasharray="6 3" connectNulls />
                      {/* Reference line at $3.50 LT equilibrium */}
                      <ReferenceLine y={3.50} stroke="#64748b" strokeDasharray="4 4" label={{ value: "$3.50 LT avg", position: "right", fontSize: 9, fill: "#64748b" }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                );
              })() : (
                <p className="text-muted-foreground text-sm py-8 text-center">
                  No forward curve data. Run{" "}
                  <code className="font-mono bg-muted px-1 rounded">pnpm --filter @workspace/scripts run seed-gas-forwards</code>
                  {" "}to seed the strip.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Forward spark spread with sensitivity */}
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base">Forward Spark Spread Sensitivity — {node} (HR {heatRate})</CardTitle>
              <CardDescription>
                Implied spark spread = {node} power price − (gas price × {heatRate} heat rate).
                Power proxy = trailing 3-month average DA price. Sensitivity shows ±$1/MMBtu gas shock.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {fwdLoading ? (
                <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-teal-400" /></div>
              ) : fwdData?.forwardStrip.length ? (
                <ResponsiveContainer width="100%" height={280}>
                  <ComposedChart data={fwdData.forwardStrip} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#64748b" }} interval={3} angle={-30} textAnchor="end" height={40} />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={v => `$${v}`} />
                    <RechartsTooltip content={<CustomTooltip unit="/MWh" />} />
                    <Legend />
                    <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="3 3" />
                    <Line dataKey="sparkHigh" name="Gas −$1 (bull)"  stroke={C.green}  dot={false} strokeWidth={1.5} strokeDasharray="4 2" connectNulls />
                    <Line dataKey="sparkBase" name="Base case"       stroke={C.teal}   dot={false} strokeWidth={2} connectNulls />
                    <Line dataKey="sparkLow"  name="Gas +$1 (bear)"  stroke={C.red}    dot={false} strokeWidth={1.5} strokeDasharray="4 2" connectNulls />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-muted-foreground text-sm text-center py-8">No data</p>
              )}
            </CardContent>
          </Card>

          {/* Synthetic power forward chart */}
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base">Synthetic Power Forward Strip — {node} (Gas × HR {heatRate})</CardTitle>
              <CardDescription>
                Projected power settlement price = HH gas forward × {heatRate} MMBtu/MWh heat rate × seasonal ERCOT shape.
                No Bloomberg power forward subscription required — derived entirely from the gas strip.
                {fwdData?.avgSyntheticPowerFwd && (
                  <span className="ml-1 font-medium text-teal-400">
                    Strip avg: ${fwdData.avgSyntheticPowerFwd.toFixed(2)}/MWh
                  </span>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {fwdLoading ? (
                <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-teal-400" /></div>
              ) : fwdData?.forwardStrip.length ? (
                <ResponsiveContainer width="100%" height={260}>
                  <ComposedChart
                    data={fwdData.forwardStrip.map(r => ({
                      label: r.label,
                      powerFwd: r.syntheticPowerPrice,
                      gasFwd: r.forwardPrice,
                      fuelCost: r.forwardPrice * heatRate,
                    }))}
                    margin={{ top: 5, right: 20, bottom: 5, left: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#64748b" }} interval={3} angle={-30} textAnchor="end" height={40} />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={v => `$${v}`} domain={["auto","auto"]} />
                    <RechartsTooltip content={<CustomTooltip unit="/MWh" />} />
                    <Legend />
                    <Bar dataKey="powerFwd" name="Synthetic Power Fwd (seasonal)" fill={C.teal} opacity={0.85} radius={[3,3,0,0]} />
                    <Line dataKey="fuelCost" name="Flat Gas × HR (no seasonal adj)" stroke={C.amber} dot={false} strokeWidth={1.5} strokeDasharray="5 3" connectNulls />
                    {fwdData.avgPowerFwd && (
                      <ReferenceLine y={fwdData.avgPowerFwd} stroke="#64748b" strokeDasharray="4 4"
                        label={{ value: `Hist avg $${fwdData.avgPowerFwd.toFixed(0)}`, position: "right", fontSize: 9, fill: "#64748b" }} />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-muted-foreground text-sm text-center py-8">No forward strip loaded</p>
              )}
            </CardContent>
          </Card>

          {/* Forward strip table */}
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-base">Forward Strip Detail — Monthly Settlements</CardTitle>
              <CardDescription>
                HH settle price, synthetic power forward (gas × HR × seasonal adj), and spark sensitivity.
                Power proxy for spark = trailing 3-month {node} DA avg
                {fwdData?.avgPowerFwd ? ` ($${fwdData.avgPowerFwd.toFixed(2)}/MWh)` : ""}.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto max-h-72 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card">
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="text-left py-2 pr-3">Month</th>
                      <th className="text-right py-2 pr-3">HH Settle</th>
                      <th className="text-right py-2 pr-3">Synth Power</th>
                      <th className="text-right py-2 pr-3">Src</th>
                      <th className="text-right py-2 pr-3">Gas −$1</th>
                      <th className="text-right py-2 pr-3">Base Spark</th>
                      <th className="text-right py-2">Gas +$1</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(fwdData?.forwardStrip ?? []).map((r, i) => (
                      <tr key={i} className="border-b border-border/30 hover:bg-muted/20">
                        <td className="py-1 pr-3 font-mono">{r.label}</td>
                        <td className="py-1 pr-3 text-right text-amber-400">${r.forwardPrice.toFixed(3)}</td>
                        <td className="py-1 pr-3 text-right text-teal-400 font-semibold">${r.syntheticPowerPrice.toFixed(2)}</td>
                        <td className="py-1 pr-3 text-right">
                          <span className={`text-[10px] px-1 rounded ${
                            r.source === "user_csv" ? "bg-teal-900/60 text-teal-300" :
                            r.source === "model"   ? "bg-slate-700 text-slate-400" :
                            "bg-blue-900/40 text-blue-300"
                          }`}>
                            {r.source === "user_csv" ? "📋 Upload" : r.source === "model" ? "model" : r.source === "eia_steo" ? "EIA" : r.source}
                          </span>
                        </td>
                        <td className={`py-1 pr-3 text-right ${r.sparkHigh != null && r.sparkHigh > 0 ? "text-green-400" : "text-red-400"}`}>
                          {r.sparkHigh != null ? `$${r.sparkHigh.toFixed(1)}` : "—"}
                        </td>
                        <td className={`py-1 pr-3 text-right font-semibold ${r.sparkBase == null ? "" : r.sparkBase > 10 ? "text-green-400" : r.sparkBase < 0 ? "text-red-400" : "text-amber-400"}`}>
                          {r.sparkBase != null ? `$${r.sparkBase.toFixed(1)}` : "—"}
                        </td>
                        <td className={`py-1 text-right ${r.sparkLow != null && r.sparkLow > 0 ? "text-amber-400" : "text-red-400"}`}>
                          {r.sparkLow != null ? `$${r.sparkLow.toFixed(1)}` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* Methodology note */}
          <Card className="bg-card border-border border-blue-500/20">
            <CardHeader><CardTitle className="text-sm text-blue-400">Methodology & PPA Deal Team Guidance</CardTitle></CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-2 gap-4 text-xs text-muted-foreground">
                <div className="space-y-2">
                  <p><strong className="text-foreground">Forward Strip Construction</strong></p>
                  <p>The seeder fetches real data in priority order: (1) EIA Short-Term Energy Outlook
                  (STEO) monthly Henry Hub forecast (~24 months, same API key as electricity data);
                  (2) FRED DHHFXED forward price series. Months not covered by real data use a
                  calibrated model extension: seasonal NYMEX shape from 2020–2025 settlement patterns
                  + mean reversion toward EIA AEO $3.50/MMBtu long-run reference.
                  Badges in the chart header show how many months come from each source.
                  Run <code className="bg-muted px-1 rounded">seed-gas-forwards</code> to refresh.</p>
                  <p><strong className="text-foreground">Spark Spread Interpretation</strong></p>
                  <p>Spark spread {">"} $10/MWh = gas plants profitable → power prices may compress.
                  Spark spread {"<"} $0 = gas plants uneconomic → renewable generation dominant.</p>
                </div>
                <div className="space-y-2">
                  <p><strong className="text-foreground">VPPA Pricing Implications</strong></p>
                  <p>A 10-year VPPA fixed price must be above the projected settlement price (DA LMP at
                  delivery node) to be in-the-money for Walmart. If the forward curve implies sustained
                  low spark spreads (gas surplus / renewable penetration), merchant power prices may
                  stay depressed — reducing PPA counterparty risk but also reducing the hedge value.</p>
                  <p><strong className="text-foreground">High Implied Heat Rate Signal</strong></p>
                  <p>Current 10–14 implied HRs signal scarcity pricing. If the forward strip shows
                  gas prices rising (contango), that scarcity is expected to persist — supporting higher
                  PPA floor prices and stronger counterparty creditworthiness.</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
