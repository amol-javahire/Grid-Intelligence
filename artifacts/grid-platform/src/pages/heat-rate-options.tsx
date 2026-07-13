import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ResponsiveContainer, ReferenceLine,
  AreaChart, Area, Legend,
} from "recharts";
import { Sigma, Info, BookOpen, FlaskConical, Target } from "lucide-react";

// ── Bachelier (Normal) option model ──────────────────────────────────────────
// Industry-standard for spark spread options: handles negative forwards correctly.

function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

interface Greeks {
  premium: number;
  intrinsic: number;
  timeValue: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
}

function bachelierOption(
  F: number,        // forward spark spread $/MWh  (P − HR × G)
  K: number,        // strike (0 = at-the-money spread)
  sigAbs: number,   // annualised absolute vol $/MWh
  T: number,        // years to expiry
  r: number,        // risk-free rate (annual)
  isCall: boolean,
): Greeks {
  const intrinsic = isCall ? Math.max(0, F - K) : Math.max(0, K - F);

  if (T <= 0 || sigAbs <= 0) {
    return { premium: intrinsic, intrinsic, timeValue: 0,
      delta: intrinsic > 0 ? (isCall ? 1 : -1) : 0,
      gamma: 0, vega: 0, theta: 0, rho: 0 };
  }

  const sqrtT = Math.sqrt(T);
  const sigT  = sigAbs * sqrtT;
  const d     = (F - K) / sigT;
  const Nd    = normalCDF(d);
  const phiD  = normalPDF(d);
  const disc  = Math.exp(-r * T);

  const premium = isCall
    ? disc * ((F - K) * Nd + sigT * phiD)
    : disc * ((K - F) * normalCDF(-d) + sigT * phiD);

  const delta = isCall ? disc * Nd : -disc * normalCDF(-d);
  const gamma = disc * phiD / sigT;
  const vega  = disc * phiD * sqrtT;                   // per $1/MWh change in σ_abs
  const theta = (-sigAbs * disc * phiD / (2 * sqrtT) - r * premium) / 365;
  const rho   = -T * premium * 0.01;                   // per 1% change in r
  const timeValue = Math.max(0, premium - intrinsic * disc);

  return { premium, intrinsic, timeValue, delta, gamma, vega, theta, rho };
}

// ── Types ─────────────────────────────────────────────────────────────────────

type HubEntry = { da: number; rt: number; vol: number | null };
type MonthRow = { yearMonth: string; gasPriceMmbtu: number; hubs: Record<string, HubEntry> };
type MarketData = {
  hubs: string[];
  monthly: MonthRow[];
  hubVol: Record<string, number>;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const HUB_COLORS = ["#14b8a6","#f59e0b","#8b5cf6","#3b82f6","#ec4899","#10b981","#f97316"];
const STRIKE_HRS  = [6, 7, 8, 9, 10, 11, 12, 13];
const EXPIRY_COLS = [1, 3, 6, 12, 24, 36];
const TS = { backgroundColor:"#0f172a", borderColor:"#1e293b", color:"#f8fafc", fontSize:11 };

const fd = (n: number, dp = 2) =>
  (n >= 0 ? "$" : "-$") + Math.abs(n).toFixed(dp);
const clr = (v: number) => v >= 0 ? "text-emerald-400" : "text-red-400";

// ── Slider (standalone to avoid remount on every render) ─────────────────────

function RangeSlider({
  label, value, min, max, step, display, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  display: string; onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold text-foreground">{display}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full h-1.5 accent-teal-500 cursor-pointer"
      />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function HeatRateOptions() {
  const [hub,           setHub]           = useState("HB_NORTH");
  const [strikeHR,      setStrikeHR]      = useState(9.0);
  const [isCall,        setIsCall]        = useState(true);
  const [expiryMonths,  setExpiryMonths]  = useState(6);
  const [volumeMw,      setVolumeMw]      = useState(100);
  const [hoursPerDay,   setHoursPerDay]   = useState(16);
  const [useGasOvr,     setUseGasOvr]     = useState(false);
  const [gasOvr,        setGasOvr]        = useState(3.5);
  const [usePwrOvr,     setUsePwrOvr]     = useState(false);
  const [pwrOvr,        setPwrOvr]        = useState(55.0);
  const [useVolOvr,     setUseVolOvr]     = useState(false);
  const [volOvr,        setVolOvr]        = useState(15.0);
  const [rfr,           setRfr]           = useState(5.0);
  const [chartTab,      setChartTab]      = useState<"history"|"payoff"|"sensitivity">("history");

  const { data: mkt, isLoading } = useQuery<MarketData>({
    queryKey: ["heat-rate-options-data"],
    queryFn: () => fetch("/api/heat-rate-options/market-data").then(r => r.json()),
    staleTime: 300_000,
  });

  // Set hub to first available once data loads
  useEffect(() => {
    if (mkt?.hubs.length && !mkt.hubs.includes(hub)) setHub(mkt.hubs[0]);
  }, [mkt]);

  // ── Derived computations ────────────────────────────────────────────────────
  const derived = useMemo(() => {
    if (!mkt?.monthly.length) return null;

    const hubMonths = mkt.monthly.filter(m => m.hubs[hub]);
    if (!hubMonths.length) return null;
    const latest = hubMonths[hubMonths.length - 1];

    const latestGas   = latest.gasPriceMmbtu;
    const latestPower = latest.hubs[hub].da;
    const fwdGas      = useGasOvr ? gasOvr   : latestGas;
    const fwdPower    = usePwrOvr ? pwrOvr   : latestPower;
    const fwdSpread   = fwdPower - strikeHR * fwdGas;
    const baseVol     = mkt.hubVol[hub] ?? 15;
    const sigAbs      = useVolOvr ? volOvr   : baseVol;
    const T           = expiryMonths / 12;
    const r           = rfr / 100;

    const opt = bachelierOption(fwdSpread, 0, sigAbs, T, r, isCall);

    // Total contract $/value
    const contractMwh = volumeMw * hoursPerDay * 30.44 * expiryMonths;
    const totalPremium = opt.premium * contractMwh;

    // Historical spark-spread series for selected hub + HR
    const hist = hubMonths.map(m => ({
      month: m.yearMonth,
      gas: m.gasPriceMmbtu,
      power: m.hubs[hub].da,
      spread: Number((m.hubs[hub].da - strikeHR * m.gasPriceMmbtu).toFixed(2)),
      gasCost: Number((strikeHR * m.gasPriceMmbtu).toFixed(2)),
      intrinsic: Number(Math.max(0, m.hubs[hub].da - strikeHR * m.gasPriceMmbtu).toFixed(2)),
    }));

    // All-hub spreads for the comparison chart
    const allHubSpreads = mkt.monthly.map(m => {
      const row: Record<string, number | string> = { month: m.yearMonth };
      for (const h of mkt.hubs) {
        if (m.hubs[h]) row[h] = Number((m.hubs[h].da - strikeHR * m.gasPriceMmbtu).toFixed(2));
      }
      return row;
    });

    // Payoff profile (vs terminal power price)
    const pMin = Math.max(5, fwdPower * 0.35);
    const pMax = fwdPower * 1.85;
    const payoff = Array.from({ length: 80 }, (_, i) => {
      const p  = pMin + (pMax - pMin) * (i / 79);
      const ss = p - strikeHR * fwdGas;
      const pay = isCall ? Math.max(0, ss) : Math.max(0, -ss);
      return {
        power:  Number(p.toFixed(1)),
        payoff: Number(pay.toFixed(2)),
        netPL:  Number((pay - opt.premium).toFixed(2)),
      };
    });

    // Sensitivity: option value vs gas price
    const sensByGas = Array.from({ length: 72 }, (_, i) => {
      const g = 1.0 + i * 0.1;
      const fs = fwdPower - strikeHR * g;
      return {
        gas:   Number(g.toFixed(1)),
        value: Number(bachelierOption(fs, 0, sigAbs, T, r, isCall).premium.toFixed(2)),
      };
    });

    // Heat-rate matrix
    type MatrixRow = { hr: number; fwdSpread: number; [key: string]: number };
    const hrMatrix: MatrixRow[] = STRIKE_HRS.map(hr => {
      const fs = fwdPower - hr * fwdGas;
      const cols: Record<string, number> = {};
      for (const exp of EXPIRY_COLS) {
        const v = bachelierOption(fs, 0, sigAbs, exp / 12, r, isCall);
        cols[`${exp}M`] = Number(v.premium.toFixed(2));
      }
      return { hr, fwdSpread: Number(fs.toFixed(2)), ...cols };
    });

    const breakeven = isCall
      ? strikeHR * fwdGas + opt.premium
      : strikeHR * fwdGas - opt.premium;

    return {
      latestGas, latestPower, fwdGas, fwdPower,
      fwdSpread, sigAbs, opt, contractMwh, totalPremium,
      hist, allHubSpreads, payoff, sensByGas, hrMatrix,
      latestMonth: latest.yearMonth, baseVol, breakeven,
      impliedVolPct: fwdSpread !== 0 ? (sigAbs / Math.abs(fwdSpread) * 100) : null,
    };
  }, [mkt, hub, strikeHR, isCall, expiryMonths, volumeMw, hoursPerDay,
      useGasOvr, gasOvr, usePwrOvr, pwrOvr, useVolOvr, volOvr, rfr]);

  // ── Render ──────────────────────────────────────────────────────────────────

  if (isLoading) return (
    <div className="h-full flex items-center justify-center">
      <div className="h-8 w-8 rounded-full border-2 border-teal-500 border-t-transparent animate-spin" />
    </div>
  );
  if (!mkt) return <div className="p-6 text-muted-foreground">No market data.</div>;

  return (
    <div className="h-full flex overflow-hidden">

      {/* ── Left control panel ───────────────────────────────────────────── */}
      <aside className="w-72 shrink-0 border-r border-border bg-card overflow-y-auto">
        <div className="p-4 space-y-4">

          {/* Title */}
          <div>
            <div className="flex items-center gap-2">
              <Sigma className="h-4 w-4 text-amber-400" />
              <span className="text-sm font-semibold">Option Parameters</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">Bachelier normal spread model</p>
          </div>

          {/* Hub */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">ERCOT Hub (underlying)</label>
            <select
              value={hub} onChange={e => setHub(e.target.value)}
              className="w-full text-sm bg-background border border-border rounded-md px-2 py-1.5"
            >
              {mkt.hubs.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
          </div>

          {/* Call / Put */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Option Type</label>
            <div className="flex gap-2">
              {([["Call", true], ["Put", false]] as const).map(([label, val]) => (
                <button
                  key={label}
                  onClick={() => setIsCall(val)}
                  className={`flex-1 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                    isCall === val
                      ? val ? "bg-emerald-600 text-white border-emerald-600"
                             : "bg-red-600 text-white border-red-600"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Strike HR */}
          <RangeSlider
            label="Strike Heat Rate"
            value={strikeHR} min={6} max={14} step={0.5}
            display={`${strikeHR.toFixed(1)} MMBtu/MWh`}
            onChange={setStrikeHR}
          />

          {/* Expiry */}
          <RangeSlider
            label="Expiry"
            value={expiryMonths} min={1} max={36} step={1}
            display={`${expiryMonths}M`}
            onChange={setExpiryMonths}
          />

          {/* Volume */}
          <RangeSlider
            label="Volume"
            value={volumeMw} min={10} max={500} step={10}
            display={`${volumeMw} MW`}
            onChange={setVolumeMw}
          />

          {/* Hours/day */}
          <RangeSlider
            label="Hours / Day (contract)"
            value={hoursPerDay} min={8} max={24} step={1}
            display={`${hoursPerDay}h (${hoursPerDay === 24 ? "flat" : hoursPerDay === 16 ? "on-peak" : "custom"})`}
            onChange={setHoursPerDay}
          />

          <div className="border-t border-border/60 pt-3 space-y-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Market Overrides</p>

            {/* Gas override */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Gas Price (Henry Hub)</span>
                <button
                  onClick={() => setUseGasOvr(!useGasOvr)}
                  className={`text-xs px-1.5 py-0.5 rounded border transition-colors ${
                    useGasOvr ? "bg-amber-500/20 text-amber-300 border-amber-500/30" : "border-border text-muted-foreground"
                  }`}
                >{useGasOvr ? "Override" : "Live"}</button>
              </div>
              {useGasOvr
                ? <RangeSlider label="" value={gasOvr} min={1} max={10} step={0.1}
                    display={`$${gasOvr.toFixed(2)}/MMBtu`} onChange={setGasOvr} />
                : <div className="text-sm font-semibold text-teal-400">
                    ${derived?.latestGas.toFixed(3)}/MMBtu
                    <span className="text-xs text-muted-foreground font-normal ml-1">({derived?.latestMonth})</span>
                  </div>
              }
            </div>

            {/* Power override */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Power Price ({hub})</span>
                <button
                  onClick={() => setUsePwrOvr(!usePwrOvr)}
                  className={`text-xs px-1.5 py-0.5 rounded border transition-colors ${
                    usePwrOvr ? "bg-amber-500/20 text-amber-300 border-amber-500/30" : "border-border text-muted-foreground"
                  }`}
                >{usePwrOvr ? "Override" : "Live"}</button>
              </div>
              {usePwrOvr
                ? <RangeSlider label="" value={pwrOvr} min={10} max={150} step={1}
                    display={`$${pwrOvr.toFixed(0)}/MWh`} onChange={setPwrOvr} />
                : <div className="text-sm font-semibold text-teal-400">
                    ${derived?.latestPower.toFixed(2)}/MWh
                    <span className="text-xs text-muted-foreground font-normal ml-1">(DA avg)</span>
                  </div>
              }
            </div>

            {/* Vol override */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Spark Spread Vol (σ)</span>
                <button
                  onClick={() => setUseVolOvr(!useVolOvr)}
                  className={`text-xs px-1.5 py-0.5 rounded border transition-colors ${
                    useVolOvr ? "bg-amber-500/20 text-amber-300 border-amber-500/30" : "border-border text-muted-foreground"
                  }`}
                >{useVolOvr ? "Override" : "Historical"}</button>
              </div>
              {useVolOvr
                ? <RangeSlider label="" value={volOvr} min={1} max={60} step={0.5}
                    display={`$${volOvr.toFixed(1)}/MWh ann.`} onChange={setVolOvr} />
                : <div className="text-sm font-semibold text-blue-400">
                    ${derived?.sigAbs.toFixed(2)}/MWh ann.
                    {derived?.impliedVolPct != null &&
                      <span className="text-xs text-muted-foreground font-normal ml-1">
                        (~{derived.impliedVolPct.toFixed(0)}% impl.)
                      </span>}
                  </div>
              }
            </div>

            {/* Risk-free rate */}
            <RangeSlider
              label="Risk-Free Rate"
              value={rfr} min={0} max={10} step={0.25}
              display={`${rfr.toFixed(2)}%`}
              onChange={setRfr}
            />
          </div>

          {/* Explainer */}
          <div className="border-t border-border/60 pt-3">
            <div className="flex items-start gap-2 bg-blue-500/5 border border-blue-500/20 rounded-md p-3">
              <Info className="h-3.5 w-3.5 text-blue-400 mt-0.5 shrink-0" />
              <p className="text-xs text-muted-foreground leading-relaxed">
                <strong className="text-blue-300">Heat rate option</strong>: right to convert gas→power
                at the strike heat rate. Call = long spark spread exposure. Used by
                peaker operators, gas marketers, and power traders to hedge tolling
                margins. The Bachelier model handles negative spark spreads correctly.
              </p>
            </div>
          </div>
        </div>
      </aside>

      {/* ── Right main area ──────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-6">

          {/* Page header */}
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Sigma className="h-5 w-5 text-amber-400" />
              <h1 className="text-2xl font-bold">Heat Rate Options</h1>
              <Badge variant="outline" className="text-xs text-emerald-400 border-emerald-400/30">
                ERCOT · Real Data
              </Badge>
              <Badge variant="outline" className="text-xs text-blue-400 border-blue-400/30">
                Bachelier Normal Model
              </Badge>
            </div>
            <p className="text-muted-foreground text-sm max-w-3xl">
              Price the right to convert natural gas into electricity at a specified heat rate.
              Payoff = max(0, Power − HR × Gas). Widely used by gas marketers, peaker operators,
              and power traders (e.g. TC Energy, Constellation, NRG) to hedge tolling margins and
              spark spread exposure in ERCOT.
            </p>
          </div>

          {!derived ? (
            <div className="text-muted-foreground text-sm">No data for selected hub.</div>
          ) : (
          <>

          {/* KPI cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="pb-1 pt-4 px-4">
                <CardDescription className="text-xs">Forward Spark Spread</CardDescription>
              </CardHeader>
              <CardContent className="pb-4 px-4">
                <div className={`text-3xl font-bold ${clr(derived.fwdSpread)}`}>
                  {fd(derived.fwdSpread)}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Power − {strikeHR.toFixed(1)} × Gas · /MWh
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-1 pt-4 px-4">
                <CardDescription className="text-xs">Option Premium</CardDescription>
              </CardHeader>
              <CardContent className="pb-4 px-4">
                <div className="text-3xl font-bold text-teal-400">
                  {fd(derived.opt.premium)}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  per MWh · {expiryMonths}M · {isCall ? "Call" : "Put"}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-1 pt-4 px-4">
                <CardDescription className="text-xs">Intrinsic / Time Value</CardDescription>
              </CardHeader>
              <CardContent className="pb-4 px-4">
                <div className="text-xl font-bold flex items-baseline gap-1">
                  <span className="text-emerald-400">{fd(derived.opt.intrinsic)}</span>
                  <span className="text-muted-foreground text-base">/</span>
                  <span className="text-blue-400">{fd(derived.opt.timeValue)}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  intrinsic / time · per MWh
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-1 pt-4 px-4">
                <CardDescription className="text-xs">Total Contract Value</CardDescription>
              </CardHeader>
              <CardContent className="pb-4 px-4">
                <div className="text-2xl font-bold text-purple-400">
                  ${(Math.abs(derived.totalPremium) / 1000).toFixed(0)}K
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {volumeMw}MW × {hoursPerDay}h × {expiryMonths}M
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Chart section */}
          <Card>
            <CardHeader className="pb-1">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <CardTitle className="text-sm">Market Analysis</CardTitle>
                <div className="flex gap-1">
                  {([
                    ["history",     "Spark Spread History"],
                    ["payoff",      "Payoff Profile"],
                    ["sensitivity", "Gas Sensitivity"],
                  ] as const).map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => setChartTab(id)}
                      className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
                        chartTab === id
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {chartTab === "history" && (
                <CardDescription className="text-xs">
                  Spark spread at HR={strikeHR.toFixed(1)} for all ERCOT hubs · selected hub highlighted
                </CardDescription>
              )}
              {chartTab === "payoff" && (
                <CardDescription className="text-xs">
                  Payoff at expiry vs terminal power price · gas held flat at ${derived.fwdGas.toFixed(3)}/MMBtu
                </CardDescription>
              )}
              {chartTab === "sensitivity" && (
                <CardDescription className="text-xs">
                  Option premium vs Henry Hub gas price · power held flat at ${derived.fwdPower.toFixed(2)}/MWh
                </CardDescription>
              )}
            </CardHeader>
            <CardContent style={{ height: 280 }} className="pt-2">

              {/* History */}
              {chartTab === "history" && (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={derived.allHubSpreads} margin={{ top:4, right:16, left:0, bottom:0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e2d3e" vertical={false} />
                    <XAxis dataKey="month" stroke="#64748b" tick={{ fill:"#64748b", fontSize:10 }} interval={3} />
                    <YAxis stroke="#64748b" tick={{ fill:"#64748b", fontSize:10 }} width={50}
                      tickFormatter={v => `$${v}`} />
                    <RTooltip contentStyle={TS} formatter={(v: number, n: string) => [`$${v.toFixed(2)}/MWh`, n]} />
                    <ReferenceLine y={0} stroke="#475569" strokeDasharray="4 4" />
                    <Legend wrapperStyle={{ fontSize:11 }} />
                    {mkt.hubs.map((h, i) => (
                      <Line key={h} dataKey={h} name={h}
                        stroke={HUB_COLORS[i % HUB_COLORS.length]}
                        strokeWidth={h === hub ? 2.5 : 1}
                        strokeOpacity={h === hub ? 1 : 0.35}
                        dot={false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              )}

              {/* Payoff */}
              {chartTab === "payoff" && (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={derived.payoff} margin={{ top:4, right:16, left:0, bottom:16 }}>
                    <defs>
                      <linearGradient id="gPay" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#14b8a6" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#14b8a6" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gPL" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#f59e0b" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e2d3e" vertical={false} />
                    <XAxis dataKey="power" type="number" domain={["dataMin","dataMax"]}
                      stroke="#64748b" tick={{ fill:"#64748b", fontSize:10 }}
                      tickFormatter={v => `$${Number(v).toFixed(0)}`}
                      label={{ value:"Power Price ($/MWh)", position:"insideBottom", offset:-8, fill:"#64748b", fontSize:10 }} />
                    <YAxis stroke="#64748b" tick={{ fill:"#64748b", fontSize:10 }} width={50}
                      tickFormatter={v => `$${Number(v).toFixed(0)}`} />
                    <RTooltip contentStyle={TS}
                      formatter={(v: number, n: string) => [`$${v.toFixed(2)}/MWh`, n]} />
                    <ReferenceLine x={derived.fwdPower}
                      stroke="#8b5cf6" strokeDasharray="4 4"
                      label={{ value:"Fwd", position:"top", fill:"#8b5cf6", fontSize:9 }} />
                    <ReferenceLine x={derived.breakeven}
                      stroke="#f59e0b" strokeDasharray="3 3"
                      label={{ value:"B/E", position:"insideTopRight", fill:"#f59e0b", fontSize:9 }} />
                    <ReferenceLine y={0} stroke="#475569" />
                    <Area dataKey="payoff" name="Payoff at expiry"
                      stroke="#14b8a6" fill="url(#gPay)" dot={false} strokeWidth={2} />
                    <Area dataKey="netPL"  name="Net P&L (after premium)"
                      stroke="#f59e0b" fill="url(#gPL)" dot={false} strokeWidth={2} strokeDasharray="5 3" />
                    <Legend wrapperStyle={{ fontSize:11 }} />
                  </AreaChart>
                </ResponsiveContainer>
              )}

              {/* Sensitivity */}
              {chartTab === "sensitivity" && (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={derived.sensByGas} margin={{ top:4, right:16, left:0, bottom:16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e2d3e" vertical={false} />
                    <XAxis dataKey="gas" type="number" domain={[1, 8]}
                      stroke="#64748b" tick={{ fill:"#64748b", fontSize:10 }}
                      tickFormatter={v => `$${Number(v).toFixed(1)}`}
                      label={{ value:"Henry Hub Gas Price ($/MMBtu)", position:"insideBottom", offset:-8, fill:"#64748b", fontSize:10 }} />
                    <YAxis stroke="#64748b" tick={{ fill:"#64748b", fontSize:10 }} width={50}
                      tickFormatter={v => `$${Number(v).toFixed(1)}`} />
                    <RTooltip contentStyle={TS}
                      formatter={(v: number) => [`$${v.toFixed(2)}/MWh`, "Option value"]} />
                    <ReferenceLine x={derived.fwdGas}
                      stroke="#8b5cf6" strokeDasharray="4 4"
                      label={{ value:"Current gas", position:"top", fill:"#8b5cf6", fontSize:9 }} />
                    <Line dataKey="value" name={`${isCall?"Call":"Put"} premium (HR=${strikeHR.toFixed(1)})`}
                      stroke="#14b8a6" dot={false} strokeWidth={2.5} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Greeks + Market Context */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

            {/* Greeks */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Option Greeks</CardTitle>
                <CardDescription className="text-xs">
                  Bachelier model sensitivities at current inputs
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-0.5">
                <table className="w-full text-sm">
                  <tbody>
                    {[
                      {
                        g: "Delta (Δ)",
                        v: derived.opt.delta.toFixed(4),
                        desc: "Premium change per $1 spark spread move",
                        c: derived.opt.delta >= 0 ? "text-emerald-400" : "text-red-400",
                      },
                      {
                        g: "Gamma (Γ)",
                        v: derived.opt.gamma.toFixed(6),
                        desc: "Delta change per $1 move (convexity)",
                        c: "text-blue-400",
                      },
                      {
                        g: "Vega (ν)",
                        v: `$${derived.opt.vega.toFixed(4)}`,
                        desc: "$/MWh per $1/MWh change in σ_abs",
                        c: "text-purple-400",
                      },
                      {
                        g: "Theta (Θ)",
                        v: `${fd(derived.opt.theta)}/day`,
                        desc: "Time decay per calendar day",
                        c: "text-amber-400",
                      },
                      {
                        g: "Rho (ρ)",
                        v: `${fd(derived.opt.rho)}`,
                        desc: "Premium change per 1% rate move",
                        c: "text-slate-400",
                      },
                    ].map(row => (
                      <tr key={row.g} className="border-b border-border/30 last:border-0">
                        <td className="py-2 pr-2 text-xs text-muted-foreground w-24 font-medium">{row.g}</td>
                        <td className={`py-2 pr-3 font-mono font-semibold text-sm ${row.c}`}>{row.v}</td>
                        <td className="py-2 text-xs text-muted-foreground/70">{row.desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="pt-2 space-y-1 text-xs text-muted-foreground/70 border-t border-border/30 mt-1">
                  <div>Breakeven power price:{" "}
                    <span className="text-amber-400 font-medium">${derived.breakeven.toFixed(2)}/MWh</span>
                  </div>
                  <div>Gas cost to generate:{" "}
                    <span className="text-foreground/80">${(strikeHR * derived.fwdGas).toFixed(2)}/MWh</span>
                    {" "}at HR={strikeHR.toFixed(1)}
                  </div>
                  <div>σ_abs (annualised):{" "}
                    <span className="text-blue-400 font-medium">${derived.sigAbs.toFixed(2)}/MWh</span>
                    {" · "}{derived.hist.length} months sample
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Market Context */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Market Context — {hub}</CardTitle>
                <CardDescription className="text-xs">
                  Current inputs and moneyness assessment
                </CardDescription>
              </CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <tbody>
                    {[
                      {
                        label: "Gas price",
                        val: `$${derived.fwdGas.toFixed(3)}/MMBtu`,
                        note: useGasOvr ? "manual override" : "Henry Hub latest",
                      },
                      {
                        label: `Power price (${hub} DA)`,
                        val: `$${derived.fwdPower.toFixed(2)}/MWh`,
                        note: usePwrOvr ? "manual override" : "latest monthly avg",
                      },
                      {
                        label: `Spark spread @ HR=${strikeHR.toFixed(1)}`,
                        val: fd(derived.fwdSpread),
                        note: derived.fwdSpread > 0 ? "in the money" : "out of the money",
                      },
                      {
                        label: "Moneyness",
                        val: derived.fwdSpread > 5 ? "Deep ITM" :
                             derived.fwdSpread > 0 ? "In the Money (ITM)" :
                             derived.fwdSpread > -5 ? "Out of the Money (OTM)" : "Deep OTM",
                        note: `|spread| = $${Math.abs(derived.fwdSpread).toFixed(2)}/MWh`,
                      },
                      {
                        label: "Historical σ_abs (HR=9)",
                        val: `$${derived.baseVol.toFixed(2)}/MWh ann.`,
                        note: `${derived.hist.length}-month sample`,
                      },
                      {
                        label: "Contract volume (MWh)",
                        val: derived.contractMwh.toLocaleString(undefined, { maximumFractionDigits: 0 }),
                        note: `${volumeMw}MW × ${hoursPerDay}h × ${expiryMonths}M`,
                      },
                    ].map(row => (
                      <tr key={row.label} className="border-b border-border/30 last:border-0">
                        <td className="py-1.5 pr-3 text-xs text-muted-foreground">{row.label}</td>
                        <td className={`py-1.5 pr-3 font-semibold text-sm ${clr(0)}`}
                          style={{ color: "#14b8a6" }}>{row.val}</td>
                        <td className="py-1.5 text-xs text-muted-foreground/60">{row.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>

          {/* Heat Rate Matrix */}
          <div>
            <div className="mb-2">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Heat Rate Option Matrix — Premium ($/MWh)
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isCall ? "Call" : "Put"} premiums at different strike heat rates (rows) × expiries (columns).
                Power = ${derived.fwdPower.toFixed(2)} · Gas = ${derived.fwdGas.toFixed(3)} · σ = ${derived.sigAbs.toFixed(2)}/MWh
                · Click a row to select that strike HR.
              </p>
            </div>
            <div className="border rounded-md overflow-auto bg-card">
              <table className="w-full text-xs min-w-[600px]">
                <thead>
                  <tr className="border-b border-border text-muted-foreground bg-muted/10">
                    <th className="px-3 py-2 text-left">Strike HR</th>
                    <th className="px-3 py-2 text-left">Fwd Spread</th>
                    <th className="px-3 py-2 text-left">Moneyness</th>
                    {EXPIRY_COLS.map(m => (
                      <th key={m} className={`px-3 py-2 text-right ${expiryMonths === m ? "text-teal-400" : ""}`}>
                        {m}M
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {derived.hrMatrix.map(row => {
                    const isSel = Math.abs(row.hr - strikeHR) < 0.01;
                    const rowSpread = row.fwdSpread;
                    return (
                      <tr
                        key={row.hr}
                        onClick={() => setStrikeHR(row.hr)}
                        className={`border-b border-border/40 cursor-pointer transition-colors ${
                          isSel ? "bg-teal-500/10" : "hover:bg-muted/20"
                        }`}
                      >
                        <td className="px-3 py-1.5 font-mono font-semibold">
                          {row.hr.toFixed(0)}
                          <span className="text-muted-foreground font-normal text-xs ml-1">MMBtu/MWh</span>
                        </td>
                        <td className={`px-3 py-1.5 font-mono ${clr(rowSpread)}`}>
                          {fd(rowSpread)}
                        </td>
                        <td className="px-3 py-1.5">
                          <Badge variant="outline" className={`text-xs ${
                            rowSpread > 5  ? "text-emerald-400 border-emerald-400/30" :
                            rowSpread > 0  ? "text-teal-400 border-teal-400/30" :
                            rowSpread > -5 ? "text-amber-400 border-amber-400/30" :
                                            "text-red-400 border-red-400/30"
                          }`}>
                            {rowSpread > 5 ? "Deep ITM" : rowSpread > 0 ? "ITM" : rowSpread > -5 ? "OTM" : "Deep OTM"}
                          </Badge>
                        </td>
                        {EXPIRY_COLS.map(m => {
                          const val = row[`${m}M`] as number;
                          const highlighted = isSel && expiryMonths === m;
                          return (
                            <td key={m} className={`px-3 py-1.5 text-right font-mono ${
                              highlighted ? "text-teal-300 font-bold" : "text-foreground/80"
                            }`}>
                              {val > 0.005 ? `$${val.toFixed(2)}` : "< $0.01"}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">
              Higher strike HR → plant less efficient → smaller spark spread → lower call premium.
              Highlighted cell = current selection. ITM = in the money (spark spread &gt; 0).
            </p>
          </div>

          {/* Historical data table */}
          <div>
            <div className="mb-2">
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Historical Monthly Spark Spread — {hub}
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Realized spark spreads at HR={strikeHR.toFixed(1)} · Intrinsic value = max(0, spread)
              </p>
            </div>
            <div className="border rounded-md overflow-auto bg-card" style={{ maxHeight: 340 }}>
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card shadow-sm">
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="px-3 py-2 text-left">Month</th>
                    <th className="px-3 py-2 text-right">Gas $/MMBtu</th>
                    <th className="px-3 py-2 text-right">Power DA $/MWh</th>
                    <th className="px-3 py-2 text-right">Gas Cost $/MWh</th>
                    <th className="px-3 py-2 text-right">Spark Spread</th>
                    <th className="px-3 py-2 text-right">Intrinsic Value</th>
                  </tr>
                </thead>
                <tbody>
                  {[...derived.hist].reverse().map(r => (
                    <tr key={r.month} className="border-b border-border/40 hover:bg-muted/20">
                      <td className="px-3 py-1.5 font-medium">{r.month}</td>
                      <td className="px-3 py-1.5 text-right text-muted-foreground">
                        ${r.gas.toFixed(3)}
                      </td>
                      <td className="px-3 py-1.5 text-right">${r.power.toFixed(2)}</td>
                      <td className="px-3 py-1.5 text-right text-muted-foreground">
                        ${r.gasCost.toFixed(2)}
                      </td>
                      <td className={`px-3 py-1.5 text-right font-mono ${clr(r.spread)}`}>
                        {fd(r.spread)}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {r.intrinsic > 0
                          ? <span className="text-emerald-400 font-mono">${r.intrinsic.toFixed(2)}</span>
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">
              Data: Henry Hub (FRED DHHNGSP) + ERCOT {hub} DA price (CDR Report 13060). Monthly averages.
            </p>
          </div>

          {/* ── Methodology section ─────────────────────────────────────── */}
          <div className="space-y-4 pt-2">

            {/* Data sources note */}
            <div className="bg-slate-800/30 border border-slate-700/30 rounded-xl p-4">
              <div className="flex items-start gap-2">
                <Info className="h-4 w-4 text-slate-500 mt-0.5 shrink-0" />
                <p className="text-xs text-slate-500 leading-relaxed">
                  <strong className="text-slate-400">Data sources:</strong>{" "}
                  Gas prices from FRED DHHNGSP (Henry Hub daily spot, Federal Reserve Bank of St. Louis — public,
                  no key). Power prices from ERCOT CDR Report 13060 (DA hub prices — DAMLZHBSPP annual XLSX files,
                  public, no auth required). Both datasets are updated monthly; the vol estimate uses all available
                  months from January 2024 onward. Spark-spread volatility σ_abs is computed as the annualised
                  standard deviation of monthly first-differences of (P&nbsp;−&nbsp;HR×G) at HR=9, in $/MWh — this
                  is the correct input to the Bachelier model (not log-returns, since spreads can go negative).
                </p>
              </div>
            </div>

            {/* 3-column explainer */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

              {/* What This Does */}
              <Card className="bg-slate-800/50 border-slate-700/50">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-1.5 text-slate-100">
                    <BookOpen className="h-4 w-4 text-amber-400" />
                    What This Tool Does
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-slate-400 space-y-2">
                  <p>
                    Prices <span className="text-slate-200 font-medium">heat rate call and put options</span> — the
                    right (not obligation) to convert natural gas into electricity at a specified heat rate.
                    Payoff = max(0, P&nbsp;−&nbsp;HR&nbsp;×&nbsp;G) for a call. These are the standard instrument
                    used to value and hedge <span className="text-slate-200 font-medium">tolling agreements</span>,
                    peaker plant operating margins, and structured gas-power basis risk.
                  </p>
                  <p>
                    The pricer uses the <span className="text-slate-200 font-medium">Bachelier (normal) model</span>,
                    the industry standard for spread options. Unlike Black-Scholes, Bachelier assumes normally
                    distributed absolute price changes (not log-returns), which correctly handles the case where
                    the spark spread is negative — common during periods of high gas prices or low power demand.
                  </p>
                  <p>
                    All five Greeks (Δ, Γ, ν, Θ, ρ) are computed analytically from the closed-form Bachelier
                    solution. The heat rate matrix shows premiums across 8 strike heat rates × 6 expiries at a glance.
                  </p>
                </CardContent>
              </Card>

              {/* Use Cases */}
              <Card className="bg-slate-800/50 border-slate-700/50">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-1.5 text-slate-100">
                    <Target className="h-4 w-4 text-teal-400" />
                    Use Cases
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-slate-400 space-y-0">
                  <ul className="space-y-2 list-none">
                    {[
                      ["Gas Marketer / Midstream", "Price a tolling agreement on an ERCOT peaker. Set strike HR to the plant's design heat rate, expiry to the contract term, volume to the facility's MW capacity. The call premium is the fair-value toll."],
                      ["Peaker Operator / IPP", "Stress-test your plant margin under different gas and power scenarios. Toggle the gas/power overrides to model $5 gas + $40 power vs $2.50 gas + $60 power — compare option values and Greeks."],
                      ["Power Trader (Corp. Desk)", "Replicate a real option embedded in a PPA or capacity contract. The payoff profile chart shows where you need the spark spread to settle to cover the premium cost."],
                      ["Walmart Energy Procurement", "Assess the incremental option value of a tolling/capacity payment in a supply contract. Compare the intrinsic value (current spark spread × volume) against the time value paid — i.e., how much you're paying for optionality."],
                      ["Structurer / Quant", "Read off delta-hedging ratios for a portfolio of heat rate options across multiple ERCOT hubs. The heat rate matrix gives a full premium surface to calibrate an internal vol model."],
                    ].map(([role, desc]) => (
                      <li key={role} className="border-l-2 border-teal-500/30 pl-2 pb-2 last:pb-0">
                        <p className="text-slate-200 font-medium leading-tight">{role}</p>
                        <p className="text-slate-400 mt-0.5">{desc}</p>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>

              {/* Key Assumptions & Formulas */}
              <Card className="bg-slate-800/50 border-slate-700/50">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-1.5 text-slate-100">
                    <FlaskConical className="h-4 w-4 text-purple-400" />
                    Key Assumptions & Formulas
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-xs text-slate-400 space-y-2">
                  <div>
                    <p className="text-slate-200 font-medium mb-1">Bachelier Call Formula</p>
                    <p className="font-mono text-slate-300 bg-slate-900/60 rounded px-2 py-1.5 text-[11px] leading-snug">
                      C = e<sup>−rT</sup> [ F·Φ(d) + σ√T·φ(d) ]<br />
                      d = F / (σ√T)<br />
                      F = fwdPower − strikeHR × fwdGas
                    </p>
                    <p className="text-slate-500 mt-1">
                      Where σ is absolute vol ($/MWh ann.), Φ = normal CDF, φ = normal PDF, K=0 (ATM spread).
                    </p>
                  </div>
                  {[
                    ["Spread forward (F)", "Latest month's avg DA hub price minus (strikeHR × Henry Hub spot). No term structure — flat curve assumed unless overridden."],
                    ["Volatility (σ_abs)", "Annualised std dev of monthly Δ(P − 9×G) in $/MWh, computed from Jan 2024 onward. Base estimate at HR=9; scales with the same σ regardless of chosen HR (reasonable approximation for nearby strikes)."],
                    ["Expiry (T)", "Time in years = months ÷ 12. Settlement assumed at end of period — no path dependency."],
                    ["Contract volume", "MW × hours/day × (30.44 days/month) × months. On-peak = 16h/day, flat = 24h/day."],
                    ["No conveyance cost", "Transmission, line losses, imbalance, and scheduling fees are excluded. All prices are hub-level DA averages."],
                    ["Black-Scholes vs Bachelier", "B-S underprices OTM spread options when spreads can go negative. Bachelier is preferred by ISDA for spark/dark/quark spread options and commodity crack spreads."],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <span className="text-slate-200 font-medium">{k}: </span>
                      <span>{v}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>

            </div>
          </div>

          </>
          )}
        </div>
      </div>
    </div>
  );
}
