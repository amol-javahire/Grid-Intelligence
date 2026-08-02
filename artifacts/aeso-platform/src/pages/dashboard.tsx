import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ComposedChart, Line, Area, Legend,
} from "recharts";
import {
  Activity, TrendingUp, Calculator, FileSignature, ListOrdered,
  ArrowRight, AlertTriangle,
} from "lucide-react";
import { TC_FORWARD, curveStripAverage } from "@/lib/alberta-forward-curve";
import { GAS_HISTORY, impliedHeatRate } from "@/lib/alberta-gas-history";

/* ══════════════════════════════════════════════════════════════════════════
   Dashboard — two bands.

   TOP: live market state (what the system is doing right now).
   BOTTOM: origination (what to do about it).

   Every panel is wired only to sources proven to hold data:
     · aeso_hourly_pool_price          — 22.5k hourly rows
     · aeso_metered_volume      — 14.9M hourly generator rows
     · aeso_asset_registry      — 230 CSD generators with MC + fuel type
     · /api/aeso/csd            — live scrape of the AESO CSD report
     · forward curve + gas history — static, sourced modules

   Deliberately NOT wired to aeso_hourly_gen_output, aeso_queue_projects,
   aeso_outages or aeso_supply_demand. Those were the reason the previous
   dashboard rendered every tile as "---": the route didn't fail, it returned
   nulls from four never-seeded tables and the page had no way to say so.
   Where a source IS missing, the API now reports it and we show that plainly
   rather than printing a dash.
   ══════════════════════════════════════════════════════════════════════════ */

interface SourceFlag { live: boolean; table: string }
interface DashboardData {
  latestPoolPrice: number | null;
  latestAilMw: number | null;
  latestReserveMarginPct: number | null;
  latestDate: string | null;
  avgPriceLast30Days: number | null;
  spikesLast30Days: number;
  windPctLastMonth: number | null;
  gasPctLastMonth: number | null;
  solarPctLastMonth: number | null;
  fleetMcMw: number | null;
  fleetGenMwh30d: number | null;
  byFuel: { fuelType: string; mcMw: number; genMwh: number }[];
  queueProjectCount: number;
  sources: Record<string, SourceFlag>;
}

interface CsdData {
  summary?: {
    totalNetGenMw: number | null;
    netInterchangeMw: number | null;
    ailMw: number | null;
  };
}

interface FuelTtm {
  fuel_type: string;
  assets: number;
  mc_mw: number;
  capacity_factor: number | null;
  capture_price: number | null;
  capture_rate: number | null;
  capture_spread: number | null;
  ttm_pool_price: number | null;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

const fmt = (n: number | null | undefined, d = 2) => (n != null ? n.toFixed(d) : "—");
const FUEL_COLOR: Record<string, string> = {
  WIND: "#14b8a6", SOLAR: "#f59e0b", HYDRO: "#3b82f6", "ENERGY STORAGE": "#10b981",
  COGENERATION: "#f97316", "COMBINED CYCLE": "#ef4444", "SIMPLE CYCLE": "#dc2626",
  "GAS FIRED STEAM": "#b91c1c", OTHER: "#64748b",
};

function Tile({ label, value, unit, sub, tone }: {
  label: string; value: string; unit?: string; sub?: string; tone?: "good" | "bad" | "warn";
}) {
  const color = tone === "good" ? "text-emerald-500" : tone === "bad" ? "text-red-500"
              : tone === "warn" ? "text-amber-500" : "";
  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <div className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</div>
        <div className={`text-2xl font-bold mt-1 ${color}`}>
          {value}
          {unit && <span className="text-sm font-normal text-muted-foreground"> {unit}</span>}
        </div>
        {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { data: dash, isLoading } = useQuery<DashboardData>({
    queryKey: ["aeso-dashboard"],
    queryFn: () => getJson<DashboardData>("/api/aeso/dashboard"),
    staleTime: 60_000,
  });

  const { data: csd } = useQuery<CsdData>({
    queryKey: ["aeso-dashboard-csd"],
    queryFn: () => getJson<CsdData>("/api/aeso/csd"),
    staleTime: 2 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  const { data: fuelTtm } = useQuery<{ fuels: FuelTtm[] }>({
    queryKey: ["aeso-dashboard-fuels"],
    queryFn: () => getJson<{ fuels: FuelTtm[] }>("/api/aeso/generation-stack/fuels"),
    staleTime: 10 * 60_000,
  });

  const latestGas = GAS_HISTORY[0];
  const spot = dash?.latestPoolPrice ?? null;
  const heatRate = spot != null && latestGas ? impliedHeatRate(spot, latestGas.gasGj) : null;
  const stripAvg = curveStripAverage();
  const fwdVsSpot = spot != null ? stripAvg - spot : null;

  // Fleet capture-rate leaders — the origination signal.
  const captureRanked = (fuelTtm?.fuels ?? [])
    .filter(f => f.capture_rate != null && f.mc_mw > 0)
    .slice()
    .sort((a, b) => (b.capture_rate ?? 0) - (a.capture_rate ?? 0));

  const captureChart = captureRanked.map(f => ({
    fuel: f.fuel_type.replace("GAS FIRED STEAM", "GAS STEAM").replace("ENERGY STORAGE", "STORAGE"),
    rate: f.capture_rate != null ? +(f.capture_rate * 100).toFixed(1) : 0,
    spread: f.capture_spread,
    mc: f.mc_mw,
    raw: f.fuel_type,
  }));

  const curveChart = TC_FORWARD.map(r => ({
    period: r.period.replace("Balance of month", "BoM").replace("Balance of ", "Bal ").replace("Calendar ", "Cal-"),
    Power: r.flat,
    Gas: r.gasGj,
  }));

  const deadSources = Object.entries(dash?.sources ?? {}).filter(([, v]) => !v.live);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Market Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Alberta market state, then where the origination opportunity sits
        </p>
      </div>

      {/* ═══ BAND 1 — LIVE MARKET STATE ═══════════════════════════════════ */}
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Market state</h2>
        <div className="h-px flex-1 bg-border" />
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <Tile label="Pool price" value={`C$${fmt(spot)}`} unit="/MWh"
                sub={dash?.latestDate ? `as of ${dash.latestDate}` : undefined} />
          <Tile label="30-day average" value={`C$${fmt(dash?.avgPriceLast30Days)}`} unit="/MWh"
                sub={`${dash?.spikesLast30Days ?? 0} hrs ≥ C$200`}
                tone={(dash?.spikesLast30Days ?? 0) > 24 ? "warn" : undefined} />
          <Tile label="Alberta internal load"
                value={csd?.summary?.ailMw != null ? Math.round(csd.summary.ailMw).toLocaleString() : "—"}
                unit="MW" sub="live CSD" />
          <Tile label="Net generation"
                value={csd?.summary?.totalNetGenMw != null ? Math.round(csd.summary.totalNetGenMw).toLocaleString() : "—"}
                unit="MW"
                sub={csd?.summary?.netInterchangeMw != null
                  ? `intertie ${csd.summary.netInterchangeMw >= 0 ? "+" : ""}${Math.round(csd.summary.netInterchangeMw)} MW`
                  : "live CSD"} />
          <Tile label="Implied heat rate" value={fmt(heatRate, 1)} unit="GJ/MWh"
                sub={latestGas ? `gas C$${fmt(latestGas.gasGj)}/GJ · ${latestGas.month}` : undefined} />
        </div>
      )}

      {/* Fuel mix from real metered volume */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Fleet output by fuel — last 30 days</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Share of metered generation. From 14.9M hourly generator rows joined to the CSD
              registry — not a fuel-mix table.
            </p>
          </CardHeader>
          <CardContent>
            {dash?.byFuel && dash.byFuel.length > 0 ? (
              <div className="space-y-2">
                {dash.byFuel
                  .filter(f => f.genMwh > 0)
                  .slice(0, 8)
                  .map(f => {
                    const pct = (dash.fleetGenMwh30d ?? 0) > 0 ? (f.genMwh / (dash.fleetGenMwh30d ?? 1)) * 100 : 0;
                    return (
                      <div key={f.fuelType} className="space-y-1">
                        <div className="flex justify-between text-xs">
                          <span className="font-medium">{f.fuelType}</span>
                          <span className="font-mono text-muted-foreground">
                            {pct.toFixed(1)}% · {Math.round(f.mcMw).toLocaleString()} MW cap
                          </span>
                        </div>
                        <div className="w-full bg-muted rounded-full h-2">
                          <div className="h-2 rounded-full transition-all"
                               style={{ width: `${Math.min(pct, 100)}%`,
                                        background: FUEL_COLOR[f.fuelType?.toUpperCase()] ?? "#64748b" }} />
                        </div>
                      </div>
                    );
                  })}
              </div>
            ) : (
              <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">
                Loading fleet data…
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Forward curve vs spot</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Power (left) and AECO gas (right). Strip average C${stripAvg.toFixed(2)}/MWh
              {fwdVsSpot != null && (
                <> — {fwdVsSpot >= 0 ? "above" : "below"} spot by C${Math.abs(fwdVsSpot).toFixed(2)}</>
              )}.
            </p>
          </CardHeader>
          <CardContent className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={curveChart} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="dashGas" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="period" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                <YAxis yAxisId="p" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))"
                       tickFormatter={v => `$${v}`} width={46} />
                <YAxis yAxisId="g" orientation="right" tick={{ fontSize: 10 }} stroke="#f59e0b"
                       tickFormatter={v => `$${v}`} width={40} domain={[0, "dataMax + 1"]} />
                <Tooltip contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))", fontSize: 12 }}
                         formatter={(v: number, n: string) => n === "Gas" ? [`C$${v.toFixed(2)}/GJ`, n] : [`C$${v.toFixed(2)}/MWh`, n]} />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
                <Area yAxisId="g" type="monotone" dataKey="Gas" stroke="#f59e0b" fill="url(#dashGas)" strokeWidth={1.5} dot={false} />
                <Line yAxisId="p" type="monotone" dataKey="Power" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={{ r: 2 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* ═══ BAND 2 — ORIGINATION ═════════════════════════════════════════ */}
      <div className="flex items-center gap-2 pt-2">
        <TrendingUp className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Origination</h2>
        <div className="h-px flex-1 bg-border" />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">Capture rate by fuel — trailing 12 months</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Generation-weighted capture price ÷ hour-weighted pool price. Above 100% means the fuel
            earns more than the system average when it runs — the core screening signal in a
            single-price market.
          </p>
        </CardHeader>
        <CardContent className="h-64">
          {captureChart.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={captureChart} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="fuel" tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))"
                       angle={-20} textAnchor="end" height={54} interval={0} />
                <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))"
                       tickFormatter={v => `${v}%`} width={44} />
                <Tooltip contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))", fontSize: 12 }}
                         formatter={(v: number, _n, p: any) =>
                           [`${v}% · spread C$${fmt(p?.payload?.spread)}/MWh · ${Math.round(p?.payload?.mc ?? 0)} MW`, "Capture rate"]} />
                <Bar dataKey="rate" radius={[3, 3, 0, 0]}>
                  {captureChart.map((d, i) => (
                    <Cell key={i} fill={d.rate >= 100 ? "#10b981" : d.rate >= 70 ? "hsl(var(--primary))" : "#ef4444"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              Loading capture data…
            </div>
          )}
        </CardContent>
      </Card>

      {/* Entry points */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          { href: "/rankings", icon: ListOrdered, title: "Asset Rankings",
            blurb: "Screen the 230-asset CSD fleet on seven dimensions and reweight by objective." },
          { href: "/npv", icon: Calculator, title: "DCF Valuation",
            blurb: "Value an asset against the Alberta forward curve — CAPEX, OPEX, ITC, production." },
          { href: "/offtake", icon: FileSignature, title: "Offtake (PPA / VPPA)",
            blurb: "Price the contract: physical delivery terms or CfD settlement and basis exposure." },
        ].map(({ href, icon: Icon, title, blurb }) => (
          <Link key={href} href={href}>
            <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1.5">
                  <Icon className="h-4 w-4 text-primary" />
                  <span className="font-semibold text-sm">{title}</span>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground ml-auto" />
                </div>
                <p className="text-xs text-muted-foreground leading-snug">{blurb}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {/* Honest data-coverage strip — replaces silent "---" tiles */}
      {deadSources.length > 0 && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="pt-4 pb-4 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
            <div className="text-xs text-muted-foreground leading-relaxed">
              <span className="font-semibold text-foreground">Not every table is seeded.</span>{" "}
              These sources returned nothing, so nothing on this page depends on them:{" "}
              {deadSources.map(([k, v], idx) => (
                <span key={k}>
                  <code className="bg-muted px-1 py-0.5 rounded text-[10px]">{v.table}</code>
                  {idx < deadSources.length - 1 ? ", " : ""}
                </span>
              ))}
              . The previous dashboard read from these and rendered every tile as a dash without
              saying why. Panels above use only proven-live sources.
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        {Object.entries(dash?.sources ?? {}).map(([k, v]) => (
          <Badge key={k} variant="outline"
                 className={v.live ? "border-emerald-500/40 text-emerald-500" : "border-muted text-muted-foreground"}>
            {v.live ? "●" : "○"} {v.table}
          </Badge>
        ))}
      </div>
    </div>
  );
}
