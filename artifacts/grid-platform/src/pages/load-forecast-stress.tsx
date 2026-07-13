import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, TrendingUp, ShieldAlert, Info, BookOpen, Target, FlaskConical } from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  ResponsiveContainer, Tooltip as RechartsTooltip, Cell, Legend,
} from "recharts";

const API_BASE = "/api";
const PYPSA_BASE = "/pypsa";
const TS = { backgroundColor: "#0f172a", borderColor: "#1e293b", color: "#f8fafc", fontSize: 11 };

// ── ERCOT hub config ─────────────────────────────────────────────────────────
// load_forecasts stores load at EIA-930 "weather zone" granularity (the only
// real load-forecast basis available). Every other tab in this platform
// (ERCOT Historical, Congestion, Nodal, Queue, PyPSA network) uses the ERCOT
// market Hub/Load-Zone breakdown (HB_HOUSTON/HB_NORTH/HB_WEST/HB_SOUTH), so we
// aggregate the 8 weather zones up to the 4 hubs used by the PyPSA 5-bus
// reduced-order model to keep the whole platform speaking the same language.
const ERCOT_HUBS: Record<string, { label: string; short: string; color: string; zones: string[] }> = {
  HOUSTON: { label: "HB_HOUSTON — Houston Hub (Coast + East)",         short: "Houston Hub", color: "#14b8a6", zones: ["COAS", "EAST"] },
  NORTH:   { label: "HB_NORTH — North Hub (North Central + North)",    short: "North Hub",   color: "#f59e0b", zones: ["NCEN", "NRTH"] },
  WEST:    { label: "HB_WEST — West Hub (Far West + West)",            short: "West Hub",    color: "#ec4899", zones: ["FWES", "WEST"] },
  SOUTH:   { label: "HB_SOUTH — South Hub (South Central + South)",    short: "South Hub",   color: "#3b82f6", zones: ["SCEN", "SOUT"] },
};

interface LoadForecastDailyRow {
  zone: string; year: number; month: number; day: number;
  baseMw: number; evMw: number; dcMw: number; totalMw: number;
}

interface AggDailyRow { year: number; month: number; day: number; baseMw: number; evMw: number; dcMw: number; totalMw: number }

function sumDailyBy(rows: LoadForecastDailyRow[], zones: string[] | null): AggDailyRow[] {
  const map = new Map<string, AggDailyRow>();
  for (const r of rows) {
    if (zones && !zones.includes(r.zone)) continue;
    const k = `${r.year}-${r.month}-${r.day}`;
    const e = map.get(k);
    if (e) {
      e.baseMw += r.baseMw ?? 0; e.evMw += r.evMw ?? 0; e.dcMw += r.dcMw ?? 0; e.totalMw += r.totalMw ?? 0;
    } else {
      map.set(k, { year: r.year, month: r.month, day: r.day, baseMw: r.baseMw ?? 0, evMw: r.evMw ?? 0, dcMw: r.dcMw ?? 0, totalMw: r.totalMw ?? 0 });
    }
  }
  return Array.from(map.values());
}

function maxByTotal(rows: AggDailyRow[]): AggDailyRow | null {
  return rows.reduce<AggDailyRow | null>((max, r) => (!max || r.totalMw > max.totalMw ? r : max), null);
}

// Real EIA-860 2024 operable nameplate capacity, ERCOT market — matches the
// PyPSA Tier-1 model's wind/solar p_nom sums exactly (see network.py _T1_GEN).
const ERCOT_WIND_NAMEPLATE_MW = 38_566.7;
const ERCOT_SOLAR_NAMEPLATE_MW = 22_171.5;
// PyPSA Tier-1 reduced-order model's total gas_cc + gas_ct nameplate across
// all 4 buses (network.py _T1_GEN) — this is what the OPF actually derates,
// which differs from the smaller real ERCOT gas fleet by design (reduced-order model).
const ERCOT_TIER1_GAS_MW = 96_241;

// Renewables Output % → wind/solar capacity factor. Ceilings calibrated so a
// shared default of 50% reproduces each fuel's real average CF computed from
// ercot_fuel_mix (Jan 2024–Jun 2026 hourly, gen_mw / EIA-860 nameplate): wind
// mean 34.6% (σ 18.0pp), solar mean 31.6% (σ 40.2pp, day/night bimodal). A
// single knob can't hit both fuels' 2σ ceilings at once, so the default is
// prioritized (exact real-average match); max=110% pushes wind to ~76% CF,
// just beyond its observed historical max of 74.7%.
const WIND_CF_CEILING = 0.691;
const SOLAR_CF_CEILING = 0.632;

// ── CAISO hub config ─────────────────────────────────────────────────────────

const CAISO_HUBS: Record<string, { label: string; defaultLoadMw: number }> = {
  SP15: { label: "SP15 (Southern CA)", defaultLoadMw: 27000 },
  NP15: { label: "NP15 (Northern CA)", defaultLoadMw: 20000 },
};

const FUEL_COLORS: Record<string, string> = {
  natural_gas: "#f59e0b", solar: "#fbbf24", wind: "#14b8a6", storage: "#8b5cf6",
  hydro: "#3b82f6", nuclear: "#a855f7", geothermal: "#ef4444", biomass: "#22c55e",
};

interface CaisoCapacityResponse {
  hub: string;
  byFuelType: Array<{ fuelType: string; capacityMw: number; count: number }>;
  totalMw: number;
  source: string;
}

// Typical average availability factors applied to non-weather-dependent fuels
// (fixed assumptions, not derived from real-time dispatch data).
const FIXED_AVAILABILITY: Record<string, number> = {
  nuclear: 0.95, hydro: 0.40, geothermal: 0.90, biomass: 0.85, storage: 0.90,
};

interface ScarcityResult {
  scarcity_level: "NORMAL" | "ELEVATED" | "SEVERE" | "CRITICAL";
  system_load_mw: number;
  total_available_mw: number;
  reserve_margin_pct: number;
  total_load_shed_mw: number;
  max_lmp: number;
  lmp: Record<string, number>;
  zone_risk: Array<{ zone: string; hub: string; lmp: number; load_mw: number; load_shed_mw: number; shed_pct: number }>;
}

const LEVEL_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  NORMAL:   { bg: "bg-emerald-500/10", border: "border-emerald-500/30", text: "text-emerald-300" },
  ELEVATED: { bg: "bg-amber-500/10",   border: "border-amber-500/30",   text: "text-amber-300" },
  SEVERE:   { bg: "bg-orange-500/10",  border: "border-orange-500/30",  text: "text-orange-300" },
  CRITICAL: { bg: "bg-red-500/10",     border: "border-red-500/30",     text: "text-red-300" },
};

export default function LoadForecastStress() {
  const [iso, setIso] = useState<"ERCOT" | "CAISO">("ERCOT");
  const [ercotHub, setErcotHub] = useState("NORTH");
  const [caisoHub, setCaisoHub] = useState("SP15");

  const [renewPct, setRenewPct] = useState(50);
  const [evPct,    setEvPct]    = useState(100);
  const [dcPct,    setDcPct]    = useState(100);

  const [caisoLoadMw, setCaisoLoadMw] = useState(27000);
  const [caisoEvAdd,  setCaisoEvAdd]  = useState(500);
  const [caisoDcAdd,  setCaisoDcAdd]  = useState(1000);
  const [gasDerate,   setGasDerate]   = useState(6);

  // ── ERCOT data ──────────────────────────────────────────────────────────
  const { data: dailyRows = [], isLoading: ercotLoading } = useQuery<LoadForecastDailyRow[]>({
    queryKey: ["load-forecast-zones-daily"],
    queryFn: () => fetch(`${API_BASE}/load-forecast/zones`).then(r => r.json()),
    staleTime: 10 * 60 * 1000,
    enabled: iso === "ERCOT",
  });

  const hubDailyRows = useMemo(
    () => sumDailyBy(dailyRows, ERCOT_HUBS[ercotHub]?.zones ?? null),
    [dailyRows, ercotHub]
  );

  const zoneChartData = useMemo(() => {
    const map = new Map<string, { year: number; month: number; base: number; ev: number; dc: number; n: number }>();
    for (const r of hubDailyRows) {
      const k = `${r.year}-${r.month}`;
      const e = map.get(k);
      if (e) { e.base += r.baseMw; e.ev += r.evMw; e.dc += r.dcMw; e.n++; }
      else map.set(k, { year: r.year, month: r.month, base: r.baseMw, ev: r.evMw, dc: r.dcMw, n: 1 });
    }
    return Array.from(map.values())
      .sort((a, b) => a.year - b.year || a.month - b.month)
      .map(e => ({
        label: `${e.month}/${String(e.year).slice(2)}`,
        base: Math.round(e.base / e.n), ev: Math.round(e.ev / e.n), dc: Math.round(e.dc / e.n),
      }));
  }, [hubDailyRows]);

  const hubPeakDay = useMemo(() => maxByTotal(hubDailyRows), [hubDailyRows]);

  // System-wide (all 8 zones) coincident peak day — the real input to the
  // PyPSA scarcity call, independent of which hub is selected for display.
  const systemDailyRows = useMemo(() => sumDailyBy(dailyRows, null), [dailyRows]);
  const systemPeakDay = useMemo(() => maxByTotal(systemDailyRows), [systemDailyRows]);

  const windCf  = (renewPct / 100) * WIND_CF_CEILING;
  const solarCf = (renewPct / 100) * SOLAR_CF_CEILING;

  const systemLoadMw = systemPeakDay
    ? systemPeakDay.baseMw + systemPeakDay.evMw * (evPct / 100) + systemPeakDay.dcMw * (dcPct / 100)
    : 0;

  const ercotMut = useMutation({
    mutationFn: async (params: object) => {
      const res = await fetch(`${PYPSA_BASE}/scarcity`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body?.detail ?? "Stress test failed — load exceeds all available capacity");
      }
      return body as ScarcityResult;
    },
  });

  function runErcotStressTest() {
    ercotMut.mutate({
      system_load_mw: Math.round(systemLoadMw),
      wind_cf: windCf,
      solar_cf: solarCf,
      gas_derate_pct: gasDerate,
      nuclear_derate_pct: 0,
      voll: 5000,
      gas_price_mmbtu: 5,
    });
  }

  const ercotResult = ercotMut.data;
  const ercotLevel = ercotResult?.scarcity_level ?? "NORMAL";
  const ercotErrorMsg = ercotMut.isError ? (ercotMut.error as Error).message : undefined;

  // ── CAISO data ──────────────────────────────────────────────────────────
  const { data: caisoCap, isLoading: caisoLoading } = useQuery<CaisoCapacityResponse>({
    queryKey: ["caiso-capacity", caisoHub],
    queryFn: () => fetch(`${API_BASE}/caiso-capacity?hub=${caisoHub}`).then(r => r.json()),
    staleTime: 10 * 60 * 1000,
    enabled: iso === "CAISO",
  });

  const caisoAnalysis = useMemo(() => {
    if (!caisoCap) return null;
    let available = 0;
    const breakdown: Array<{ fuelType: string; nameplateMw: number; availableMw: number }> = [];
    for (const f of caisoCap.byFuelType) {
      let cf: number;
      if (f.fuelType === "wind") cf = windCf;
      else if (f.fuelType === "solar") cf = solarCf;
      else if (f.fuelType === "natural_gas") cf = 1 - gasDerate / 100;
      else cf = FIXED_AVAILABILITY[f.fuelType] ?? 0.7;
      const avail = f.capacityMw * cf;
      available += avail;
      breakdown.push({ fuelType: f.fuelType, nameplateMw: f.capacityMw, availableMw: Math.round(avail) });
    }
    const stressedLoad = caisoLoadMw + caisoEvAdd + caisoDcAdd;
    const reserveMarginPct = ((available - stressedLoad) / stressedLoad) * 100;
    const deficitMw = Math.max(0, stressedLoad - available);
    let level: keyof typeof LEVEL_COLORS = "NORMAL";
    if (reserveMarginPct < 0) level = "CRITICAL";
    else if (reserveMarginPct < 8) level = "SEVERE";
    else if (reserveMarginPct < 15) level = "ELEVATED";
    return { available: Math.round(available), stressedLoad, reserveMarginPct, deficitMw, level, breakdown };
  }, [caisoCap, windCf, solarCf, gasDerate, caisoLoadMw, caisoEvAdd, caisoDcAdd]);

  return (
    <div className="p-6 space-y-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <TrendingUp className="h-6 w-6 text-teal-400" />
            Load Forecast &amp; Stress Test
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Wire forecasted load + renewables / EV / datacenter scenarios into the grid stress simulator
          </p>
        </div>
        <div className="flex gap-1 bg-slate-800/60 p-1 rounded-lg border border-slate-700/50">
          {(["ERCOT", "CAISO"] as const).map(m => (
            <button
              key={m}
              onClick={() => setIso(m)}
              className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
                iso === m ? "bg-teal-600 text-white" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
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
              Combines a <span className="text-foreground font-medium">3-year load forecast</span> (Jul 2026 – Jun 2029)
              built from real EIA-930 hourly data with an <span className="text-foreground font-medium">OPF-based scarcity stress test</span> to
              assess supply adequacy at projected peak demand.
            </p>
            <p>
              The forecast uses OLS regression on temperature and calendar effects (R²=0.88–0.92), then layers on
              incremental load from EVs and datacenter growth. The ERCOT stress tab feeds the peak into the
              PyPSA 5-bus Tier-1 OPF to determine whether installed capacity — derated by renewable CFs — is
              sufficient or triggers VOLL scarcity pricing.
            </p>
            <p>
              CAISO uses a simpler reserve-margin approach (real EIA-860 capacity vs adjustable peak demand) since
              CAISO nodal data does not include a load-forecast regression.
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
                ["PE / Developer", "How much capacity headroom remains in 2028 if major datacenters come online? → Drag DC increment slider — compare unserved energy in OPF stress result."],
                ["Utility / Grid Planner", "What reserve margin does a hub maintain under the high-EV scenario by 2029? → Advance year, increase EV slider, read reserve margin KPI."],
                ["IPP", "Where is load growth fastest, and does transmission keep up? → Compare hub peak trajectory 2026–2029 for NORTH vs WEST vs HOUSTON."],
                ["Investor / Analyst", "At what peak load does scarcity pricing begin in the West hub? → OPF stress test shows VOLL onset — watch avg LMP spike."],
              ].map(([role, a]) => (
                <li key={role} className="border-l-2 border-teal-500/30 pl-2">
                  <p className="text-foreground font-medium leading-tight">{role}</p>
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
              ["Forecast method", "OLS: Load ~ Temp + Temp² + month_sin/cos + isWeekend. Trained on real EIA-930 (Jan 2024–Jun 2026). R²=0.88–0.92 major zones."],
              ["Temperature", "Real Open-Meteo archive through Jun 2026; then 3yr climatological projection (+0.3°F/yr warming trend per CMIP6)."],
              ["EV load", "+0.5% system load/yr compounding (ERCOT 2024 LTLF planning assumption). Applied uniformly across zones."],
              ["Datacenter load", "Incremental MW from 55 curated hyperscaler/colo facilities in the DB. Allocated to host zone."],
              ["ERCOT stress test", "PyPSA 5-bus Tier-1 OPF. Nameplate capacity from EIA 860 (wind 38.6 GW, solar 22.2 GW, gas 96 GW). Derated by CF sliders."],
              ["CAISO stress", "Simple reserve margin: EIA-860 nameplate × accreditation factor vs adjustable peak. No OPF."],
              ["VOLL", "$9,000/MWh for unserved energy in OPF objective. Matches ERCOT ORDC cap. Unserved MWh shown as KPI."],
            ].map(([k, v]) => (
              <div key={k}>
                <span className="text-foreground font-medium">{k}: </span>
                <span>{v}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Hub selector */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground uppercase tracking-wide">Hub</span>
        {iso === "ERCOT" ? (
          <Select value={ercotHub} onValueChange={setErcotHub}>
            <SelectTrigger className="w-[340px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(ERCOT_HUBS).map(([h, meta]) => (
                <SelectItem key={h} value={h}>{meta.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Select value={caisoHub} onValueChange={v => { setCaisoHub(v); setCaisoLoadMw(CAISO_HUBS[v].defaultLoadMw); }}>
            <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(CAISO_HUBS).map(([h, meta]) => (
                <SelectItem key={h} value={h}>{meta.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {iso === "ERCOT" ? (
        <ErcotPanel
          loading={ercotLoading}
          zoneChartData={zoneChartData}
          hubMeta={ERCOT_HUBS[ercotHub]}
          hubPeakDay={hubPeakDay}
          ercotHub={ercotHub}
          renewPct={renewPct} setRenewPct={setRenewPct}
          evPct={evPct} setEvPct={setEvPct}
          dcPct={dcPct} setDcPct={setDcPct}
          gasDerate={gasDerate} setGasDerate={setGasDerate}
          windCf={windCf} solarCf={solarCf}
          systemLoadMw={systemLoadMw}
          systemPeakDay={systemPeakDay}
          onRun={runErcotStressTest}
          isPending={ercotMut.isPending}
          result={ercotResult}
          level={ercotLevel}
          errorMsg={ercotErrorMsg}
        />
      ) : (
        <CaisoPanel
          loading={caisoLoading}
          cap={caisoCap}
          hubLabel={CAISO_HUBS[caisoHub].label}
          renewPct={renewPct} setRenewPct={setRenewPct}
          windCf={windCf} solarCf={solarCf}
          gasDerate={gasDerate} setGasDerate={setGasDerate}
          caisoLoadMw={caisoLoadMw} setCaisoLoadMw={setCaisoLoadMw}
          caisoEvAdd={caisoEvAdd} setCaisoEvAdd={setCaisoEvAdd}
          caisoDcAdd={caisoDcAdd} setCaisoDcAdd={setCaisoDcAdd}
          analysis={caisoAnalysis}
        />
      )}
    </div>
  );
}

// ── ERCOT panel ───────────────────────────────────────────────────────────────

function ErcotPanel(props: {
  loading: boolean;
  zoneChartData: Array<{ label: string; base: number; ev: number; dc: number }>;
  hubMeta?: { label: string; short: string; color: string; zones: string[] };
  hubPeakDay: AggDailyRow | null;
  ercotHub: string;
  renewPct: number; setRenewPct: (v: number) => void;
  evPct: number; setEvPct: (v: number) => void;
  dcPct: number; setDcPct: (v: number) => void;
  gasDerate: number; setGasDerate: (v: number) => void;
  windCf: number; solarCf: number;
  systemLoadMw: number;
  systemPeakDay: AggDailyRow | null;
  onRun: () => void;
  isPending: boolean;
  result?: ScarcityResult;
  level: string;
  errorMsg?: string;
}) {
  const { loading, zoneChartData, hubMeta, hubPeakDay, ercotHub, renewPct, setRenewPct,
    evPct, setEvPct, dcPct, setDcPct, gasDerate, setGasDerate, windCf, solarCf,
    systemLoadMw, systemPeakDay, onRun, isPending, result, level, errorMsg } = props;

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">Loading load forecast…</div>;
  }

  const levelColors = LEVEL_COLORS[level];

  const combinedRenewMw = windCf * ERCOT_WIND_NAMEPLATE_MW + solarCf * ERCOT_SOLAR_NAMEPLATE_MW;
  const evMwValue = systemPeakDay ? systemPeakDay.evMw * (evPct / 100) : 0;
  const dcMwValue = systemPeakDay ? systemPeakDay.dcMw * (dcPct / 100) : 0;
  const gasOfflineMw = ERCOT_TIER1_GAS_MW * (gasDerate / 100);

  return (
    <div className="space-y-6">
      {/* Forecast chart */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">3-Year Load Forecast — {hubMeta?.short}</CardTitle>
          <CardDescription className="text-xs">
            OLS temperature regression + EV &amp; datacenter increments · Jul 2026 – Jun 2029 (real EIA-930 basis,
            aggregated from {hubMeta?.zones.join(" + ")} weather zones)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={zoneChartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#94a3b8" }} interval={5} />
                <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={v => `${(v / 1000).toFixed(0)}GW`} width={40} />
                <RechartsTooltip contentStyle={TS} formatter={(v: number) => [`${v.toLocaleString()} MW`]} />
                <Area type="monotone" dataKey="base" stackId="1" stroke={hubMeta?.color ?? "#14b8a6"} fill={hubMeta?.color ?? "#14b8a6"} fillOpacity={0.35} />
                <Area type="monotone" dataKey="ev" stackId="1" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.35} />
                <Area type="monotone" dataKey="dc" stackId="1" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.35} />
                <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {hubPeakDay && (
            <p className="text-xs text-muted-foreground mt-2">
              Forecasted peak: <span className="text-foreground font-mono">{Math.round(hubPeakDay.totalMw).toLocaleString()} MW</span>{" "}
              ({hubPeakDay.month}/{hubPeakDay.day}/{hubPeakDay.year}) — PyPSA reduced-order bus{" "}
              <span className="font-mono text-teal-400">HB_{ercotHub}</span>
            </p>
          )}
        </CardContent>
      </Card>

      {/* Stress controls */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Stress Test Parameters
          </CardTitle>
          <CardDescription className="text-xs">
            Defaults reflect real base-case conditions; bounds extend to (or slightly beyond) observed best/worst case
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <SliderField
              label="Renewables Output" value={renewPct} onChange={setRenewPct} min={0} max={110} step={1}
              absolute={`${(combinedRenewMw / 1000).toFixed(1)} GW`}
              percent={`${renewPct}%`}
              color="text-teal-400"
              sub={`wind ${(windCf * 100).toFixed(0)}% CF / solar ${(solarCf * 100).toFixed(0)}% CF`}
            />
            <SliderField
              label="EV Load" value={evPct} onChange={setEvPct} min={40} max={220} step={5}
              absolute={`${Math.round(evMwValue).toLocaleString()} MW`}
              percent={`${evPct}%`}
              color="text-amber-400"
              sub="of forecasted EV increment"
            />
            <SliderField
              label="Datacenter Load" value={dcPct} onChange={setDcPct} min={30} max={300} step={5}
              absolute={`${Math.round(dcMwValue).toLocaleString()} MW`}
              percent={`${dcPct}%`}
              color="text-purple-400"
              sub="of forecasted DC pipeline"
            />
            <SliderField
              label="Gas Capacity Derate" value={gasDerate} onChange={setGasDerate} min={0} max={55} step={1}
              absolute={`−${(gasOfflineMw / 1000).toFixed(1)} GW`}
              percent={`−${gasDerate}%`}
              color="text-orange-400"
              sub="of 96.2 GW Tier-1 gas fleet"
            />
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button size="sm" variant="default" className="bg-teal-600 hover:bg-teal-700" disabled={isPending || !systemPeakDay} onClick={onRun}>
              {isPending ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Running PyPSA OPF...</> : "Run Stress Test"}
            </Button>
            <span className="text-xs text-muted-foreground">
              System-wide load implied: <span className="font-mono text-foreground">{(systemLoadMw / 1000).toFixed(1)} GW</span> · Full nodal OPF (ERCOT 340-bus Tier-2 model)
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-3 border-t border-border pt-3">
            <span className="text-foreground font-medium">Methodology: </span>
            Renewables default (50%) reproduces the real average wind/solar capacity factor from ercot_fuel_mix hourly
            data (Jan 2024–Jun 2026): wind 34.6% CF (σ 18.0pp), solar 31.6% CF (σ 40.2pp, day/night bimodal) — one shared
            knob can't hit both fuels' ceilings exactly, so the default is calibrated to match both real averages and the
            110% max is set by wind's ceiling (~76% CF, just beyond its observed historical max of 74.7%). Gas derate
            default (6%) is the real ERCOT gas fleet's average forced-outage rate (thermal_params, n=26 units); the 55%
            max reflects Winter Storm Uri (Feb 2021), when roughly half of ERCOT gas generation was simultaneously
            forced offline. EV/DC load bounds (40–220% / 30–300%) are scenario ranges (low/high adoption and pipeline
            uncertainty) — the forecast has no variance data to derive a statistical bound from.
          </p>
        </CardContent>
      </Card>

      {errorMsg && !isPending && (
        <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
          <ShieldAlert className="h-5 w-5 mt-0.5 shrink-0 text-red-300" />
          <div>
            <span className="font-semibold text-base text-red-300">Grid Status: CRITICAL — Infeasible</span>
            <p className="text-sm text-muted-foreground mt-0.5">
              {errorMsg}. The stressed load exceeds total available generation even after full dispatch — this
              scenario represents a total system collapse, not a partial shortage.
            </p>
          </div>
        </div>
      )}

      {result && !isPending && !errorMsg && (
        <>
          <div className={`flex items-start gap-3 rounded-lg border ${levelColors.border} ${levelColors.bg} px-4 py-3`}>
            <ShieldAlert className={`h-5 w-5 mt-0.5 shrink-0 ${levelColors.text}`} />
            <div>
              <span className={`font-semibold text-base ${levelColors.text}`}>Grid Status: {level}</span>
              <p className="text-sm text-muted-foreground mt-0.5">
                Reserve margin {result.reserve_margin_pct.toFixed(1)}% · Max LMP ${result.max_lmp.toLocaleString()}/MWh ·{" "}
                {result.total_load_shed_mw > 0 ? `${(result.total_load_shed_mw / 1000).toFixed(1)} GW unserved` : "No load shedding"}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: "Implied System Load", value: `${(result.system_load_mw / 1000).toFixed(0)} GW` },
              { label: "Available Capacity",  value: `${(result.total_available_mw / 1000).toFixed(0)} GW` },
              { label: "Reserve Margin",       value: `${result.reserve_margin_pct.toFixed(1)}%` },
              { label: "Max LMP",              value: `$${result.max_lmp.toLocaleString()}` },
            ].map(k => (
              <Card key={k.label} className="bg-card border-border">
                <CardContent className="pt-3 pb-2 px-3">
                  <div className="text-xs text-muted-foreground">{k.label}</div>
                  <div className="text-xl font-bold font-mono text-foreground">{k.value}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Nodal LMP by Zone</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[180px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={result.zone_risk} margin={{ top: 4, right: 16, left: -10, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="zone" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                    <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={v => `$${v}`} />
                    <RechartsTooltip contentStyle={TS} formatter={(v: number) => [`$${v.toFixed(0)}/MWh`]} />
                    <Bar dataKey="lmp" radius={[2, 2, 0, 0]}>
                      {result.zone_risk.map((z, i) => (
                        <Cell key={i} fill={z.zone === ercotHub ? "#14b8a6" : "#475569"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
                <Info className="h-3 w-3" /> Highlighted bar = your selected hub ({ercotHub}).
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ── CAISO panel ───────────────────────────────────────────────────────────────

function CaisoPanel(props: {
  loading: boolean;
  cap?: CaisoCapacityResponse;
  hubLabel: string;
  renewPct: number; setRenewPct: (v: number) => void;
  windCf: number; solarCf: number;
  gasDerate: number; setGasDerate: (v: number) => void;
  caisoLoadMw: number; setCaisoLoadMw: (v: number) => void;
  caisoEvAdd: number; setCaisoEvAdd: (v: number) => void;
  caisoDcAdd: number; setCaisoDcAdd: (v: number) => void;
  analysis: { available: number; stressedLoad: number; reserveMarginPct: number; deficitMw: number; level: string;
    breakdown: Array<{ fuelType: string; nameplateMw: number; availableMw: number }> } | null;
}) {
  const { loading, cap, hubLabel, renewPct, setRenewPct, windCf, solarCf, gasDerate, setGasDerate,
    caisoLoadMw, setCaisoLoadMw, caisoEvAdd, setCaisoEvAdd, caisoDcAdd, setCaisoDcAdd, analysis } = props;

  if (loading || !cap) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">Loading CAISO capacity…</div>;
  }

  const levelColors = LEVEL_COLORS[analysis?.level ?? "NORMAL"];
  const caisoWindMw = cap.byFuelType.find(f => f.fuelType === "wind")?.capacityMw ?? 0;
  const caisoSolarMw = cap.byFuelType.find(f => f.fuelType === "solar")?.capacityMw ?? 0;
  const caisoGasMw = cap.byFuelType.find(f => f.fuelType === "natural_gas")?.capacityMw ?? 0;
  const caisoRenewMw = windCf * caisoWindMw + solarCf * caisoSolarMw;
  const caisoGasOfflineMw = caisoGasMw * (gasDerate / 100);

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <Info className="h-5 w-5 mt-0.5 shrink-0 text-amber-300" />
        <p className="text-sm text-amber-200">
          CAISO reserve-margin estimate — no nodal OPF / transmission model exists for CAISO yet (ERCOT only).
          Capacity is real EIA-860 installed capacity for {hubLabel}; load is a user-specified scenario since
          no CAISO load forecast dataset is available (ERCOT's is a real OLS regression on EIA-930 data).
          Renewables/Gas Derate defaults below are calibrated from ERCOT real data since CAISO has no equivalent
          hourly fuel-mix dataset.
        </p>
      </div>

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Installed Capacity — {hubLabel}</CardTitle>
          <CardDescription className="text-xs">Real EIA-860 2024 operable generators, {cap.totalMw.toLocaleString()} MW total</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={cap.byFuelType} margin={{ top: 4, right: 16, left: -10, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis dataKey="fuelType" tick={{ fontSize: 10, fill: "#94a3b8" }} />
                <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }} tickFormatter={v => `${(v / 1000).toFixed(0)}GW`} />
                <RechartsTooltip contentStyle={TS} formatter={(v: number) => [`${v.toLocaleString()} MW`]} />
                <Bar dataKey="capacityMw" radius={[2, 2, 0, 0]}>
                  {cap.byFuelType.map((f, i) => <Cell key={i} fill={FUEL_COLORS[f.fuelType] ?? "#64748b"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Stress Test Parameters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-4">
            <SliderField label="System Load" value={caisoLoadMw} onChange={setCaisoLoadMw} min={10000} max={35000} step={500}
              absolute={`${(caisoLoadMw / 1000).toFixed(1)} GW`} color="text-red-400" sub="scenario input (no forecast data)" />
            <SliderField label="EV Load Add" value={caisoEvAdd} onChange={setCaisoEvAdd} min={0} max={3000} step={100}
              absolute={`+${caisoEvAdd.toLocaleString()} MW`} color="text-amber-400" sub="stress increment" />
            <SliderField label="Datacenter Load Add" value={caisoDcAdd} onChange={setCaisoDcAdd} min={0} max={5000} step={100}
              absolute={`+${caisoDcAdd.toLocaleString()} MW`} color="text-purple-400" sub="stress increment" />
            <SliderField label="Gas Capacity Derate" value={gasDerate} onChange={setGasDerate} min={0} max={55} step={1}
              absolute={`−${(caisoGasOfflineMw / 1000).toFixed(2)} GW`} percent={`−${gasDerate}%`}
              color="text-orange-400" sub={`of ${(caisoGasMw / 1000).toFixed(1)} GW ${hubLabel} gas fleet`} />
          </div>
          <SliderField label="Renewables Output" value={renewPct} onChange={setRenewPct} min={0} max={110} step={1}
            absolute={`${(caisoRenewMw / 1000).toFixed(1)} GW`} percent={`${renewPct}%`}
            color="text-teal-400" sub={`wind ${(windCf * 100).toFixed(0)}% CF / solar ${(solarCf * 100).toFixed(0)}% CF, ERCOT-calibrated`} />
        </CardContent>
      </Card>

      {analysis && (
        <>
          <div className={`flex items-start gap-3 rounded-lg border ${levelColors.border} ${levelColors.bg} px-4 py-3`}>
            <ShieldAlert className={`h-5 w-5 mt-0.5 shrink-0 ${levelColors.text}`} />
            <div>
              <span className={`font-semibold text-base ${levelColors.text}`}>Grid Status: {analysis.level}</span>
              <p className="text-sm text-muted-foreground mt-0.5">
                Reserve margin {analysis.reserveMarginPct.toFixed(1)}% ·{" "}
                {analysis.deficitMw > 0 ? `${(analysis.deficitMw / 1000).toFixed(1)} GW capacity deficit` : "Adequate capacity"}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: "Stressed Load",       value: `${(analysis.stressedLoad / 1000).toFixed(1)} GW` },
              { label: "Available Capacity",  value: `${(analysis.available / 1000).toFixed(1)} GW` },
              { label: "Reserve Margin",       value: `${analysis.reserveMarginPct.toFixed(1)}%` },
              { label: "Capacity Deficit",     value: analysis.deficitMw > 0 ? `${(analysis.deficitMw / 1000).toFixed(1)} GW` : "None" },
            ].map(k => (
              <Card key={k.label} className="bg-card border-border">
                <CardContent className="pt-3 pb-2 px-3">
                  <div className="text-xs text-muted-foreground">{k.label}</div>
                  <div className="text-xl font-bold font-mono text-foreground">{k.value}</div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      <Card className="bg-card border-border">
        <CardContent className="pt-4 pb-3">
          <p className="text-xs text-muted-foreground">
            <span className="text-foreground font-medium">Methodology: </span>
            Wind/solar available MW = nameplate × capacity factor slider. Gas available MW = nameplate × (1 − derate).
            Nuclear/hydro/geothermal/biomass/storage use fixed typical availability factors (95% / 40% / 90% / 85% / 90%)
            — not derived from real dispatch data, unlike ERCOT's PyPSA OPF. Reserve margin = (available − stressed load) / stressed load.
            Renewables/Gas Derate slider calibration (default, ceilings) is ERCOT-derived (ercot_fuel_mix, thermal_params)
            since no equivalent CAISO hourly dataset exists yet. This is a system-wide adequacy screen, not a locational price signal.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Shared slider field ─────────────────────────────────────────────────────

function SliderField(props: {
  label: string; value: number; onChange: (v: number) => void;
  min: number; max: number; step: number;
  absolute: string; percent?: string; color: string; sub?: string;
}) {
  const { label, value, onChange, min, max, step, absolute, percent, color, sub } = props;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className={`font-mono font-semibold ${color}`}>{absolute}</span>
      </div>
      <Slider min={min} max={max} step={step} value={[value]} onValueChange={([v]) => onChange(v)} />
      <div className="flex justify-between items-center mt-1">
        {percent ? <span className={`text-xs font-mono ${color}`}>{percent}</span> : <span />}
        {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      </div>
    </div>
  );
}
