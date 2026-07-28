import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, Cell, LineChart, Line, Legend,
} from "recharts";

/* ══════════════════════════════════════════════════════════════════════════
   Alberta project economics calculator.

   Two modes:
     · Project Investment NPV — full economics; CAPEX and OPEX drive the result
     · PPA / VPPA Settlement  — contract settlement value only (ERCOT-style)

   COST BASIS — read before changing these numbers
   ------------------------------------------------
   The NET figures are the sourced ones: MSA Q1 2026 analysis, derived from the
   AESO 2024 Long-Term Outlook and inflation-adjusted to 2026 CAD. AESO/MSA
   publish renewables NET of an assumed 30% Clean Technology ITC.

   The GROSS figures below are NOT independently sourced — they are simply
   net ÷ 0.70, i.e. the 30% ITC reversed out (1177/0.7 = 1682, 1298/0.7 = 1854,
   1413/0.7 = 2019). They exist so the calculator can start from gross and
   apply a user-chosen ITC rate without double-counting the incentive.

   THE DOUBLE-COUNT TRAP: if you enter the MSA *net* number as CAPEX and then
   also apply a 30% ITC, you have taken the credit twice and the NPV is wrong.
   This page always takes GROSS input and applies the ITC once, explicitly.

   Gas is not ITC-eligible, so gross == net for CCGT/SCGT.
   ══════════════════════════════════════════════════════════════════════════ */

type TechKey = "wind" | "solar" | "bess" | "ccgt" | "scgt";

interface TechDefaults {
  label: string;
  grossCapexPerKw: number;   // C$/kW, 2026 — derived for renewables (net ÷ 0.7)
  netCapexPerKw: number;     // C$/kW, 2026 — MSA published (renewables only)
  fixedOmPerKwYr: number;    // C$/kW-year
  variableOmPerMwh: number;  // C$/MWh
  capacityFactor: number;    // fraction
  degradationPctYr: number;  // %/yr output decline
  lifeYears: number;
  itcEligible: boolean;
  defaultItcPct: number;
  heatRateGjPerMwh?: number; // gas only
  refSize: string;
  captureRate: number;       // vs Alberta pool price, screening default
}

const TECH: Record<TechKey, TechDefaults> = {
  wind: {
    label: "Wind", grossCapexPerKw: 1682, netCapexPerKw: 1177,
    fixedOmPerKwYr: 97.39, variableOmPerMwh: 0, capacityFactor: 0.36,
    degradationPctYr: 0.35, lifeYears: 30, itcEligible: true, defaultItcPct: 30,
    refSize: "100 MW reference", captureRate: 0.82,
  },
  solar: {
    label: "Solar", grossCapexPerKw: 1856, netCapexPerKw: 1298,
    fixedOmPerKwYr: 29.72, variableOmPerMwh: 0, capacityFactor: 0.19,
    degradationPctYr: 0.5, lifeYears: 30, itcEligible: true, defaultItcPct: 30,
    refSize: "50 MW reference", captureRate: 0.88,
  },
  bess: {
    label: "Battery storage", grossCapexPerKw: 2018, netCapexPerKw: 1413,
    fixedOmPerKwYr: 53.47, variableOmPerMwh: 0, capacityFactor: 0.15,
    degradationPctYr: 1.5, lifeYears: 20, itcEligible: true, defaultItcPct: 30,
    refSize: "generic — duration not specified by AESO", captureRate: 1.35,
  },
  ccgt: {
    label: "CCGT", grossCapexPerKw: 1706, netCapexPerKw: 1706,
    fixedOmPerKwYr: 22.19, variableOmPerMwh: 4.01, capacityFactor: 0.55,
    degradationPctYr: 0, lifeYears: 30, itcEligible: false, defaultItcPct: 0,
    heatRateGjPerMwh: 7.0, refSize: "418 MW", captureRate: 1.0,
  },
  scgt: {
    label: "Aeroderivative SCGT", grossCapexPerKw: 1849, netCapexPerKw: 1849,
    fixedOmPerKwYr: 25.65, variableOmPerMwh: 7.39, capacityFactor: 0.08,
    degradationPctYr: 0, lifeYears: 25, itcEligible: false, defaultItcPct: 0,
    heatRateGjPerMwh: 10.0, refSize: "47 MW", captureRate: 1.15,
  },
};

// Underwriting bands (screening, not EPC quotes) — C$/kW gross
const CAPEX_BANDS: Record<TechKey, [number, number, number]> = {
  wind:  [1500, 1680, 2000],
  solar: [1650, 1860, 2050],
  bess:  [2000, 2400, 2800],
  ccgt:  [1500, 1710, 2100],
  scgt:  [1650, 1850, 2300],
};

const EMISSIONS_T_PER_GJ = 0.0561;   // tCO2e per GJ
const AESO_TRADING_CHARGE = 0.606;   // C$/MWh
const OUTAGE_DERATE = 0.14;          // forced + planned, gas

/* ── finance helpers ─────────────────────────────────────────────────────── */

function irr(cashflows: number[]): number | null {
  // Bisection — robust enough for conventional (-,+,+,...) profiles.
  const npvAt = (r: number) => cashflows.reduce((a, cf, t) => a + cf / Math.pow(1 + r, t), 0);
  let lo = -0.95, hi = 2.0;
  if (npvAt(lo) * npvAt(hi) > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npvAt(lo) * npvAt(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

interface Inputs {
  tech: TechKey;
  mw: number;
  durationHrs: number;      // BESS only
  grossCapexPerKw: number;
  itcPct: number;
  capacityFactor: number;
  degradationPctYr: number;
  availabilityPct: number;
  curtailmentPct: number;
  lossFactorPct: number;
  lifeYears: number;
  fixedOmPerKwYr: number;
  variableOmPerMwh: number;
  otherOpexPerKwYr: number; // land lease, tax, insurance, admin, reclamation
  opexEscalationPct: number;
  poolPrice: number;
  captureRate: number;
  priceEscalationPct: number;
  gasPricePerGj: number;
  carbonPricePerT: number;
  wacc: number;
  ppaStrike: number;
  ppaEscalationPct: number;
  ppaTermYears: number;
  contractedPct: number;
}

interface YearRow {
  year: number;
  mwh: number;
  price: number;
  revenue: number;
  opex: number;
  ebitda: number;
  cashflow: number;
  cumulative: number;
}

function runModel(i: Inputs) {
  const t = TECH[i.tech];
  const kw = i.mw * 1000;

  // ── CAPEX: gross in, ITC applied exactly once ──────────────────────────
  const grossCapex = kw * i.grossCapexPerKw;
  const itcValue = grossCapex * (i.itcPct / 100);
  const netCapex = grossCapex - itcValue;

  // Gas fuel + carbon, per MWh
  const fuelPerMwh = t.heatRateGjPerMwh ? t.heatRateGjPerMwh * i.gasPricePerGj : 0;
  const carbonPerMwh = t.heatRateGjPerMwh
    ? t.heatRateGjPerMwh * EMISSIONS_T_PER_GJ * i.carbonPricePerT : 0;

  const rows: YearRow[] = [];
  let cumulative = -netCapex;

  for (let y = 1; y <= i.lifeYears; y++) {
    const degr = Math.pow(1 - i.degradationPctYr / 100, y - 1);
    const avail = i.availabilityPct / 100;
    const curt = 1 - i.curtailmentPct / 100;
    const loss = 1 - i.lossFactorPct / 100;
    const mwh = i.mw * 8760 * i.capacityFactor * degr * avail * curt * loss;

    // Merchant price = pool × capture rate, escalated
    const esc = Math.pow(1 + i.priceEscalationPct / 100, y - 1);
    const merchant = i.poolPrice * i.captureRate * esc;

    // Contracted share settles at the escalated strike, within term
    const inTerm = y <= i.ppaTermYears;
    const strike = i.ppaStrike * Math.pow(1 + i.ppaEscalationPct / 100, y - 1);
    const contracted = inTerm ? i.contractedPct / 100 : 0;
    const price = contracted * strike + (1 - contracted) * merchant;

    const revenue = mwh * price;

    const opexEsc = Math.pow(1 + i.opexEscalationPct / 100, y - 1);
    const fixedOm = kw * (i.fixedOmPerKwYr + i.otherOpexPerKwYr) * opexEsc;
    const varOm = mwh * (i.variableOmPerMwh + fuelPerMwh + carbonPerMwh + AESO_TRADING_CHARGE) * opexEsc;
    const opex = fixedOm + varOm;

    const ebitda = revenue - opex;
    cumulative += ebitda;
    rows.push({ year: y, mwh, price, revenue, opex, ebitda, cashflow: ebitda, cumulative });
  }

  // ── NPV / IRR ──────────────────────────────────────────────────────────
  const r = i.wacc / 100;
  const npv = rows.reduce((a, row) => a + row.cashflow / Math.pow(1 + r, row.year), -netCapex);
  const projectIrr = irr([-netCapex, ...rows.map(x => x.cashflow)]);

  // ── LCOE: discounted cost ÷ discounted energy ──────────────────────────
  const discCost = rows.reduce((a, row) => a + row.opex / Math.pow(1 + r, row.year), netCapex);
  const discMwh = rows.reduce((a, row) => a + row.mwh / Math.pow(1 + r, row.year), 0);
  const lcoe = discMwh > 0 ? discCost / discMwh : 0;

  // Breakeven flat price: the level price making NPV zero (= LCOE by construction)
  const breakeven = lcoe;

  // Payback — first year cumulative turns positive (undiscounted)
  const paybackYear = rows.find(x => x.cumulative >= 0)?.year ?? null;

  const avgEbitda = rows.reduce((a, x) => a + x.ebitda, 0) / Math.max(rows.length, 1);
  const annualOpex = rows.length ? rows[0].opex : 0;
  const annualMwh = rows.length ? rows[0].mwh : 0;

  return {
    grossCapex, itcValue, netCapex, npv, projectIrr, lcoe, breakeven,
    paybackYear, avgEbitda, annualOpex, annualMwh, rows,
    fuelPerMwh, carbonPerMwh,
  };
}

/* ── small UI helpers ────────────────────────────────────────────────────── */

function NumField({ label, value, onChange, step = 1, suffix, hint }: {
  label: string; value: number; onChange: (v: number) => void;
  step?: number; suffix?: string; hint?: string;
}) {
  return (
    <div>
      <label className="text-xs text-muted-foreground block mb-1">{label}</label>
      <div className="flex items-center gap-1.5">
        <input
          type="number" value={value} step={step}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-full bg-background border border-border rounded-md px-2 py-1.5 text-sm"
        />
        {suffix && <span className="text-xs text-muted-foreground shrink-0">{suffix}</span>}
      </div>
      {hint && <p className="text-[10px] text-muted-foreground mt-1 leading-tight">{hint}</p>}
    </div>
  );
}

function Kpi({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: "good" | "bad" | "neutral";
}) {
  const color = tone === "good" ? "text-emerald-500"
              : tone === "bad" ? "text-red-500" : "text-foreground";
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

const money = (n: number) =>
  Math.abs(n) >= 1e6 ? `C$${(n / 1e6).toFixed(1)}M`
  : Math.abs(n) >= 1e3 ? `C$${(n / 1e3).toFixed(0)}k`
  : `C$${n.toFixed(0)}`;

/* ══════════════════════════════════════════════════════════════════════════ */

export default function NpvCalculator() {
  const [mode, setMode] = useState<"project" | "ppa">("project");
  const [tech, setTech] = useState<TechKey>("wind");

  const d = TECH[tech];
  const [i, setI] = useState<Inputs>(() => ({
    tech: "wind", mw: 100, durationHrs: 4,
    grossCapexPerKw: TECH.wind.grossCapexPerKw,
    itcPct: TECH.wind.defaultItcPct,
    capacityFactor: TECH.wind.capacityFactor,
    degradationPctYr: TECH.wind.degradationPctYr,
    availabilityPct: 97, curtailmentPct: 3, lossFactorPct: 2,
    lifeYears: TECH.wind.lifeYears,
    fixedOmPerKwYr: TECH.wind.fixedOmPerKwYr,
    variableOmPerMwh: TECH.wind.variableOmPerMwh,
    otherOpexPerKwYr: 15, opexEscalationPct: 2,
    poolPrice: 62, captureRate: TECH.wind.captureRate, priceEscalationPct: 2,
    gasPricePerGj: 2.5, carbonPricePerT: 110,
    wacc: 8,
    ppaStrike: 55, ppaEscalationPct: 2, ppaTermYears: 15, contractedPct: 80,
  }));

  const set = <K extends keyof Inputs>(k: K, v: Inputs[K]) => setI(p => ({ ...p, [k]: v }));

  const switchTech = (k: TechKey) => {
    const t = TECH[k];
    setTech(k);
    setI(p => ({
      ...p, tech: k,
      grossCapexPerKw: t.grossCapexPerKw, itcPct: t.defaultItcPct,
      capacityFactor: t.capacityFactor, degradationPctYr: t.degradationPctYr,
      lifeYears: t.lifeYears, fixedOmPerKwYr: t.fixedOmPerKwYr,
      variableOmPerMwh: t.variableOmPerMwh, captureRate: t.captureRate,
    }));
  };

  const res = useMemo(() => runModel(i), [i]);

  // P10 / P50 / P90 on pool price (±25% band, screening)
  const bands = useMemo(() => {
    const lo = runModel({ ...i, poolPrice: i.poolPrice * 0.75 });
    const hi = runModel({ ...i, poolPrice: i.poolPrice * 1.25 });
    return { p10: lo.npv, p50: res.npv, p90: hi.npv };
  }, [i, res.npv]);

  // Tornado — ±20% on the five drivers that matter
  const tornado = useMemo(() => {
    const drivers: { name: string; make: (s: number) => Inputs }[] = [
      { name: "CAPEX",          make: s => ({ ...i, grossCapexPerKw: i.grossCapexPerKw * s }) },
      { name: "Pool price",     make: s => ({ ...i, poolPrice: i.poolPrice * s }) },
      { name: "Capacity factor",make: s => ({ ...i, capacityFactor: i.capacityFactor * s }) },
      { name: "WACC",           make: s => ({ ...i, wacc: i.wacc * s }) },
      { name: "OPEX",           make: s => ({ ...i, fixedOmPerKwYr: i.fixedOmPerKwYr * s,
                                              otherOpexPerKwYr: i.otherOpexPerKwYr * s }) },
    ];
    return drivers.map(dr => {
      const down = runModel(dr.make(0.8)).npv;
      const up   = runModel(dr.make(1.2)).npv;
      return { name: dr.name, low: Math.min(down, up) - res.npv, high: Math.max(down, up) - res.npv,
               swing: Math.abs(up - down) };
    }).sort((a, b) => b.swing - a.swing);
  }, [i, res.npv]);

  const cashflowData = res.rows.map(r => ({
    year: `Y${r.year}`, ebitda: Math.round(r.ebitda / 1e6 * 10) / 10,
    cumulative: Math.round(r.cumulative / 1e6 * 10) / 10,
  }));

  const isBess = tech === "bess";
  const isGas = tech === "ccgt" || tech === "scgt";
  const band = CAPEX_BANDS[tech];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Project Economics &amp; NPV</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Alberta project investment analysis — CAPEX, OPEX, incentives and pool-price revenue.
          </p>
        </div>
        <div className="flex gap-1 bg-muted p-1 rounded-lg">
          {([["project", "Project Investment NPV"], ["ppa", "PPA / VPPA Settlement"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setMode(k)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                mode === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Technology selector */}
      <div className="flex gap-2 flex-wrap">
        {(Object.keys(TECH) as TechKey[]).map(k => (
          <button key={k} onClick={() => switchTech(k)}
            className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
              tech === k ? "bg-primary text-primary-foreground border-primary"
                         : "border-border text-muted-foreground hover:text-foreground"}`}>
            {TECH[k].label}
          </button>
        ))}
      </div>

      {/* ITC double-count warning — the single most important note on this page */}
      <Card className="border-amber-500/40">
        <CardContent className="pt-4 pb-4">
          <div className="text-sm font-semibold mb-1">Cost basis: gross CAPEX in, incentive applied once</div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            MSA/AESO publish renewable capital costs <strong>net of an assumed 30% Clean Technology ITC</strong>
            {" "}({d.label} net: C${d.netCapexPerKw.toLocaleString()}/kW). This calculator takes
            {" "}<strong>gross</strong> CAPEX (C${d.grossCapexPerKw.toLocaleString()}/kW) and applies the ITC
            explicitly below, so the credit is counted exactly once. Entering the published net figure
            <em> and</em> an ITC percentage would double-count the incentive.
            {d.itcEligible
              ? " Clean Technology ITC is up to 30% through 2033, 15% in 2034; Clean Electricity ITC is up to 15%. The same property generally cannot claim both."
              : " Gas generation is not ITC-eligible, so gross equals net."}
            {" "}Gross values for renewables are derived (net ÷ 0.70), not independently published.
          </p>
        </CardContent>
      </Card>

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi label={mode === "project" ? "Project NPV" : "Settlement NPV"}
             value={money(res.npv)} tone={res.npv >= 0 ? "good" : "bad"}
             sub={`at ${i.wacc}% WACC, ${i.lifeYears}-yr life`} />
        <Kpi label="Project IRR"
             value={res.projectIrr !== null ? `${(res.projectIrr * 100).toFixed(1)}%` : "n/a"}
             tone={res.projectIrr !== null && res.projectIrr * 100 >= i.wacc ? "good" : "bad"}
             sub={res.projectIrr === null ? "no sign change in cashflows" : `vs ${i.wacc}% hurdle`} />
        <Kpi label="LCOE" value={`C$${res.lcoe.toFixed(1)}/MWh`}
             sub="discounted cost ÷ discounted energy" />
        <Kpi label="Breakeven price" value={`C$${res.breakeven.toFixed(1)}/MWh`}
             sub="flat price for NPV = 0" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi label="Gross CAPEX" value={money(res.grossCapex)}
             sub={`C$${i.grossCapexPerKw.toLocaleString()}/kW${isBess ? ` · C$${(res.grossCapex / (i.mw * 1000 * i.durationHrs)).toFixed(0)}/kWh` : ""}`} />
        <Kpi label="ITC value" value={money(res.itcValue)}
             sub={`${i.itcPct}% — net CAPEX ${money(res.netCapex)}`} />
        <Kpi label="Annual EBITDA (avg)" value={money(res.avgEbitda)}
             sub={`${(res.annualMwh / 1000).toFixed(0)} GWh yr 1`} />
        <Kpi label="Payback"
             value={res.paybackYear ? `${res.paybackYear} yrs` : "beyond life"}
             sub="undiscounted, from COD" />
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* ── Inputs ─────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Project</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <NumField label="Capacity" value={i.mw} onChange={v => set("mw", v)} suffix="MW" />
              {isBess && (
                <NumField label="Duration" value={i.durationHrs} onChange={v => set("durationHrs", v)}
                  suffix="hrs" step={0.5}
                  hint="AESO's published battery cost does not state duration — enter yours. Alberta's Jurassic BESS is 80 MW / 160 MWh (2-hr)." />
              )}
              <div>
                <div className="flex items-baseline justify-between text-xs mb-1">
                  <span className="text-muted-foreground">Gross CAPEX</span>
                  <span className="font-semibold">C${i.grossCapexPerKw.toLocaleString()}/kW</span>
                </div>
                <Slider value={[i.grossCapexPerKw]} min={band[0]} max={band[2]} step={10}
                        onValueChange={v => set("grossCapexPerKw", v[0])} />
                <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                  <span>low {band[0]}</span><span>base {band[1]}</span><span>high {band[2]}</span>
                </div>
              </div>
              <NumField label="Clean Technology ITC" value={i.itcPct} onChange={v => set("itcPct", v)}
                suffix="%" hint={d.itcEligible ? "30% through 2033, 15% in 2034." : "Gas is not eligible — leave at 0."} />
              <NumField label="Project life" value={i.lifeYears} onChange={v => set("lifeYears", v)} suffix="yrs" />
              <NumField label="WACC / discount rate" value={i.wacc} onChange={v => set("wacc", v)} suffix="%" step={0.5} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Production</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <NumField label="Capacity factor" value={+(i.capacityFactor * 100).toFixed(1)}
                onChange={v => set("capacityFactor", v / 100)} suffix="%" step={0.5} />
              <NumField label="Availability" value={i.availabilityPct} onChange={v => set("availabilityPct", v)}
                suffix="%" hint={isGas ? `Gas outage assumption ~${OUTAGE_DERATE * 100}% forced + planned.` : undefined} />
              <NumField label="Curtailment / constraint" value={i.curtailmentPct}
                onChange={v => set("curtailmentPct", v)} suffix="%"
                hint="UNCALIBRATED screening input. MSA measured 561 GWh of constrained intermittent generation in Q1 2026, up ~250% year-over-year — do not assume zero." />
              <NumField label="Transmission loss factor" value={i.lossFactorPct}
                onChange={v => set("lossFactorPct", v)} suffix="%" step={0.5} />
              <NumField label="Annual degradation" value={i.degradationPctYr}
                onChange={v => set("degradationPctYr", v)} suffix="%/yr" step={0.05} />
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Operating cost</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <NumField label="Fixed O&M" value={i.fixedOmPerKwYr} onChange={v => set("fixedOmPerKwYr", v)}
                suffix="C$/kW-yr" step={0.5} hint={`MSA ${d.label} baseline: C$${d.fixedOmPerKwYr}/kW-yr.`} />
              <NumField label="Other fixed costs" value={i.otherOpexPerKwYr}
                onChange={v => set("otherOpexPerKwYr", v)} suffix="C$/kW-yr" step={0.5}
                hint="Land lease, municipal property tax, insurance, asset management, regulatory compliance, reclamation reserve. Property tax is project-specific (designated industrial property, municipal mill rate)." />
              <NumField label="Variable O&M" value={i.variableOmPerMwh} onChange={v => set("variableOmPerMwh", v)}
                suffix="C$/MWh" step={0.1} />
              <NumField label="OPEX escalation" value={i.opexEscalationPct}
                onChange={v => set("opexEscalationPct", v)} suffix="%/yr" step={0.5} />
              {isGas && (
                <>
                  <NumField label="AB-NIT gas price" value={i.gasPricePerGj} onChange={v => set("gasPricePerGj", v)}
                    suffix="C$/GJ" step={0.1}
                    hint={`Heat rate ${d.heatRateGjPerMwh} GJ/MWh → fuel C$${res.fuelPerMwh.toFixed(2)}/MWh.`} />
                  <NumField label="Carbon price (TIER)" value={i.carbonPricePerT}
                    onChange={v => set("carbonPricePerT", v)} suffix="C$/t" step={5}
                    hint={`${EMISSIONS_T_PER_GJ} tCO2e/GJ → carbon C$${res.carbonPerMwh.toFixed(2)}/MWh.`} />
                </>
              )}
              <p className="text-[10px] text-muted-foreground">
                AESO trading charge of C${AESO_TRADING_CHARGE}/MWh is applied automatically.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Revenue</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <NumField label="Alberta pool price" value={i.poolPrice} onChange={v => set("poolPrice", v)}
                suffix="C$/MWh" hint="Province-wide uniform price. Alberta has no locational basis today." />
              <NumField label="Capture rate" value={+(i.captureRate * 100).toFixed(0)}
                onChange={v => set("captureRate", v / 100)} suffix="%"
                hint={`Technology-weighted vs pool. ${d.label} screening default ${(d.captureRate * 100).toFixed(0)}%.`} />
              <NumField label="Price escalation" value={i.priceEscalationPct}
                onChange={v => set("priceEscalationPct", v)} suffix="%/yr" step={0.5} />
              <NumField label="PPA strike" value={i.ppaStrike} onChange={v => set("ppaStrike", v)} suffix="C$/MWh" />
              <NumField label="PPA term" value={i.ppaTermYears} onChange={v => set("ppaTermYears", v)} suffix="yrs" />
              <NumField label="Contracted share" value={i.contractedPct}
                onChange={v => set("contractedPct", v)} suffix="%"
                hint="Remainder settles merchant at pool × capture rate." />
            </CardContent>
          </Card>
        </div>

        {/* ── Results ────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">NPV range — pool price ±25%</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {([["P10 (low price)", bands.p10], ["P50 (base)", bands.p50], ["P90 (high price)", bands.p90]] as const)
                  .map(([label, v]) => (
                    <div key={label} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{label}</span>
                      <span className={`font-semibold ${v >= 0 ? "text-emerald-500" : "text-red-500"}`}>{money(v)}</span>
                    </div>
                  ))}
              </div>
              <p className="text-[10px] text-muted-foreground mt-3 leading-tight">
                Band is a pool-price sensitivity, not a calibrated stochastic forecast.
                Replace with a historical bootstrap once an Alberta price model is fitted.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Sensitivity (±20%)</CardTitle></CardHeader>
            <CardContent className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={tornado} layout="vertical"
                          margin={{ left: 10, right: 10, top: 5, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                  <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={10}
                         tickFormatter={(v) => `${(v / 1e6).toFixed(0)}M`} />
                  <YAxis type="category" dataKey="name" width={95}
                         stroke="hsl(var(--muted-foreground))" fontSize={10} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))" }}
                    formatter={(v: number) => money(v)} />
                  <ReferenceLine x={0} stroke="hsl(var(--muted-foreground))" />
                  <Bar dataKey="low" fill="hsl(var(--destructive))" />
                  <Bar dataKey="high" fill="hsl(var(--primary))" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3"><CardTitle className="text-sm">Risks not yet modelled</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-xs">
              {[
                ["Locational basis (today)", "Zero — Alberta settles at a uniform province-wide pool price.", "none"],
                ["Locational basis (REM)", "Disabled until LMP scenarios exist. REM introduces nodal pricing ~2027.", "future"],
                ["Curtailment", "Manual input above. Uncalibrated — no project-level allocation model yet.", "manual"],
                ["Shape / capture risk", "Technology-weighted pool price. Refine with hourly generation once seeded.", "manual"],
              ].map(([k, v, tag]) => (
                <div key={k as string} className="flex gap-2">
                  <span className={`shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium ${
                    tag === "future" ? "bg-muted text-muted-foreground"
                    : tag === "none" ? "bg-emerald-500/15 text-emerald-600"
                    : "bg-amber-500/15 text-amber-600"}`}>
                    {tag === "future" ? "FUTURE" : tag === "none" ? "N/A" : "MANUAL"}
                  </span>
                  <div>
                    <div className="font-medium">{k}</div>
                    <div className="text-muted-foreground leading-tight">{v}</div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Cashflow */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Cashflow profile (C$M)</CardTitle>
        </CardHeader>
        <CardContent className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={cashflowData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="year" stroke="hsl(var(--muted-foreground))" fontSize={11} />
              <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11}
                     tickFormatter={(v) => `${v}M`} />
              <Tooltip
                contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))" }}
                formatter={(v: number) => `C$${v}M`} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" />
              <Line type="monotone" dataKey="ebitda" name="Annual EBITDA"
                    stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="cumulative" name="Cumulative"
                    stroke="hsl(var(--chart-2, var(--muted-foreground)))" strokeWidth={2}
                    strokeDasharray="4 3" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground leading-relaxed">
        <strong>Sources &amp; basis.</strong> Capital and O&amp;M baselines: MSA Q1 2026 analysis derived from the
        AESO 2024 Long-Term Outlook, inflation-adjusted to 2026 CAD; renewables published net of an assumed 30%
        Clean Technology ITC (gross shown here is net ÷ 0.70, derived — not independently published).
        Emissions factor {EMISSIONS_T_PER_GJ} tCO₂e/GJ; AESO trading charge C${AESO_TRADING_CHARGE}/MWh plus GST.
        Capex bands are screening ranges, not EPC quotes. This is a screening model for origination triage —
        not an investment recommendation.
      </p>
    </div>
  );
}
