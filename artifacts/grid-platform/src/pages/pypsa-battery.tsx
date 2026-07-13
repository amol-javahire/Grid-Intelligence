import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Loader2, Battery, DollarSign, TrendingUp, BookOpen, Target, FlaskConical } from "lucide-react";
import { useState } from "react";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
  Tooltip as RechartsTooltip, Cell, AreaChart, Area, Legend,
} from "recharts";

const BASE = "/pypsa";
const TS = { backgroundColor: "#0f172a", borderColor: "#1e293b", color: "#f8fafc", fontSize: 11 };

const MONTHS = [
  { value: 1, label: "Jan" }, { value: 2, label: "Feb" }, { value: 3, label: "Mar" },
  { value: 4, label: "Apr" }, { value: 5, label: "May" }, { value: 6, label: "Jun" },
  { value: 7, label: "Jul" }, { value: 8, label: "Aug" }, { value: 9, label: "Sep" },
  { value: 10, label: "Oct" }, { value: 11, label: "Nov" }, { value: 12, label: "Dec" },
];

const YEARS = [2024, 2025];

const NODES = [
  { value: "HB_WEST",    label: "HB_WEST (West Texas)" },
  { value: "HB_NORTH",   label: "HB_NORTH (Dallas/FW)" },
  { value: "HB_SOUTH",   label: "HB_SOUTH (San Antonio)" },
  { value: "HB_HOUSTON", label: "HB_HOUSTON (Coast)" },
  { value: "HB_PAN",     label: "HB_PAN (Panhandle)" },
];

const BUSES = ["NORTH", "WEST", "PAN", "SOUTH", "HOUSTON"];

interface HourlyRow {
  hour: number;
  label: string;
  charge_mw: number;
  discharge_mw: number;
  soc_mwh: number;
  da_price: number;
  rt_price: number;
  lmp: number;
  effective_price: number;
  curtailment_mw: number;
}

interface BatteryResult {
  status: string;
  storage_bus: string;
  storage_mw: number;
  storage_mwh: number;
  node: string;
  year: number;
  month: number;
  n_hours: number;
  total_charge_mwh: number;
  total_discharge_mwh: number;
  "arbitrage_revenue_$": number;
  "daily_revenue_$": number;
  avg_lmp_at_bus: number;
  avg_da_hub: number;
  zone_basis_mwh: number;
  lmp_volatility: number;
  neg_price_hours: number;
  total_curtailment_mwh: number;
  da_price_range: [number, number];
  hourly_schedule: HourlyRow[];
}

export default function PypsaBattery() {
  const [storageBus,  setStorageBus]  = useState("WEST");
  const [storageMw,   setStorageMw]   = useState(500);
  const [storageMwh,  setStorageMwh]  = useState(2000);
  const [efficiency,  setEfficiency]  = useState(90);
  const [node,        setNode]        = useState("HB_WEST");
  const [year,        setYear]        = useState(2025);
  const [month,       setMonth]       = useState(7);
  const [windCf,      setWindCf]      = useState(35);
  const [solarCf,     setSolarCf]     = useState(22);
  const [gasPrice,    setGasPrice]    = useState(350);
  const [dirty, setDirty] = useState(false);
  const [result, setResult] = useState<BatteryResult | null>(null);

  const mut = useMutation({
    mutationFn: (params: object) =>
      fetch(`${BASE}/battery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      }).then(r => r.json()),
    onSuccess: (data) => { setResult(data); setDirty(false); },
  });

  function runSim() {
    mut.mutate({
      storage_bus: storageBus,
      storage_mw: storageMw,
      storage_mwh: storageMwh,
      storage_efficiency: efficiency / 100,
      node,
      year,
      month,
      wind_cf: windCf / 100,
      solar_cf: solarCf / 100,
      gas_price_mmbtu: gasPrice / 100,
    });
  }

  const sched = result?.hourly_schedule ?? [];
  const maxSoc = result ? result.storage_mwh : 1;
  const maxPrice = sched.length > 0 ? Math.max(...sched.map(h => h.da_price), 1) : 1;

  const monthLabel = MONTHS.find(m => m.value === month)?.label ?? "";
  const annualRevEst = result ? result["daily_revenue_$"] * 30 : 0;

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Battery className="h-6 w-6 text-emerald-400" />
            Battery Revenue Simulator
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            5-bus zonal OPF (24 × Tier-1 snapshots) · zone LMP captures curtailment &amp; congestion · real ERCOT DA prices · cyclic SOC
          </p>
        </div>
        <Badge variant="outline" className="border-emerald-500/40 text-emerald-400 text-xs">
          24-Snapshot OPF
        </Badge>
      </div>

      {/* Explainer panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5">
              <BookOpen className="h-4 w-4 text-emerald-400" />
              What This Tool Does
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground space-y-2">
            <p>
              Simulates a <span className="text-foreground font-medium">battery storage asset on the ERCOT 5-bus network</span> using
              two coupled stages. Phase 1 runs 24 separate Tier-1 OPFs — one per hour of day — using diurnal renewable and
              load profiles to derive zone-specific LMPs that reflect curtailment and congestion at the storage bus.
            </p>
            <p>
              Phase 2 runs a <span className="text-foreground font-medium">battery arbitrage LP</span> using a blended price
              signal (50% real DA hub prices + 50% zone OPF LMP) to dispatch charge and discharge over a representative
              24-hour cycle. The cyclic SOC constraint forces the battery to start and end at the same state of charge,
              preventing unrealistic one-way arbitrage.
            </p>
            <p>
              Revenue is settled at <span className="text-foreground font-medium">real historical DA hub prices</span> from ERCOT CDR reports — not model outputs — so the financial result is grounded in actual market data.
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
                ["What is the realistic daily arbitrage revenue for a West Texas BESS co-located with solar?",
                  "Set bus=WEST, node=HB_WEST, solarCF=25%, Jul 2025 → high curtailment depresses zone LMP vs hub."],
                ["Does a 4-hour battery outperform a 2-hour at the Houston coast?",
                  "Set bus=HOUSTON, MWh=2×MW (4h) vs MWh=1×MW (2h) — compare daily revenue and $/MW-day."],
                ["How does zone basis affect battery siting?",
                  "Compare Zone Basis KPI card across WEST / NORTH / HOUSTON — positive basis = zone earns more than hub."],
                ["Is a BESS worth less in a high-curtailment summer week vs winter?",
                  "Run Jul 2025 (high solar, more curtailment) vs Jan 2025 (low solar, tighter supply) at HB_WEST."],
              ].map(([q, a]) => (
                <li key={q} className="border-l-2 border-emerald-500/30 pl-2">
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
              ["Network", "ERCOT 5-bus Tier-1: NORTH, SOUTH, WEST, HOUSTON, PAN. Transmission limits are aggregate zonal."],
              ["DA prices", "Real hourly DA prices from ERCOT CDR Report 13060 (Jan 2024–Dec 2025, 15 hub/zone nodes). Revenue is settled here."],
              ["Zone LMP", "Per-hour OPF marginal price at the storage bus, driven by the wind CF, solar CF, and gas price inputs. Not used for settlement — used for dispatch signal."],
              ["Dispatch signal", "Blended: 50% real DA price + 50% zone OPF LMP. Mimics a merchant that has both real market access and zonal congestion awareness."],
              ["Cyclic SOC", "Battery SOC at hour 24 must equal SOC at hour 0. Prevents infinite single-direction arbitrage."],
              ["Efficiency", "Round-trip efficiency applies symmetrically: charge takes in X MWh, discharge puts out X × η² MWh (split between charge and discharge stages)."],
              ["Curtailment", "Hours where zone LMP < 0 (negative prices) result in renewable curtailment. Curtailment MWh = hourly curtailment_mw summed over 24h."],
              ["Revenue", "arbitrage_revenue_$ = Σ (discharge_mw × DA_price − charge_mw × DA_price) across all hours. Daily = total ÷ 30 (avg month)."],
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
            Battery + Market Parameters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-4">
            {/* Battery params */}
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Battery Asset</p>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-muted-foreground">Power Capacity</span>
                  <span className="font-mono text-emerald-400">{storageMw} MW</span>
                </div>
                <Slider min={50} max={2000} step={50} value={[storageMw]}
                  onValueChange={([v]) => { setStorageMw(v); setDirty(true); }} />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-muted-foreground">Energy Capacity</span>
                  <span className="font-mono text-emerald-400">{storageMwh} MWh ({(storageMwh/storageMw).toFixed(1)}h)</span>
                </div>
                <Slider min={100} max={8000} step={100} value={[storageMwh]}
                  onValueChange={([v]) => { setStorageMwh(v); setDirty(true); }} />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-muted-foreground">Round-trip Efficiency</span>
                  <span className="font-mono text-emerald-400">{efficiency}%</span>
                </div>
                <Slider min={60} max={99} step={1} value={[efficiency]}
                  onValueChange={([v]) => { setEfficiency(v); setDirty(true); }} />
              </div>

              <div>
                <p className="text-xs text-muted-foreground mb-1">Siting Bus</p>
                <div className="flex flex-wrap gap-2">
                  {BUSES.map(b => (
                    <button key={b} onClick={() => { setStorageBus(b); setDirty(true); }}
                      className={`px-3 py-1 rounded text-xs font-mono border transition-colors ${
                        storageBus === b
                          ? "border-emerald-500 bg-emerald-500/20 text-emerald-300"
                          : "border-border text-muted-foreground hover:border-emerald-500/40"
                      }`}>
                      {b}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Market params */}
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Market Period</p>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Hub node (real hourly DA prices)</p>
                <div className="flex flex-col gap-1">
                  {NODES.map(n => (
                    <button key={n.value} onClick={() => { setNode(n.value); setDirty(true); }}
                      className={`text-left px-3 py-1.5 rounded text-xs border transition-colors ${
                        node === n.value
                          ? "border-emerald-500 bg-emerald-500/15 text-emerald-300"
                          : "border-border text-muted-foreground hover:border-emerald-500/40"
                      }`}>
                      {n.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Year</p>
                  <div className="flex gap-2">
                    {YEARS.map(y => (
                      <button key={y} onClick={() => { setYear(y); setDirty(true); }}
                        className={`px-3 py-1 rounded text-xs font-mono border transition-colors ${
                          year === y
                            ? "border-emerald-500 bg-emerald-500/20 text-emerald-300"
                            : "border-border text-muted-foreground hover:border-emerald-500/40"
                        }`}>
                        {y}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Month</p>
                  <div className="flex flex-wrap gap-1">
                    {MONTHS.slice(0, 12).map(m => (
                      <button key={m.value} onClick={() => { setMonth(m.value); setDirty(true); }}
                        className={`px-2 py-1 rounded text-xs font-mono border transition-colors ${
                          month === m.value
                            ? "border-emerald-500 bg-emerald-500/20 text-emerald-300"
                            : "border-border text-muted-foreground hover:border-emerald-500/40"
                        }`}>
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-muted-foreground">Wind CF</span>
                  <span className="font-mono text-teal-400">{windCf}%</span>
                </div>
                <Slider min={5} max={75} step={1} value={[windCf]}
                  onValueChange={([v]) => { setWindCf(v); setDirty(true); }} />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-muted-foreground">Solar CF</span>
                  <span className="font-mono text-amber-400">{solarCf}%</span>
                </div>
                <Slider min={5} max={50} step={1} value={[solarCf]}
                  onValueChange={([v]) => { setSolarCf(v); setDirty(true); }} />
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button size="sm" variant={dirty || !result ? "default" : "outline"}
              className={dirty || !result ? "bg-emerald-600 hover:bg-emerald-700" : ""}
              disabled={mut.isPending}
              onClick={runSim}>
              {mut.isPending
                ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Running 24-hr OPF...</>
                : "Run Battery Simulation"}
            </Button>
            {!result && !mut.isPending && (
              <span className="text-xs text-muted-foreground">
                Uses real {year}-{String(month).padStart(2,"0")} hourly DA prices from {node}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {mut.isPending && (
        <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Running 24-snapshot PyPSA OPF with StorageUnit...</span>
        </div>
      )}

      {result && !mut.isPending && (
        <>
          {/* KPI strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
            {[
              {
                label: "Daily Arbitrage Rev",
                value: `$${Math.abs(result["daily_revenue_$"]).toLocaleString()}`,
                sub: `${monthLabel} ${result.year} avg day`,
                color: result["daily_revenue_$"] >= 0 ? "text-emerald-400" : "text-red-400",
              },
              {
                label: "Monthly Est",
                value: `$${(Math.abs(annualRevEst)/1000).toFixed(0)}k`,
                sub: "×30 days",
                color: "text-teal-400",
              },
              {
                label: "$/MW-day",
                value: `$${result.storage_mw > 0 ? (Math.abs(result["daily_revenue_$"])/result.storage_mw).toFixed(0) : "—"}`,
                sub: "per MW capacity",
                color: "text-amber-400",
              },
              {
                label: "Charge / Discharge",
                value: `${result.total_charge_mwh.toFixed(0)} / ${result.total_discharge_mwh.toFixed(0)}`,
                sub: "MWh in 24h",
                color: "text-muted-foreground",
              },
              {
                label: "Zone Basis",
                value: `${result.zone_basis_mwh >= 0 ? "+" : ""}$${result.zone_basis_mwh?.toFixed(2) ?? "0.00"}`,
                sub: `vs hub DA $${result.avg_da_hub?.toFixed(2) ?? "—"}/MWh`,
                color: (result.zone_basis_mwh ?? 0) >= 0 ? "text-teal-400" : "text-red-400",
              },
              {
                label: "Curtailment MWh",
                value: `${(result.total_curtailment_mwh ?? 0).toFixed(0)}`,
                sub: "total in 24h (OPF)",
                color: (result.total_curtailment_mwh ?? 0) > 0 ? "text-amber-400" : "text-emerald-400",
              },
              {
                label: "Neg-Price Hours",
                value: result.neg_price_hours.toString(),
                sub: `LMP vol $${result.lmp_volatility.toFixed(1)}/MWh`,
                color: result.neg_price_hours > 0 ? "text-red-400" : "text-emerald-400",
              },
            ].map(kpi => (
              <Card key={kpi.label} className="bg-card border-border">
                <CardContent className="pt-3 pb-2 px-3">
                  <div className="text-xs text-muted-foreground">{kpi.label}</div>
                  <div className={`text-xl font-bold font-mono ${kpi.color}`}>{kpi.value}</div>
                  <div className="text-xs text-muted-foreground">{kpi.sub}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Main dispatch + price chart */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">24-Hour Dispatch Schedule — {result.node} {monthLabel} {result.year}</CardTitle>
              <CardDescription className="text-xs">
                Battery charge (charging ↓) and discharge (↑) against DA price signal ·
                DA price range: ${result.da_price_range[0].toFixed(2)}–${result.da_price_range[1].toFixed(2)}/MWh
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={sched} margin={{ top: 4, right: 20, left: -10, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} />
                    <YAxis yAxisId="mw" tick={{ fontSize: 10, fill: "#94a3b8" }}
                      tickFormatter={v => `${v}MW`} />
                    <YAxis yAxisId="price" orientation="right" tick={{ fontSize: 10, fill: "#94a3b8" }}
                      tickFormatter={v => `$${v}`} />
                    <RechartsTooltip contentStyle={TS}
                      formatter={(v: number, name: string) => [
                        name.includes("price") || name.includes("LMP") ? `$${v.toFixed(2)}/MWh` : `${v.toFixed(1)} MW`,
                        name,
                      ]} />
                    <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
                    <Bar yAxisId="mw" dataKey="discharge_mw" name="Discharge" stackId="bat" fill="#22c55e" radius={[2,2,0,0]} />
                    <Bar yAxisId="mw" dataKey="charge_mw" name="Charge" stackId="bat" fill="#3b82f6"
                      radius={[0,0,2,2]}
                      label={false} />
                    <Line yAxisId="price" type="monotone" dataKey="da_price" name="DA Price"
                      stroke="#f59e0b" strokeWidth={2} dot={false} />
                    <Line yAxisId="price" type="monotone" dataKey="lmp" name="Zone LMP"
                      stroke="#a855f7" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
                    <Line yAxisId="price" type="monotone" dataKey="effective_price" name="Effective (blended)"
                      stroke="#22d3ee" strokeWidth={1.5} dot={false} strokeDasharray="2 2" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* SOC profile */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">State of Charge Profile</CardTitle>
                <CardDescription className="text-xs">
                  Cyclic SOC — starts and ends at same level · {result.storage_mwh} MWh total capacity
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[200px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={sched} margin={{ top: 4, right: 16, left: -10, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} />
                      <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={v => `${v}MWh`}
                        domain={[0, result.storage_mwh]} />
                      <RechartsTooltip contentStyle={TS}
                        formatter={(v: number) => [`${v.toFixed(1)} MWh`, "SOC"]} />
                      <Area type="monotone" dataKey="soc_mwh" name="SOC"
                        fill="#22c55e" fillOpacity={0.2} stroke="#22c55e" strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>

            {/* Hourly revenue waterfall */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Hourly Revenue Attribution</CardTitle>
                <CardDescription className="text-xs">
                  Revenue earned each hour: discharge earnings − charge cost
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[200px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={sched.map(h => ({
                        ...h,
                        hourly_rev: h.discharge_mw > 0
                          ? h.discharge_mw * h.da_price
                          : -h.charge_mw * h.da_price,
                      }))}
                      margin={{ top: 4, right: 16, left: -10, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} />
                      <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={v => `$${v.toFixed(0)}`} />
                      <RechartsTooltip contentStyle={TS}
                        formatter={(v: number) => [`$${v.toFixed(0)}`, "Revenue"]} />
                      <Bar dataKey="hourly_rev" name="Hourly revenue" radius={[2,2,2,2]}>
                        {sched.map((h, i) => {
                          const rev = h.discharge_mw > 0
                            ? h.discharge_mw * h.da_price
                            : -h.charge_mw * h.da_price;
                          return <Cell key={i} fill={rev >= 0 ? "#22c55e" : "#ef4444"} />;
                        })}
                      </Bar>
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Hourly schedule table */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Full 24-Hour Dispatch Table</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border">
                      <th className="text-left pb-1 font-normal">Hour</th>
                      <th className="text-right pb-1 font-normal">Charge MW</th>
                      <th className="text-right pb-1 font-normal">Discharge MW</th>
                      <th className="text-right pb-1 font-normal">SOC MWh</th>
                      <th className="text-right pb-1 font-normal">DA Price</th>
                      <th className="text-right pb-1 font-normal">Bus LMP</th>
                      <th className="text-right pb-1 font-normal">Rev $</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sched.map(h => {
                      const rev = h.discharge_mw > 0
                        ? h.discharge_mw * h.da_price
                        : -h.charge_mw * h.da_price;
                      return (
                        <tr key={h.hour} className="border-b border-border/30">
                          <td className="py-0.5 font-mono text-muted-foreground">{h.label}</td>
                          <td className={`text-right font-mono ${h.charge_mw > 0 ? "text-blue-400" : "text-muted-foreground"}`}>
                            {h.charge_mw > 0 ? h.charge_mw.toFixed(1) : "—"}
                          </td>
                          <td className={`text-right font-mono ${h.discharge_mw > 0 ? "text-emerald-400" : "text-muted-foreground"}`}>
                            {h.discharge_mw > 0 ? h.discharge_mw.toFixed(1) : "—"}
                          </td>
                          <td className="text-right font-mono text-teal-400">{h.soc_mwh.toFixed(0)}</td>
                          <td className="text-right font-mono">${h.da_price.toFixed(2)}</td>
                          <td className={`text-right font-mono ${h.lmp < 0 ? "text-red-400" : ""}`}>
                            ${h.lmp.toFixed(2)}
                          </td>
                          <td className={`text-right font-mono ${rev >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {rev >= 0 ? "+" : ""}${rev.toFixed(0)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border font-medium">
                      <td className="pt-2 text-muted-foreground">Total</td>
                      <td className="text-right font-mono text-blue-400">{result.total_charge_mwh.toFixed(1)}</td>
                      <td className="text-right font-mono text-emerald-400">{result.total_discharge_mwh.toFixed(1)}</td>
                      <td colSpan={3} />
                      <td className={`text-right font-mono text-lg ${result["daily_revenue_$"] >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        ${result["daily_revenue_$"].toFixed(0)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Real DA prices from <span className="font-mono text-teal-400">{result.node}</span> {monthLabel} {result.year} ·
                PyPSA StorageUnit with {(efficiency)}% RTE ·
                Cyclic SOC constraint (start = end) ·
                Revenue = discharge × DA price − charge × DA price
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
