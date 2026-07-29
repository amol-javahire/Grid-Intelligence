import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useGetAesoSupplyDemand, useGetAesoSupplyDemandStats } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

// ─── CSD types ────────────────────────────────────────────────────────────────
type CsdSummary = {
  totalNetGenMw: number | null;
  netInterchangeMw: number | null;
  ailMw: number | null;
  netToGridMw: number | null;
  crRequiredMw: number | null;
  dcrMw: number | null;
  dcrGenMw: number | null;
  dcrOtherMw: number | null;
  ffrArmedMw: number | null;
  ffrOfferedMw: number | null;
  lltMw: number | null;
};

type GenGroup = { name: string; mcMw: number; tngMw: number; dcrMw: number };
type AssetRow = { name: string; mcMw: number; tngMw: number; dcrMw: number };
type AssetGroup = { groupName: string; assets: AssetRow[] };
type InterchangePath = { path: string; flowMw: number };
type CsdData = {
  lastUpdated: string | null;
  summary: CsdSummary;
  generationGroups: GenGroup[];
  total: GenGroup | null;
  interchangePaths: InterchangePath[];
  assetGroups: AssetGroup[];
};

const GROUP_COLORS: Record<string, string> = {
  COGENERATION: "bg-amber-500/20 border-amber-500/40",
  WIND: "bg-teal-500/20 border-teal-500/40",
  "COMBINED CYCLE": "bg-yellow-500/20 border-yellow-500/40",
  "GAS FIRED STEAM": "bg-orange-500/20 border-orange-500/40",
  SOLAR: "bg-yellow-400/20 border-yellow-400/40",
  "SIMPLE CYCLE": "bg-orange-400/20 border-orange-400/40",
  HYDRO: "bg-blue-500/20 border-blue-500/40",
  OTHER: "bg-slate-500/20 border-slate-500/40",
  "ENERGY STORAGE": "bg-purple-500/20 border-purple-500/40",
};

function utilColor(pct: number): string {
  if (pct >= 80) return "bg-emerald-500";
  if (pct >= 60) return "bg-lime-500";
  if (pct >= 40) return "bg-yellow-500";
  if (pct >= 20) return "bg-amber-500";
  return "bg-orange-500";
}

function SummaryCard({ label, value, unit = "MW", highlight = false }: { label: string; value: number | null; unit?: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${highlight ? "border-primary/50 bg-primary/5" : "border-border bg-card"}`}>
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className={`text-xl font-bold font-mono ${highlight ? "text-primary" : "text-foreground"}`}>
        {value != null ? value.toLocaleString() : "—"}
        <span className="text-xs font-normal text-muted-foreground ml-1">{unit}</span>
      </div>
    </div>
  );
}

function CsdView({ data }: { data: CsdData }) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Current Supply &amp; Demand</h2>
        {data.lastUpdated && (
          <span className="text-xs text-muted-foreground">Last Update: {data.lastUpdated}</span>
        )}
      </div>

      {/* Summary grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        <SummaryCard label="Alberta Total Net Generation" value={data.summary.totalNetGenMw} highlight />
        <SummaryCard label="Alberta Internal Load (AIL)" value={data.summary.ailMw} highlight />
        <SummaryCard label="Net Actual Interchange" value={data.summary.netInterchangeMw} />
        <SummaryCard label="Net-To-Grid Generation" value={data.summary.netToGridMw} />
        <SummaryCard label="CR Required" value={data.summary.crRequiredMw} />
        <SummaryCard label="Dispatched CR (DCR)" value={data.summary.dcrMw} />
        <SummaryCard label="DCR — Generation" value={data.summary.dcrGenMw} />
        <SummaryCard label="DCR — Other" value={data.summary.dcrOtherMw} />
        <SummaryCard label="FFR Armed Dispatch" value={data.summary.ffrArmedMw} />
        <SummaryCard label="FFR Offered Volume" value={data.summary.ffrOfferedMw} />
        <SummaryCard label="Long Lead Time Volume" value={data.summary.lltMw} />
      </div>

      {/* Interchange paths */}
      {data.interchangePaths.length > 0 && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm font-medium">Interchange Paths</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="py-2 text-left font-medium text-muted-foreground">Path</th>
                  <th className="py-2 text-right font-medium text-muted-foreground">Actual Flow (MW)</th>
                </tr>
              </thead>
              <tbody>
                {data.interchangePaths.map((p, i) => (
                  <tr key={i} className="border-b border-border/40">
                    <td className="py-2">{p.path}</td>
                    <td className={`py-2 text-right font-mono font-medium ${p.flowMw < 0 ? "text-blue-400" : "text-amber-400"}`}>
                      {p.flowMw > 0 ? "+" : ""}{p.flowMw.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {/* Generation Group table */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm font-medium">Generation Groups — MC / TNG / DCR</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="py-2 text-left font-medium text-muted-foreground">Fuel Group</th>
                  <th className="py-2 text-right font-medium text-muted-foreground">MC (MW)</th>
                  <th className="py-2 text-right font-medium text-muted-foreground">TNG (MW)</th>
                  <th className="py-2 text-right font-medium text-muted-foreground">DCR (MW)</th>
                  <th className="py-2 pl-4 font-medium text-muted-foreground">Utilization</th>
                </tr>
              </thead>
              <tbody>
                {data.generationGroups.map((g, i) => {
                  const utilPct = g.mcMw > 0 ? (g.tngMw / g.mcMw) * 100 : 0;
                  return (
                    <tr key={i} className="border-b border-border/40 hover:bg-muted/20 cursor-pointer"
                      onClick={() => {
                        const match = data.assetGroups.find(
                          (ag) => ag.groupName.toLowerCase() === g.name.toLowerCase().replace("gas fired steam", "gas fired steam").replace("combined cycle", "combined cycle").replace("simple cycle", "simple cycle").replace("cogeneration", "cogeneration").replace("energy storage", "energy storage")
                            || g.name.toLowerCase().includes(ag.groupName.toLowerCase())
                            || ag.groupName.toLowerCase().includes(g.name.toLowerCase().split(" ")[0])
                        );
                        if (match) setExpandedGroup(expandedGroup === match.groupName ? null : match.groupName);
                      }}
                    >
                      <td className="py-2.5 font-medium">
                        <div className={`inline-flex items-center gap-2 px-2 py-0.5 rounded border text-xs ${GROUP_COLORS[g.name] ?? "border-border"}`}>
                          {g.name}
                        </div>
                      </td>
                      <td className="py-2.5 text-right font-mono">{g.mcMw.toLocaleString()}</td>
                      <td className="py-2.5 text-right font-mono text-primary">{g.tngMw.toLocaleString()}</td>
                      <td className="py-2.5 text-right font-mono text-amber-400">{g.dcrMw.toLocaleString()}</td>
                      <td className="py-2.5 pl-4">
                        <div className="flex items-center gap-2 min-w-[120px]">
                          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${utilColor(utilPct)}`}
                              style={{ width: `${Math.min(utilPct, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs text-muted-foreground w-10 text-right">
                            {utilPct.toFixed(0)}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {data.total && (
                  <tr className="border-t-2 border-border bg-muted/20 font-semibold">
                    <td className="py-2.5 px-1">TOTAL</td>
                    <td className="py-2.5 text-right font-mono">{data.total.mcMw.toLocaleString()}</td>
                    <td className="py-2.5 text-right font-mono text-primary">{data.total.tngMw.toLocaleString()}</td>
                    <td className="py-2.5 text-right font-mono text-amber-400">{data.total.dcrMw.toLocaleString()}</td>
                    <td />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground mt-2">Click a row to expand individual assets. MC = Maximum Capability · TNG = Total Net Generation · DCR = Dispatched Contingency Reserve</p>
        </CardContent>
      </Card>

      {/* Individual asset tables — shown when a group is expanded */}
      {expandedGroup && (
        <Card>
          <CardHeader className="py-3 flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium">{expandedGroup} — Individual Assets</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setExpandedGroup(null)}>✕</Button>
          </CardHeader>
          <CardContent className="pt-0">
            {data.assetGroups
              .filter((ag) => ag.groupName === expandedGroup)
              .map((ag) => (
                <div key={ag.groupName} className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="py-2 text-left font-medium text-muted-foreground">Asset</th>
                        <th className="py-2 text-right font-medium text-muted-foreground">MC (MW)</th>
                        <th className="py-2 text-right font-medium text-muted-foreground">TNG (MW)</th>
                        <th className="py-2 text-right font-medium text-muted-foreground">DCR (MW)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ag.assets.map((asset, j) => (
                        <tr key={j} className="border-b border-border/30 hover:bg-muted/10">
                          <td className="py-1.5 text-xs">{asset.name}</td>
                          <td className="py-1.5 text-right font-mono text-xs text-muted-foreground">{asset.mcMw}</td>
                          <td className={`py-1.5 text-right font-mono text-xs ${asset.tngMw > 0 ? "text-primary" : "text-muted-foreground"}`}>
                            {asset.tngMw}
                          </td>
                          <td className={`py-1.5 text-right font-mono text-xs ${asset.dcrMw > 0 ? "text-amber-400" : "text-muted-foreground"}`}>
                            {asset.dcrMw}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Historical chart view ────────────────────────────────────────────────────
function HistoricalView() {
  const { data: supplyDemand, isLoading: isSdLoading } = useGetAesoSupplyDemand({ limit: 168 });
  const { data: stats, isLoading: isStatsLoading } = useGetAesoSupplyDemandStats();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Load &amp; Capacity (Last 7 Days)</CardTitle>
        </CardHeader>
        <CardContent className="h-96">
          {isSdLoading ? (
            <Skeleton className="w-full h-full" />
          ) : supplyDemand && supplyDemand.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={supplyDemand.slice().reverse()}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={12} tickFormatter={(val) => val.split("T")[0]} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <Tooltip contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))" }} />
                <Line type="monotone" dataKey="ailMw" name="AIL Load" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />
                <Line type="monotone" dataKey="availableCapacityMw" name="Available Capacity" stroke="hsl(var(--chart-3))" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-muted-foreground">No data available</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Monthly Statistics</CardTitle>
        </CardHeader>
        <CardContent>
          {isStatsLoading ? (
            <Skeleton className="w-full h-64" />
          ) : stats && stats.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="pb-2 font-medium text-muted-foreground">Month</th>
                    <th className="pb-2 font-medium text-muted-foreground">Peak AIL (MW)</th>
                    <th className="pb-2 font-medium text-muted-foreground">Avg Reserve Margin</th>
                    <th className="pb-2 font-medium text-muted-foreground">Min Reserve Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((stat, i) => (
                    <tr key={i} className="border-b border-border/50">
                      <td className="py-2">{stat.year}-{String(stat.month).padStart(2, "0")}</td>
                      <td className="py-2">{stat.peakAilMw.toFixed(0)}</td>
                      <td className="py-2">{stat.avgReserveMarginPct.toFixed(1)}%</td>
                      <td className="py-2 text-destructive">{stat.minReserveMarginPct.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center text-muted-foreground">No data available</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function SupplyDemand() {
  const [tab, setTab] = useState<"csd" | "historical">("csd");

  const { data: csdData, isLoading: isCsdLoading, isFetching: isCsdFetching, dataUpdatedAt, refetch: refetchCsd } =
    useQuery<CsdData>({
      queryKey: ["aeso-csd"],
      queryFn: () => fetch("/api/aeso/csd").then((r) => r.json()),
      staleTime: 2 * 60 * 1000,
      refetchInterval: 5 * 60 * 1000,
      enabled: tab === "csd",
    });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">CSD — Current Supply &amp; Demand</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Live AESO CSD report and historical AIL/capacity data
          </p>
        </div>
        {tab === "csd" && (
          <div className="flex items-center gap-3 shrink-0">
            {dataUpdatedAt > 0 && (
              <span className="text-xs text-muted-foreground">
                Updated {new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={() => void refetchCsd()} disabled={isCsdFetching}>
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isCsdFetching ? "animate-spin" : ""}`} />
              {isCsdFetching ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <Button variant={tab === "csd" ? "default" : "outline"} size="sm" onClick={() => setTab("csd")}>
          Live CSD
        </Button>
        <Button variant={tab === "historical" ? "default" : "outline"} size="sm" onClick={() => setTab("historical")}>
          Historical
        </Button>
      </div>

      {tab === "csd" ? (
        isCsdLoading ? (
          <div className="space-y-4">
            <Skeleton className="w-full h-32" />
            <Skeleton className="w-full h-64" />
          </div>
        ) : csdData ? (
          <CsdView data={csdData} />
        ) : (
          <div className="flex h-64 items-center justify-center text-muted-foreground">Unable to load live CSD data</div>
        )
      ) : (
        <HistoricalView />
      )}
    </div>
  );
}
