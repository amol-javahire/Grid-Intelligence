import { useGetAesoPoolPrice } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { AlertTriangle, ExternalLink } from "lucide-react";

/* ══════════════════════════════════════════════════════════════════════════
   AECO Gas / Alberta Power Forward Curve

   Every number on this page is either (a) AESO settlement data already in
   the platform's own database, or (b) verified directly against the primary
   PDF it cites — not a secondhand table. Two sources, fetched and grepped
   against on 2026-07-28:

     TC Energy "Power Market Update" (indicative, as of 2026-07-14)
     https://www.tcenergy.com/siteassets/pdfs/power/alberta-power-marketing/
       power-market-updates/2026/tce-market-update-july-2026.pdf
     — every figure below matches the PDF table exactly, including the
       On-Peak/Off-Peak columns and implied heat rate, which were pulled
       straight from the source rather than assumed.

     Alberta Market Surveillance Administrator, Wholesale Market Report Q1 2026
     https://www.albertamsa.ca/assets/Documents/Wholesale-Market-Report-Q1-2026.pdf
     — Cal-27/28/29 and the Q1 average pool price below are the MSA's own
       stated figures, grepped from the downloaded PDF text, not a search
       snippet paraphrase.

   WHY TWO SOURCES INSTEAD OF ONE "AECO PRICE": neither is a live tradable
   curve. TC Energy is a marketer's indicative table, refreshed monthly, with
   an explicit forward-looking-information disclaimer. MSA is a regulator's
   quarterly retrospective — authoritative but stale by design. The real
   tradable curve (ICE NGX XW7 gas forward, XCU AESO flat power forward) is
   proprietary; see the licensing note below. Until that's licensed, showing
   both a current indicative source and a regulator-grade validation point is
   more honest than picking one and implying it's an exchange settlement.
   ══════════════════════════════════════════════════════════════════════════ */

interface ForwardRow {
  period: string;
  flat: number;
  onPeak: number;
  offPeak: number;
  gasGj: number;
  heatRate: number;
}

// TC Energy Power Market Update — indicative as of July 14, 2026.
const TC_FORWARD: ForwardRow[] = [
  { period: "Balance of month", flat: 43.12, onPeak: 53.20, offPeak: 22.96, gasGj: 1.67, heatRate: 25.82 },
  { period: "August 2026",      flat: 44.00, onPeak: 56.65, offPeak: 27.96, gasGj: 1.53, heatRate: 28.84 },
  { period: "Balance of 2026",  flat: 42.75, onPeak: 52.65, offPeak: 30.33, gasGj: 1.94, heatRate: 22.00 },
  { period: "Calendar 2027",    flat: 46.61, onPeak: 56.40, offPeak: 34.10, gasGj: 2.24, heatRate: 20.80 },
  { period: "Calendar 2028",    flat: 65.38, onPeak: 83.60, offPeak: 42.27, gasGj: 2.44, heatRate: 26.82 },
  { period: "Calendar 2029",    flat: 80.88, onPeak: 105.87,offPeak: 48.98, gasGj: 2.47, heatRate: 32.73 },
];

// MSA Wholesale Market Report Q1 2026 — quarter-end calendar strip, stated
// as % change over the quarter (source's own framing, not derived here).
const MSA_CAL_STRIP = [
  { label: "Cal-27", price: 47.88, qoq: -18 },
  { label: "Cal-28", price: 59.07, qoq: -20 },
  { label: "Cal-29", price: 63.62, qoq: -18 },
];

const ICE_TARGET_STATE = [
  { symbol: "AB-NIT 2A",  name: "Same Day Index",              use: "Historical daily AECO cash/settled price (CAD/GJ) — the MSA's own reference series" },
  { symbol: "AB-NIT 5A",  name: "Day Ahead & Same Day",         use: "Alternative Alberta cash gas benchmarks" },
  { symbol: "XW7",        name: "AB-NIT 5A Monthly Financial Fixed Price", use: "Forward gas curve, monthly contracts to 60 months — cash-settled vs AB-NIT 5A average" },
  { symbol: "XW6",        name: "AB-NIT 7A Financial Fixed Price", use: "Alternative gas forward, month-ahead-index-settled, to 60 months" },
  { symbol: "XCU",        name: "AESO Financial Flat Fixed Price", use: "Alberta 7×24 flat power forward, CAD/MWh, monthly to 96 months — settles against AESO hourly pool price" },
];

function money(n: number, d = 2) {
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

export default function AecoGas() {
  const { data: prices, isLoading } = useGetAesoPoolPrice({ limit: 720 });

  const chartData = (prices ?? [])
    .slice()
    .reverse()
    .map((p) => ({ date: p.date, "Pool price": p.poolPrice }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">AECO Gas &amp; Alberta Power Forward</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Alberta power settles at a single province-wide pool price, and roughly 60% of the
          fleet's maximum capability is gas-fired (cogeneration, combined cycle, simple cycle,
          gas fired steam — 14,188 of 23,393 MW in the CSD registry). AECO gas is therefore the
          dominant marginal-cost driver of Alberta power price, more directly than in ERCOT or
          CAISO where the fuel mix is more diverse.
        </p>
      </div>

      {/* ── Licensing note — the most important thing on this page ─────────── */}
      <Card className="border-amber-500/40 bg-amber-500/5">
        <CardContent className="pt-4 pb-4 flex gap-3">
          <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
          <div className="text-xs text-muted-foreground leading-relaxed">
            <span className="font-medium text-foreground">
              The real tradable curves are proprietary, and neither table below is one.
            </span>{" "}
            ICE NGX's AB-NIT gas indices (2A, 5A) and financial forwards (XW7, XW6) and the AESO
            flat power forward (XCU) are transaction-based, volume-weighted settlement prices —
            genuine market data, not a forecast. But ICE data is licensed: terminal access does
            not include redistribution or display rights in a customer-facing product. Before
            showing ICE settlement values here, that needs to be confirmed separately from
            terminal access — it is not the same permission. Until licensed, this page shows an
            indicative marketer table and a regulator's quarterly retrospective instead, both
            clearly labelled as such.
          </div>
        </CardContent>
      </Card>

      {/* ── TC Energy indicative forward curve ──────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">
            Indicative forward prices — as of July 14, 2026
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            TC Energy Power Marketing · indicative only, not an exchange settlement · verified
            against the source PDF, not a secondhand table
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="pb-2 font-medium">Delivery</th>
                  <th className="pb-2 font-medium text-right">Flat 7×24 $/MWh</th>
                  <th className="pb-2 font-medium text-right">On-Peak 7×16 $/MWh</th>
                  <th className="pb-2 font-medium text-right">Off-Peak 7×8 $/MWh</th>
                  <th className="pb-2 font-medium text-right">AECO Gas $/GJ</th>
                  <th className="pb-2 font-medium text-right">Implied heat rate GJ/MWh</th>
                </tr>
              </thead>
              <tbody>
                {TC_FORWARD.map((r) => (
                  <tr key={r.period} className="border-b border-border/50">
                    <td className="py-2 font-medium">{r.period}</td>
                    <td className="py-2 text-right tabular-nums">${money(r.flat)}</td>
                    <td className="py-2 text-right tabular-nums text-muted-foreground">${money(r.onPeak)}</td>
                    <td className="py-2 text-right tabular-nums text-muted-foreground">${money(r.offPeak)}</td>
                    <td className="py-2 text-right tabular-nums">${money(r.gasGj)}</td>
                    <td className="py-2 text-right tabular-nums text-muted-foreground">{money(r.heatRate, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground mt-3 flex items-center gap-1">
            Source:{" "}
            <a href="https://www.tcenergy.com/siteassets/pdfs/power/alberta-power-marketing/power-market-updates/2026/tce-market-update-july-2026.pdf"
               target="_blank" rel="noreferrer" className="underline hover:text-foreground inline-flex items-center gap-0.5">
              TC Energy Power Market Update, July 2026 <ExternalLink className="h-2.5 w-2.5" />
            </a>
            . Forward-looking information — TC Energy's own disclaimer applies; not a firm quote.
          </p>
        </CardContent>
      </Card>

      {/* ── MSA regulator validation ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Calendar strip — MSA Q1 2026</CardTitle>
            <p className="text-xs text-muted-foreground">
              Regulator-grade validation source. Combines ICE NGX, Canax, Velocity Capital and
              certain bilateral transactions — too infrequent for a live curve, but authoritative
              for sanity-checking the indicative table above.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {MSA_CAL_STRIP.map((c) => (
              <div key={c.label} className="flex items-center justify-between">
                <span className="text-sm font-medium">{c.label}</span>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm">${money(c.price)}/MWh</span>
                  <span className="text-xs text-red-500">{c.qoq}% q/q</span>
                </div>
              </div>
            ))}
            <div className="pt-2 mt-2 border-t border-border flex items-center justify-between">
              <span className="text-sm font-medium">Q1 2026 avg pool price</span>
              <span className="font-mono text-sm">$32.15/MWh</span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              19% below Q1 2025, 25% below Q4 2025 — mild January weather and increased supply.
            </p>
            <p className="text-[11px] text-muted-foreground pt-2">
              Source:{" "}
              <a href="https://www.albertamsa.ca/assets/Documents/Wholesale-Market-Report-Q1-2026.pdf"
                 target="_blank" rel="noreferrer" className="underline hover:text-foreground inline-flex items-center gap-0.5">
                MSA Wholesale Market Report, Q1 2026 <ExternalLink className="h-2.5 w-2.5" />
              </a>
            </p>
          </CardContent>
        </Card>

        {/* ── Latest development, same source PDF ── */}
        <Card className="border-primary/30">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Latest demand-side development</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              On July 8, 2026, Meta announced its first Canadian data centre, in Sturgeon County,
              Alberta — a CAD $13B+ investment. The facility is a 1.0 GW data centre, scalable to
              ~1.8 GW once the dedicated Greenlight Electricity Centre (932 MW gas combined-cycle
              plant) is fully operational. First phase connects 970 MW to the Alberta grid —
              roughly a 10% increase to Alberta's average annual AIL.
            </p>
            <p className="text-[11px] text-muted-foreground pt-2">
              Source: same TC Energy Power Market Update cited above.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Historical AESO pool price — real, already seeded ──────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Historical AESO pool price — last 30 days</CardTitle>
          <p className="text-xs text-muted-foreground">
            Settlement-grade, from the platform's own AESO seeder — not indicative. This is the
            price the forward curves above are ultimately trying to predict.
          </p>
        </CardHeader>
        <CardContent className="h-72">
          {isLoading ? (
            <Skeleton className="w-full h-full" />
          ) : chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={11}
                       tickFormatter={(v) => String(v).slice(0, 10)} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11}
                       tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))" }}
                  itemStyle={{ color: "hsl(var(--foreground))" }}
                  labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                  formatter={(v: number) => [`$${v.toFixed(2)}/MWh`, "Pool price"]}
                />
                <Line type="monotone" dataKey="Pool price" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">No data available</div>
          )}
        </CardContent>
      </Card>

      {/* ── Target-state ICE NGX reference ──────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Target state — ICE NGX (not yet integrated)</CardTitle>
          <p className="text-xs text-muted-foreground">
            The real tradable curves, for reference. Requires WebICE/ICE Connect access
            (US$675/user/month, per ICE's published data service pricing) and confirmed
            redistribution rights before any of this can be displayed live.
          </p>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {ICE_TARGET_STATE.map((row) => (
              <div key={row.symbol} className="flex items-start gap-3 text-sm py-1.5 border-b border-border/40 last:border-0">
                <span className="font-mono font-semibold w-20 shrink-0">{row.symbol}</span>
                <div className="min-w-0">
                  <span className="font-medium">{row.name}</span>
                  <span className="text-muted-foreground"> — {row.use}</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground leading-relaxed">
        <strong>Also relevant:</strong> AESO's own public price forecast looks roughly two hours
        ahead — it is not a forward curve. The AESO Long-Term Outlook forecasts load and
        generation adequacy, not a tradable power price. Neither substitutes for the tables above.
      </p>
    </div>
  );
}
