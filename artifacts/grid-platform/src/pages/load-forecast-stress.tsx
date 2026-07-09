import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, TrendingUp, ShieldAlert, Info } from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  ResponsiveContainer, Tooltip as RechartsTooltip, Cell, Legend,
} from "recharts";

const API_BASE = "/api";
const PYPSA_BASE = "/pypsa";
const TS = { backgroundColor: "#0f172a", borderColor: "#1e293b", color: "#f8fafc", fontSize: 11 };

// ── ERCOT zone config ────────────────────────────────────────────────────────

const ERCOT_ZONES: Record<string, { label: string; color: string; bus: string }> = {
  COAS: { label: "Coast",         color: "#14b8a6", bus: "HOUSTON" },
  EAST: { label: "East",          color: "#22c55e", bus: "HOUSTON" },
  NCEN: { label: "North Central", color: "#8b5cf6", bus: "NORTH" },
  NRTH: { label: "North",         color: "#f59e0b", bus: "NORTH" },
  FWES: { label: "Far West",      color: "#f97316", bus: "WEST" },
  WEST: { label: "West",          color: "#ec4899", bus: "WEST" },
  SCEN: { label: "South Central", color: "#ef4444", bus: "SOUTH" },
  SOUT: { label: "South",         color: "#3b82f6", bus: "SOUTH" },
};

// Mirrors artifacts/pypsa-engine/network.py _T1_LOAD — used to scale a single
// zone's stressed load back up to a system-wide MW figure for the 5-bus model.
const LOAD_FRACTIONS: Record<string, number> = {
  HOUSTON: 0.38, NORTH: 0.22, SOUTH: 0.27, WEST: 0.11, PAN: 0.02,
};

interface LoadForecastRow {
  zone: string; year: number; month: number;
  baseMw: number; evMw: number; dcMw: number; totalMw: number; peakMw: number;
}

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
  const [ercotZone, setErcotZone] = useState("NCEN");
  const [caisoHub, setCaisoHub] = useState("SP15");

  const [renewPct, setRenewPct] = useState(50);
  const [evPct,    setEvPct]    = useState(100);
  const [dcPct,    setDcPct]    = useState(100);

  const [caisoLoadMw, setCaisoLoadMw] = useState(27000);
  const [caisoEvAdd,  setCaisoEvAdd]  = useState(500);
  const [caisoDcAdd,  setCaisoDcAdd]  = useState(1000);
  const [gasDerate,   setGasDerate]   = useState(15);

  // ── ERCOT data ──────────────────────────────────────────────────────────
  const { data: ercotRows = [], isLoading: ercotLoading } = useQuery<LoadForecastRow[]>({
    queryKey: ["load-forecast-overview"],
    queryFn: () => fetch(`${API_BASE}/load-forecast/overview`).then(r => r.json()),
    staleTime: 10 * 60 * 1000,
    enabled: iso === "ERCOT",
  });

  const zoneRows = useMemo(
    () => ercotRows.filter(r => r.zone === ercotZone).sort((a, b) => a.year - b.year || a.month - b.month),
    [ercotRows, ercotZone]
  );

  const zoneChartData = useMemo(() => zoneRows.map(r => ({
    label: `${r.month}/${String(r.year).slice(2)}`,
    base: Math.round(r.baseMw), ev: Math.round(r.evMw), dc: Math.round(r.dcMw),
  })), [zoneRows]);

  const peakRow = useMemo(
    () => zoneRows.reduce<LoadForecastRow | null>(
      (max, r) => (!max || r.totalMw > max.totalMw ? r : max), null
    ),
    [zoneRows]
  );

  const mappedBus = ERCOT_ZONES[ercotZone]?.bus ?? "NORTH";
  const windCf  = (renewPct / 100) * 0.55;
  const solarCf = (renewPct / 100) * 0.35;

  const stressedZoneLoad = peakRow
    ? peakRow.baseMw + peakRow.evMw * (evPct / 100) + peakRow.dcMw * (dcPct / 100)
    : 0;
  const systemLoadMw = stressedZoneLoad / (LOAD_FRACTIONS[mappedBus] ?? 0.22);

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

      {/* Zone / Hub selector */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground uppercase tracking-wide">
          {iso === "ERCOT" ? "Zone" : "Hub"}
        </span>
        {iso === "ERCOT" ? (
          <Select value={ercotZone} onValueChange={setErcotZone}>
            <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(ERCOT_ZONES).map(([z, meta]) => (
                <SelectItem key={z} value={z}>{z} — {meta.label}</SelectItem>
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
          zoneMeta={ERCOT_ZONES[ercotZone]}
          peakRow={peakRow}
          mappedBus={mappedBus}
          renewPct={renewPct} setRenewPct={setRenewPct}
          evPct={evPct} setEvPct={setEvPct}
          dcPct={dcPct} setDcPct={setDcPct}
          gasDerate={gasDerate} setGasDerate={setGasDerate}
          windCf={windCf} solarCf={solarCf}
          systemLoadMw={systemLoadMw}
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
  zoneMeta?: { label: string; color: string; bus: string };
  peakRow: LoadForecastRow | null;
  mappedBus: string;
  renewPct: number; setRenewPct: (v: number) => void;
  evPct: number; setEvPct: (v: number) => void;
  dcPct: number; setDcPct: (v: number) => void;
  gasDerate: number; setGasDerate: (v: number) => void;
  windCf: number; solarCf: number;
  systemLoadMw: number;
  onRun: () => void;
  isPending: boolean;
  result?: ScarcityResult;
  level: string;
  errorMsg?: string;
}) {
  const { loading, zoneChartData, zoneMeta, peakRow, mappedBus, renewPct, setRenewPct,
    evPct, setEvPct, dcPct, setDcPct, gasDerate, setGasDerate, windCf, solarCf,
    systemLoadMw, onRun, isPending, result, level, errorMsg } = props;

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">Loading load forecast…</div>;
  }

  const levelColors = LEVEL_COLORS[level];

  return (
    <div className="space-y-6">
      {/* Forecast chart */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">3-Year Load Forecast — {zoneMeta?.label}</CardTitle>
          <CardDescription className="text-xs">
            OLS temperature regression + EV &amp; datacenter increments · Jul 2026 – Jun 2029 (real EIA-930 basis)
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
                <Area type="monotone" dataKey="base" stackId="1" stroke={zoneMeta?.color ?? "#14b8a6"} fill={zoneMeta?.color ?? "#14b8a6"} fillOpacity={0.35} />
                <Area type="monotone" dataKey="ev" stackId="1" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.35} />
                <Area type="monotone" dataKey="dc" stackId="1" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.35} />
                <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {peakRow && (
            <p className="text-xs text-muted-foreground mt-2">
              Forecasted peak: <span className="text-foreground font-mono">{peakRow.totalMw.toLocaleString()} MW</span>{" "}
              ({peakRow.month}/{peakRow.year}) — mapped to PyPSA reduced-order bus{" "}
              <span className="font-mono text-teal-400">{mappedBus}</span> ({(LOAD_FRACTIONS[mappedBus] * 100).toFixed(0)}% of ERCOT system load)
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
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <SliderField label="Renewables Output" value={renewPct} onChange={setRenewPct} min={0} max={100} step={5}
              display={`${renewPct}%`} color="text-teal-400" sub={`wind ${(windCf * 100).toFixed(0)}% CF / solar ${(solarCf * 100).toFixed(0)}% CF`} />
            <SliderField label="EV Load" value={evPct} onChange={setEvPct} min={50} max={300} step={10}
              display={`${evPct}%`} color="text-amber-400" sub="of forecasted EV increment" />
            <SliderField label="Datacenter Load" value={dcPct} onChange={setDcPct} min={50} max={400} step={10}
              display={`${dcPct}%`} color="text-purple-400" sub="of forecasted DC pipeline" />
            <SliderField label="Gas Capacity Derate" value={gasDerate} onChange={setGasDerate} min={0} max={50} step={5}
              display={`−${gasDerate}%`} color="text-orange-400" sub="freeze / maintenance outages" />
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button size="sm" variant="default" className="bg-teal-600 hover:bg-teal-700" disabled={isPending || !peakRow} onClick={onRun}>
              {isPending ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Running PyPSA OPF...</> : "Run Stress Test"}
            </Button>
            <span className="text-xs text-muted-foreground">
              System-wide load implied: <span className="font-mono text-foreground">{(systemLoadMw / 1000).toFixed(1)} GW</span> · Full nodal OPF (ERCOT 5-bus reduced-order model)
            </span>
          </div>
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
                        <Cell key={i} fill={z.zone === mappedBus ? "#14b8a6" : "#475569"} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
                <Info className="h-3 w-3" /> Highlighted bar = zone mapped from your selected forecast zone ({mappedBus}).
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
  gasDerate: number; setGasDerate: (v: number) => void;
  caisoLoadMw: number; setCaisoLoadMw: (v: number) => void;
  caisoEvAdd: number; setCaisoEvAdd: (v: number) => void;
  caisoDcAdd: number; setCaisoDcAdd: (v: number) => void;
  analysis: { available: number; stressedLoad: number; reserveMarginPct: number; deficitMw: number; level: string;
    breakdown: Array<{ fuelType: string; nameplateMw: number; availableMw: number }> } | null;
}) {
  const { loading, cap, hubLabel, renewPct, setRenewPct, gasDerate, setGasDerate,
    caisoLoadMw, setCaisoLoadMw, caisoEvAdd, setCaisoEvAdd, caisoDcAdd, setCaisoDcAdd, analysis } = props;

  if (loading || !cap) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground">Loading CAISO capacity…</div>;
  }

  const levelColors = LEVEL_COLORS[analysis?.level ?? "NORMAL"];

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <Info className="h-5 w-5 mt-0.5 shrink-0 text-amber-300" />
        <p className="text-sm text-amber-200">
          CAISO reserve-margin estimate — no nodal OPF / transmission model exists for CAISO yet (ERCOT only).
          Capacity is real EIA-860 installed capacity for {hubLabel}; load is a user-specified scenario since
          no CAISO load forecast dataset is available (ERCOT's is a real OLS regression on EIA-930 data).
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
              display={`${(caisoLoadMw / 1000).toFixed(1)} GW`} color="text-red-400" sub="scenario input (no forecast data)" />
            <SliderField label="EV Load Add" value={caisoEvAdd} onChange={setCaisoEvAdd} min={0} max={3000} step={100}
              display={`+${caisoEvAdd} MW`} color="text-amber-400" sub="stress increment" />
            <SliderField label="Datacenter Load Add" value={caisoDcAdd} onChange={setCaisoDcAdd} min={0} max={5000} step={100}
              display={`+${caisoDcAdd} MW`} color="text-purple-400" sub="stress increment" />
            <SliderField label="Gas Capacity Derate" value={gasDerate} onChange={setGasDerate} min={0} max={50} step={5}
              display={`−${gasDerate}%`} color="text-orange-400" sub="outages / maintenance" />
          </div>
          <SliderField label="Renewables Output" value={renewPct} onChange={setRenewPct} min={0} max={100} step={5}
            display={`${renewPct}%`} color="text-teal-400" sub="wind & solar CF applied to real nameplate MW" />
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
            This is a system-wide adequacy screen, not a locational price signal.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Shared slider field ─────────────────────────────────────────────────────

function SliderField(props: {
  label: string; value: number; onChange: (v: number) => void;
  min: number; max: number; step: number; display: string; color: string; sub?: string;
}) {
  const { label, value, onChange, min, max, step, display, color, sub } = props;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className={`font-mono ${color}`}>{display}</span>
      </div>
      <Slider min={min} max={max} step={step} value={[value]} onValueChange={([v]) => onChange(v)} />
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}
