import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import {
  useListCandidates,
  useDeleteCandidate,
  useCreateScreening,
  useCreateCandidate,
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
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Loader2, Search, Download, Save, Trash2, Plus, ArrowUpDown,
  Wind, Sun, Zap, Flame, Droplets, Atom, Leaf, Info,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ─── Score dimension config ───────────────────────────────────────────────────
const DIMS = [
  {
    key: "curtailmentScore" as const,
    label: "Curtailment",
    shortLabel: "Curt",
    color: "#f59e0b",
    tooltip: "ERCOT: mapped to load zone by lat/lon (LZ_WEST/NORTH/SOUTH/HOUSTON) using real CDR 12301 neg-price % (fleet avg 6.42%) + asset-type exposure. Wind/solar in LZ_WEST score lowest (~65). CAISO/PJM: modeled.",
  },
  {
    key: "interconnectionScore" as const,
    label: "Congestion",
    shortLabel: "Cong",
    color: "#ef4444",
    tooltip: "Based on DA–RT spread at the nearest proxy node. Wide spreads = constrained transmission = lower score.",
  },
  {
    key: "locationScore" as const,
    label: "Basis Risk",
    shortLabel: "Basis",
    color: "#8b5cf6",
    tooltip: "Based on spread volatility (std dev). High volatility = unpredictable settlement basis = lower score.",
  },
  {
    key: "priceScore" as const,
    label: "Price",
    shortLabel: "Price",
    color: "#14b8a6",
    tooltip: "Average DA LMP at the proxy node. Higher market prices support better PPA merchant tail value.",
  },
  {
    key: "demandProximityScore" as const,
    label: "Capacity",
    shortLabel: "Cap",
    color: "#3b82f6",
    tooltip: "Log-scaled plant size score. Larger plants are more attractive for Walmart's ~500 MW procurement need.",
  },
  {
    key: "financialScore" as const,
    label: "Asset Age",
    shortLabel: "Age",
    color: "#22c55e",
    tooltip: "Commissioning year proxy for technology quality and remaining useful life. Newer = higher score.",
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
  PJM: {
    default: "Zone by state (NI/AEP-Dayton/DOM/BGE/PSEG/PPL/Western Hub)",
  },
};

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
  const [sortField, setSortField] = useState<"overallScore" | "curtailmentScore" | "interconnectionScore" | "locationScore" | "priceScore" | "demandProximityScore">("overallScore");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newMarket, setNewMarket] = useState("ERCOT");
  const [newAssetType, setNewAssetType] = useState("solar");
  const [newCapacity, setNewCapacity] = useState("");
  const [newState, setNewState] = useState("");
  const [newCounty, setNewCounty] = useState("");

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: candidates, isLoading } = useListCandidates({
    market: marketFilter as any,
    assetType: assetTypeFilter as any,
  });

  const deleteCandidate = useDeleteCandidate();
  const createScreening = useCreateScreening();
  const createCandidate = useCreateCandidate();

  const filtered = useMemo(() => {
    if (!candidates) return [];
    return candidates
      .filter(c => c.name.toLowerCase().includes(searchTerm.toLowerCase()))
      .sort((a, b) => {
        const aVal = (a as any)[sortField] ?? 0;
        const bVal = (b as any)[sortField] ?? 0;
        return sortDir === "desc" ? bVal - aVal : aVal - bVal;
      });
  }, [candidates, searchTerm, sortField, sortDir]);

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
    const headers = ["Name", "Market", "Asset Type", "Capacity (MW)", "Overall", "Curtailment", "Congestion", "Basis Risk", "Price", "Capacity Score", "Asset Age", "State", "County", "COD"];
    const rows = candidates.map(c => [
      `"${c.name}"`, c.market, c.assetType, c.capacityMw,
      c.overallScore,
      (c as any).curtailmentScore ?? "",
      (c as any).interconnectionScore ?? "",
      (c as any).locationScore ?? "",
      (c as any).priceScore ?? "",
      (c as any).demandProximityScore ?? "",
      (c as any).financialScore ?? "",
      c.state ?? "", c.county ?? "",
      (c as any).commissioningYear ?? "",
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

  const handleAddCandidate = () => {
    if (!newName.trim() || !newCapacity) return;
    createCandidate.mutate({
      data: {
        name: newName.trim(),
        market: newMarket as any,
        assetType: newAssetType as any,
        capacityMw: parseFloat(newCapacity),
        latitude: 0,
        longitude: 0,
        state: newState || undefined,
        county: newCounty || undefined,
        status: "active" as any,
      },
    }, {
      onSuccess: () => {
        toast({ title: "Candidate added" });
        queryClient.invalidateQueries({ queryKey: getListCandidatesQueryKey() });
        setAddOpen(false);
        setNewName(""); setNewCapacity(""); setNewState(""); setNewCounty("");
      },
      onError: () => toast({ title: "Failed to add candidate", variant: "destructive" }),
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
              3,875 EIA 860 2024 operational plants — scored on congestion, curtailment, basis risk, price & capacity.
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="mr-1 h-4 w-4" /> Add
            </Button>
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
            Curtailment (25%) · Congestion (20%) · Basis Risk (20%) · Price (15%) · Capacity (12%) · Asset Age (8%).{" "}
            ERCOT: CDR 12301 neg-price % (6.42% fleet avg) + zone by lat/lon (LZ_WEST/NORTH/SOUTH/HOUSTON) + asset-type penalties. CAISO: real OASIS neg-price % by zone (NP15: 3.8%, SP15: 13.2%, ZP26: 14.8%) + asset-type multipliers — 28 months of real data.
            PJM uses hub/zone by state (modeled). All ERCOT and CAISO curtailment scores are derived from real public market data.
          </span>
        </div>

        {/* Filters + stats */}
        <div className="flex flex-wrap gap-3 shrink-0 items-center">
          <div className="relative w-[260px]">
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
                  <SortHeader field="overallScore" label="Overall" />
                </TableHead>
                <TableHead className="w-[180px]">
                  <div className="flex items-center gap-2 text-xs">
                    Risk Dimensions
                    <span className="text-muted-foreground font-normal">← hover bars</span>
                  </div>
                </TableHead>
                <TableHead>COD</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right text-xs">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={10} className="h-32 text-center">
                    <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="h-32 text-center text-muted-foreground">
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
                        <div className="flex items-center gap-2">
                          <span className={`font-bold text-base ${scoreColor(c.overallScore)}`}>
                            {c.overallScore.toFixed(0)}
                          </span>
                          <div className="w-12 h-1.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className={`h-full rounded-full ${scoreBg(c.overallScore)}`}
                              style={{ width: `${c.overallScore}%` }}
                            />
                          </div>
                        </div>
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

      {/* Add dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Add Candidate</DialogTitle></DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-1.5">
              <Label>Name *</Label>
              <Input placeholder="e.g. West Texas Solar I" value={newName} onChange={e => setNewName(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Market *</Label>
                <Select value={newMarket} onValueChange={setNewMarket}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ERCOT">ERCOT</SelectItem>
                    <SelectItem value="CAISO">CAISO</SelectItem>
                    <SelectItem value="PJM">PJM</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Asset Type *</Label>
                <Select value={newAssetType} onValueChange={setNewAssetType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
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
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Capacity (MW) *</Label>
              <Input type="number" placeholder="e.g. 200" value={newCapacity} onChange={e => setNewCapacity(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>State</Label>
                <Input placeholder="e.g. TX" value={newState} onChange={e => setNewState(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>County</Label>
                <Input placeholder="e.g. Pecos" value={newCounty} onChange={e => setNewCounty(e.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={handleAddCandidate} disabled={!newName.trim() || !newCapacity || createCandidate.isPending}>
              {createCandidate.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
