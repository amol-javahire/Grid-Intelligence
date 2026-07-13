import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Loader2, TrendingUp, Zap, DollarSign, Layers, AlertTriangle, BookOpen, Target, FlaskConical } from "lucide-react";
import { useState } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
  Tooltip as RechartsTooltip, Legend,
} from "recharts";

const BASE = "/pypsa";
const TS = { backgroundColor: "#0f172a", borderColor: "#1e293b", color: "#f8fafc", fontSize: 11 };

const CARRIER_COLORS: Record<string, string> = {
  wind: "#14b8a6",
  solar: "#f59e0b",
  gas_cc: "#8b5cf6",
  gas_ct: "#ef4444",
  storage: "#3b82f6",
  hydro: "#0ea5e9",
  nuclear: "#a3e635",
  biomass: "#84cc16",
};

const CARRIER_LABELS: Record<string, string> = {
  wind: "Wind",
  solar: "Solar",
  gas_cc: "Gas CC",
  gas_ct: "Gas CT (peaker)",
  storage: "Storage",
  hydro: "Hydro",
  nuclear: "Nuclear",
  biomass: "Biomass",
};

const CARRIER_ORDER = ["nuclear", "hydro", "biomass", "gas_cc", "gas_ct", "wind", "solar", "storage"];

interface ExpansionResult {
  periods: number[];
  demand_scenario: string;
  system_peak_by_period_mw: Record<string, number>;
  new_builds_by_period_mw: Record<string, Record<string, number>>;
  cumulative_capacity_mix_mw: Record<string, Record<string, number>>;
  capex_by_period_usd: Record<string, number>;
  dispatch_by_period_mwh: Record<string, Record<string, number>>;
  unserved_energy_by_period_mwh: Record<string, number>;
  unserved_energy_pct_by_period: Record<string, number>;
  avg_lmp_by_period: Record<string, number | null>;
  total_discounted_system_cost_usd: number | null;
  assumptions: {
    wacc: number;
    target_reserve_margin: number;
    voll_usd_per_mwh: number;
    capital_costs_source: string;
    accreditation_source: string;
    demand_source: string;
  };
}

function fmtUsd(v: number) {
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${v.toLocaleString()}`;
}

export default function PypsaExpansion() {
  const [scenario, setScenario] = useState<"moderate" | "aggressive">("moderate");
  const [gasPrice, setGasPrice] = useState(350);
  const [dirty, setDirty] = useState(false);
  const [result, setResult] = useState<ExpansionResult | null>(null);

  const mut = useMutation({
    mutationFn: (params: object) =>
      fetch(`${BASE}/expansion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      }).then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.detail || `HTTP ${r.status}`);
        }
        return r.json();
      }),
    onSuccess: (data) => { setResult(data); setDirty(false); },
  });

  function runSim() {
    mut.mutate({
      periods: [2026, 2028, 2030, 2032],
      demand_scenario: scenario,
      gas_price_mmbtu: gasPrice / 100,
    });
  }

  const buildData = result
    ? result.periods.map((p) => {
        const d = result.new_builds_by_period_mw[String(p)] || {};
        return { period: String(p), ...d };
      })
    : [];

  const mixData = result
    ? result.periods.map((p) => {
        const d = result.cumulative_capacity_mix_mw[String(p)] || {};
        return { period: String(p), ...d };
      })
    : [];

  const lmpData = result
    ? result.periods.map((p) => ({
        period: String(p),
        lmp: result.avg_lmp_by_period[String(p)] ?? 0,
        peak: result.system_peak_by_period_mw[String(p)] ?? 0,
        unservedPct: result.unserved_energy_pct_by_period[String(p)] ?? 0,
      }))
    : [];

  const maxUnservedPct = result
    ? Math.max(0, ...Object.values(result.unserved_energy_pct_by_period))
    : 0;
  const hasUnserved = maxUnservedPct > 0;

  const capexData = result
    ? result.periods.map((p) => ({
        period: String(p),
        capex: result.capex_by_period_usd[String(p)] ?? 0,
      }))
    : [];

  const totalCapex = result
    ? Object.values(result.capex_by_period_usd).reduce((a, b) => a + b, 0)
    : 0;

  const finalPeriod = result ? result.periods[result.periods.length - 1] : null;
  const finalLmp = result && finalPeriod ? result.avg_lmp_by_period[String(finalPeriod)] : null;
  const finalUnservedPct = result && finalPeriod ? result.unserved_energy_pct_by_period[String(finalPeriod)] : null;
  const finalUnservedMwh = result && finalPeriod ? result.unserved_energy_by_period_mwh[String(finalPeriod)] : null;

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Layers className="h-6 w-6 text-teal-400" />
            Multi-Year Capacity Expansion Optimizer
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            PyPSA multi-investment-period LP · least-cost build-out of wind, solar, storage, and gas across four investment
            years on the ERCOT 5-bus network, subject to an ERCOT-style accredited-capacity reserve margin constraint
          </p>
        </div>
        <Badge variant="outline" className="border-teal-500/40 text-teal-400 text-xs">
          Multi-Investment-Period LP
        </Badge>
      </div>

      {/* Explainer panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <BookOpen className="h-4 w-4 text-teal-400" />
              What This Tool Does
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground space-y-2">
            <p>
              Solves a <span className="text-foreground font-medium">multi-investment-period capacity expansion LP</span> using
              PyPSA + HiGHS. The optimizer finds the least-cost mix of new wind, solar, storage, and gas capacity to build
              across four investment years (2026, 2028, 2030, 2032) on the ERCOT 5-bus network.
            </p>
            <p>
              Each period uses <span className="text-foreground font-medium">4 seasonal representative days × 24 hours</span> (96 snapshots)
              to capture diurnal and seasonal variation. New capacity built in one period is available in all future periods.
              The LP minimises annualised capex + operating cost + scarcity cost (VOLL) simultaneously across all periods.
            </p>
            <p>
              The result tells you the optimal technology mix, timing, and estimated system LMP trajectory — the same
              framework ERCOT uses in its long-term planning studies.
            </p>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <Target className="h-4 w-4 text-amber-400" />
              Use Cases
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground space-y-2">
            <ul className="space-y-1.5 list-none">
              {[
                ["What generation mix should anchor Walmart's 2026–2032 PPA pipeline?",
                  "Run Moderate demand, $3.50 HH → solar+storage dominates early periods."],
                ["How does aggressive AI datacenter load change the optimal build-out?",
                  "Switch to Aggressive demand → gas CT additions spike in 2028–2030."],
                ["At what gas price does solar+storage beat gas peakers?",
                  "Drag HH from $3 → $7 → $15 → solar share grows, CT share shrinks."],
                ["What is the least-cost path to ERCOT's 13.75% reserve margin?",
                  "Reserve margin constraint is always active — result shows minimum-cost path."],
              ].map(([q, a]) => (
                <li key={q} className="border-l-2 border-teal-500/30 pl-2">
                  <p className="text-foreground font-medium leading-tight">{q}</p>
                  <p className="text-muted-foreground mt-0.5">{a}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <FlaskConical className="h-4 w-4 text-purple-400" />
              Key Assumptions
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground space-y-1.5">
            {[
              ["Network", "ERCOT 5-bus Tier-1 (NORTH, SOUTH, WEST, HOUSTON, PAN). Transmission limits are aggregate zonal — not nodal."],
              ["Capital costs", "NREL ATB 2024 advanced scenario: Solar $700/kW, Wind $1,100/kW, Storage $280/kWh, Gas CC $900/kW, Gas CT $700/kW."],
              ["Demand", "Moderate: EIA STEO +1.63%/yr. Aggressive: ERCOT LTLF filing 2024 (+17.6%/yr reflecting hyperscaler growth)."],
              ["Reserve margin", "13.75% accredited-capacity constraint (ERCOT 2024 planning requirement). Storage accredited at 100% power, wind at 14%, solar at 64%."],
              ["WACC", "7% real. Capital recovery factor applied to annualise CAPEX over technology design life."],
              ["Gas dispatch", "Marginal cost = HH price × heat rate (8.5 MMBtu/MWh CC, 11.5 CT) + $2/MWh VOM. Adjusted relative to $3.50 base."],
              ["VOLL", "$9,000/MWh scarcity backstop — matches ERCOT ORDC cap. Any unserved energy priced at VOLL in the objective."],
              ["Build rate caps", "Max 3 GW/period per technology (supply chain constraint). Causes scarcity in Aggressive scenario early periods."],
            ].map(([k, v]) => (
              <div key={k}>
                <span className="text-foreground font-medium">{k}: </span>
                <span>{v}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Controls */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Scenario Parameters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-4">
            <div>
              <p className="text-xs text-muted-foreground mb-2">Demand growth scenario</p>
              <div className="flex flex-wrap gap-2">
                {[
                  { id: "moderate" as const, label: "Moderate (load_forecasts, +1.63%/yr)" },
                  { id: "aggressive" as const, label: "Aggressive (ERCOT LTLF filing, +17.6%/yr)" },
                ].map((s) => (
                  <button
                    key={s.id}
                    onClick={() => { setScenario(s.id); setDirty(true); }}
                    className={`px-3 py-1.5 rounded text-xs font-mono border transition-colors ${
                      scenario === s.id
                        ? "border-teal-500 bg-teal-500/20 text-teal-300"
                        : "border-border text-muted-foreground hover:border-teal-500/40 hover:text-teal-400"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Investment periods: 2026 · 2028 · 2030 · 2032 (4 seasonal representative days × 24 hrs each per period)
              </p>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Henry Hub Gas Price</span>
                <span className="font-mono text-orange-400">${(gasPrice / 100).toFixed(2)}/MMBtu</span>
              </div>
              <Slider min={100} max={2100} step={25} value={[gasPrice]}
                onValueChange={([v]) => { setGasPrice(v); setDirty(true); }} />
              <div className="flex justify-between text-xs mt-0.5 text-muted-foreground/50">
                <span>$1.00</span><span>$21.00</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button size="sm" variant={dirty || !result ? "default" : "outline"}
              className={dirty || !result ? "bg-teal-600 hover:bg-teal-700" : ""}
              disabled={mut.isPending}
              onClick={runSim}>
              {mut.isPending
                ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Solving 4-period LP...</>
                : "Run Capacity Expansion"}
            </Button>
            {!result && !mut.isPending && (
              <span className="text-xs text-muted-foreground">
                Solves a single multi-investment-period LP across all 4 years jointly (HiGHS)
              </span>
            )}
            {mut.isError && (
              <span className="text-xs text-red-400">{(mut.error as Error).message}</span>
            )}
          </div>
        </CardContent>
      </Card>

      {mut.isPending && (
        <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Solving multi-investment-period capacity expansion LP...</span>
        </div>
      )}

      {result && !mut.isPending && (
        <>
          {/* KPI strip */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              {
                label: "Total Discounted System Cost",
                value: result.total_discounted_system_cost_usd != null
                  ? fmtUsd(result.total_discounted_system_cost_usd)
                  : "—",
                sub: `WACC ${(result.assumptions.wacc * 100).toFixed(1)}% · 4 periods`,
                icon: DollarSign,
                color: "text-teal-400",
              },
              {
                label: "Total New-Build Capex",
                value: fmtUsd(totalCapex),
                sub: "Annualized capital cost, 2026–2032",
                icon: TrendingUp,
                color: "text-purple-400",
              },
              {
                label: `${finalPeriod} Avg LMP`,
                value: finalLmp != null ? `$${finalLmp.toFixed(2)}/MWh` : "—",
                sub: `System peak ${finalPeriod ? (result.system_peak_by_period_mw[String(finalPeriod)] / 1000).toFixed(1) : "—"} GW`,
                icon: Zap,
                color: "text-amber-400",
              },
              {
                label: "Reserve Margin Target",
                value: `${(result.assumptions.target_reserve_margin * 100).toFixed(2)}%`,
                sub: "ERCOT accredited-capacity constraint",
                icon: Layers,
                color: "text-blue-400",
              },
              {
                label: `${finalPeriod} Unserved Energy`,
                value: finalUnservedPct != null ? `${finalUnservedPct.toFixed(2)}%` : "—",
                sub: finalUnservedMwh != null
                  ? `${finalUnservedMwh.toLocaleString()} MWh served at $${result.assumptions.voll_usd_per_mwh.toLocaleString()}/MWh VOLL`
                  : "No demand shortfall",
                icon: AlertTriangle,
                color: finalUnservedPct && finalUnservedPct > 0 ? "text-red-400" : "text-teal-400",
              },
            ].map((kpi) => (
              <Card key={kpi.label} className="bg-card border-border">
                <CardContent className="pt-3 pb-2 px-3">
                  <div className="text-xs text-muted-foreground">{kpi.label}</div>
                  <div className={`text-xl font-bold font-mono ${kpi.color}`}>{kpi.value}</div>
                  <div className="text-xs text-muted-foreground">{kpi.sub}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* New builds by period */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">New Capacity Builds by Period</CardTitle>
                <CardDescription className="text-xs">
                  Optimal least-cost additions per investment year, by technology (MW)
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[260px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={buildData} margin={{ top: 4, right: 16, left: -10, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="period" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                      <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}GW`} />
                      <RechartsTooltip contentStyle={TS}
                        formatter={(v: number, name: string) => [`${v.toFixed(0)} MW`, CARRIER_LABELS[name] || name]} />
                      <Legend wrapperStyle={{ fontSize: 10 }} formatter={(v) => CARRIER_LABELS[v] || v} />
                      {CARRIER_ORDER.filter((c) => c !== "hydro" && c !== "nuclear" && c !== "biomass").map((c) => (
                        <Bar key={c} dataKey={c} stackId="a" fill={CARRIER_COLORS[c]} name={c} radius={[0, 0, 0, 0]} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Cumulative mix by period */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Cumulative Capacity Mix</CardTitle>
                <CardDescription className="text-xs">
                  Total installed capacity active in each period, existing fleet + new builds (MW)
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[260px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={mixData} margin={{ top: 4, right: 16, left: -10, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="period" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                      <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}GW`} />
                      <RechartsTooltip contentStyle={TS}
                        formatter={(v: number, name: string) => [`${(v / 1000).toFixed(1)} GW`, CARRIER_LABELS[name] || name]} />
                      <Legend wrapperStyle={{ fontSize: 10 }} formatter={(v) => CARRIER_LABELS[v] || v} />
                      {CARRIER_ORDER.map((c) => (
                        <Bar key={c} dataKey={c} stackId="b" fill={CARRIER_COLORS[c]} name={c} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* LMP trend */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Average LMP Trend</CardTitle>
                <CardDescription className="text-xs">
                  System-average shadow price by period — includes $
                  {result.assumptions.voll_usd_per_mwh.toLocaleString()}/MWh scarcity (VOLL) pricing whenever the optimizer
                  cannot fully serve load within build-rate caps
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[200px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={lmpData} margin={{ top: 4, right: 16, left: -10, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="period" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                      <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v) => `$${v}`} />
                      <RechartsTooltip contentStyle={TS}
                        formatter={(v: number, name: string) =>
                          name === "lmp" ? [`$${v.toFixed(2)}/MWh`, "Avg LMP"] : [`${v.toFixed(2)}%`, "Unserved energy"]
                        } />
                      <Line type="monotone" dataKey="lmp" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} name="lmp" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                {hasUnserved && (
                  <div className="mt-2 flex items-start gap-1.5 text-xs text-red-400/90 bg-red-500/10 border border-red-500/20 rounded px-2 py-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                      Demand exceeds buildable capacity in one or more periods (up to {maxUnservedPct.toFixed(2)}% of load
                      unserved at VOLL) — the LMP spike reflects real scarcity pricing, not just tight but feasible supply.
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Capex by period */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Annualized New-Build Capex</CardTitle>
                <CardDescription className="text-xs">
                  NREL ATB 2024 capital costs × CRF, applied to new capacity commissioned that period
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[200px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={capexData} margin={{ top: 4, right: 16, left: -10, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="period" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                      <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={(v) => fmtUsd(v)} />
                      <RechartsTooltip contentStyle={TS} formatter={(v: number) => [fmtUsd(v), "Capex"]} />
                      <Bar dataKey="capex" fill="#14b8a6" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Assumptions */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Model Assumptions</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div>
                  <p className="text-muted-foreground mb-1">Demand source</p>
                  <p className="text-foreground">{result.assumptions.demand_source}</p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-1">Capital costs</p>
                  <p className="text-foreground">{result.assumptions.capital_costs_source}</p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-1">Capacity accreditation</p>
                  <p className="text-foreground">{result.assumptions.accreditation_source}</p>
                </div>
                <div>
                  <p className="text-muted-foreground mb-1">Scarcity backstop (VOLL)</p>
                  <p className="text-foreground">${result.assumptions.voll_usd_per_mwh.toLocaleString()}/MWh</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
