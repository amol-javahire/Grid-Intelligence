import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import {
  useListCandidates,
  useDeleteCandidate,
  useCreateScreening,
  getListCandidatesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Loader2, Search, Download, Save, Trash2, ArrowUpDown,
  Wind, Sun, Zap, Flame, Droplets, Atom, Leaf, Info, BookOpen, Target, FlaskConical,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

// ─── Investment objectives ────────────────────────────────────────────────────
const OBJECTIVES = [
  {
    id: "risk_adjusted",
    label: "Risk-Adjusted Value",
    desc: "Curtailment 22% · Congestion 18% · Basis 15% · Capture Price 12% · Mkt Revenue 10% · Capacity 10% · Interconnect Risk 8% · RECs 5%",
    weights: { curtailmentScore: 0.22, interconnectionScore: 0.18, locationScore: 0.15, priceScore: 0.12, financialScore: 0.10, demandProximityScore: 0.10, developmentRiskScore: 0.08, environmentalScore: 0.05 },
  },
  {
    id: "lowest_lcoe",
    label: "Lowest LCOE",
    desc: "Minimize delivered cost — capture price 30% · curtailment 22% · congestion 15% · basis 12% · mkt revenue 10% · capacity 7% · interconnect 4%",
    weights: { priceScore: 0.30, curtailmentScore: 0.22, interconnectionScore: 0.15, locationScore: 0.12, financialScore: 0.10, demandProximityScore: 0.07, developmentRiskScore: 0.04 },
  },
  {
    id: "corporate_hedge",
    label: "Corporate Load Hedge",
    desc: "Reliability for corporate load hedging — curtailment 30% · congestion 22% · basis 18% · interconnect risk 12% · capture price 8% · capacity 7% · mkt revenue 3%",
    weights: { curtailmentScore: 0.30, interconnectionScore: 0.22, locationScore: 0.18, developmentRiskScore: 0.12, priceScore: 0.08, demandProximityScore: 0.07, financialScore: 0.03 },
  },
  {
    id: "decarbonization",
    label: "Decarbonization",
    desc: "Maximize clean MWh and REC impact — capacity 25% · curtailment 22% · RECs/yr 20% · mkt revenue 13% · congestion 10% · basis 7% · interconnect 3%",
    weights: { demandProximityScore: 0.25, curtailmentScore: 0.22, environmentalScore: 0.20, financialScore: 0.13, interconnectionScore: 0.10, locationScore: 0.07, developmentRiskScore: 0.03 },
  },
  {
    id: "capacity_value",
    label: "Capacity Value",
    desc: "Peak demand support — capacity 35% · curtailment 18% · congestion 15% · capture price 12% · basis 10% · interconnect 7% · mkt revenue 3%",
    weights: { demandProximityScore: 0.35, curtailmentScore: 0.18, interconnectionScore: 0.15, priceScore: 0.12, locationScore: 0.10, developmentRiskScore: 0.07, financialScore: 0.03 },
  },
  {
    id: "merchant_upside",
    label: "Merchant / Developer Upside",
    desc: "High capture price + market revenue for merchant tail — capture price 35% · basis 20% · mkt revenue 18% · congestion 12% · curtailment 10% · interconnect 5%",
    weights: { priceScore: 0.35, locationScore: 0.20, financialScore: 0.18, interconnectionScore: 0.12, curtailmentScore: 0.10, developmentRiskScore: 0.05 },
  },
] as const;

type ObjectiveId = typeof OBJECTIVES[number]["id"];

// ─── Score dimension config ───────────────────────────────────────────────────
const DIMS = [
  {
    key: "curtailmentScore" as const,
    label: "Curtailment",
    shortLabel: "Curt",
    color: "#f59e0b",
    tooltip: "Real neg_price_percent from market databases. ERCOT: CDR data — HB_PAN 21.9% neg-price hrs → wind score ~60; LZ_WEST 12.6% → wind ~85; LZ_HOUSTON 1.9% → wind ~98. CAISO: OASIS neg-pct by zone. PJM: real pjm_node_stats — <0.5% neg-price hrs (very stable); wind/solar score ~95+. Asset-type multiplier applied (wind 1.2–1.3×, gas 0.35–0.45×).",
  },
  {
    key: "interconnectionScore" as const,
    label: "Congestion",
    shortLabel: "Cong",
    color: "#ef4444",
    tooltip: "Real DA price basis vs market average + volatility penalty. ERCOT: LZ_LCRA $35.15 (+21%) → score 75; HB_PAN $19.83 (-32%) → score 5. CAISO: SP15 $30.77 (-7%) → gas ~45; NP15 $37.42 (+13%) → gas ~75. PJM: PSEG $53.25/JCPL → score ~65; DOM $43.53 → score ~42. All real: CDR 13060, OASIS, pjm_node_stats.",
  },
  {
    key: "locationScore" as const,
    label: "Basis Risk",
    shortLabel: "Basis",
    color: "#8b5cf6",
    tooltip: "Real price volatility (std dev of monthly DA prices). ERCOT: LZ_WEST vol 14.0 → score ~60 (most volatile); HB_SOUTH vol 8.3 → score ~74 (most stable). CAISO: ref vol 13.6 (score 62). PJM: hub/zone vol 9.4–12.2 (score 63–67); Eastern Hub/PSEG more volatile than Western Hub. Lower volatility = more predictable PPA settlement.",
  },
  {
    key: "priceScore" as const,
    label: "Capture Price",
    shortLabel: "Cap$",
    color: "#14b8a6",
    tooltip: "Real hub DA price × technology timing-capture ratio. Wind captures ~82% of hub avg (produces when prices are lower); solar ~103% (peaks during summer afternoon demand); storage ~118% (dispatches at peak). PJM: PSEG $53.25 DA → gas capture ~$53; DOM $43.53 → gas ~$44. Score 50 = system-average capture price.",
  },
  {
    key: "demandProximityScore" as const,
    label: "Capacity",
    shortLabel: "MW",
    color: "#3b82f6",
    tooltip: "Log-scaled plant size score. Larger plants are more attractive for large procurement programs. 2,000 MW → 93; 500 MW → 76; 100 MW → 58; 10 MW → 36.",
  },
  {
    key: "financialScore" as const,
    label: "Mkt Revenue",
    shortLabel: "Rev",
    color: "#22c55e",
    tooltip: "Annual energy market revenue = capacity × capacity factor × real hub DA price × capture ratio × 8,760 h. Log-scaled 0–100. $200M+/yr → 95; $50M → 80; $10M → 62; $1M → 42. PJM uses real pjm_node_stats DA prices ($43–53/MWh by zone). Reflects scale and market value of the asset.",
  },
  {
    key: "developmentRiskScore" as const,
    label: "Interconnect Risk",
    shortLabel: "IQ",
    color: "#f97316",
    tooltip: "Real total MW in interconnection queue for the same zone (from queue_projects DB). Heavy queue backlog = longer study timelines, higher upgrade costs, more withdrawal risk. PJM: PPL 26.6 GW → score 25; EASTERN HUB 12.9 GW → score 56. ERCOT/CAISO also from real queue data. Lower queue MW = higher score.",
  },
  {
    key: "environmentalScore" as const,
    label: "RECs / Yr",
    shortLabel: "REC",
    color: "#a855f7",
    tooltip: "Annual Renewable Energy Credit value = MWh generated × REC market price. ERCOT Texas TRC ~$1.50/MWh; CAISO WREGIS ~$10–12/MWh. Log-scaled 0–100. Non-renewable assets (gas, nuclear, coal) score 0 — they are not REC-eligible.",
  },
];

const FUEL_ICONS: Record<string, React.ElementType> = {
  solar: Sun, wind: Wind, storage: Zap, natural_gas: Flame,
  hydro: Droplets, nuclear: Atom, biomass: Leaf, geothermal: Zap,
};
const FUEL_COLORS: Record<string, string> = {
  solar: "#f59e0b", wind: "#14b8a6", storage: "#8b5cf6", natural_gas: "#6b7280",
  hydro: "#3b82f6", nuclear: "#ec4899", biomass: "#22c55e", geothermal: "#f97316",
};

const PROXY_NODE_LABEL: Record<string, Record<string, string>> = {
  ERCOT: {
    wind: "Load zone by lat/lon — wind curtailment highest in LZ_WEST",
    solar: "Load zone by lat/lon — solar curtailment highest in LZ_SOUTH/LZ_WEST",
    storage: "Load zone by lat/lon — storage benefits from price dispersion",
    natural_gas: "Load zone by lat/lon — dispatchable, minimal curtailment exposure",
    nuclear: "Load zone by lat/lon — baseload, near-zero curtailment risk",
    hydro: "Load zone by lat/lon — dispatchable, low curtailment risk",
    default: "ERCOT load zone by lat/lon (CDR 12301 real data)",
  },
  CAISO: {
    solar: "CAISO zone by lat/lon — solar curtailment highest in ZP26/SP15 (13-15% neg-price hours)",
    wind: "CAISO zone by lat/lon — Tehachapi/Altamont moderate curtailment",
    storage: "CAISO zone by lat/lon — storage benefits from duck-curve price spreads",
    natural_gas: "CAISO zone by lat/lon — dispatchable, minimal curtailment exposure",
    hydro: "CAISO zone by lat/lon — dispatchable, low curtailment risk",
    geothermal: "CAISO zone by lat/lon — baseload, near-zero curtailment risk",
    default: "CAISO zone by lat/lon (real OASIS neg-price %, 28 months)",
  },
};

// ─── REC value formatter ──────────────────────────────────────────────────────
function fmtRec(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}

// ─── Score color helper ───────────────────────────────────────────────────────
function scoreColor(v: number) {
  if (v >= 75) return "text-emerald-400";
  if (v >= 60) return "text-teal-400";
  if (v >= 45) return "text-amber-400";
  return "text-red-400";
}
function scoreBg(v: number) {
  if (v >= 75) return "bg-emerald-500";
  if (v >= 60) return "bg-teal-500";
  if (v >= 45) return "bg-amber-500";
  return "bg-red-500";
}

// ─── Mini bar stack ───────────────────────────────────────────────────────────
function ScoreBar({ c }: { c: Record<string, number> }) {
  return (
    <div className="flex gap-1 items-end h-6">
      {DIMS.map(d => (
        <Tooltip key={d.key}>
          <TooltipTrigger asChild>
            <div
              className="w-4 rounded-sm cursor-default transition-opacity hover:opacity-100 opacity-80"
              style={{
                height: `${Math.max(10, (c[d.key] || 0) * 0.24)}px`,
                backgroundColor: d.color,
              }}
            />
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs max-w-[220px]">
            <p className="font-semibold mb-0.5">{d.label}: {(c[d.key] || 0).toFixed(0)}/100</p>
            <p className="text-muted-foreground">{d.tooltip}</p>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function Rankings() {
  const searchParams = new URLSearchParams(window.location.search);

  const [searchTerm, setSearchTerm] = useState("");
  const [marketFilter, setMarketFilter] = useState<string | undefined>(searchParams.get("market") as any || undefined);
  const [assetTypeFilter, setAssetTypeFilter] = useState<string | undefined>(searchParams.get("assetType") as any || undefined);
  const [sortField, setSortField] = useState<"overallScore" | "objectiveScore" | "curtailmentScore" | "interconnectionScore" | "locationScore" | "priceScore" | "demandProximityScore" | "financialScore" | "developmentRiskScore" | "environmentalScore" | "annualRecValueUsd">("overallScore");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [objective, setObjective] = useState<ObjectiveId>(
    (searchParams.get("objective") as ObjectiveId) || "risk_adjusted"
  );

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: candidates, isLoading } = useListCandidates({
    market: marketFilter as any,
    assetType: assetTypeFilter as any,
  });

  const deleteCandidate = useDeleteCandidate();
  const createScreening = useCreateScreening();

  const activeObjective = OBJECTIVES.find(o => o.id === objective) ?? OBJECTIVES[0];

  const filtered = useMemo(() => {
    if (!candidates) return [];
    const weights = activeObjective.weights as Record<string, number>;
    return candidates
      .filter(c => c.name.toLowerCase().includes(searchTerm.toLowerCase()))
      .map(c => {
        const objectiveScore = Math.round(
          Object.entries(weights).reduce((s, [k, w]) => s + ((c as any)[k] ?? 50) * w, 0)
        );
        return { ...c, objectiveScore };
      })
      .sort((a, b) => {
        const aVal = (a as any)[sortField] ?? 0;
        const bVal = (b as any)[sortField] ?? 0;
        return sortDir === "desc" ? bVal - aVal : aVal - bVal;
      });
  }, [candidates, searchTerm, sortField, sortDir, activeObjective]);

  const stats = useMemo(() => {
    if (!filtered.length) return null;
    const scores = filtered.map(c => c.overallScore);
    return {
      total: filtered.length,
      avg: (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1),
      high: scores.filter(s => s >= 75).length,
      med: scores.filter(s => s >= 50 && s < 75).length,
      low: scores.filter(s => s < 50).length,
    };
  }, [filtered]);

  const handleSortBy = (field: typeof sortField) => {
    if (sortField === field) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortField(field); setSortDir("desc"); }
  };

  const handleExportCsv = () => {
    if (!candidates) return;
    const headers = ["Name", "Market", "Asset Type", "Capacity (MW)", "Overall", "Curtailment", "Congestion", "Basis Risk", "Capture Price", "Capacity Score", "Mkt Revenue", "Interconnect Risk", "RECs/Yr Score", "State", "County", "COD", "REC Eligible", "Annual RECs (MWh)", "REC Price ($/MWh)", "Annual REC Value ($)", "20yr REC Value ($)", "REC Market"];
    const rows = candidates.map(c => [
      `"${c.name}"`, c.market, c.assetType, c.capacityMw,
      c.overallScore,
      (c as any).curtailmentScore ?? "",
      (c as any).interconnectionScore ?? "",
      (c as any).locationScore ?? "",
      (c as any).priceScore ?? "",
      (c as any).demandProximityScore ?? "",
      (c as any).financialScore ?? "",
      (c as any).developmentRiskScore ?? "",
      (c as any).environmentalScore ?? "",
      c.state ?? "", c.county ?? "",
      (c as any).commissioningYear ?? "",
      (c as any).recEligible ? "Yes" : "No",
      (c as any).annualRecMwh ?? 0,
      (c as any).recPricePerMwh ?? 0,
      (c as any).annualRecValueUsd ?? 0,
      (c as any).lifetimeRecValue20yr ?? 0,
      `"${(c as any).recMarketLabel ?? ""}"`,
    ]);
    const csv = [headers, ...rows].map(r => r.join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = "eia860_ranked_candidates.csv";
    a.click();
  };

  const handleSaveScreening = () => {
    createScreening.mutate({
      data: {
        name: `Screening ${new Date().toLocaleDateString()}`,
        market: marketFilter || "All",
        assetType: assetTypeFilter || "All",
        objective: "risk_adjusted_value",
        filters: { market: marketFilter, assetType: assetTypeFilter },
        candidateIds: candidates?.map(c => c.id) || [],
      },
    }, {
      onSuccess: () => toast({ title: "Screening saved" }),
      onError: () => toast({ title: "Failed to save screening", variant: "destructive" }),
    });
  };

  const SortHeader = ({ field, label }: { field: typeof sortField; label: string }) => (
    <button
      className={`flex items-center gap-1 hover:text-primary transition-colors ${sortField === field ? "text-primary" : ""}`}
      onClick={() => handleSortBy(field)}
    >
      {label}
      <ArrowUpDown className="h-3 w-3" />
    </button>
  );

  return (
    <TooltipProvider>
      <div className="p-6 h-full flex flex-col space-y-4">

        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 shrink-0">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Candidate Rankings</h1>
            <p className="text-muted-foreground text-sm">
              3,875 EIA 860 2024 operational plants — 8 real-data dimensions: curtailment, congestion, basis risk, capture price, market revenue, interconnect risk, RECs/yr, capacity.
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={handleExportCsv} disabled={!candidates?.length}>
              <Download className="mr-1 h-4 w-4" /> Export CSV
            </Button>
            <Button size="sm" onClick={handleSaveScreening} disabled={createScreening.isPending || !candidates?.length}>
              {createScreening.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
              Save Screening
            </Button>
          </div>
        </div>

        {/* Score methodology note */}
        <div className="shrink-0 flex items-start gap-2 text-xs text-muted-foreground bg-card border border-border rounded-md px-3 py-2">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-primary" />
          <span>
            <span className="font-medium text-foreground">Scoring methodology: </span>
            {activeObjective.desc}.{" "}
            ERCOT: real neg-price %, DA prices, and volatility from ercot_node_stats DB (52 months CDR). CAISO: real OASIS data. Queue depth by zone powers Interconnect Risk. Capture Price = hub DA × technology timing ratio. Mkt Revenue = MW × CF × capture price × 8,760h. RECs/Yr = annual MWh × market REC price.
          </span>
        </div>

        {/* Filters + stats */}
        <div className="flex flex-wrap gap-3 shrink-0 items-center">
          {/* Objective dropdown — most prominent */}
          <div className="flex items-center gap-2 bg-primary/10 border border-primary/30 rounded-md px-3 py-1.5">
            <span className="text-xs font-medium text-primary whitespace-nowrap">Objective</span>
            <Select
              value={objective}
              onValueChange={(v) => {
                setObjective(v as ObjectiveId);
                setSortField(v === "risk_adjusted" ? "overallScore" : "objectiveScore");
                setSortDir("desc");
              }}
            >
              <SelectTrigger className="h-7 w-[220px] border-0 bg-transparent p-0 focus:ring-0 text-sm font-semibold text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OBJECTIVES.map(o => (
                  <SelectItem key={o.id} value={o.id}>
                    <div>
                      <div className="font-medium">{o.label}</div>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="relative w-[220px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search plants…" className="pl-8 h-9" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
          </div>
          <Select value={marketFilter || "all"} onValueChange={v => setMarketFilter(v === "all" ? undefined : v)}>
            <SelectTrigger className="w-[130px] h-9"><SelectValue placeholder="All Markets" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Markets</SelectItem>
              <SelectItem value="ERCOT">ERCOT</SelectItem>
              <SelectItem value="CAISO">CAISO</SelectItem>
              <SelectItem value="PJM">PJM</SelectItem>
            </SelectContent>
          </Select>
          <Select value={assetTypeFilter || "all"} onValueChange={v => setAssetTypeFilter(v === "all" ? undefined : v)}>
            <SelectTrigger className="w-[150px] h-9"><SelectValue placeholder="All Types" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="solar">Solar</SelectItem>
              <SelectItem value="wind">Wind</SelectItem>
              <SelectItem value="storage">Storage</SelectItem>
              <SelectItem value="natural_gas">Natural Gas</SelectItem>
              <SelectItem value="hydro">Hydro</SelectItem>
              <SelectItem value="nuclear">Nuclear</SelectItem>
              <SelectItem value="biomass">Biomass</SelectItem>
              <SelectItem value="geothermal">Geothermal</SelectItem>
            </SelectContent>
          </Select>

          {/* Live stats */}
          {stats && (
            <div className="flex items-center gap-3 ml-auto text-xs">
              <span className="text-muted-foreground">{stats.total.toLocaleString()} plants</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400" /><span className="text-emerald-400 font-medium">{stats.high}</span> high</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400" /><span className="text-amber-400 font-medium">{stats.med}</span> med</span>
              <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400" /><span className="text-red-400 font-medium">{stats.low}</span> low</span>
              <span className="text-muted-foreground">avg <span className="font-semibold text-foreground">{stats.avg}</span></span>
            </div>
          )}
        </div>

        {/* Score dimension legend */}
        <div className="shrink-0 flex flex-wrap gap-3">
          {DIMS.map(d => (
            <Tooltip key={d.key}>
              <TooltipTrigger asChild>
                <button
                  className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded border transition-colors ${sortField === d.key ? "border-primary/60 bg-primary/10" : "border-border hover:border-primary/40"}`}
                  onClick={() => handleSortBy(d.key as any)}
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: d.color }} />
                  {d.label}
                  {sortField === d.key && <ArrowUpDown className="h-2.5 w-2.5 ml-0.5" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs max-w-[220px]">
                <p className="font-semibold mb-0.5">{d.label}</p>
                <p className="text-muted-foreground">{d.tooltip}</p>
              </TooltipContent>
            </Tooltip>
          ))}
        </div>

        {/* Table */}
        <div className="border rounded-md flex-1 overflow-auto bg-card">
          <Table>
            <TableHeader className="sticky top-0 bg-card z-10 shadow-sm">
              <TableRow>
                <TableHead className="w-8 text-xs">#</TableHead>
                <TableHead className="w-[220px]">Plant</TableHead>
                <TableHead>Market</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">MW</TableHead>
                <TableHead>
                  <SortHeader
                    field={objective === "risk_adjusted" ? "overallScore" : "objectiveScore"}
                    label={objective === "risk_adjusted" ? "Overall" : activeObjective.label.split(" ").slice(0, 2).join(" ")}
                  />
                </TableHead>
                <TableHead className="w-[180px]">
                  <div className="flex items-center gap-2 text-xs">
                    Risk Dimensions
                    <span className="text-muted-foreground font-normal">← hover bars</span>
                  </div>
                </TableHead>
                <TableHead>COD</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">
                  <SortHeader field="annualRecValueUsd" label="REC/yr" />
                </TableHead>
                <TableHead className="text-right text-xs">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={11} className="h-32 text-center">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="h-32 text-center text-muted-foreground">
                    No candidates found.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((c, idx) => {
                  const FuelIcon = FUEL_ICONS[c.assetType] ?? Zap;
                  const fuelColor = FUEL_COLORS[c.assetType] ?? "#94a3b8";
                  const proxyLabel = (PROXY_NODE_LABEL[c.market]?.[c.assetType]) || PROXY_NODE_LABEL[c.market]?.default || "—";
                  return (
                    <TableRow key={c.id} className="hover:bg-muted/30 text-sm">
                      <TableCell className="text-xs text-muted-foreground">{idx + 1}</TableCell>
                      <TableCell>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="font-medium truncate block max-w-[200px] cursor-default">
                              {c.name}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="right" className="text-xs max-w-[240px]">
                            <p className="font-semibold mb-1">{c.name}</p>
                            <p className="text-muted-foreground">Proxy node: {proxyLabel}</p>
                            {c.notes && <p className="text-muted-foreground mt-0.5">{c.notes.replace("Source: EIA 860 2024 | ", "")}</p>}
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">{c.market}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <FuelIcon className="h-3.5 w-3.5 shrink-0" style={{ color: fuelColor }} />
                          <span className="text-xs capitalize">{c.assetType.replace(/_/g, " ")}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-xs font-medium">
                        {parseFloat(c.capacityMw as any).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                      </TableCell>
                      <TableCell>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="flex items-center gap-2 cursor-default">
                              {(() => {
                                const displayScore = objective === "risk_adjusted"
                                  ? c.overallScore
                                  : (c as any).objectiveScore ?? c.overallScore;
                                return (
                                  <>
                                    <span className={`font-bold text-base ${scoreColor(displayScore)}`}>
                                      {Math.round(displayScore)}
                                    </span>
                                    <div className="w-12 h-1.5 rounded-full bg-muted overflow-hidden">
                                      <div
                                        className={`h-full rounded-full ${scoreBg(displayScore)}`}
                                        style={{ width: `${displayScore}%` }}
                                      />
                                    </div>
                                  </>
                                );
                              })()}
                            </div>
                          </TooltipTrigger>
                          {objective !== "risk_adjusted" && (
                            <TooltipContent side="right" className="text-xs max-w-[220px]">
                              <p className="font-semibold mb-1">{activeObjective.label}</p>
                              <p className="text-muted-foreground">{activeObjective.desc}</p>
                              <p className="text-muted-foreground mt-1">Base score: {c.overallScore.toFixed(0)}</p>
                            </TooltipContent>
                          )}
                        </Tooltip>
                      </TableCell>
                      <TableCell>
                        <ScoreBar c={c as any} />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {(c as any).commissioningYear ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {c.state ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className={`text-xs font-medium cursor-default ${(c as any).recEligible ? "text-emerald-400" : "text-muted-foreground/50"}`}>
                              {(c as any).recEligible ? `${fmtRec((c as any).annualRecValueUsd)}/yr` : "—"}
                            </span>
                          </TooltipTrigger>
                          {(c as any).recEligible && (
                            <TooltipContent side="left" className="text-xs max-w-[210px]">
                              <p className="font-semibold mb-1">REC Valuation</p>
                              <p>{((c as any).annualRecMwh ?? 0).toLocaleString()} RECs/yr @ ${(c as any).recPricePerMwh}/MWh</p>
                              <p className="text-muted-foreground">{(c as any).recMarketLabel}</p>
                              <p className="text-muted-foreground mt-0.5">20-yr value: {fmtRec((c as any).lifetimeRecValue20yr)}</p>
                            </TooltipContent>
                          )}
                        </Tooltip>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => deleteCandidate.mutate({ id: c.id }, {
                            onSuccess: () => {
                              toast({ title: "Removed" });
                              queryClient.invalidateQueries({ queryKey: getListCandidatesQueryKey() });
                            },
                          })}
                          disabled={deleteCandidate.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </div>

        {/* Explainer panel */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 shrink-0">
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-1.5">
                <BookOpen className="h-4 w-4 text-teal-400" />
                What This Tool Does
              </CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground space-y-2">
              <p>
                Scores all <span className="text-foreground font-medium">3,875 EIA 860 2024 operating plants</span> across
                ERCOT, CAISO, and PJM on 8 real-data dimensions drawn from actual market databases — not synthetic estimates.
              </p>
              <p>
                Six pre-built <span className="text-foreground font-medium">investment objective weight sets</span> instantly
                rerank the universe to match your mandate: risk-adjusted value, lowest LCOE, corporate load hedge,
                decarbonisation, capacity value, or merchant/developer upside.
              </p>
              <p>
                Filter by ISO, technology, and location, then export to CSV or save the screening for future reference. Click
                any row to open the NPV Calculator pre-loaded with that project's scores.
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
                  ["Developer / Originator", "Which ERCOT wind projects have the lowest curtailment and congestion combined? → Select Risk-Adjusted objective, filter ISO=ERCOT + Wind."],
                  ["PE / Fund Manager", "Which CAISO solar projects offer the best capture price and lowest basis risk? → Lowest LCOE objective, filter ISO=CAISO + Solar."],
                  ["IPP", "What is the queue depth in my target zone and how does it affect interconnect scores? → Filter zone, sort by Congestion dimension."],
                  ["Investor / Analyst", "Which projects combine high REC production with low curtailment for an ESG mandate? → Decarbonisation objective, filter by RECs/Yr score."],
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
                ["Universe", "EIA 860 2024 operable generators >1 MW across ERCOT (ERCO), CAISO (CISO), and PJM balancing authorities."],
                ["Curtailment", "Real neg-price % from ERCOT CDR 13060/13061 (28 months) and CAISO OASIS PRC_LMP. PJM from pjm_node_stats (<0.5% neg-price historically)."],
                ["Congestion", "DA price basis vs hub from real monthly CDR/OASIS data. Queue assignment: haversine nearest-neighbour from EIA plant to queue project."],
                ["Capture price", "CDR hub DA monthly averages × technology timing ratio (solar diurnal, wind nocturnal, storage spread)."],
                ["Interconnect risk", "Real queue depth (MW of competing projects) in EIA sub-BA zone from ERCOT GIS Report + CAISO public ISO data."],
                ["RECs/Yr", "Annual MWh (nameplate × CF) × regional REC market price ($3–7/MWh ERCOT, $10–15/MWh CAISO)."],
                ["Scores", "0–100 per dimension (100 = best). Composite = weighted sum by active objective. Weights shown in objective badge."],
              ].map(([k, v]) => (
                <div key={k}>
                  <span className="text-foreground font-medium">{k}: </span>
                  <span>{v}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

    </TooltipProvider>
  );
}
