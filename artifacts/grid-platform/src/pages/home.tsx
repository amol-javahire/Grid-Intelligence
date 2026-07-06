import { useState } from "react";
import { useLocation } from "wouter";
import { useGetDashboardSummary, useGetMarketBreakdown } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { Loader2, Activity, Zap, Server, Network } from "lucide-react";

export default function Home() {
  const [, setLocation] = useLocation();
  const [market, setMarket] = useState<string>("ERCOT");
  const [assetType, setAssetType] = useState<string>("solar");
  const [objective, setObjective] = useState<string>("lowest_lcoe");

  const { data: summary, isLoading: isLoadingSummary } = useGetDashboardSummary();
  const { data: breakdown, isLoading: isLoadingBreakdown } = useGetMarketBreakdown();

  const handleScreeningSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const params = new URLSearchParams();
    if (market) params.append("market", market);
    if (assetType) params.append("assetType", assetType);
    params.append("objective", objective);
    setLocation(`/rankings?${params.toString()}`);
  };

  const ASSET_COLORS: Record<string, string> = {
    wind:        "#14b8a6",
    solar:       "#f59e0b",
    storage:     "#8b5cf6",
    hydro:       "#3b82f6",
    geothermal:  "#ef4444",
    biomass:     "#22c55e",
    natural_gas: "#94a3b8",
    nuclear:     "#f97316",
  };

  const ASSET_LABELS: Record<string, string> = {
    wind:        "Wind",
    solar:       "Solar",
    storage:     "Storage",
    hydro:       "Hydro",
    geothermal:  "Geothermal",
    biomass:     "Biomass",
    natural_gas: "Natural Gas",
    nuclear:     "Nuclear",
  };

  type BreakdownRow = { market: string; assetType: string; count: number; totalCapacityMw: number };

  const pivotedBreakdown = (() => {
    if (!breakdown || !Array.isArray(breakdown)) return [];
    const rows = breakdown as BreakdownRow[];
    const markets = [...new Set(rows.map(r => r.market))].sort();
    const assetTypes = [...new Set(rows.map(r => r.assetType))];
    return markets.map(market => {
      const entry: Record<string, string | number> = { market };
      for (const at of assetTypes) {
        const match = rows.find(r => r.market === market && r.assetType === at);
        entry[at] = match ? Math.round((match.totalCapacityMw / 1000) * 10) / 10 : 0;
      }
      return entry;
    });
  })();

  const activeAssetTypes = breakdown && Array.isArray(breakdown)
    ? [...new Set((breakdown as BreakdownRow[]).map(r => r.assetType))].sort()
    : [];

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight mb-2">Platform Overview</h1>
        <p className="text-muted-foreground">Market intelligence and candidate screening cockpit.</p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Candidates</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? <Loader2 className="h-4 w-4 animate-spin" /> : (
              <div className="text-2xl font-bold">{summary?.activeCandidates || 0}</div>
            )}
            <p className="text-xs text-muted-foreground mt-1">
              out of {summary?.totalCandidates || 0} total
            </p>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Capacity</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? <Loader2 className="h-4 w-4 animate-spin" /> : (
              <div className="text-2xl font-bold">{(summary?.totalCapacityMw || 0).toLocaleString()} MW</div>
            )}
            <p className="text-xs text-muted-foreground mt-1">Across all markets</p>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Score</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? <Loader2 className="h-4 w-4 animate-spin" /> : (
              <div className="text-2xl font-bold text-primary">{(summary?.avgOverallScore || 0).toFixed(1)}</div>
            )}
            <p className="text-xs text-muted-foreground mt-1">Overall candidate health</p>
          </CardContent>
        </Card>
        <Card className="bg-card">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Queue Projects</CardTitle>
            <Network className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoadingSummary ? <Loader2 className="h-4 w-4 animate-spin" /> : (
              <div className="text-2xl font-bold">{(summary?.queueProjectCount || 0).toLocaleString()}</div>
            )}
            <p className="text-xs text-muted-foreground mt-1">Tracked in ISO queues</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Screening Form */}
        <Card className="col-span-1 bg-card border-border">
          <CardHeader>
            <CardTitle>Start Screening</CardTitle>
            <CardDescription>Configure parameters to find optimal assets.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleScreeningSubmit} className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="market">Market</Label>
                <Select value={market} onValueChange={setMarket}>
                  <SelectTrigger id="market">
                    <SelectValue placeholder="Select market" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ERCOT">ERCOT</SelectItem>
                    <SelectItem value="CAISO">CAISO</SelectItem>
                    <SelectItem value="PJM">PJM</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="assetType">Asset Type</Label>
                <Select value={assetType} onValueChange={setAssetType}>
                  <SelectTrigger id="assetType">
                    <SelectValue placeholder="Select asset type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="solar">Solar</SelectItem>
                    <SelectItem value="wind">Wind</SelectItem>
                    <SelectItem value="storage">Storage</SelectItem>
                    <SelectItem value="solar_storage">Solar + Storage</SelectItem>
                    <SelectItem value="wind_storage">Wind + Storage</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="objective">Investment Objective</Label>
                <Select value={objective} onValueChange={setObjective}>
                  <SelectTrigger id="objective">
                    <SelectValue placeholder="Select objective" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="lowest_lcoe">Lowest LCOE</SelectItem>
                    <SelectItem value="risk_adjusted_value">Risk-Adjusted Value</SelectItem>
                    <SelectItem value="load_hedge">Load Hedge</SelectItem>
                    <SelectItem value="decarbonization">Decarbonization Impact</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" className="w-full">
                Run Screen
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Market Chart */}
        <Card className="col-span-2 bg-card border-border">
          <CardHeader>
            <CardTitle>Market Breakdown</CardTitle>
            <CardDescription>Installed capacity by ISO and technology type.</CardDescription>
          </CardHeader>
          <CardContent className="h-[350px]">
            {isLoadingBreakdown ? (
              <div className="h-full flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : pivotedBreakdown.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={pivotedBreakdown} margin={{ top: 8, right: 16, left: 8, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="market"
                    stroke="hsl(var(--muted-foreground))"
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                  />
                  <YAxis
                    stroke="hsl(var(--muted-foreground))"
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    label={{ value: "GW", angle: -90, position: "insideLeft", offset: 10, fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    tickFormatter={(v: number) => v === 0 ? "0" : `${v}`}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: "hsl(var(--popover))", borderColor: "hsl(var(--border))", color: "hsl(var(--popover-foreground))", fontSize: 12 }}
                    itemStyle={{ color: "hsl(var(--popover-foreground))" }}
                    formatter={(value: number, name: string) => [`${value} GW`, ASSET_LABELS[name] ?? name]}
                    cursor={{ fill: "hsl(var(--muted))", opacity: 0.3 }}
                  />
                  <Legend
                    formatter={(val: string) => ASSET_LABELS[val] ?? val}
                    wrapperStyle={{ color: "hsl(var(--muted-foreground))", fontSize: 11, paddingTop: 4 }}
                  />
                  {activeAssetTypes.map(at => (
                    <Bar key={at} dataKey={at} name={at} stackId="stack" fill={ASSET_COLORS[at] ?? "#94a3b8"} radius={activeAssetTypes.indexOf(at) === activeAssetTypes.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-muted-foreground">
                No breakdown data available.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
