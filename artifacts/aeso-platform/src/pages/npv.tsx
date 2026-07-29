import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, LineChart, Line, Legend,
} from "recharts";
import {
  ChevronDown, ChevronUp, Settings2, DollarSign, TrendingUp, TrendingDown, Minus,
} from "lucide-react";

/* ══════════════════════════════════════════════════════════════════════════
   Alberta project economics calculator.

   Structure mirrors the ERCOT platform's ppa-calculator.tsx: a narrow left
   panel drives a 2-step Fuel -> Project wizard (real AESO asset data) that
   auto-populates assumptions, a collapsible Assumptions panel for everything
   else, always-visible Contract Terms sliders, and a Compute action. The
   right panel stays empty until you compute, then shows a project header,
   price/volume waterfall breakdown, P10/P50/P90 cards, and a cashflow chart
   — same rhythm as ERCOT's results panel. AESO-specific extras (tornado,
   live price scrubber, risks-not-modelled) are appended after the core
   results rather than dropped, since they don't exist on the ERCOT page.

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

// Visual metadata for the cost-reference cards — mirrors the ERCOT platform's
// Project Development Cost Reference layout (artifacts/grid-platform/src/pages/
// ppa-calculator.tsx CAPEX_BENCHMARKS) so the two apps read as one family.
const TECH_META: Record<TechKey, { emoji: string; color: string }> = {
  wind:  { emoji: "🌬️", color: "border-teal-500/40 bg-teal-900/10" },
  solar: { emoji: "☀️", color: "border-amber-500/40 bg-amber-900/10" },
  bess:  { emoji: "🔋", color: "border-emerald-500/40 bg-emerald-900/10" },
  ccgt:  { emoji: "⚡", color: "border-orange-500/40 bg-orange-900/10" },
  scgt:  { emoji: "🔥", color: "border-red-500/40 bg-red-900/10" },
};

// Maps a CSD fuel_type onto the nearest cost model. HYDRO, COGENERATION, GAS
// FIRED STEAM and OTHER have no dedicated Alberta cost model yet — assets in
// those fuels are excluded from the project picker rather than silently
// mapped onto a technology they aren't (e.g. cogen forced into CCGT).
const FUEL_TO_TECH: Partial<Record<string, TechKey>> = {
  WIND: "wind",
  SOLAR: "solar",
  "ENERGY STORAGE": "bess",
  "COMBINED CYCLE": "ccgt",
  "SIMPLE CYCLE": "scgt",
};

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

function WaterfallRow({ label, value, note, highlight, indent }: {
  label: string; value: string; note?: string; highlight?: boolean; indent?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between py-1.5 ${highlight ? "border-t border-border mt-1 pt-2.5" : ""}`}>
      <div className={indent ? "pl-3" : ""}>
        <span className={`text-xs ${highlight ? "text-foreground font-semibold" : "text-muted-foreground"}`}>{label}</span>
        {note && <span className="text-[10px] text-muted-foreground/60 ml-1.5">{note}</span>}
      </div>
      <span className={`text-xs font-mono ${highlight ? "text-primary font-bold" : "text-foreground/90"}`}>{value}</span>
    </div>
  );
}

function ScenarioCard({ label, npv, k }: { label: string; npv: number; k: "p10" | "p50" | "p90" }) {
  const positive = npv >= 0;
  const neutral = Math.abs(npv) < 0.05e6;
  const Icon = neutral ? Minus : positive ? TrendingUp : TrendingDown;
  const badge = {
    p10: "bg-primary/15 text-primary",
    p50: "bg-muted text-foreground",
    p90: "bg-red-500/15 text-red-500",
  }[k];
  const fmt = (n: number) => n >= 0 ? `+${money(n)}` : `-${money(Math.abs(n))}`;
  return (
    <Card className={neutral ? "" : positive ? "border-emerald-500/40" : "border-red-500/40"}>
      <CardContent className="pt-4 pb-4">
        <div className="flex items-center justify-between mb-2">
          <span className={`text-xs font-semibold px-2 py-0.5 rounded ${badge}`}>{k.toUpperCase()}</span>
          <Icon className={`h-4 w-4 ${neutral ? "text-muted-foreground" : positive ? "text-emerald-500" : "text-red-500"}`} />
        </div>
        <p className="text-xs text-muted-foreground mb-1">{label}</p>
        <p className={`text-xl font-bold ${neutral ? "" : positive ? "text-emerald-500" : "text-red-500"}`}>{fmt(npv)}</p>
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

  // ── Step 1/2 — real-project wizard (mirrors ERCOT's ISO -> Tech -> Project) ──
  // Fuel → asset, backed by the same aeso_asset_ttm view as the Generation
  // Stack tab, so MW and capture rate here are measured, not assumed.
  const [pickerFuel, setPickerFuel] = useState<string>("");
  const [pickerAssetId, setPickerAssetId] = useState<string>("");

  const { data: pickerFuels } = useQuery({
    queryKey: ["npv-picker-fuels"],
    queryFn: () => getJson<{ fuels: { fuel_type: string; assets: number }[] }>(
      "/api/aeso/generation-stack/fuels"),
  });

  const pickableFuels = (pickerFuels?.fuels ?? []).filter(f => FUEL_TO_TECH[f.fuel_type]);

  const { data: pickerAssets, isLoading: assetsLoading } = useQuery({
    queryKey: ["npv-picker-assets", pickerFuel],
    queryFn: () => getJson<{ assets: StackAsset[] }>(
      `/api/aeso/generation-stack/assets?fuel=${encodeURIComponent(pickerFuel)}`),
    enabled: !!pickerFuel,
  });

  const projectOptions = useMemo(
    () => (pickerAssets?.assets ?? []).slice().sort((a, b) => b.mc_mw - a.mc_mw),
    [pickerAssets]
  );

  const pickedAsset = projectOptions.find(a => a.asset_id === pickerAssetId) ?? null;

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

  // Cost-reference grid has its own size slider — a general benchmark, not
  // tied to the specific scenario being computed above (mirrors ERCOT's
  // ppa-calculator.tsx, where the CAPEX reference is independent of the
  // selected candidate's actual MW).
  const [costRefMw, setCostRefMw] = useState(910);

  // Live pool-price sensitivity scrubber, -30%..+30%. Independent of the
  // fixed ±25% P10/P90 band below — this one is user-driven and recomputes
  // on every drag, not a fixed screening assumption.
  const [priceSensPct, setPriceSensPct] = useState(0);

  // Assumptions panel — collapsed by default, auto-expands once a project is
  // picked (mirrors ERCOT's Risk Factors accordion behavior).
  const [assumptionsExpanded, setAssumptionsExpanded] = useState(false);

  // Results stay hidden until Compute is pressed — mirrors ERCOT's empty
  // results panel. Unlike ERCOT, a specific real asset isn't required: this
  // page also supports pure hypothetical technology modeling.
  const [hasComputed, setHasComputed] = useState(false);

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

  function pickFuel(f: string) {
    setPickerFuel(f);
    setPickerAssetId("");
  }
  function pickProject(id: string) {
    setPickerAssetId(id);
    setHasComputed(false);
  }

  // Prefill MW and capture rate from the selected asset's measured TTM
  // performance — real numbers from aeso_asset_ttm, not screening defaults.
  useEffect(() => {
    if (!pickedAsset) return;
    const mappedTech = FUEL_TO_TECH[pickedAsset.fuel_type];
    if (mappedTech) switchTech(mappedTech);
    set("mw", Math.round(pickedAsset.mc_mw));
    if (pickedAsset.capture_rate != null) {
      // Clamp: single-asset TTM capture rate can be noisy for low-generation
      // or partial-year assets — keep it in a sane screening band.
      set("captureRate", Math.max(0.2, Math.min(2.0, pickedAsset.capture_rate)));
    }
    setAssumptionsExpanded(true);
  }, [pickedAsset?.asset_id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Live scenario at the current slider position — recomputed on every drag.
  const sensRes = useMemo(
    () => runModel({ ...i, poolPrice: i.poolPrice * (1 + priceSensPct / 100) }),
    [i, priceSensPct]
  );
  const sensDelta = sensRes.npv - res.npv;

  // ── Waterfall breakdowns (year-1 values) — same narrative shape as ERCOT's
  //    Revenue Build-Up / Volume Waterfall cards, decomposed from runModel. ──
  const priceWaterfall = useMemo(() => {
    const y1 = res.rows[0];
    const merchant = i.poolPrice * i.captureRate;
    const contracted = i.ppaTermYears >= 1 ? i.contractedPct / 100 : 0;
    return {
      poolPrice: i.poolPrice,
      captureRate: i.captureRate,
      merchant,
      contractedPct: contracted,
      strike: i.ppaStrike,
      blendedPrice: y1?.price ?? 0,
    };
  }, [i, res.rows]);

  const volumeWaterfall = useMemo(() => {
    const nameplateAdj = i.mw * 8760 * i.capacityFactor; // "expected" gen at nameplate × CF
    const afterCurtailment = nameplateAdj * (1 - i.curtailmentPct / 100);
    const afterAvailability = afterCurtailment * (i.availabilityPct / 100);
    const delivered = res.rows[0]?.mwh ?? afterAvailability * (1 - i.lossFactorPct / 100);
    return {
      nameplateAdj,
      curtailmentLoss: nameplateAdj - afterCurtailment,
      afterCurtailment,
      availabilityLoss: afterCurtailment - afterAvailability,
      afterAvailability,
      delivered,
    };
  }, [i, res.rows]);

  const cashflowData = res.rows.map(r => ({
    year: `Y${r.year}`, ebitda: Math.round(r.ebitda / 1e6 * 10) / 10,
    cumulative: Math.round(r.cumulative / 1e6 * 10) / 10,
  }));

  const isBess = tech === "bess";
  const isGas = tech === "ccgt" || tech === "scgt";
  const band = CAPEX_BANDS[tech];

  const selectCls = "w-full bg-background border border-border rounded-md px-2 py-1.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed";
  const projectLabel = pickedAsset ? (pickedAsset.asset_name ?? pickedAsset.asset_id) : `Generic ${d.label.toLowerCase()}`;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Project Economics &amp; NPV</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Alberta project investment analysis — pick a real project or model a generic technology.
          </p>
        </div>
        <div className="flex gap-1 bg-muted p-1 rounded-lg">
          {([["project", "Project Investment NPV"], ["ppa", "PPA / VPPA Settlement"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => { setMode(k); setHasComputed(false); }}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                mode === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {label}
            </button>
          ))}
        </div>
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* ── Left panel — wizard + assumptions + contract terms ─────────── */}
        <div className="lg:col-span-1 space-y-4">

          {/* Step 1 — Fuel */}
          <Card>
            <CardContent className="pt-4 pb-4 space-y-4">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">
                  <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-primary text-primary-foreground text-[10px] font-bold mr-1.5">1</span>
                  Fuel type
                </label>
                <select className={selectCls} value={pickerFuel} onChange={e => pickFuel(e.target.value)}>
                  <option value="">— Generic technology (no specific project) —</option>
                  {pickableFuels.map(f => (
                    <option key={f.fuel_type} value={f.fuel_type}>{f.fuel_type} ({f.assets})</option>
                  ))}
                </select>
              </div>

              {/* Step 2 — Project */}
              <div>
                <label className="block text-xs text-muted-foreground mb-1">
                  <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-primary text-primary-foreground text-[10px] font-bold mr-1.5">2</span>
                  Project
                  {pickerFuel && <span className="ml-1.5 text-muted-foreground/70">({projectOptions.length} · sorted by MW)</span>}
                  {assetsLoading && pickerFuel && <span className="ml-1.5 text-muted-foreground/70">loading…</span>}
                </label>
                <select className={selectCls} value={pickerAssetId} disabled={!pickerFuel}
                  onChange={e => pickProject(e.target.value)}>
                  <option value="">— Select a project —</option>
                  {projectOptions.map(a => (
                    <option key={a.asset_id} value={a.asset_id}>
                      {a.asset_name ?? a.asset_id} · {Math.round(a.mc_mw)} MW
                    </option>
                  ))}
                </select>
              </div>

              {!pickerFuel && (
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Or pick a generic technology</label>
                  <div className="flex gap-1.5 flex-wrap">
                    {(Object.keys(TECH) as TechKey[]).map(k => (
                      <button key={k} onClick={() => switchTech(k)}
                        className={`px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                          tech === k ? "bg-primary text-primary-foreground border-primary"
                                     : "border-border text-muted-foreground hover:text-foreground"}`}>
                        {TECH_META[k].emoji} {TECH[k].label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {pickedAsset && (
                <div className="rounded-lg bg-muted/30 p-2.5 text-xs text-muted-foreground space-y-1">
                  <div className="flex justify-between">
                    <span>Measured capture rate</span>
                    <span className="font-semibold text-foreground">
                      {pickedAsset.capture_rate != null ? `${(pickedAsset.capture_rate * 100).toFixed(0)}%` : "—"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Measured capacity factor</span>
                    <span className="font-semibold text-foreground">
                      {pickedAsset.capacity_factor != null ? `${(pickedAsset.capacity_factor * 100).toFixed(0)}%` : "—"}
                    </span>
                  </div>
                  {pickedAsset.months_present < 12 && (
                    <p className="text-amber-500">only {pickedAsset.months_present}/12 months metered</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Assumptions (collapsible) ── */}
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <button
              className="w-full flex items-center justify-between px-4 py-3 text-xs font-semibold text-foreground/90 hover:bg-muted/40 transition-colors"
              onClick={() => setAssumptionsExpanded(v => !v)}
            >
              <span className="flex items-center gap-1.5">
                <Settings2 className="h-3.5 w-3.5 text-amber-400" />
                Assumptions
                <span className="text-muted-foreground font-normal">
                  · CAPEX, production, opex, revenue
                </span>
              </span>
              {assumptionsExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>

            {assumptionsExpanded && (
              <div className="px-4 pb-4 space-y-5 border-t border-border pt-3">
                <div className="space-y-3">
                  <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">CAPEX &amp; financing</h4>
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
                </div>

                <div className="space-y-3">
                  <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Production</h4>
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
                </div>

                <div className="space-y-3">
                  <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Operating cost</h4>
                  <NumField label="Fixed O&M" value={i.fixedOmPerKwYr} onChange={v => set("fixedOmPerKwYr", v)}
                    suffix="C$/kW-yr" step={0.5} hint={`MSA ${d.label} baseline: C$${d.fixedOmPerKwYr}/kW-yr.`} />
                  <NumField label="Other fixed costs" value={i.otherOpexPerKwYr}
                    onChange={v => set("otherOpexPerKwYr", v)} suffix="C$/kW-yr" step={0.5}
                    hint="Land lease, municipal property tax, insurance, asset management, regulatory compliance, reclamation reserve." />
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
                </div>

                <div className="space-y-3">
                  <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Revenue basis</h4>
                  <NumField label="Alberta pool price" value={i.poolPrice} onChange={v => set("poolPrice", v)}
                    suffix="C$/MWh" hint="Province-wide uniform price. Alberta has no locational basis today." />
                  <NumField label="Capture rate" value={+(i.captureRate * 100).toFixed(0)}
                    onChange={v => set("captureRate", v / 100)} suffix="%"
                    hint={`Technology-weighted vs pool. ${d.label} screening default ${(d.captureRate * 100).toFixed(0)}%.`} />
                  <NumField label="Price escalation" value={i.priceEscalationPct}
                    onChange={v => set("priceEscalationPct", v)} suffix="%/yr" step={0.5} />
                </div>
              </div>
            )}
          </div>

          {/* ── Contract Terms (always visible) ── */}
          <div className="border-t border-border pt-4 space-y-4">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Contract Terms</h3>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Strike price</span>
                <span className="font-semibold text-primary">C${i.ppaStrike}/MWh</span>
              </div>
              <Slider value={[i.ppaStrike]} min={15} max={100} step={0.5}
                onValueChange={v => set("ppaStrike", v[0])} />
              <div className="flex justify-between text-[10px] text-muted-foreground"><span>$15</span><span>$100</span></div>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Contract term</span>
                <span className="font-semibold text-primary">{i.ppaTermYears} years</span>
              </div>
              <Slider value={[i.ppaTermYears]} min={5} max={25} step={1}
                onValueChange={v => set("ppaTermYears", v[0])} />
              <div className="flex justify-between text-[10px] text-muted-foreground"><span>5 yr</span><span>25 yr</span></div>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">WACC</span>
                <span className="font-semibold text-amber-500">{i.wacc}%</span>
              </div>
              <Slider value={[i.wacc]} min={4} max={15} step={0.5}
                onValueChange={v => set("wacc", v[0])} />
              <div className="flex justify-between text-[10px] text-muted-foreground"><span>4%</span><span>15%</span></div>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Price escalation</span>
                <span className="font-semibold text-purple-400">{i.ppaEscalationPct}%/yr</span>
              </div>
              <Slider value={[i.ppaEscalationPct]} min={0} max={5} step={0.25}
                onValueChange={v => set("ppaEscalationPct", v[0])} />
              <div className="flex justify-between text-[10px] text-muted-foreground"><span>0%</span><span>5%/yr</span></div>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Contracted share</span>
                <span className="font-semibold text-teal-400">{i.contractedPct}%</span>
              </div>
              <Slider value={[i.contractedPct]} min={0} max={100} step={5}
                onValueChange={v => set("contractedPct", v[0])} />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>0% merchant</span><span>100% contracted</span>
              </div>
            </div>
          </div>

          <button onClick={() => setHasComputed(true)}
            className="w-full py-2.5 rounded-lg font-semibold text-sm bg-primary text-primary-foreground hover:opacity-90 transition-opacity flex items-center justify-center gap-2">
            <DollarSign className="h-4 w-4" /> Compute NPV
          </button>
        </div>

        {/* ── Right panel — results ────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-5">
          {!hasComputed && (
            <div className="flex flex-col items-center justify-center h-72 bg-muted/20 border border-border border-dashed rounded-xl text-muted-foreground">
              <DollarSign className="h-10 w-10 mb-3 opacity-30" />
              <p className="text-sm">Pick a project (or a generic technology) and compute</p>
              <p className="text-xs mt-2 text-center max-w-xs leading-relaxed">
                Measured capture rate and capacity factor auto-populate from real AESO metered
                data when you select a project.<br />Drag any assumption to stress-test before computing.
              </p>
            </div>
          )}

          {hasComputed && (
            <>
              {/* ── Project header ── */}
              <Card>
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <p className="text-sm font-semibold">{projectLabel}</p>
                      <p className="text-xs text-muted-foreground">
                        {TECH_META[tech].emoji} {d.label} · {i.mw} MW{pickedAsset ? " · real AESO asset" : " · generic"}
                      </p>
                    </div>
                    <span className={`text-[10px] font-semibold px-2 py-1 rounded border ${
                      d.itcEligible ? "text-teal-400 bg-teal-900/30 border-teal-700" : "text-slate-400 bg-slate-800 border-slate-600"
                    }`}>
                      {d.itcEligible ? `${i.itcPct}% ITC eligible` : "Not ITC-eligible (gas)"}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
                    {[
                      { label: "Gross Gen",     value: `${(volumeWaterfall.nameplateAdj / 1000).toFixed(0)} GWh/yr` },
                      { label: "Delivered",     value: `${(volumeWaterfall.delivered / 1000).toFixed(0)} GWh/yr` },
                      { label: "Strike",        value: `C$${i.ppaStrike}/MWh` },
                      { label: "Blended price", value: `C$${priceWaterfall.blendedPrice.toFixed(2)}/MWh` },
                      { label: "Breakeven",     value: `C$${res.breakeven.toFixed(1)}/MWh` },
                      { label: "Term / WACC",   value: `${i.ppaTermYears} yr / ${i.wacc}%` },
                    ].map(({ label, value }) => (
                      <div key={label}>
                        <p className="text-[10px] text-muted-foreground">{label}</p>
                        <p className="text-xs font-medium">{value}</p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {/* ── Price waterfall + Volume waterfall ── */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Revenue Build-Up ($/MWh, year 1)</h3>
                    <WaterfallRow label="Alberta pool price" value={`C$${priceWaterfall.poolPrice.toFixed(2)}`} />
                    <WaterfallRow label={`× Capture Rate (${(priceWaterfall.captureRate * 100).toFixed(0)}%)`}
                      value={`C$${priceWaterfall.merchant.toFixed(2)}`} note="merchant price" indent />
                    <WaterfallRow label={`Blend with Strike (${(priceWaterfall.contractedPct * 100).toFixed(0)}% contracted)`}
                      value={`C$${priceWaterfall.blendedPrice.toFixed(2)}`} note="weighted avg" indent />
                    <WaterfallRow label="vs Strike" value={`C$${i.ppaStrike.toFixed(2)}`} highlight />
                    <WaterfallRow
                      label="Net $/MWh"
                      value={`${(priceWaterfall.blendedPrice - i.ppaStrike) >= 0 ? "+" : ""}C$${(priceWaterfall.blendedPrice - i.ppaStrike).toFixed(2)}`}
                      highlight
                    />
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="pt-4 pb-4">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Volume Waterfall (GWh/yr, year 1)</h3>
                    <WaterfallRow label="Expected generation (nameplate × CF)"
                      value={`${(volumeWaterfall.nameplateAdj / 1000).toFixed(1)} GWh`} />
                    <WaterfallRow label={`− Curtailment (${i.curtailmentPct.toFixed(1)}%)`}
                      value={`−${(volumeWaterfall.curtailmentLoss / 1000).toFixed(1)} GWh`} indent />
                    <WaterfallRow label="After curtailment"
                      value={`${(volumeWaterfall.afterCurtailment / 1000).toFixed(1)} GWh`} indent />
                    <WaterfallRow label={`× Availability (${i.availabilityPct.toFixed(1)}%)`}
                      value={`−${(volumeWaterfall.availabilityLoss / 1000).toFixed(1)} GWh`} indent />
                    <WaterfallRow label="Delivered volume"
                      value={`${(volumeWaterfall.delivered / 1000).toFixed(1)} GWh`} highlight />
                  </CardContent>
                </Card>
              </div>

              {/* ── P10/P50/P90 scenario cards ── */}
              <div className="grid grid-cols-3 gap-3">
                <ScenarioCard label="Low pool price (−25%)" npv={bands.p10} k="p10" />
                <ScenarioCard label="Base case" npv={bands.p50} k="p50" />
                <ScenarioCard label="High pool price (+25%)" npv={bands.p90} k="p90" />
              </div>

              {/* ── KPI row ── */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <Kpi label={mode === "project" ? "Project NPV" : "Settlement NPV"}
                     value={money(res.npv)} tone={res.npv >= 0 ? "good" : "bad"}
                     sub={`at ${i.wacc}% WACC, ${i.lifeYears}-yr life`} />
                <Kpi label="Project IRR"
                     value={res.projectIrr !== null ? `${(res.projectIrr * 100).toFixed(1)}%` : "n/a"}
                     tone={res.projectIrr !== null && res.projectIrr * 100 >= i.wacc ? "good" : "bad"}
                     sub={res.projectIrr === null ? "no sign change in cashflows" : `vs ${i.wacc}% hurdle`} />
                <Kpi label="Gross CAPEX" value={money(res.grossCapex)}
                     sub={`ITC ${money(res.itcValue)} → net ${money(res.netCapex)}`} />
                <Kpi label="Payback"
                     value={res.paybackYear ? `${res.paybackYear} yrs` : "beyond life"}
                     sub="undiscounted, from COD" />
              </div>

              {/* ── Cashflow chart ── */}
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

              {/* ── AESO-specific extras (no ERCOT equivalent) ── */}
              <div className="grid lg:grid-cols-2 gap-4">
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

              <Card className="border-primary/30">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Price sensitivity — live scrubber</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Drag to move the Alberta pool price ±30% and watch NPV recompute in real time.
                    No forward curve backs this — Alberta has no free public power or AB-NIT gas
                    forward source comparable to ERCOT's Henry Hub strip, so this is a pure
                    what-if against your entered pool price, not a probability-weighted forecast.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <div className="flex items-baseline justify-between text-xs mb-1">
                      <span className="text-muted-foreground">Pool price adjustment</span>
                      <span className={`font-semibold ${priceSensPct > 0 ? "text-emerald-500" : priceSensPct < 0 ? "text-red-500" : ""}`}>
                        {priceSensPct > 0 ? "+" : ""}{priceSensPct}%
                      </span>
                    </div>
                    <Slider value={[priceSensPct]} min={-30} max={30} step={1}
                            onValueChange={(v) => setPriceSensPct(v[0])} />
                    <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                      <span>−30%</span><span>base ${i.poolPrice}/MWh</span><span>+30%</span>
                    </div>
                  </div>

                  <div className="rounded-lg bg-muted/30 p-3 space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Scenario pool price</span>
                      <span className="font-mono font-medium">
                        C${(i.poolPrice * (1 + priceSensPct / 100)).toFixed(2)}/MWh
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Scenario NPV</span>
                      <span className={`font-mono font-bold ${sensRes.npv >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                        {money(sensRes.npv)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Δ vs base case</span>
                      <span className={`font-mono ${sensDelta >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                        {sensDelta >= 0 ? "+" : ""}{money(sensDelta)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Scenario IRR</span>
                      <span className="font-mono">
                        {sensRes.projectIrr !== null ? `${(sensRes.projectIrr * 100).toFixed(1)}%` : "n/a"}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>

      {/* ── Project Development Cost Reference ──────────────────────────────
          Mirrors the ERCOT platform's card grid (ppa-calculator.tsx
          CAPEX_BENCHMARKS) so both apps read as one family. CAPEX and O&M are
          sourced (MSA Q1 2026 / AESO 2024 LTO); land, interconnection,
          insurance and decommissioning are NOT — Alberta-specific figures for
          those four line items haven't been sourced yet, so they're labelled
          rather than filled with a guessed number. */}
      <div className="border-t border-border pt-6">
        <h2 className="text-lg font-bold">Project Development Cost Reference</h2>
        <p className="text-xs text-muted-foreground mb-5">
          2026 CAD · MSA Q1 2026 analysis, derived from the AESO 2024 Long-Term Outlook ·
          renewables shown gross of the 30% Clean Technology ITC (net ÷ 0.70, derived)
        </p>

        <div className="bg-card rounded-xl border border-border p-4 mb-5">
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-sm font-medium">Project Size:</span>
            <Slider value={[costRefMw]} min={10} max={2000} step={10}
                    onValueChange={(v) => setCostRefMw(v[0])} className="w-44" />
            <span className="text-sm font-mono text-primary w-20">{costRefMw} MW</span>
            <span className="text-xs text-muted-foreground">
              → total project cost and annual O&amp;M scale with size
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {(Object.keys(TECH) as TechKey[]).map((k) => {
            const b = TECH[k];
            const meta = TECH_META[k];
            const bandK = CAPEX_BANDS[k];
            const totalLo = (bandK[0] * costRefMw * 1000 / 1_000_000).toFixed(0);
            const totalHi = (bandK[2] * costRefMw * 1000 / 1_000_000).toFixed(0);
            const omLo = (b.fixedOmPerKwYr * costRefMw * 1000 / 1_000_000).toFixed(1);

            return (
              <div key={k} className={`rounded-xl border p-4 ${meta.color}`}>
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xl">{meta.emoji}</span>
                  <div>
                    <p className="text-sm font-bold">{b.label}</p>
                    <p className="text-[10px] text-muted-foreground">{b.lifeYears}-year design life</p>
                  </div>
                </div>

                <div className="bg-background/60 rounded-lg px-3 py-2 mb-3">
                  <p className="text-[10px] text-muted-foreground mb-0.5">
                    All-in project cost (gross) — {costRefMw} MW
                  </p>
                  <p className="text-lg font-bold font-mono">${totalLo}M – ${totalHi}M</p>
                  <p className="text-[10px] text-muted-foreground">
                    ${bandK[0].toLocaleString()}–${bandK[2].toLocaleString()}/kW · base ${bandK[1].toLocaleString()}/kW
                  </p>
                </div>

                <div className="space-y-1.5 text-xs">
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-24 shrink-0 leading-snug">Fixed O&amp;M</span>
                    <span className="leading-snug">
                      ${b.fixedOmPerKwYr}/kW-yr (${omLo}M/yr at {costRefMw} MW)
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-24 shrink-0 leading-snug">Variable O&amp;M</span>
                    <span className="leading-snug">
                      {b.variableOmPerMwh === 0 ? "~$0/MWh (negligible)" : `$${b.variableOmPerMwh}/MWh`}
                      {b.heatRateGjPerMwh ? " + fuel + carbon (see Operating cost panel)" : ""}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-muted-foreground w-24 shrink-0 leading-snug">ITC</span>
                    <span className="leading-snug">
                      {b.itcEligible ? `${b.defaultItcPct}% Clean Technology ITC through 2033` : "Not eligible (gas)"}
                    </span>
                  </div>
                  {(["Land", "Interconnection", "Insurance", "Decommissioning"] as const).map((label) => (
                    <div key={label} className="flex gap-2">
                      <span className="text-muted-foreground w-24 shrink-0 leading-snug">{label}</span>
                      <span className="leading-snug flex items-center gap-1.5">
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-muted text-muted-foreground">
                          NOT SOURCED
                        </span>
                        <span className="text-muted-foreground">Alberta-specific figure not yet available</span>
                      </span>
                    </div>
                  ))}
                </div>

                <div className="mt-3 pt-3 border-t border-border/50">
                  <p className="text-[10px] text-muted-foreground leading-snug">
                    ▸ {b.refSize} · capacity factor {(b.capacityFactor * 100).toFixed(0)}% screening default
                  </p>
                </div>
              </div>
            );
          })}
        </div>

        <p className="mt-4 text-[10px] text-muted-foreground">
          CAPEX bands are screening ranges, not EPC quotes. Land, interconnection, insurance and
          decommissioning are deliberately left unfilled rather than estimated from non-Alberta
          benchmarks — get in touch if you have sourced figures for these four line items.
        </p>
      </div>

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
