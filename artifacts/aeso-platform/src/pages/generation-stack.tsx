import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell,
} from "recharts";
import { AlertTriangle } from "lucide-react";

/* Alberta's generation stack: what each technology actually earns and how hard
   it runs. Every figure is trailing-12-month, recomputed from hourly settlement
   volumes and pool price — never an average of monthly percentages. */

type Fuel = {
  fuel_type: string;
  assets: number;
  mc_mw: number;
  ttm_gen_mwh: number;
  capacity_factor: number | null;
  capture_price: number | null;
  capture_rate: number | null;
  capture_spread: number | null;
  ttm_pool_price: number | null;
  partial_assets: number;
  caveat: string | null;
};

type MonthRow = {
  month: string;
  fuel_type: string;
  capacity_factor: number | null;
  capture_price: number | null;
  capture_rate: number | null;
  capture_spread: number | null;
  avg_pool_price: number | null;
};

type Asset = {
  asset_id: string;
  asset_name: string | null;
  fuel_type: string;
  mc_mw: number;
  months_present: number;
  ttm_gen_mwh: number;
  capacity_factor: number | null;
  capture_price: number | null;
  capture_rate: number | null;
  capture_spread: number | null;
  capacity_caveat: string | null;
};

const FUEL_COLOUR: Record<string, string> = {
  WIND: "#38bdf8",
  SOLAR: "#fbbf24",
  COGENERATION: "#a78bfa",
  "COMBINED CYCLE": "#34d399",
  "GAS FIRED STEAM": "#f87171",
  "SIMPLE CYCLE": "#fb923c",
  HYDRO: "#22d3ee",
  "ENERGY STORAGE": "#e879f9",
  OTHER: "#94a3b8",
};

const colour = (f: string) => FUEL_COLOUR[f] ?? "#94a3b8";
const pct = (v: number | null | undefined, d = 1) =>
  v == null ? "—" : `${(v * 100).toFixed(d)}%`;
const money = (v: number | null | undefined, d = 2) =>
  v == null ? "—" : `$${v.toFixed(d)}`;
const signedMoney = (v: number | null | undefined) =>
  v == null ? "—" : `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

const chartTooltip = {
  contentStyle: { backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))" },
  itemStyle: { color: "hsl(var(--foreground))" },
  labelStyle: { color: "hsl(var(--muted-foreground))" },
};

export default function GenerationStack() {
  const [fuel, setFuel] = useState<string>("ALL");

  const { data: fuelData, isLoading: fuelsLoading } = useQuery({
    queryKey: ["gen-stack-fuels"],
    queryFn: () => get<{ poolPrice: number | null; fuels: Fuel[] }>(
      "/api/aeso/generation-stack/fuels"),
  });

  const { data: monthly } = useQuery({
    queryKey: ["gen-stack-monthly", fuel],
    queryFn: () => get<{ months: MonthRow[] }>(
      `/api/aeso/generation-stack/monthly?fuel=${encodeURIComponent(fuel)}`),
  });

  const { data: assetData } = useQuery({
    queryKey: ["gen-stack-assets", fuel],
    queryFn: () => get<{ assets: Asset[] }>(
      `/api/aeso/generation-stack/assets?fuel=${encodeURIComponent(fuel)}`),
  });

  const fuels = fuelData?.fuels ?? [];
  const pool = fuelData?.poolPrice ?? null;
  const months = monthly?.months ?? [];
  const assets = assetData?.assets ?? [];
  const selected = fuels.find((f) => f.fuel_type === fuel) ?? null;

  const monthLabel = (m: string) => (m ?? "").slice(0, 7);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Generation Stack</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Trailing 12 months · capacity factor, capture price and capture rate by technology
          </p>
        </div>
        {pool != null && (
          <Card className="shrink-0">
            <CardContent className="py-3 px-4">
              <div className="text-xs text-muted-foreground">TTM average pool price</div>
              <div className="text-2xl font-bold">{money(pool)}<span className="text-sm font-normal text-muted-foreground">/MWh</span></div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* fuel selector */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFuel("ALL")}
          className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
            fuel === "ALL"
              ? "bg-primary text-primary-foreground border-primary"
              : "border-border hover:bg-accent"}`}
        >
          All fuels
        </button>
        {fuels.map((f) => (
          <button
            key={f.fuel_type}
            onClick={() => setFuel(f.fuel_type)}
            className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
              fuel === f.fuel_type
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border hover:bg-accent"}`}
          >
            <span className="inline-block w-2 h-2 rounded-full mr-2"
                  style={{ background: colour(f.fuel_type) }} />
            {f.fuel_type}
          </button>
        ))}
      </div>

      {selected?.caveat && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="py-3 px-4 flex gap-3 items-start">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <div className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{selected.fuel_type}: </span>
              {selected.caveat}
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="capture-price">
        <TabsList>
          <TabsTrigger value="capture-price">Capture Prices</TabsTrigger>
          <TabsTrigger value="capture-rate">Capture Rates</TabsTrigger>
          <TabsTrigger value="capacity-factor">Capacity Factor</TabsTrigger>
        </TabsList>

        {/* ── CAPTURE PRICES ─────────────────────────────────────────────── */}
        <TabsContent value="capture-price" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                Capture price by technology — TTM
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Generation-weighted realised pool price. Dashed line is the hour-weighted
                average pool price; distance from it is the capture spread.
              </p>
            </CardHeader>
            <CardContent className="h-80">
              {fuelsLoading ? <Skeleton className="w-full h-full" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={fuels}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="fuel_type" stroke="hsl(var(--muted-foreground))"
                           fontSize={10} interval={0} angle={-20} textAnchor="end" height={70} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12}
                           tickFormatter={(v) => `$${v}`} />
                    <Tooltip {...chartTooltip}
                             formatter={(v: number) => [money(v), "Capture price"]} />
                    {pool != null && (
                      <ReferenceLine y={pool} stroke="hsl(var(--muted-foreground))"
                                     strokeDasharray="4 4"
                                     label={{ value: `Pool ${money(pool)}`, position: "right",
                                              fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                    )}
                    <Bar dataKey="capture_price" radius={[4, 4, 0, 0]}>
                      {fuels.map((f) => (
                        <Cell key={f.fuel_type} fill={colour(f.fuel_type)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                Monthly capture price {fuel !== "ALL" && `— ${fuel}`}
              </CardTitle>
            </CardHeader>
            <CardContent className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={months}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="month" tickFormatter={monthLabel}
                         stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12}
                         tickFormatter={(v) => `$${v}`} />
                  <Tooltip {...chartTooltip} labelFormatter={monthLabel}
                           formatter={(v: number, n: string) => [money(v),
                             n === "capture_price" ? "Capture price" : "Pool price"]} />
                  <Line type="monotone" dataKey="avg_pool_price" dot={false} strokeWidth={1.5}
                        stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" />
                  <Line type="monotone" dataKey="capture_price" dot={false} strokeWidth={2}
                        stroke={fuel === "ALL" ? "hsl(var(--primary))" : colour(fuel)} />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── CAPTURE RATES ──────────────────────────────────────────────── */}
        <TabsContent value="capture-rate" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Capture rate by technology — TTM</CardTitle>
              <p className="text-xs text-muted-foreground">
                Capture price as a share of average pool price. Below 100% is a value deficit —
                the technology earns less than the market average because it generates when
                everything else does.
              </p>
            </CardHeader>
            <CardContent className="h-80">
              {fuelsLoading ? <Skeleton className="w-full h-full" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={fuels}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="fuel_type" stroke="hsl(var(--muted-foreground))"
                           fontSize={10} interval={0} angle={-20} textAnchor="end" height={70} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12}
                           tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
                    <Tooltip {...chartTooltip}
                             formatter={(v: number) => [pct(v), "Capture rate"]} />
                    <ReferenceLine y={1} stroke="hsl(var(--muted-foreground))"
                                   strokeDasharray="4 4"
                                   label={{ value: "100%", position: "right",
                                            fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                    <Bar dataKey="capture_rate" radius={[4, 4, 0, 0]}>
                      {fuels.map((f) => (
                        <Cell key={f.fuel_type} fill={colour(f.fuel_type)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">
                  Capture spread {fuel !== "ALL" && `— ${fuel}`}
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  Capture price minus pool price, in $/MWh. Stays readable when the pool price
                  is near zero and the percentage rate becomes unstable.
                </p>
              </CardHeader>
              <CardContent className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={months}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="month" tickFormatter={monthLabel}
                           stroke="hsl(var(--muted-foreground))" fontSize={11} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12}
                           tickFormatter={(v) => `$${v}`} />
                    <Tooltip {...chartTooltip} labelFormatter={monthLabel}
                             formatter={(v: number) => [signedMoney(v), "Spread"]} />
                    <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" />
                    <Line type="monotone" dataKey="capture_spread" dot={false} strokeWidth={2}
                          stroke={fuel === "ALL" ? "hsl(var(--primary))" : colour(fuel)} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium">
                  Monthly capture rate {fuel !== "ALL" && `— ${fuel}`}
                </CardTitle>
              </CardHeader>
              <CardContent className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={months}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="month" tickFormatter={monthLabel}
                           stroke="hsl(var(--muted-foreground))" fontSize={11} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12}
                           tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
                    <Tooltip {...chartTooltip} labelFormatter={monthLabel}
                             formatter={(v: number) => [pct(v), "Capture rate"]} />
                    <ReferenceLine y={1} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="capture_rate" dot={false} strokeWidth={2}
                          stroke={fuel === "ALL" ? "hsl(var(--primary))" : colour(fuel)} />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── CAPACITY FACTOR ────────────────────────────────────────────── */}
        <TabsContent value="capacity-factor" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">Capacity factor by technology — TTM</CardTitle>
              <p className="text-xs text-muted-foreground">
                Generation divided by capacity-hours, accrued only between each asset's first
                and last metered hour — so assets commissioned mid-window are not penalised
                for months they did not exist.
              </p>
            </CardHeader>
            <CardContent className="h-80">
              {fuelsLoading ? <Skeleton className="w-full h-full" /> : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={fuels}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="fuel_type" stroke="hsl(var(--muted-foreground))"
                           fontSize={10} interval={0} angle={-20} textAnchor="end" height={70} />
                    <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12}
                           tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
                    <Tooltip {...chartTooltip}
                             formatter={(v: number) => [pct(v), "Capacity factor"]} />
                    <Bar dataKey="capacity_factor" radius={[4, 4, 0, 0]}>
                      {fuels.map((f) => (
                        <Cell key={f.fuel_type} fill={colour(f.fuel_type)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                Monthly capacity factor {fuel !== "ALL" && `— ${fuel}`}
              </CardTitle>
            </CardHeader>
            <CardContent className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={months}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="month" tickFormatter={monthLabel}
                         stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12}
                         tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
                  <Tooltip {...chartTooltip} labelFormatter={monthLabel}
                           formatter={(v: number) => [pct(v), "Capacity factor"]} />
                  <Line type="monotone" dataKey="capacity_factor" dot={false} strokeWidth={2}
                        stroke={fuel === "ALL" ? "hsl(var(--primary))" : colour(fuel)} />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── asset detail ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Assets {fuel !== "ALL" ? `— ${fuel}` : ""}{" "}
            <span className="text-muted-foreground font-normal">({assets.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto max-h-[520px]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border text-left">
                  <th className="pb-2 font-medium text-muted-foreground">Asset</th>
                  <th className="pb-2 font-medium text-muted-foreground">Fuel</th>
                  <th className="pb-2 font-medium text-muted-foreground text-right">MC (MW)</th>
                  <th className="pb-2 font-medium text-muted-foreground text-right">TTM MWh</th>
                  <th className="pb-2 font-medium text-muted-foreground text-right">CF</th>
                  <th className="pb-2 font-medium text-muted-foreground text-right">Capture</th>
                  <th className="pb-2 font-medium text-muted-foreground text-right">Rate</th>
                  <th className="pb-2 font-medium text-muted-foreground text-right">Spread</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <tr key={a.asset_id} className="border-b border-border/50 hover:bg-accent/40">
                    <td className="py-2">
                      <div className="font-medium">{a.asset_name ?? a.asset_id}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-2">
                        {a.asset_id}
                        {a.capacity_caveat && (
                          <Badge variant="outline" className="text-[10px] py-0 border-amber-500/50 text-amber-600">
                            {a.months_present}/12 mo
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="py-2">
                      <span className="inline-block w-2 h-2 rounded-full mr-2"
                            style={{ background: colour(a.fuel_type) }} />
                      <span className="text-xs">{a.fuel_type}</span>
                    </td>
                    <td className="py-2 text-right tabular-nums">{a.mc_mw?.toFixed(0)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {a.ttm_gen_mwh == null ? "—" : Math.round(a.ttm_gen_mwh).toLocaleString()}
                    </td>
                    <td className="py-2 text-right tabular-nums">{pct(a.capacity_factor)}</td>
                    <td className="py-2 text-right tabular-nums">{money(a.capture_price)}</td>
                    <td className="py-2 text-right tabular-nums">{pct(a.capture_rate)}</td>
                    <td className={`py-2 text-right tabular-nums ${
                      (a.capture_spread ?? 0) < 0 ? "text-red-500" : "text-emerald-500"}`}>
                      {signedMoney(a.capture_spread)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Source: AESO metered volumes (settlement-grade hourly), AESO pool price, and the ETS
        Current Supply Demand report for fuel type and maximum capability. Trailing-12-month
        figures are recomputed from summed components — never averaged from monthly percentages.
      </p>
    </div>
  );
}
