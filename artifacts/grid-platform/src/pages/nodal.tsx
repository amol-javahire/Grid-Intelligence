import { useState } from "react";
import { useListErcotNodalStats } from "@workspace/api-client-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { Loader2, Search, TrendingUp, TrendingDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const C = {
  teal: "#14b8a6",
  amber: "#f59e0b",
  red: "#ef4444",
  green: "#22c55e",
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

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

export default function NodalAnalysis() {
  const [searchTerm, setSearchTerm] = useState("");
  const [year, setYear] = useState<number>(2025);
  const [month, setMonth] = useState<number>(6);
  const [sortField, setSortField] = useState<"avgDaPrice" | "spread" | "negPricePercent">("avgDaPrice");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const { data: nodalStats, isLoading } = useListErcotNodalStats({ year, month });

  const handleSort = (field: typeof sortField) => {
    if (sortField === field) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("desc"); }
  };

  const processed = (nodalStats || []).map(n => ({
    ...n,
    spread: (n.onPeakAvg || 0) - (n.offPeakAvg || 0),
  }));

  const sorted = [...processed].sort((a, b) => {
    const av = sortField === "spread" ? a.spread : (a[sortField] ?? 0);
    const bv = sortField === "spread" ? b.spread : (b[sortField] ?? 0);
    return sortDir === "desc" ? Number(bv) - Number(av) : Number(av) - Number(bv);
  });

  const filtered = sorted.filter(s =>
    s.settlementPoint.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const sortedByPrice = [...processed].sort((a, b) => b.avgDaPrice - a.avgDaPrice);
  const topNodes = sortedByPrice.slice(0, 5);
  const bottomNodes = sortedByPrice.slice(-5).reverse();

  const chartData = [
    ...topNodes.map(n => ({ name: n.settlementPoint.replace("_", " ").substring(0, 12), price: n.avgDaPrice, type: "highest" })),
    ...bottomNodes.map(n => ({ name: n.settlementPoint.replace("_", " ").substring(0, 12), price: n.avgDaPrice, type: "lowest" })),
  ];

  return (
    <div className="p-8 h-full flex flex-col space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Nodal Analysis</h1>
          <p className="text-muted-foreground">ERCOT settlement point spread calculator and ranking.</p>
        </div>
        <div className="flex gap-3">
          <Select value={year.toString()} onValueChange={(v) => setYear(parseInt(v))}>
            <SelectTrigger className="w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="2026">2026</SelectItem>
              <SelectItem value="2025">2025</SelectItem>
              <SelectItem value="2024">2024</SelectItem>
              <SelectItem value="2023">2023</SelectItem>
            </SelectContent>
          </Select>
          <Select value={month.toString()} onValueChange={(v) => setMonth(parseInt(v))}>
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTH_NAMES.map((m, i) => (
                <SelectItem key={i + 1} value={(i + 1).toString()}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card className="shrink-0">
        <CardHeader className="pb-2">
          <CardTitle>Highest vs Lowest Pricing Nodes ($/MWh)</CardTitle>
          <CardDescription>Top 5 highest (teal) and lowest (amber) settlement point DA averages — {MONTH_NAMES[month - 1]} {year}</CardDescription>
        </CardHeader>
        <CardContent style={{ height: 260 }}>
          {isLoading ? (
            <div className="h-full flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                <XAxis dataKey="name" stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 11 }} />
                <YAxis stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 11 }} />
                <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`$${v.toFixed(2)}/MWh`]} />
                <Bar dataKey="price" name="Avg DA Price" radius={[4, 4, 0, 0]}>
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.type === "highest" ? C.teal : C.amber} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground border rounded-md border-dashed">
              No data for this period.
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex shrink-0">
        <div className="relative w-full max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search settlement point..."
            className="pl-8 bg-card"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
          />
        </div>
      </div>

      <div className="border rounded-md flex-1 overflow-auto bg-card">
        <Table>
          <TableHeader className="sticky top-0 bg-card z-10 shadow-sm">
            <TableRow>
              <TableHead>Settlement Point</TableHead>
              <TableHead
                className="text-right cursor-pointer hover:text-primary select-none"
                onClick={() => handleSort("avgDaPrice")}
              >
                Avg DA Price {sortField === "avgDaPrice" ? (sortDir === "desc" ? "↓" : "↑") : "↕"}
              </TableHead>
              <TableHead className="text-right">On-Peak Avg</TableHead>
              <TableHead className="text-right">Off-Peak Avg</TableHead>
              <TableHead
                className="text-right cursor-pointer hover:text-primary select-none"
                onClick={() => handleSort("spread")}
              >
                Spread {sortField === "spread" ? (sortDir === "desc" ? "↓" : "↑") : "↕"}
              </TableHead>
              <TableHead className="text-right">Volatility</TableHead>
              <TableHead
                className="text-right cursor-pointer hover:text-primary select-none"
                onClick={() => handleSort("negPricePercent")}
              >
                Neg % {sortField === "negPricePercent" ? (sortDir === "desc" ? "↓" : "↑") : "↕"}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center">
                  <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  No settlement points found.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((node) => (
                <TableRow key={node.id}>
                  <TableCell className="font-medium font-mono text-xs">{node.settlementPoint}</TableCell>
                  <TableCell className="text-right font-semibold">${node.avgDaPrice.toFixed(2)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">${(node.onPeakAvg || 0).toFixed(2)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">${(node.offPeakAvg || 0).toFixed(2)}</TableCell>
                  <TableCell className="text-right">
                    <span className={`font-semibold ${node.spread > 5 ? "text-primary" : ""}`}>
                      ${node.spread.toFixed(2)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">${(node.stdDev || 0).toFixed(2)}</TableCell>
                  <TableCell className="text-right">
                    <span className={(node.negPricePercent || 0) > 5 ? "text-red-500 font-medium" : "text-muted-foreground"}>
                      {(node.negPricePercent || 0).toFixed(1)}%
                    </span>
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
