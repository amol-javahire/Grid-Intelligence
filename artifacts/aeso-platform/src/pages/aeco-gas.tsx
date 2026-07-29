import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
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

// Curve data lives in @/lib/alberta-forward-curve so this tab and the DCF
// Valuation tab cannot drift apart — the DCF discounts against exactly the
// numbers displayed here.
import { TC_FORWARD, MSA_CAL_STRIP } from "@/lib/alberta-forward-curve";

function money(n: number, d = 2) {
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

export default function ForwardPrices() {
  // Forward curve as a combo series: flat power on the left axis, AECO gas on
  // the right. Ordered as published (near-dated first) so the shape of the
  // strip reads left-to-right.
  const curveChart = TC_FORWARD.map((r) => ({
    period: r.period
      .replace("Balance of month", "BoM")
      .replace("Balance of ", "Bal ")
      .replace("Calendar ", "Cal-"),
    "Flat power": r.flat,
    "On-peak": r.onPeak,
    "Off-peak": r.offPeak,
    "Gas (C$/GJ)": r.gasGj,
    heatRate: r.heatRate,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Forward Prices</h1>
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

      {/* ── Forward curve chart — power and gas together ───────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Forward curve — power and gas</CardTitle>
          <p className="text-xs text-muted-foreground">
            Flat 7×24 power and on/off-peak on the left axis (C$/MWh); AECO gas on the right
            (C$/GJ). The widening gap from Cal-2028 is the curve pricing power scarcity, not fuel —
            gas is nearly flat across the strip while power roughly doubles.
          </p>
        </CardHeader>
        <CardContent className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={curveChart} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
              <defs>
                <linearGradient id="fwdGasFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="period" stroke="hsl(var(--muted-foreground))" fontSize={11} />
              <YAxis yAxisId="power" stroke="hsl(var(--muted-foreground))" fontSize={11}
                     tickFormatter={(v) => `$${v}`} width={54} />
              <YAxis yAxisId="gas" orientation="right" stroke="#f59e0b" fontSize={11}
                     tickFormatter={(v) => `$${v}`} width={48} domain={[0, "dataMax + 1"]} />
              <Tooltip
                contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))", fontSize: 12 }}
                formatter={(v: number, name: string) =>
                  name === "Gas (C$/GJ)" ? [`C$${v.toFixed(2)}/GJ`, name] : [`C$${v.toFixed(2)}/MWh`, name]} />
              <Legend iconSize={9} wrapperStyle={{ fontSize: 11 }} />
              <Area yAxisId="gas" type="monotone" dataKey="Gas (C$/GJ)" stroke="#f59e0b"
                    fill="url(#fwdGasFill)" strokeWidth={1.5} dot={{ r: 2 }} />
              <Line yAxisId="power" type="monotone" dataKey="On-peak" stroke="#8b5cf6"
                    strokeWidth={1.5} strokeDasharray="4 2" dot={{ r: 2 }} />
              <Line yAxisId="power" type="monotone" dataKey="Flat power" stroke="hsl(var(--primary))"
                    strokeWidth={2.5} dot={{ r: 3 }} />
              <Line yAxisId="power" type="monotone" dataKey="Off-peak" stroke="#64748b"
                    strokeWidth={1.5} strokeDasharray="4 2" dot={{ r: 2 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground leading-relaxed">
        <strong>Also relevant:</strong> AESO's own public price forecast looks roughly two hours
        ahead — it is not a forward curve. The AESO Long-Term Outlook forecasts load and
        generation adequacy, not a tradable power price. Neither substitutes for the tables above.
        For settled history rather than forwards, see the Historical Prices tab.
      </p>
    </div>
  );
}
