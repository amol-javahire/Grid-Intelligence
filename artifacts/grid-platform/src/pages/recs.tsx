import { useState, useMemo, useRef, useEffect } from "react";
import { useListCandidates, useListQueueProjects } from "@workspace/api-client-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
  Tooltip as RechartsTooltip, Cell, PieChart, Pie, Legend,
} from "recharts";
import {
  Loader2, ArrowUpDown, Leaf, Sun, Wind, Droplets, Zap, Info,
  Building2, ListTree, Search, X,
} from "lucide-react";

const ELIGIBLE_TYPES = new Set([
  "solar", "wind", "offshore_wind", "hydro",
  "geothermal", "biomass", "hybrid", "solar_storage", "wind_storage",
]);

const TYPE_LABELS: Record<string, string> = {
  solar: "Solar", wind: "Wind", offshore_wind: "Offshore Wind",
  hydro: "Hydro", geothermal: "Geothermal", biomass: "Biomass",
  hybrid: "Hybrid", solar_storage: "Solar + Storage", wind_storage: "Wind + Storage",
};

const TYPE_COLORS: Record<string, string> = {
  solar: "#f59e0b", wind: "#14b8a6", offshore_wind: "#06b6d4",
  hydro: "#3b82f6", geothermal: "#84cc16", biomass: "#22c55e",
  hybrid: "#ec4899", solar_storage: "#f97316", wind_storage: "#8b5cf6",
};

const MARKET_COLORS: Record<string, string> = {
  ERCOT: "#14b8a6", CAISO: "#f59e0b",
};

function TypeIcon({ type }: { type: string }) {
  if (type === "solar" || type === "solar_storage") return <Sun className="h-3.5 w-3.5 shrink-0" style={{ color: TYPE_COLORS.solar }} />;
  if (type === "wind" || type === "wind_storage") return <Wind className="h-3.5 w-3.5 shrink-0" style={{ color: TYPE_COLORS.wind }} />;
  if (type === "offshore_wind") return <Wind className="h-3.5 w-3.5 shrink-0" style={{ color: TYPE_COLORS.offshore_wind }} />;
  if (type === "hydro") return <Droplets className="h-3.5 w-3.5 shrink-0" style={{ color: TYPE_COLORS.hydro }} />;
  if (type === "biomass") return <Leaf className="h-3.5 w-3.5 shrink-0" style={{ color: TYPE_COLORS.biomass }} />;
  return <Zap className="h-3.5 w-3.5 shrink-0" style={{ color: TYPE_COLORS[type] ?? "#94a3b8" }} />;
}

function fmtM(v: number) {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000)     return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)         return `$${(v / 1_000).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}
function fmtMwh(v: number) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M MWh`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(0)}k MWh`;
  return `${v.toFixed(0)} MWh`;
}

const TOOLTIP_STYLE = {
  backgroundColor: "#0f172a", borderColor: "#1e293b", color: "#f8fafc", fontSize: 12,
};

type SortField = "annualRecValueUsd" | "annualRecMwh" | "recPricePerMwh" | "lifetimeRecValue20yr" | "capacityMw";
type DataSource = "operational" | "queue";

// ── Plant combobox ─────────────────────────────────────────────────────────────
function PlantCombobox({
  plants,
  value,
  onChange,
}: {
  plants: string[];
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const filtered = useMemo(() => {
    if (!query) return plants.slice(0, 200);
    const q = query.toLowerCase();
    return plants.filter(p => p.toLowerCase().includes(q)).slice(0, 200);
  }, [plants, query]);

  function select(name: string) {
    onChange(name);
    setQuery(name);
    setOpen(false);
  }

  function clear() {
    onChange(undefined);
    setQuery("");
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative w-[260px]">
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          className="pl-8 pr-8 h-9 text-sm"
          placeholder="Search plants…"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={e => {
            setQuery(e.target.value);
            if (value) onChange(undefined);
            setOpen(true);
          }}
        />
        {(query || value) && (
          <button
            className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
            onClick={clear}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {open && filtered.length > 0 && (
        <div className="absolute top-full mt-1 left-0 right-0 z-50 bg-slate-900 border border-slate-700 rounded-md shadow-xl max-h-[260px] overflow-y-auto">
          {filtered.map(name => (
            <button
              key={name}
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-slate-700 truncate ${value === name ? "text-teal-400 font-medium" : "text-slate-200"}`}
              onMouseDown={e => { e.preventDefault(); select(name); }}
            >
              {name}
            </button>
          ))}
          {plants.length > 200 && !query && (
            <div className="px-3 py-1.5 text-xs text-muted-foreground border-t border-slate-700">
              Showing first 200 — type to narrow
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function RECAnalysis() {
  const [dataSource, setDataSource] = useState<DataSource>("operational");
  const [marketFilter, setMarket]   = useState<string | undefined>(undefined);
  const [typeFilter,   setType]     = useState<string | undefined>(undefined);
  const [stateFilter,  setState]    = useState<string | undefined>(undefined);
  const [plantFilter,  setPlant]    = useState<string | undefined>(undefined);
  const [sortField,    setSortField] = useState<SortField>("annualRecValueUsd");
  const [sortDir,      setSortDir]  = useState<"desc" | "asc">("desc");

  const { data: candidateData, isLoading: loadingCandidates } = useListCandidates({});
  const { data: queueData,     isLoading: loadingQueue }      = useListQueueProjects({ limit: 3000 } as any);

  const isLoading = dataSource === "operational" ? loadingCandidates : loadingQueue;

  // ── Base eligible set ─────────────────────────────────────────────────────
  const eligible = useMemo(() => {
    if (dataSource === "operational") {
      return (candidateData as any[] ?? []).filter(c => c.recEligible === true);
    }
    return (queueData as any[] ?? [])
      .filter(q => q.recEligible === true)
      .map(q => ({
        ...q,
        name:              q.projectName,
        assetType:         q.fuelType,
        commissioningYear: q.requestDate ? new Date(q.requestDate).getFullYear() : null,
      }));
  }, [dataSource, candidateData, queueData]);

  // ── Progressive filter stages ─────────────────────────────────────────────
  const filteredByMarket = useMemo(() =>
    marketFilter ? eligible.filter(c => c.market === marketFilter) : eligible,
    [eligible, marketFilter]);

  const filteredByMarketType = useMemo(() =>
    typeFilter ? filteredByMarket.filter(c => c.assetType === typeFilter) : filteredByMarket,
    [filteredByMarket, typeFilter]);

  const filteredByMarketTypeState = useMemo(() =>
    stateFilter ? filteredByMarketType.filter(c => (c.state ?? "") === stateFilter) : filteredByMarketType,
    [filteredByMarketType, stateFilter]);

  const filtered = useMemo(() => {
    let rows = plantFilter
      ? filteredByMarketTypeState.filter(c => (c.name ?? c.projectName) === plantFilter)
      : filteredByMarketTypeState;
    return [...rows].sort((a, b) => {
      const av = (a as any)[sortField] ?? 0;
      const bv = (b as any)[sortField] ?? 0;
      return sortDir === "desc" ? bv - av : av - bv;
    });
  }, [filteredByMarketTypeState, plantFilter, sortField, sortDir]);

  // ── Derived filter options ────────────────────────────────────────────────
  const availableStates = useMemo(() => {
    const s = new Set<string>();
    filteredByMarketType.forEach(c => { if (c.state) s.add(c.state); });
    return [...s].sort();
  }, [filteredByMarketType]);

  const availablePlants = useMemo(() => {
    const names = filteredByMarketTypeState.map(c => c.name ?? c.projectName).filter(Boolean);
    return [...new Set(names)].sort();
  }, [filteredByMarketTypeState]);

  const availableTypes = useMemo(() => {
    const s = new Set<string>();
    filteredByMarket.forEach(c => { if (c.assetType) s.add(c.assetType); });
    return [...s].filter(t => ELIGIBLE_TYPES.has(t)).sort();
  }, [filteredByMarket]);

  // ── KPI stats ─────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    if (!filtered.length) return null;
    const totalAnnualMwh   = filtered.reduce((s, c) => s + ((c as any).annualRecMwh    ?? 0), 0);
    const totalAnnualValue = filtered.reduce((s, c) => s + ((c as any).annualRecValueUsd ?? 0), 0);
    const total20yr        = filtered.reduce((s, c) => s + ((c as any).lifetimeRecValue20yr ?? 0), 0);
    const avgPrice = totalAnnualMwh > 0
      ? filtered.reduce((s, c) => s + ((c as any).recPricePerMwh ?? 0) * ((c as any).annualRecMwh ?? 0), 0) / totalAnnualMwh
      : 0;
    return { totalAnnualMwh, totalAnnualValue, total20yr, avgPrice, count: filtered.length };
  }, [filtered]);

  // ── Year × Technology stacked bar ─────────────────────────────────────────
  const yearTechData = useMemo(() => {
    const yearMap: Record<number, Record<string, number>> = {};
    const techSet = new Set<string>();
    filtered.forEach(r => {
      const yr: number | null = (r as any).commissioningYear ?? null;
      if (!yr || yr < 1985 || yr > 2030) return;
      const tech = (r as any).assetType ?? "other";
      techSet.add(tech);
      if (!yearMap[yr]) yearMap[yr] = {};
      yearMap[yr][tech] = (yearMap[yr][tech] ?? 0) + ((r as any).annualRecValueUsd ?? 0);
    });
    const rows = Object.entries(yearMap)
      .map(([yr, d]) => {
        const row: Record<string, number> = { year: parseInt(yr) };
        techSet.forEach(t => { row[t] = Math.round((d[t] ?? 0) / 1_000_000 * 10) / 10; });
        return row;
      })
      .sort((a, b) => a.year - b.year);
    const techs = [...techSet].sort((a, b) => {
      const aT = rows.reduce((s, r) => s + (r[a] ?? 0), 0);
      const bT = rows.reduce((s, r) => s + (r[b] ?? 0), 0);
      return bT - aT;
    });
    return { rows, techs };
  }, [filtered]);

  // ── By-type pie ───────────────────────────────────────────────────────────
  const typeData = useMemo(() => {
    const t: Record<string, { annualValue: number; count: number }> = {};
    filtered.forEach(c => {
      const tp = (c as any).assetType;
      if (!t[tp]) t[tp] = { annualValue: 0, count: 0 };
      t[tp].annualValue += (c as any).annualRecValueUsd ?? 0;
      t[tp].count++;
    });
    return Object.entries(t)
      .map(([type, d]) => ({ type, ...d, fill: TYPE_COLORS[type] ?? "#94a3b8" }))
      .sort((a, b) => b.annualValue - a.annualValue);
  }, [filtered]);

  // ── Market summary ────────────────────────────────────────────────────────
  const marketData = useMemo(() => {
    const m: Record<string, { annualValue: number; annualMwh: number; count: number }> = {};
    filtered.forEach(c => {
      const mkt = c.market;
      if (!m[mkt]) m[mkt] = { annualValue: 0, annualMwh: 0, count: 0 };
      m[mkt].annualValue += (c as any).annualRecValueUsd ?? 0;
      m[mkt].annualMwh   += (c as any).annualRecMwh    ?? 0;
      m[mkt].count++;
    });
    return Object.entries(m)
      .map(([market, d]) => ({ market, ...d }))
      .sort((a, b) => b.annualValue - a.annualValue);
  }, [filtered]);

  const handleSort = (f: SortField) => {
    if (sortField === f) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortField(f); setSortDir("desc"); }
  };

  const SortHead = ({ field, label }: { field: SortField; label: string }) => (
    <button
      className={`flex items-center gap-1 hover:text-primary transition-colors ml-auto ${sortField === field ? "text-primary" : ""}`}
      onClick={() => handleSort(field)}
    >
      {label}<ArrowUpDown className="h-3 w-3" />
    </button>
  );

  const yearLabel = dataSource === "operational" ? "Commissioning Year" : "Queue Entry Year";
  const activeFilterCount = [marketFilter, typeFilter, stateFilter, plantFilter].filter(Boolean).length;

  return (
    <TooltipProvider>
      <div className="p-6 h-full flex flex-col space-y-4">

        {/* ── Header + data source tabs ── */}
        <div className="shrink-0 flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <Leaf className="h-5 w-5 text-emerald-400" />
              <h1 className="text-2xl font-bold tracking-tight">REC Analysis</h1>
            </div>
            <p className="text-muted-foreground text-sm">
              Renewable Energy Credit valuation across ERCOT and CAISO — solar, wind, hydro, geothermal, biomass only.
            </p>
          </div>
          <div className="flex rounded-md border border-border overflow-hidden shrink-0 self-start">
            <Button
              variant="ghost" size="sm"
              className={`rounded-none gap-2 px-4 border-r border-border ${dataSource === "operational" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => { setDataSource("operational"); setType(undefined); setState(undefined); setPlant(undefined); }}
            >
              <Building2 className="h-3.5 w-3.5" />Operational Generators
            </Button>
            <Button
              variant="ghost" size="sm"
              className={`rounded-none gap-2 px-4 ${dataSource === "queue" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => { setDataSource("queue"); setType(undefined); setState(undefined); setPlant(undefined); }}
            >
              <ListTree className="h-3.5 w-3.5" />Interconnection Queue
            </Button>
          </div>
        </div>

        {/* ── Filters ── */}
        <div className="shrink-0 flex flex-wrap gap-3 items-center bg-slate-900/60 border border-slate-700/50 rounded-lg px-4 py-3">
          {/* Market */}
          <Select value={marketFilter || "all"} onValueChange={v => {
            setMarket(v === "all" ? undefined : v);
            setType(undefined); setState(undefined); setPlant(undefined);
          }}>
            <SelectTrigger className="w-[130px] h-9"><SelectValue placeholder="All Markets" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Markets</SelectItem>
              <SelectItem value="ERCOT">ERCOT</SelectItem>
              <SelectItem value="CAISO">CAISO</SelectItem>
            </SelectContent>
          </Select>

          {/* Type */}
          <Select value={typeFilter || "all"} onValueChange={v => {
            setType(v === "all" ? undefined : v);
            setState(undefined); setPlant(undefined);
          }}>
            <SelectTrigger className="w-[165px] h-9"><SelectValue placeholder="All Types" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {availableTypes.map(t => (
                <SelectItem key={t} value={t}>{TYPE_LABELS[t] ?? t}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* State */}
          <Select value={stateFilter || "all"} onValueChange={v => {
            setState(v === "all" ? undefined : v);
            setPlant(undefined);
          }}>
            <SelectTrigger className="w-[115px] h-9"><SelectValue placeholder="All States" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All States</SelectItem>
              {availableStates.map(s => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Plant combobox */}
          <PlantCombobox
            plants={availablePlants}
            value={plantFilter}
            onChange={v => setPlant(v)}
          />

          {/* Active filter chips */}
          {activeFilterCount > 0 && (
            <button
              className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
              onClick={() => { setMarket(undefined); setType(undefined); setState(undefined); setPlant(undefined); }}
            >
              Clear all
            </button>
          )}

          <div className="ml-auto text-xs text-muted-foreground self-center whitespace-nowrap">
            {filtered.length.toLocaleString()} {dataSource === "operational" ? "plants" : "projects"}
          </div>
        </div>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* ── KPI cards ── */}
            {stats && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 shrink-0">
                <Card>
                  <CardHeader className="pb-1 pt-4 px-4"><CardDescription className="text-xs">Eligible Plants</CardDescription></CardHeader>
                  <CardContent className="pb-4 px-4">
                    <div className="text-2xl font-bold text-emerald-400">{stats.count.toLocaleString()}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {dataSource === "operational" ? "of 3,875 EIA 860" : "of ~3,493 in queue"}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-1 pt-4 px-4"><CardDescription className="text-xs">Annual REC Generation</CardDescription></CardHeader>
                  <CardContent className="pb-4 px-4">
                    <div className="text-2xl font-bold text-teal-400">{fmtMwh(stats.totalAnnualMwh)}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">portfolio-wide / yr</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-1 pt-4 px-4"><CardDescription className="text-xs">Annual REC Revenue</CardDescription></CardHeader>
                  <CardContent className="pb-4 px-4">
                    <div className="text-2xl font-bold text-amber-400">{fmtM(stats.totalAnnualValue)}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">avg ${stats.avgPrice.toFixed(2)}/MWh blended</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-1 pt-4 px-4"><CardDescription className="text-xs">20-Year REC Value</CardDescription></CardHeader>
                  <CardContent className="pb-4 px-4">
                    <div className="text-2xl font-bold text-purple-400">{fmtM(stats.total20yr)}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">undiscounted</div>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* ── Charts ── */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 shrink-0">
              <Card className="lg:col-span-2">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Annual REC Value by {yearLabel} & Technology ($M/yr)</CardTitle>
                  <CardDescription className="text-xs">Stacked by technology — shows vintage and fuel type driving REC portfolio</CardDescription>
                </CardHeader>
                <CardContent style={{ height: 220 }}>
                  {yearTechData.rows.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={yearTechData.rows} margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e2d3e" vertical={false} />
                        <XAxis dataKey="year" stroke="#64748b" tick={{ fill: "#64748b", fontSize: 10 }} />
                        <YAxis stroke="#64748b" tick={{ fill: "#64748b", fontSize: 10 }} tickFormatter={v => `$${v}M`} width={48} />
                        <RechartsTooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number, name: string) => [`$${v.toFixed(1)}M/yr`, name.replace(/_/g, " ")]} />
                        {yearTechData.techs.map(tech => (
                          <Bar key={tech} dataKey={tech} stackId="a" fill={TYPE_COLORS[tech] ?? "#94a3b8"} name={tech} isAnimationActive={false} />
                        ))}
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-full flex items-center justify-center text-muted-foreground text-sm">No data for current filters</div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Annual Value by Technology</CardTitle>
                  <CardDescription className="text-xs">Share of total REC revenue</CardDescription>
                </CardHeader>
                <CardContent style={{ height: 220 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        isAnimationActive={false}
                        data={typeData}
                        cx="38%" cy="50%"
                        innerRadius={44} outerRadius={76}
                        paddingAngle={2}
                        dataKey="annualValue"
                        nameKey="type"
                      >
                        {typeData.map((entry, i) => <Cell key={i} fill={entry.fill} stroke="transparent" />)}
                      </Pie>
                      <RechartsTooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number, name: string) => [fmtM(v), String(name).replace(/_/g, " ")]} />
                      <Legend
                        layout="vertical" align="right" verticalAlign="middle"
                        formatter={(v) => <span style={{ color: "#f8fafc", fontSize: 11 }}>{v.replace(/_/g, " ")}</span>}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>

            {/* ── Market summary ── */}
            {marketData.length > 0 && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 shrink-0">
                {marketData.map(m => (
                  <div key={m.market} className="bg-card border border-border rounded-md px-4 py-3 flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: MARKET_COLORS[m.market] }} />
                        <span className="font-semibold text-sm">{m.market}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">{m.count} plants · {fmtMwh(m.annualMwh)}</div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold text-base" style={{ color: MARKET_COLORS[m.market] }}>{fmtM(m.annualValue)}/yr</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Table ── */}
            <div className="border rounded-md flex-1 overflow-auto bg-card min-h-[200px]">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10 shadow-sm">
                  <TableRow>
                    <TableHead className="w-8 text-xs">#</TableHead>
                    <TableHead className="w-[200px]">Plant</TableHead>
                    <TableHead>Market</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="text-xs text-muted-foreground">State</TableHead>
                    <TableHead className="text-right"><SortHead field="capacityMw" label="MW" /></TableHead>
                    <TableHead className="text-right"><SortHead field="annualRecMwh" label="RECs/yr" /></TableHead>
                    <TableHead className="text-right"><SortHead field="recPricePerMwh" label="$/MWh" /></TableHead>
                    <TableHead className="text-right"><SortHead field="annualRecValueUsd" label="Annual Value" /></TableHead>
                    <TableHead className="text-right"><SortHead field="lifetimeRecValue20yr" label="20yr Value" /></TableHead>
                    <TableHead>REC Program</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={11} className="h-24 text-center text-muted-foreground">
                        No eligible plants match the current filters.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filtered.map((c, idx) => {
                      const recMwh = (c as any).annualRecMwh       ?? 0;
                      const recVal = (c as any).annualRecValueUsd   ?? 0;
                      const rec20  = (c as any).lifetimeRecValue20yr ?? 0;
                      const price  = (c as any).recPricePerMwh      ?? 0;
                      const label  = (c as any).recMarketLabel       ?? "";
                      const name   = (c as any).name ?? (c as any).projectName ?? "—";
                      return (
                        <TableRow key={`${(c as any).id}-${idx}`} className="hover:bg-muted/30 text-sm">
                          <TableCell className="text-xs text-muted-foreground">{idx + 1}</TableCell>
                          <TableCell>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="font-medium truncate block max-w-[190px] cursor-default">{name}</span>
                              </TooltipTrigger>
                              <TooltipContent side="right" className="text-xs max-w-[240px]">
                                <p className="font-semibold mb-1">{name}</p>
                                {(c as any).notes && (
                                  <p className="text-muted-foreground">{(c as any).notes.replace("Source: EIA 860 2024 | ", "")}</p>
                                )}
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs" style={{ borderColor: MARKET_COLORS[c.market], color: MARKET_COLORS[c.market] }}>
                              {c.market}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <TypeIcon type={(c as any).assetType} />
                              <span className="text-xs capitalize">{((c as any).assetType ?? "").replace(/_/g, " ")}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{c.state ?? "—"}</TableCell>
                          <TableCell className="text-right text-xs font-medium">
                            {parseFloat((c as any).capacityMw).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </TableCell>
                          <TableCell className="text-right text-xs">{recMwh.toLocaleString()}</TableCell>
                          <TableCell className="text-right text-xs font-medium">${price.toFixed(2)}</TableCell>
                          <TableCell className="text-right">
                            <span className="text-emerald-400 font-semibold text-sm">{fmtM(recVal)}/yr</span>
                          </TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground">{fmtM(rec20)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{label}</TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>

            {/* ── Methodology ── */}
            <div className="shrink-0 border border-slate-700/50 rounded-lg bg-slate-900/40 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Info className="h-4 w-4 text-primary shrink-0" />
                <h3 className="text-sm font-semibold">Methodology &amp; REC Price Reference</h3>
              </div>

              <p className="text-xs text-muted-foreground">
                <span className="text-foreground font-medium">Generation:</span> Annual RECs (MWh) = Capacity (MW) × Capacity Factor × 8,760 h/yr.
                Capacity factors: solar ERCOT 27%, CAISO 29%; wind ERCOT 38%, CAISO 28%; geothermal 88%; biomass 65%. (Potomac Economics 2024 SOTM; CAISO 2024 annual statistics)
                {dataSource === "operational"
                  ? " Source: EIA Form 860 2024 — operable generators >1 MW. Year = commercial operation date (COD)."
                  : " Source: interconnection queue filings across ERCOT and CAISO. Year = queue entry date."}
              </p>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                {/* ERCOT */}
                <div className="bg-slate-800/50 rounded-md p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: MARKET_COLORS.ERCOT }}>
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: MARKET_COLORS.ERCOT }} />
                    ERCOT — Texas TRC
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Texas Renewable Energy Credits (TRCs) are the ERCOT compliance instrument. Wind dominates TRC supply,
                    keeping prices low; solar commands a modest premium due to scarcity.
                  </p>
                  <table className="w-full text-xs mt-1">
                    <thead><tr className="text-muted-foreground"><th className="text-left font-normal">Type</th><th className="text-right font-normal">Price</th></tr></thead>
                    <tbody>
                      {[["Wind", "$2.00/MWh"],["Solar", "$5.00/MWh"],["Hydro / Biomass", "$1.50/MWh"],["Geothermal", "$2.00/MWh"]].map(([t, p]) => (
                        <tr key={t}><td className="text-foreground py-0.5">{t}</td><td className="text-right text-emerald-400 font-medium">{p}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* CAISO */}
                <div className="bg-slate-800/50 rounded-md p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: MARKET_COLORS.CAISO }}>
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: MARKET_COLORS.CAISO }} />
                    CAISO — CA WREGIS RPS
                  </div>
                  <p className="text-xs text-muted-foreground">
                    California WREGIS RECs under the RPS mandate. Category 1 (new, delivered to CA) commands highest premiums.
                    Solar and geothermal RECs are most valued; hydro and biomass lower.
                  </p>
                  <table className="w-full text-xs mt-1">
                    <thead><tr className="text-muted-foreground"><th className="text-left font-normal">Type</th><th className="text-right font-normal">Price</th></tr></thead>
                    <tbody>
                      {[["Solar", "$10.00/MWh"],["Geothermal", "$8.00/MWh"],["Wind", "$6.00/MWh"],["Hydro / Biomass", "$5.00/MWh"]].map(([t, p]) => (
                        <tr key={t}><td className="text-foreground py-0.5">{t}</td><td className="text-right text-emerald-400 font-medium">{p}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>

              </div>
            </div>
          </>
        )}
      </div>
    </TooltipProvider>
  );
}
