import { useState, useMemo } from "react";
import { useGetAesoPoolPriceStats } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from "recharts";
import { ExternalLink, AlertTriangle } from "lucide-react";
import {
  GAS_BY_MONTH, GAS_HISTORY, GAS_SOURCE_URL,
  GAS_HISTORY_FIRST_MONTH, impliedHeatRate,
} from "@/lib/alberta-gas-history";

/* ══════════════════════════════════════════════════════════════════════════
   Historical Prices — Alberta power and gas, monthly.

   Two independent series joined on calendar month:
     · POWER — AESO pool price, from our own aeso_hourly_pool_price table via
       /api/aeso/pool-price/stats (monthly avg/min/max/volatility/spike and
       negative-hour counts). Coverage is whatever we have seeded.
     · GAS — Government of Alberta monthly natural gas reference price,
       C$/GJ, back to 1994. See lib/alberta-gas-history.ts for the important
       caveat that this is a royalty NETBACK price, not an AECO-C spot settle.

   The two series have very different spans (gas goes back to 1994, our pool
   price seed does not), so the range slider is bounded by the OVERLAP and
   the table shows gas as "—" for any month where we hold power but not gas.
   Nothing is back-filled or interpolated to make the chart look continuous.
   ══════════════════════════════════════════════════════════════════════════ */

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Row {
  month: string;        // YYYY-MM
  label: string;        // "Jul 2026"
  year: number;
  monthNum: number;
  avgPower: number | null;
  minPower: number | null;
  maxPower: number | null;
  volatility: number | null;
  spikeCount: number | null;
  negCount: number | null;
  gasGj: number | null;
  heatRate: number | null;
}

const fmt = (n: number | null | undefined, d = 2) => (n != null ? n.toFixed(d) : "—");

export default function HistoricalPrices() {
  const { data: stats, isLoading } = useGetAesoPoolPriceStats();

  // Build the joined monthly series, newest first.
  const allRows: Row[] = useMemo(() => {
    const powerRows = (stats ?? []).map((s: any) => {
      const y = Number(s.year);
      const m = Number(s.month);
      const key = `${y}-${String(m).padStart(2, "0")}`;
      const avgPower = s.avgPrice != null ? Number(s.avgPrice) : null;
      const gasGj = GAS_BY_MONTH[key] ?? null;
      return {
        month: key,
        label: `${MONTH_LABELS[m - 1]} ${y}`,
        year: y,
        monthNum: m,
        avgPower,
        minPower: s.minPrice != null ? Number(s.minPrice) : null,
        maxPower: s.maxPrice != null ? Number(s.maxPrice) : null,
        volatility: s.volatility != null ? Number(s.volatility) : null,
        spikeCount: s.spikeCount != null ? Number(s.spikeCount) : null,
        negCount: s.negCount != null ? Number(s.negCount) : null,
        gasGj,
        heatRate: avgPower != null && gasGj != null ? impliedHeatRate(avgPower, gasGj) : null,
      } as Row;
    });
    return powerRows.sort((a, b) => b.month.localeCompare(a.month));
  }, [stats]);

  // Range slider — how many months back from the newest to show.
  const maxMonths = allRows.length;
  const [monthsBack, setMonthsBack] = useState<number>(0); // 0 = "all", set on first load
  const effectiveMonths = monthsBack === 0 ? maxMonths : Math.min(monthsBack, maxMonths);

  const visible = allRows.slice(0, effectiveMonths);
  // Chart wants oldest-first; the table wants newest-first.
  const chartData = visible.slice().reverse().map(r => ({
    label: r.label,
    "Pool price": r.avgPower != null ? +r.avgPower.toFixed(2) : null,
    "Gas (C$/GJ)": r.gasGj,
  }));

  const latest = allRows[0];
  const gasCoverage = allRows.filter(r => r.gasGj != null).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Historical Prices</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Alberta pool price and natural gas reference price — monthly averages, most recent first
        </p>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="text-xs text-muted-foreground">Latest month — pool price</div>
            <div className="text-2xl font-bold mt-1">
              {isLoading ? "—" : `C$${fmt(latest?.avgPower)}`}
              <span className="text-sm font-normal text-muted-foreground">/MWh</span>
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{latest?.label ?? "—"} average</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="text-xs text-muted-foreground">Latest month — gas</div>
            <div className="text-2xl font-bold mt-1">
              {`C$${fmt(latest?.gasGj)}`}
              <span className="text-sm font-normal text-muted-foreground">/GJ</span>
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">AB reference price</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="text-xs text-muted-foreground">Implied market heat rate</div>
            <div className="text-2xl font-bold mt-1">
              {fmt(latest?.heatRate, 1)}
              <span className="text-sm font-normal text-muted-foreground"> GJ/MWh</span>
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">pool ÷ gas, latest month</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            <div className="text-xs text-muted-foreground">Coverage</div>
            <div className="text-2xl font-bold mt-1">{maxMonths} mo</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              pool price · gas matched on {gasCoverage}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Combo chart with range slider */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <CardTitle className="text-base font-semibold">Power vs gas — monthly</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Pool price on the left axis (C$/MWh), gas reference price on the right (C$/GJ).
                Where they diverge is where the market stopped being gas-on-the-margin.
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-md">
            <div className="flex justify-between text-xs mb-1">
              <span className="text-muted-foreground">Window</span>
              <span className="font-mono text-primary">
                {effectiveMonths === maxMonths ? `all ${maxMonths} months` : `last ${effectiveMonths} months`}
              </span>
            </div>
            <Slider
              min={6}
              max={Math.max(maxMonths, 6)}
              step={1}
              value={[effectiveMonths]}
              onValueChange={([v]) => setMonthsBack(v >= maxMonths ? 0 : v)}
              disabled={maxMonths === 0}
            />
            <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
              <span>6 mo</span>
              <span>
                {visible.length > 0
                  ? `${visible[visible.length - 1].label} → ${visible[0].label}`
                  : "—"}
              </span>
              <span>all data</span>
            </div>
          </div>

          {isLoading ? (
            <Skeleton className="w-full h-80" />
          ) : chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={340}>
              <ComposedChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                <defs>
                  <linearGradient id="gasFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.28} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))"
                       interval="preserveStartEnd" minTickGap={24} />
                <YAxis yAxisId="power" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))"
                       tickFormatter={(v) => `$${v}`} width={54} />
                <YAxis yAxisId="gas" orientation="right" tick={{ fontSize: 10 }} stroke="#f59e0b"
                       tickFormatter={(v) => `$${v}`} width={48} />
                <Tooltip
                  contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))", fontSize: 12 }}
                  formatter={(v: number, name: string) =>
                    name === "Gas (C$/GJ)" ? [`C$${v}/GJ`, name] : [`C$${v}/MWh`, name]} />
                <Legend iconSize={9} wrapperStyle={{ fontSize: 11 }} />
                <Area yAxisId="gas" type="monotone" dataKey="Gas (C$/GJ)" stroke="#f59e0b"
                      fill="url(#gasFill)" strokeWidth={1.5} dot={false} connectNulls />
                <Line yAxisId="power" type="monotone" dataKey="Pool price" stroke="hsl(var(--primary))"
                      strokeWidth={2} dot={false} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              No pool price data seeded yet.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Monthly table — newest first */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">Monthly detail</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Most recent month at the top. Spike hours are ≥ C$300/MWh; negative hours are &lt; C$0.
          </p>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="w-full h-64" />
          ) : (
            <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="text-left py-2 pr-3 font-medium">Month</th>
                    <th className="text-right py-2 px-2 font-medium">Avg $/MWh</th>
                    <th className="text-right py-2 px-2 font-medium">Min</th>
                    <th className="text-right py-2 px-2 font-medium">Max</th>
                    <th className="text-right py-2 px-2 font-medium">σ</th>
                    <th className="text-right py-2 px-2 font-medium">Spike hrs</th>
                    <th className="text-right py-2 px-2 font-medium">Neg hrs</th>
                    <th className="text-right py-2 px-2 font-medium">Gas $/GJ</th>
                    <th className="text-right py-2 pl-2 font-medium">Implied HR</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.month} className="border-b border-border/40 hover:bg-muted/30">
                      <td className="py-1.5 pr-3 font-medium">{r.label}</td>
                      <td className="text-right py-1.5 px-2 tabular-nums font-semibold">{fmt(r.avgPower)}</td>
                      <td className={`text-right py-1.5 px-2 tabular-nums ${(r.minPower ?? 0) < 0 ? "text-red-400" : "text-muted-foreground"}`}>
                        {fmt(r.minPower)}
                      </td>
                      <td className="text-right py-1.5 px-2 tabular-nums text-muted-foreground">{fmt(r.maxPower, 0)}</td>
                      <td className="text-right py-1.5 px-2 tabular-nums text-muted-foreground">{fmt(r.volatility, 0)}</td>
                      <td className={`text-right py-1.5 px-2 tabular-nums ${(r.spikeCount ?? 0) > 0 ? "text-amber-500" : "text-muted-foreground"}`}>
                        {r.spikeCount ?? "—"}
                      </td>
                      <td className={`text-right py-1.5 px-2 tabular-nums ${(r.negCount ?? 0) > 0 ? "text-red-400" : "text-muted-foreground"}`}>
                        {r.negCount ?? "—"}
                      </td>
                      <td className="text-right py-1.5 px-2 tabular-nums text-amber-500">{fmt(r.gasGj)}</td>
                      <td className="text-right py-1.5 pl-2 tabular-nums text-muted-foreground">{fmt(r.heatRate, 1)}</td>
                    </tr>
                  ))}
                  {visible.length === 0 && (
                    <tr><td colSpan={9} className="py-6 text-center text-muted-foreground">No data</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Gas series caveat — matters, so it isn't buried in a footnote */}
      <Card className="border-amber-500/40 bg-amber-500/5">
        <CardContent className="pt-4 pb-4 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="text-xs text-muted-foreground leading-relaxed">
            <span className="font-semibold text-foreground">The gas series is a royalty netback price, not an AECO-C spot settle.</span>{" "}
            It is the Government of Alberta's monthly natural gas reference price — the number the
            province uses to value Crown royalty volumes, computed with a simplified netback model
            from NGX Alberta Market Hub purchases. Netback treatment puts it <em>below</em> a raw hub
            price by roughly the transportation and processing allowances of the period. It is used
            here because it is official, free, redistributable and unbroken since 1994
            (from {GAS_HISTORY_FIRST_MONTH}; {GAS_HISTORY.length} months on file), whereas ICE NGX —
            the actual traded AECO benchmark — is proprietary and terminal access does not convey
            display rights. Correct for trend, seasonality and magnitude; don't quote it as "the AECO
            price" on a given day.
            {" "}
            <a className="underline inline-flex items-center gap-0.5" href={GAS_SOURCE_URL} target="_blank" rel="noreferrer">
              Source <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
