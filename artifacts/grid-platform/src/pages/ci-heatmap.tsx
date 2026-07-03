import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Search, ArrowUpDown, MapPin, Info, ExternalLink } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type HeatmapRow = {
  node: string; nodeType: string;
  rtMonths: number; totalMonths: number;
  avgDa: number; avgRt: number;
  avgBasis: number; absAvgBasis: number; basisStddev: number; maxAbsBasis: number;
  congestionMonths: number; severeMonths: number; congestionPct: number;
  avgVolatility: number; avgNegPct: number; riskScore: number;
};

type SortKey = keyof Pick<HeatmapRow, "riskScore"|"absAvgBasis"|"basisStddev"|"maxAbsBasis"|"congestionPct"|"avgNegPct"|"avgDa"|"avgRt">;

function riskColor(score: number): string {
  if (score >= 70) return "bg-red-500/20 text-red-400 border-red-500/30";
  if (score >= 45) return "bg-orange-500/15 text-orange-400 border-orange-500/30";
  if (score >= 20) return "bg-amber-500/15 text-amber-400 border-amber-500/30";
  return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
}

function riskLabel(score: number): string {
  if (score >= 70) return "High";
  if (score >= 45) return "Moderate-High";
  if (score >= 20) return "Moderate";
  return "Low";
}

const NODE_TYPE_LABELS: Record<string, string> = {
  resource_node: "Resource Node", hub: "Hub", load_zone: "Load Zone",
};

export default function CIHeatmap() {
  const [, navigate] = useLocation();
  const [search, setSearch]       = useState("");
  const [nodeType, setNodeType]   = useState<string>("all");
  const [minMonths, setMinMonths] = useState(3);
  const [sortKey, setSortKey]     = useState<SortKey>("riskScore");
  const [sortDir, setSortDir]     = useState<"desc"|"asc">("desc");
  const [page, setPage]           = useState(0);
  const pageSize = 100;

  const { data: raw, isLoading } = useQuery<HeatmapRow[]>({
    queryKey: ["ci","heatmap"],
    queryFn:  () => fetch("/api/congestion-intel/heatmap?limit=2000").then(r => r.json()),
    staleTime: 300_000,
  });

  const filtered = useMemo(() => {
    let rows = raw ?? [];
    if (nodeType !== "all") rows = rows.filter(r => r.nodeType === nodeType);
    if (minMonths > 1) rows = rows.filter(r => r.rtMonths >= minMonths);
    if (search) rows = rows.filter(r => r.node.toLowerCase().includes(search.toLowerCase()));
    return [...rows].sort((a, b) => {
      const diff = (a[sortKey] ?? 0) - (b[sortKey] ?? 0);
      return sortDir === "desc" ? -diff : diff;
    });
  }, [raw, nodeType, search, minMonths, sortKey, sortDir]);

  const paged = filtered.slice(page * pageSize, (page + 1) * pageSize);
  const totalPages = Math.ceil(filtered.length / pageSize);

  const handleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortKey(k); setSortDir("desc"); }
  };

  const SH = ({ field, label }: { field: SortKey; label: string }) => (
    <button
      className={`flex items-center gap-1 hover:text-primary transition-colors ml-auto ${sortKey === field ? "text-primary" : ""}`}
      onClick={() => handleSort(field)}
    >
      {label}<ArrowUpDown className="h-3 w-3" />
    </button>
  );

  return (
    <TooltipProvider>
      <div className="p-6 h-full flex flex-col space-y-4">
        <div className="shrink-0">
          <div className="flex items-center gap-2 mb-1">
            <MapPin className="h-5 w-5 text-teal-400" />
            <h1 className="text-2xl font-bold">Congestion Heat Map</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            {raw ? raw.length.toLocaleString() : "…"} ERCOT nodes ranked by composite congestion risk — basis magnitude, volatility, event frequency, negative pricing
          </p>
        </div>

        <div className="shrink-0 flex items-start gap-2 text-xs text-muted-foreground bg-card border border-border rounded-md px-3 py-2">
          <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-primary" />
          <span>
            <b className="text-foreground">Risk Score (0–100)</b> = 40% avg |basis| + 25% basis volatility + 25% congestion frequency + 10% neg-price frequency.
            Basis = avg monthly RT − DA price. Congestion event = |basis| &gt; $10/MWh.
            Click any row to open Node Detail.
          </span>
        </div>

        <div className="shrink-0 flex flex-wrap gap-3 items-center">
          <div className="relative w-[220px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search nodes…" className="pl-8 h-9" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} />
          </div>
          <Select value={nodeType} onValueChange={v => { setNodeType(v); setPage(0); }}>
            <SelectTrigger className="w-[155px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="resource_node">Resource Nodes</SelectItem>
              <SelectItem value="hub">Hubs</SelectItem>
              <SelectItem value="load_zone">Load Zones</SelectItem>
            </SelectContent>
          </Select>
          <Select value={String(minMonths)} onValueChange={v => { setMinMonths(Number(v)); setPage(0); }}>
            <SelectTrigger className="w-[160px] h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">All coverage</SelectItem>
              <SelectItem value="3">≥ 3 months</SelectItem>
              <SelectItem value="6">≥ 6 months</SelectItem>
              <SelectItem value="12">≥ 12 months</SelectItem>
              <SelectItem value="24">≥ 24 months</SelectItem>
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
            <span>{filtered.length.toLocaleString()} nodes</span>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <button onClick={() => setPage(p => Math.max(0, p-1))} disabled={page===0} className="px-2 py-1 border border-border rounded text-xs disabled:opacity-40 hover:bg-muted/30">←</button>
                <span>{page+1} / {totalPages}</span>
                <button onClick={() => setPage(p => Math.min(totalPages-1, p+1))} disabled={page===totalPages-1} className="px-2 py-1 border border-border rounded text-xs disabled:opacity-40 hover:bg-muted/30">→</button>
              </div>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="border rounded-md flex-1 overflow-auto bg-card">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card z-10 shadow-sm">
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-3 py-2 text-left w-8">#</th>
                  <th className="px-3 py-2 text-left">Node</th>
                  <th className="px-3 py-2 text-left">Type</th>
                  <th className="px-3 py-2 text-right"><SH field="riskScore" label="Risk Score" /></th>
                  <th className="px-3 py-2 text-right"><SH field="absAvgBasis" label="|Avg Basis|" /></th>
                  <th className="px-3 py-2 text-right"><SH field="basisStddev" label="Basis σ" /></th>
                  <th className="px-3 py-2 text-right"><SH field="maxAbsBasis" label="Max |Basis|" /></th>
                  <th className="px-3 py-2 text-right"><SH field="congestionPct" label="Cong %" /></th>
                  <th className="px-3 py-2 text-right"><SH field="avgNegPct" label="Neg %" /></th>
                  <th className="px-3 py-2 text-right"><SH field="avgDa" label="Avg DA" /></th>
                  <th className="px-3 py-2 text-right"><SH field="avgRt" label="Avg RT" /></th>
                  <th className="px-3 py-2 text-right text-xs">Months</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((r, i) => (
                  <tr
                    key={r.node}
                    className="border-b border-border/40 hover:bg-muted/20 cursor-pointer"
                    onClick={() => navigate(`/ci-node?node=${encodeURIComponent(r.node)}`)}
                  >
                    <td className="px-3 py-1.5 text-xs text-muted-foreground">{page * pageSize + i + 1}</td>
                    <td className="px-3 py-1.5 font-mono text-xs font-medium max-w-[180px] truncate">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="flex items-center gap-1">{r.node}<ExternalLink className="h-2.5 w-2.5 text-muted-foreground/50 shrink-0" /></span>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="text-xs">{r.node}</TooltipContent>
                      </Tooltip>
                    </td>
                    <td className="px-3 py-1.5">
                      <Badge variant="outline" className="text-xs">{NODE_TYPE_LABELS[r.nodeType] ?? r.nodeType}</Badge>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <span className={`inline-flex items-center justify-center w-10 h-6 rounded text-xs font-bold border ${riskColor(r.riskScore)}`}>
                        {r.riskScore}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right text-xs">${r.absAvgBasis.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right text-xs">${r.basisStddev.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right text-xs font-medium">${r.maxAbsBasis.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right text-xs">
                      <span className={r.congestionPct >= 50 ? "text-red-400 font-medium" : r.congestionPct >= 25 ? "text-amber-400" : "text-muted-foreground"}>
                        {r.congestionPct}%
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right text-xs text-muted-foreground">{r.avgNegPct.toFixed(1)}%</td>
                    <td className="px-3 py-1.5 text-right text-xs text-muted-foreground">${r.avgDa.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right text-xs text-muted-foreground">${r.avgRt.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right text-xs text-muted-foreground">{r.rtMonths}/{r.totalMonths}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
