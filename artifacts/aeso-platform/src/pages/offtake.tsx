import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, LineChart, Line, Legend, Cell,
} from "recharts";
import { FileSignature, Landmark, AlertTriangle, Info } from "lucide-react";
import {
  buildCurvePath, TC_FORWARD_URL, CURVE_LAST_YEAR,
} from "@/lib/alberta-forward-curve";

/* ══════════════════════════════════════════════════════════════════════════
   Offtake Agreements — physical PPA vs virtual PPA (VPPA).

   Separated from DCF Valuation because they answer different questions and
   take different inputs. DCF asks "is this asset worth building/buying?"
   (CAPEX, OPEX, ITC, production, WACC). This tab asks "is this CONTRACT
   worth signing, and what risk am I taking?" — and the two structures are
   not variations of one form.

   PHYSICAL PPA — buyer takes title to energy.
     · Delivery point and settlement mechanics matter.
     · Buyer needs a retailer / load-settlement arrangement in Alberta.
     · Volume can be as-generated (buyer wears shape) or firmed (seller
       wears it and prices it in).
     · Curtailment allocation is a negotiated term with real dollar value.
     · Environmental attributes may or may not convey with the energy.

   VIRTUAL PPA / CfD — purely financial, no title, no delivery.
     · Notional volume settled as (pool - strike) x volume.
     · No delivery point, so no physical basis... TODAY.
     · Derivative accounting applies (IFRS 9 / ASC 815). Unless hedge
       accounting is elected and qualifies, fair-value swings hit P&L every
       reporting period. That earnings volatility is frequently the reason a
       corporate treasury rejects an otherwise-attractive VPPA, so it is
       surfaced here rather than buried.

   THE ALBERTA-SPECIFIC POINT WORTH KNOWING
   --------------------------------------------------------------------------
   Alberta settles at ONE province-wide pool price today. So a VPPA struck
   against the pool price has NO locational basis risk right now — the
   generator's settlement price and the reference price are the same number.
   That is a genuine structural advantage over an ERCOT VPPA, where nodal-to-
   hub basis is a live, material risk from day one.

   It ends at REM go-live (targeted mid-2027). Under nodal LMP the generator
   settles at its own node while the contract references something else, and
   Alberta VPPAs inherit exactly the basis risk ERCOT VPPAs have today. A
   contract signed now with a term crossing 2027 should price that.
   ══════════════════════════════════════════════════════════════════════════ */

type Structure = "ppa" | "vppa";

interface StackAsset {
  asset_id: string;
  asset_name: string | null;
  fuel_type: string;
  mc_mw: number;
  capture_rate: number | null;
  capacity_factor: number | null;
  months_present: number;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

const money = (n: number) =>
  Math.abs(n) >= 1e6 ? `C$${(n / 1e6).toFixed(1)}M`
  : Math.abs(n) >= 1e3 ? `C$${(n / 1e3).toFixed(0)}k`
  : `C$${n.toFixed(0)}`;

const REM_GO_LIVE_YEAR = 2027;

/* ── Shared contract inputs ───────────────────────────────────────────── */
interface Contract {
  structure: Structure;
  mw: number;
  capacityFactor: number;
  captureRate: number;
  strike: number;
  escalationPct: number;
  termYears: number;
  startYear: number;
  discountRate: number;
  // Physical PPA only
  volumeShape: "as_generated" | "firmed";
  firmingPremium: number;      // C$/MWh seller charges to firm volume
  curtailmentBorneByBuyer: number; // % of curtailment risk buyer absorbs
  curtailmentPct: number;
  includesAttributes: boolean;
  attributeValue: number;      // C$/MWh for offsets/RECs if bundled
  // VPPA only
  notionalPct: number;         // % of generation covered by the CfD
  hedgeAccounting: boolean;
  settlementFloor: boolean;    // does the CfD floor at zero (no negative payment)?
}

interface YearResult {
  year: number;
  calendarYear: number;
  poolPrice: number;
  observed: boolean;
  mwh: number;
  strike: number;
  /** Buyer's net cashflow this year, +ve = buyer gains. */
  buyerNet: number;
  /** Effective all-in cost per MWh to the buyer. */
  effectiveCost: number;
  postRem: boolean;
}

function runOfftake(c: Contract) {
  const curve = buildCurvePath(c.startYear, c.termYears, 0);
  const rows: YearResult[] = [];

  for (let y = 1; y <= c.termYears; y++) {
    const cv = curve[y - 1];
    const pool = cv.power;
    const strike = c.strike * Math.pow(1 + c.escalationPct / 100, y - 1);

    // Gross generation before curtailment
    const grossMwh = c.mw * 8760 * c.capacityFactor;
    const curtailed = grossMwh * (c.curtailmentPct / 100);

    let mwh: number;
    let buyerNet: number;

    if (c.structure === "ppa") {
      // Physical: buyer receives energy. As-generated means the buyer eats
      // curtailment in proportion to the share they agreed to bear; firmed
      // means the seller delivers regardless but charges a premium.
      const buyerCurtailmentLoss = curtailed * (c.curtailmentBorneByBuyer / 100);
      mwh = c.volumeShape === "firmed" ? grossMwh : grossMwh - buyerCurtailmentLoss;

      // Buyer pays strike (+firming premium if applicable), receives energy
      // worth pool x capture rate, plus attributes if they convey.
      const paid = mwh * (strike + (c.volumeShape === "firmed" ? c.firmingPremium : 0));
      const energyValue = mwh * pool * c.captureRate;
      const attributes = c.includesAttributes ? mwh * c.attributeValue : 0;
      buyerNet = energyValue + attributes - paid;
    } else {
      // Virtual: no energy changes hands. Notional volume settles the
      // difference between the floating pool price and the strike.
      mwh = grossMwh * (c.notionalPct / 100);
      const diff = pool - strike;
      // A floored CfD means the buyer never pays out when pool < strike
      // (seller wears it) — reduces buyer downside, seller prices it in.
      const settled = c.settlementFloor ? Math.max(0, diff) : diff;
      buyerNet = mwh * settled;
    }

    const effectiveCost = mwh > 0 ? (mwh * pool * c.captureRate - buyerNet) / mwh : 0;

    rows.push({
      year: y, calendarYear: cv.calendarYear, poolPrice: pool, observed: cv.observed,
      mwh, strike, buyerNet, effectiveCost,
      postRem: cv.calendarYear >= REM_GO_LIVE_YEAR,
    });
  }

  const r = c.discountRate / 100;
  const npv = rows.reduce((a, row) => a + row.buyerNet / Math.pow(1 + r, row.year), 0);
  const totalMwh = rows.reduce((a, row) => a + row.mwh, 0);
  const totalNet = rows.reduce((a, row) => a + row.buyerNet, 0);
  const avgEffectiveCost = totalMwh > 0
    ? rows.reduce((a, row) => a + row.effectiveCost * row.mwh, 0) / totalMwh
    : 0;
  const postRemYears = rows.filter(r2 => r2.postRem).length;
  const observedYears = rows.filter(r2 => r2.observed).length;

  return { rows, npv, totalMwh, totalNet, avgEffectiveCost, postRemYears, observedYears };
}

/* ── UI helpers ───────────────────────────────────────────────────────── */

function NumField({ label, value, onChange, step = 1, suffix, hint }: {
  label: string; value: number; onChange: (v: number) => void;
  step?: number; suffix?: string; hint?: string;
}) {
  return (
    <div>
      <label className="text-xs text-muted-foreground block mb-1">{label}</label>
      <div className="flex items-center gap-1.5">
        <input type="number" value={value} step={step}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-sm" />
        {suffix && <span className="text-xs text-muted-foreground shrink-0">{suffix}</span>}
      </div>
      {hint && <p className="text-[10px] text-muted-foreground mt-1 leading-tight">{hint}</p>}
    </div>
  );
}

function Toggle({ label, checked, onChange, hint }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string;
}) {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="accent-primary h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span className="text-xs">
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-[10px] text-muted-foreground mt-0.5 leading-snug">{hint}</span>}
      </span>
    </label>
  );
}

function Kpi({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: "good" | "bad";
}) {
  const color = tone === "good" ? "text-emerald-500" : tone === "bad" ? "text-red-500" : "";
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`text-2xl font-bold mt-1 ${color}`}>{value}</div>
        {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/* ══════════════════════════════════════════════════════════════════════════ */

export default function Offtake() {
  const [c, setC] = useState<Contract>({
    structure: "vppa",
    mw: 100, capacityFactor: 0.36, captureRate: 0.82,
    strike: 50, escalationPct: 2, termYears: 15, startYear: 2027,
    discountRate: 7,
    volumeShape: "as_generated", firmingPremium: 4,
    curtailmentBorneByBuyer: 0, curtailmentPct: 3,
    includesAttributes: true, attributeValue: 2,
    notionalPct: 100, hedgeAccounting: false, settlementFloor: false,
  });

  const set = <K extends keyof Contract>(k: K, v: Contract[K]) => setC(p => ({ ...p, [k]: v }));

  // Real-project picker, same data as DCF / Generation Stack
  const [pickerFuel, setPickerFuel] = useState("");
  const [pickerAssetId, setPickerAssetId] = useState("");

  const { data: fuels } = useQuery({
    queryKey: ["offtake-fuels"],
    queryFn: () => getJson<{ fuels: { fuel_type: string; assets: number }[] }>("/api/aeso/generation-stack/fuels"),
  });
  const { data: assets } = useQuery({
    queryKey: ["offtake-assets", pickerFuel],
    queryFn: () => getJson<{ assets: StackAsset[] }>(`/api/aeso/generation-stack/assets?fuel=${encodeURIComponent(pickerFuel)}`),
    enabled: !!pickerFuel,
  });
  const picked = (assets?.assets ?? []).find(a => a.asset_id === pickerAssetId) ?? null;

  useEffect(() => {
    if (!picked) return;
    set("mw", Math.round(picked.mc_mw));
    if (picked.capture_rate != null) set("captureRate", Math.max(0.2, Math.min(2.0, picked.capture_rate)));
    if (picked.capacity_factor != null) set("capacityFactor", Math.max(0.01, Math.min(1, picked.capacity_factor)));
  }, [picked?.asset_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const res = useMemo(() => runOfftake(c), [c]);

  const isPpa = c.structure === "ppa";

  const chartData = res.rows.map(r => ({
    year: `Y${r.year}`,
    calendarYear: r.calendarYear,
    net: Math.round(r.buyerNet / 1e6 * 100) / 100,
    pool: +r.poolPrice.toFixed(2),
    strike: +r.strike.toFixed(2),
    postRem: r.postRem,
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Offtake Agreements</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Contract-side economics — physical PPA and virtual PPA are different instruments,
            not two views of one form.
          </p>
        </div>
        <div className="flex gap-1 bg-muted p-1 rounded-lg">
          {([["ppa", "Physical PPA", Landmark], ["vppa", "Virtual PPA (CfD)", FileSignature]] as const).map(([k, label, Icon]) => (
            <button key={k} onClick={() => set("structure", k)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-1.5 ${
                c.structure === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Structure explainer — changes with the selected instrument */}
      <Card className={isPpa ? "border-teal-500/40" : "border-purple-500/40"}>
        <CardContent className="pt-4 pb-4">
          <div className="text-sm font-semibold mb-1">
            {isPpa ? "Physical PPA — buyer takes title to energy" : "Virtual PPA — financial contract for differences, no title"}
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {isPpa ? (
              <>
                The buyer receives energy at a delivery point and needs a retailer or load-settlement
                arrangement in Alberta. Volume shape, curtailment allocation and whether environmental
                attributes convey are all negotiated terms with real dollar value — they are the
                inputs below. Physical delivery also means the buyer's own load shape matters: energy
                delivered in hours you don't consume is energy you resell at pool.
              </>
            ) : (
              <>
                No energy changes hands. A notional volume settles the difference between the floating
                Alberta pool price and the strike. The generator sells its output into the pool
                independently. Because nothing is delivered, there is no delivery point, no retailer
                arrangement and no shape obligation — but there IS derivative accounting, and unless
                hedge accounting is elected and qualifies, fair-value swings hit reported earnings
                every period.
              </>
            )}
          </p>
        </CardContent>
      </Card>

      {/* The Alberta basis-risk point — the thing worth knowing */}
      <Card className="border-amber-500/40 bg-amber-500/5">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-start gap-2">
            <Info className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-semibold mb-1">
                Alberta has no locational basis risk today — and that expires at REM
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Alberta settles at one province-wide pool price, so a contract struck against the pool
                has <strong>zero locational basis risk right now</strong>. The generator's settlement
                price and the contract's reference price are the same number. An ERCOT
                {" "}{isPpa ? "PPA" : "VPPA"} carries nodal-to-hub basis from day one; an Alberta one
                does not.
                {" "}
                <strong className="text-amber-500">
                  That ends at REM go-live (targeted mid-2027).
                </strong>{" "}
                Under nodal LMP the generator settles at its own node while the contract references
                something else, and Alberta inherits exactly the basis risk ERCOT has today.
                {res.postRemYears > 0 && (
                  <> This contract has <strong>{res.postRemYears} of {c.termYears} years past 2027</strong> —
                  that exposure should be priced, and the platform cannot price it yet because no
                  Alberta LMP scenarios exist.</>
                )}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi label={isPpa ? "Buyer NPV (energy value − cost)" : "Buyer NPV (CfD settlement)"}
             value={money(res.npv)} tone={res.npv >= 0 ? "good" : "bad"}
             sub={`${c.termYears}-yr term @ ${c.discountRate}% discount`} />
        <Kpi label="Contracted volume"
             value={`${(res.totalMwh / 1000).toFixed(0)} GWh`}
             sub={isPpa ? "energy delivered over term" : `notional, ${c.notionalPct}% of output`} />
        <Kpi label={isPpa ? "Effective cost of energy" : "Effective hedged price"}
             value={`C$${res.avgEffectiveCost.toFixed(2)}/MWh`}
             sub="volume-weighted over term" />
        <Kpi label="Curve coverage"
             value={`${res.observedYears}/${c.termYears} yrs`}
             sub={`observed through Cal-${CURVE_LAST_YEAR}, held flat after`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* ── Inputs ── */}
        <div className="lg:col-span-1 space-y-4">
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Counterparty asset</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Fuel type</label>
                <select value={pickerFuel} onChange={e => { setPickerFuel(e.target.value); setPickerAssetId(""); }}
                  className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-sm">
                  <option value="">— Generic / hypothetical —</option>
                  {(fuels?.fuels ?? []).map(f => (
                    <option key={f.fuel_type} value={f.fuel_type}>{f.fuel_type} ({f.assets})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Project</label>
                <select value={pickerAssetId} onChange={e => setPickerAssetId(e.target.value)} disabled={!pickerFuel}
                  className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-sm disabled:opacity-40">
                  <option value="">— Select —</option>
                  {(assets?.assets ?? []).slice().sort((a, b) => b.mc_mw - a.mc_mw).map(a => (
                    <option key={a.asset_id} value={a.asset_id}>
                      {a.asset_name ?? a.asset_id} · {Math.round(a.mc_mw)} MW
                    </option>
                  ))}
                </select>
              </div>
              <NumField label="Capacity" value={c.mw} onChange={v => set("mw", v)} suffix="MW" />
              <NumField label="Capacity factor" value={+(c.capacityFactor * 100).toFixed(1)}
                onChange={v => set("capacityFactor", v / 100)} suffix="%" step={0.5}
                hint={picked ? "Prefilled from measured TTM metered output." : undefined} />
              <NumField label="Capture rate" value={+(c.captureRate * 100).toFixed(0)}
                onChange={v => set("captureRate", v / 100)} suffix="%"
                hint="Generation-weighted pool price ÷ system average. Drives the value of energy actually delivered." />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Commercial terms</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-muted-foreground">Strike price</span>
                  <span className="font-semibold text-primary">C${c.strike}/MWh</span>
                </div>
                <Slider value={[c.strike]} min={20} max={110} step={0.5}
                  onValueChange={v => set("strike", v[0])} />
              </div>
              <NumField label="Strike escalation" value={c.escalationPct}
                onChange={v => set("escalationPct", v)} suffix="%/yr" step={0.25} />
              <NumField label="Term" value={c.termYears} onChange={v => set("termYears", v)} suffix="yrs" />
              <NumField label="Start year" value={c.startYear} onChange={v => set("startYear", v)}
                hint={`Maps year 1 onto the forward curve. REM nodal pricing arrives ~${REM_GO_LIVE_YEAR}.`} />
              <NumField label="Discount rate" value={c.discountRate}
                onChange={v => set("discountRate", v)} suffix="%" step={0.5}
                hint="Buyer's cost of capital for contract valuation — NOT the project WACC used in DCF Valuation." />
            </CardContent>
          </Card>

          {/* Structure-specific inputs — this is the real split */}
          {isPpa ? (
            <Card className="border-teal-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Physical delivery terms</CardTitle>
                <p className="text-xs text-muted-foreground">Only apply when title transfers.</p>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Volume shape</label>
                  <select value={c.volumeShape}
                    onChange={e => set("volumeShape", e.target.value as Contract["volumeShape"])}
                    className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-sm">
                    <option value="as_generated">As-generated (buyer wears shape)</option>
                    <option value="firmed">Firmed (seller delivers, charges premium)</option>
                  </select>
                </div>
                {c.volumeShape === "firmed" && (
                  <NumField label="Firming premium" value={c.firmingPremium}
                    onChange={v => set("firmingPremium", v)} suffix="C$/MWh" step={0.5}
                    hint="What the seller charges to guarantee volume regardless of resource availability." />
                )}
                <NumField label="Expected curtailment" value={c.curtailmentPct}
                  onChange={v => set("curtailmentPct", v)} suffix="%"
                  hint="MSA measured 561 GWh of constrained intermittent generation in Q1 2026, up ~250% YoY. Do not assume zero." />
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground">Curtailment borne by buyer</span>
                    <span className="font-semibold">{c.curtailmentBorneByBuyer}%</span>
                  </div>
                  <Slider value={[c.curtailmentBorneByBuyer]} min={0} max={100} step={5}
                    onValueChange={v => set("curtailmentBorneByBuyer", v[0])} />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    0% = seller wears all curtailment risk · 100% = buyer absorbs it. A real negotiated term.
                  </p>
                </div>
                <Toggle label="Environmental attributes convey"
                  checked={c.includesAttributes} onChange={v => set("includesAttributes", v)}
                  hint="Whether offsets/RECs transfer with the energy. If they don't, the buyer gets no Scope 2 claim from this contract." />
                {c.includesAttributes && (
                  <NumField label="Attribute value" value={c.attributeValue}
                    onChange={v => set("attributeValue", v)} suffix="C$/MWh" step={0.5}
                    hint="Alberta TIER offset value. Thin market — treat as an assumption, not a quote." />
                )}
              </CardContent>
            </Card>
          ) : (
            <Card className="border-purple-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Financial settlement terms</CardTitle>
                <p className="text-xs text-muted-foreground">Only apply to a contract for differences.</p>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground">Notional volume</span>
                    <span className="font-semibold">{c.notionalPct}% of output</span>
                  </div>
                  <Slider value={[c.notionalPct]} min={10} max={100} step={5}
                    onValueChange={v => set("notionalPct", v[0])} />
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Share of the asset's generation covered by the CfD. Unlike a physical PPA there is no
                    requirement to match your own load.
                  </p>
                </div>
                <Toggle label="Settlement floored at zero"
                  checked={c.settlementFloor} onChange={v => set("settlementFloor", v)}
                  hint="If on, the buyer never pays out when pool < strike (seller wears the downside). Materially changes risk — the seller prices it into the strike." />
                <Toggle label="Hedge accounting elected and qualifies"
                  checked={c.hedgeAccounting} onChange={v => set("hedgeAccounting", v)}
                  hint="If NOT elected, fair-value movements hit reported earnings every period under IFRS 9 / ASC 815. This is often why a corporate treasury declines an otherwise-attractive VPPA." />
              </CardContent>
            </Card>
          )}
        </div>

        {/* ── Results ── */}
        <div className="lg:col-span-2 space-y-5">
          {/* Accounting warning — VPPA only, and only when unhedged */}
          {!isPpa && !c.hedgeAccounting && (
            <Card className="border-red-500/40 bg-red-500/5">
              <CardContent className="pt-4 pb-4 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-semibold text-red-400">Mark-to-market hits reported earnings</div>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    Without hedge accounting, this CfD is measured at fair value through profit or loss
                    each reporting period. With a {c.termYears}-year term the fair-value swing on a
                    C${c.strike}/MWh strike against a volatile Alberta pool price can dwarf the
                    settlement cashflow itself. The economics below are cash — they are not what shows
                    up in reported earnings. Confirm treatment with your auditor before signing.
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">
                {isPpa ? "Buyer net position by year (C$M)" : "CfD settlement by year (C$M)"}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                {isPpa
                  ? "Energy value + attributes − contract payments. Positive = the contract is in the money for the buyer."
                  : "(Pool − strike) × notional volume. Positive = buyer receives; negative = buyer pays."}
                {" "}Bars past Cal-{CURVE_LAST_YEAR} sit on a held-flat price and are lighter.
              </p>
            </CardHeader>
            <CardContent className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="year" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickFormatter={v => `${v}M`} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))" }}
                    formatter={(v: number) => [`C$${v}M`, "Buyer net"]}
                    labelFormatter={(l) => {
                      const row = chartData.find(d => d.year === l);
                      return `${l} · Cal-${row?.calendarYear}${row?.postRem ? " (post-REM)" : ""}`;
                    }} />
                  <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" />
                  <Bar dataKey="net" radius={[3, 3, 0, 0]}>
                    {chartData.map((d, idx) => (
                      <Cell key={idx}
                        fill={d.net >= 0 ? "hsl(var(--primary))" : "hsl(var(--destructive))"}
                        fillOpacity={res.rows[idx]?.observed ? 1 : 0.45} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Pool price vs strike (C$/MWh)</CardTitle>
              <p className="text-xs text-muted-foreground">
                Where the strike sits against the forward curve is the whole contract. Crossings are
                where the contract flips between in and out of the money.
              </p>
            </CardHeader>
            <CardContent className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="year" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickFormatter={v => `$${v}`} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))" }}
                    formatter={(v: number) => `C$${v}/MWh`} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {res.observedYears > 0 && res.observedYears < res.rows.length && (
                    <ReferenceLine x={`Y${res.observedYears}`} stroke="hsl(var(--muted-foreground))"
                      strokeDasharray="3 3"
                      label={{ value: "end of curve", fontSize: 9, fill: "hsl(var(--muted-foreground))", position: "insideTopRight" }} />
                  )}
                  <Line type="stepAfter" dataKey="pool" name="Pool price (fwd)"
                        stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                  <Line type="stepAfter" dataKey="strike" name="Contract strike"
                        stroke="#f59e0b" strokeWidth={2} strokeDasharray="4 3" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Structure comparison — what's actually different */}
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">What differs between the two structures</CardTitle></CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="text-left py-2 font-medium"></th>
                      <th className="text-left py-2 font-medium">Physical PPA</th>
                      <th className="text-left py-2 font-medium">Virtual PPA (CfD)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ["Title to energy", "Transfers to buyer", "Never transfers"],
                      ["Delivery point", "Required, negotiated", "None"],
                      ["Retailer arrangement", "Buyer needs one in Alberta", "Not required"],
                      ["Load shape matching", "Matters — unused energy resold at pool", "Irrelevant"],
                      ["Curtailment", "Allocated by contract, real $ value", "Reduces notional volume only"],
                      ["Locational basis (today)", "None — single AB pool price", "None — single AB pool price"],
                      ["Locational basis (post-REM)", "Delivery point vs node", "Reference price vs node"],
                      ["Accounting", "Executory / normal purchase", "Derivative — IFRS 9 / ASC 815"],
                      ["Earnings volatility", "Low", "High unless hedge accounting qualifies"],
                      ["Environmental attributes", "Convey only if contracted", "Usually contracted separately"],
                    ].map(([k, a, b]) => (
                      <tr key={k} className="border-b border-border/40">
                        <td className="py-1.5 pr-3 text-muted-foreground">{k}</td>
                        <td className="py-1.5 pr-3">{a}</td>
                        <td className="py-1.5">{b}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground leading-relaxed">
        <strong>Basis and method.</strong> Pool prices come from the same Alberta forward curve used by
        DCF Valuation (<a className="underline" href={TC_FORWARD_URL} target="_blank" rel="noreferrer">TC Energy indicative</a>,
        held flat past Cal-{CURVE_LAST_YEAR}). This tab values the CONTRACT to the buyer; DCF Valuation
        values the ASSET to its owner — the two use different discount rates by design (buyer's cost of
        capital vs project WACC) and should not be added together. Accounting commentary is a
        structural flag, not tax or audit advice. Post-REM basis exposure is identified but NOT priced:
        no Alberta LMP scenarios exist yet, and inventing one would be worse than naming the gap.
      </p>
    </div>
  );
}
