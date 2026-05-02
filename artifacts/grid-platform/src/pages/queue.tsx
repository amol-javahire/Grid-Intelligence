import { useState, useMemo } from "react";
import { useListQueueProjects, useGetQueueSummary } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  PieChart, Pie, Cell, Tooltip as RechartsTooltip, ResponsiveContainer,
  Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid
} from "recharts";
import { Loader2, Search, Zap, Wind, Sun, Battery } from "lucide-react";

const FUEL_COLORS: Record<string, string> = {
  solar: "#f59e0b",
  wind: "#14b8a6",
  storage: "#8b5cf6",
  natural_gas: "#ef4444",
  nuclear: "#3b82f6",
  hydro: "#22c55e",
  hybrid: "#ec4899",
  offshore_wind: "#06b6d4",
  geothermal: "#84cc16",
};
const FALLBACK_COLORS = ["#14b8a6","#f59e0b","#8b5cf6","#ef4444","#22c55e","#ec4899"];

const STATUS_COLORS: Record<string, string> = {
  active: "#14b8a6",
  completed: "#22c55e",
  withdrawn: "#ef4444",
  suspended: "#f59e0b",
};

const MARKET_COLORS: Record<string, string> = {
  ERCOT: "#14b8a6",
  CAISO: "#f59e0b",
  PJM: "#8b5cf6",
};

const C = {
  teal: "#14b8a6",
  border: "#1e2d3e",
  mutedFg: "#64748b",
  tooltipBg: "#0f172a",
  tooltipBorder: "#1e293b",
  tooltipFg: "#f8fafc",
};
const TOOLTIP_STYLE = {
  backgroundColor: C.tooltipBg,
  borderColor: C.tooltipBorder,
  color: C.tooltipFg,
};

function FuelIcon({ fuel }: { fuel: string }) {
  if (fuel === "solar") return <Sun className="h-3 w-3 inline mr-1" style={{ color: FUEL_COLORS.solar }} />;
  if (fuel === "wind" || fuel === "offshore_wind") return <Wind className="h-3 w-3 inline mr-1" style={{ color: FUEL_COLORS.wind }} />;
  if (fuel === "storage") return <Battery className="h-3 w-3 inline mr-1" style={{ color: FUEL_COLORS.storage }} />;
  return <Zap className="h-3 w-3 inline mr-1" style={{ color: FUEL_COLORS[fuel] ?? "#94a3b8" }} />;
}

export default function InterconnectionQueue() {
  const [searchTerm, setSearchTerm] = useState("");
  const [marketFilter, setMarketFilter] = useState<string | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [fuelFilter, setFuelFilter] = useState<string | undefined>(undefined);
  const [sortField, setSortField] = useState<"requestDate" | "capacityMw">("requestDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const { data: queueProjects, isLoading } = useListQueueProjects({
    market: marketFilter as any,
    status: statusFilter,
    fuelType: fuelFilter,
  });
  const { data: summary, isLoading: isLoadingSummary } = useGetQueueSummary();

  const filteredProjects = useMemo(() => {
    if (!queueProjects) return [];
    let rows = queueProjects.filter(p =>
      p.projectName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (p.queueId && p.queueId.toLowerCase().includes(searchTerm.toLowerCase())) ||
      (p.county && p.county.toLowerCase().includes(searchTerm.toLowerCase()))
    );
    rows = [...rows].sort((a, b) => {
      if (sortField === "capacityMw") {
        return sortDir === "desc" ? (b.capacityMw ?? 0) - (a.capacityMw ?? 0) : (a.capacityMw ?? 0) - (b.capacityMw ?? 0);
      }
      const da = a.requestDate ? new Date(a.requestDate).getTime() : 0;
      const db2 = b.requestDate ? new Date(b.requestDate).getTime() : 0;
      return sortDir === "desc" ? db2 - da : da - db2;
    });
    return rows;
  }, [queueProjects, searchTerm, sortField, sortDir]);

  const fuelData = useMemo(() =>
    (summary?.byFuelType ?? [])
      .map(d => ({ ...d, fill: FUEL_COLORS[d.fuelType] ?? FALLBACK_COLORS[0] }))
      .sort((a, b) => b.totalCapacityMw - a.totalCapacityMw),
    [summary]
  );

  const isoData = useMemo(() =>
    (summary?.byMarket ?? []).map(d => ({
      ...d,
      fill: MARKET_COLORS[d.market] ?? "#94a3b8",
    })),
    [summary]
  );

  const totalActive = summary?.byStatus?.find(s => s.status === "active")?.count ?? 0;
  const totalMW = summary?.byFuelType?.reduce((acc, d) => acc + d.totalCapacityMw, 0) ?? 0;
  const totalProjects = (summary?.byStatus ?? []).reduce((a, b) => a + b.count, 0);

  const toggleSort = (field: typeof sortField) => {
    if (sortField === field) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortField(field); setSortDir("desc"); }
  };

  return (
    <div className="p-8 h-full flex flex-col space-y-6">
      <div className="shrink-0 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Interconnection Queue</h1>
          <p className="text-muted-foreground">Track public generation queue applications across ERCOT, CAISO, and PJM.</p>
        </div>
        <div className="flex gap-4 text-right">
          <div>
            <div className="text-2xl font-bold" style={{ color: C.teal }}>{totalActive.toLocaleString()}</div>
            <div className="text-xs text-muted-foreground">Active Projects</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-foreground">{totalProjects.toLocaleString()}</div>
            <div className="text-xs text-muted-foreground">Total in Queue</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-foreground">{(totalMW / 1000).toFixed(1)} GW</div>
            <div className="text-xs text-muted-foreground">Total Capacity</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 shrink-0">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Capacity by Fuel Type</CardTitle>
            <CardDescription className="text-xs">Total MW queued by resource</CardDescription>
          </CardHeader>
          <CardContent style={{ height: 240 }}>
            {isLoadingSummary ? (
              <div className="h-full flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : fuelData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie isAnimationActive={false} data={fuelData} cx="38%" cy="50%" innerRadius={48} outerRadius={80} paddingAngle={2} dataKey="totalCapacityMw" nameKey="fuelType">
                    {fuelData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} stroke="transparent" />
                    ))}
                  </Pie>
                  <RechartsTooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number, name: string) => [`${v.toLocaleString()} MW`, name]} />
                  <Legend layout="vertical" align="right" verticalAlign="middle" formatter={(v) => <span style={{ color: C.tooltipFg, fontSize: 11 }}>{v}</span>} />
                </PieChart>
              </ResponsiveContainer>
            ) : <div className="h-full flex items-center justify-center text-muted-foreground text-sm">No data</div>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Projects by Status</CardTitle>
            <CardDescription className="text-xs">Active, Withdrawn, Completed</CardDescription>
          </CardHeader>
          <CardContent style={{ height: 240 }}>
            {isLoadingSummary ? (
              <div className="h-full flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : summary?.byStatus && summary.byStatus.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={summary.byStatus} layout="vertical" margin={{ top: 5, right: 30, left: 65, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
                  <XAxis type="number" stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 11 }} />
                  <YAxis dataKey="status" type="category" stroke={C.mutedFg} width={65} tick={{ fill: C.mutedFg, fontSize: 11 }} />
                  <RechartsTooltip contentStyle={TOOLTIP_STYLE} />
                  <Bar isAnimationActive={false} dataKey="count" name="Projects" radius={[0, 4, 4, 0]}>
                    {(summary.byStatus ?? []).map((entry, i) => (
                      <Cell key={i} fill={STATUS_COLORS[entry.status] ?? C.teal} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : <div className="h-full flex items-center justify-center text-muted-foreground text-sm">No data</div>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">MW Queued by ISO</CardTitle>
            <CardDescription className="text-xs">Total capacity in pipeline by market</CardDescription>
          </CardHeader>
          <CardContent style={{ height: 240 }}>
            {isLoadingSummary ? (
              <div className="h-full flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : isoData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={isoData} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                  <XAxis dataKey="market" stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                  <YAxis stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 11 }} tickFormatter={v => `${(v/1000).toFixed(0)}GW`} />
                  <RechartsTooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`${v.toLocaleString()} MW`]} />
                  <Bar isAnimationActive={false} dataKey="totalCapacityMw" name="Total MW" radius={[4, 4, 0, 0]}>
                    {isoData.map((entry, i) => (
                      <Cell key={i} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : <div className="h-full flex items-center justify-center text-muted-foreground text-sm">No data</div>}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap gap-3 shrink-0">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search project, ID, county..."
            className="pl-8 bg-card"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>
        <Select value={marketFilter || "all"} onValueChange={v => setMarketFilter(v === "all" ? undefined : v)}>
          <SelectTrigger className="w-[130px]">
            <SelectValue placeholder="All Markets" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Markets</SelectItem>
            <SelectItem value="ERCOT">ERCOT</SelectItem>
            <SelectItem value="CAISO">CAISO</SelectItem>
            <SelectItem value="PJM">PJM</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter || "all"} onValueChange={v => setStatusFilter(v === "all" ? undefined : v)}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="withdrawn">Withdrawn</SelectItem>
          </SelectContent>
        </Select>
        <Select value={fuelFilter || "all"} onValueChange={v => setFuelFilter(v === "all" ? undefined : v)}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="All Fuel Types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Fuel Types</SelectItem>
            <SelectItem value="solar">Solar</SelectItem>
            <SelectItem value="wind">Wind</SelectItem>
            <SelectItem value="storage">Storage</SelectItem>
            <SelectItem value="natural_gas">Natural Gas</SelectItem>
            <SelectItem value="offshore_wind">Offshore Wind</SelectItem>
            <SelectItem value="geothermal">Geothermal</SelectItem>
            <SelectItem value="hybrid">Hybrid</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto text-sm text-muted-foreground self-center">
          {filteredProjects.length} project{filteredProjects.length !== 1 ? "s" : ""}
        </div>
      </div>

      <div className="border rounded-md flex-1 overflow-auto bg-card">
        <Table>
          <TableHeader className="sticky top-0 bg-card z-10 shadow-sm">
            <TableRow>
              <TableHead className="w-[110px]">Queue ID</TableHead>
              <TableHead>Project Name</TableHead>
              <TableHead className="w-[80px]">Market</TableHead>
              <TableHead className="w-[110px]">Fuel Type</TableHead>
              <TableHead
                className="text-right w-[110px] cursor-pointer select-none hover:text-foreground"
                onClick={() => toggleSort("capacityMw")}
              >
                Capacity {sortField === "capacityMw" ? (sortDir === "desc" ? "↓" : "↑") : ""}
              </TableHead>
              <TableHead className="w-[100px]">Status</TableHead>
              <TableHead>Study Phase</TableHead>
              <TableHead>Location</TableHead>
              <TableHead
                className="w-[110px] cursor-pointer select-none hover:text-foreground"
                onClick={() => toggleSort("requestDate")}
              >
                Queue Date {sortField === "requestDate" ? (sortDir === "desc" ? "↓" : "↑") : ""}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center">
                  <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : filteredProjects.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
                  No queue projects found matching filters.
                </TableCell>
              </TableRow>
            ) : (
              filteredProjects.map((project) => (
                <TableRow key={project.id} className="hover:bg-muted/20">
                  <TableCell className="font-mono text-xs text-muted-foreground">{project.queueId || "—"}</TableCell>
                  <TableCell className="font-medium text-sm">{project.projectName}</TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      style={{ borderColor: MARKET_COLORS[project.market] ?? "transparent", color: MARKET_COLORS[project.market] ?? undefined }}
                      className="text-xs font-semibold"
                    >
                      {project.market}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs capitalize flex items-center gap-1">
                      <FuelIcon fuel={project.fuelType} />
                      {project.fuelType.replace("_", " ")}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-semibold text-sm">
                    {project.capacityMw?.toLocaleString()} <span className="text-muted-foreground font-normal text-xs">MW</span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className="text-xs capitalize"
                      style={{
                        borderColor: STATUS_COLORS[project.status] ?? "transparent",
                        color: STATUS_COLORS[project.status] ?? undefined,
                      }}
                    >
                      {project.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{project.studyGroupPhase || "—"}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {project.county ? `${project.county}, ${project.state}` : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {project.requestDate ? new Date(project.requestDate).toLocaleDateString() : "—"}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
