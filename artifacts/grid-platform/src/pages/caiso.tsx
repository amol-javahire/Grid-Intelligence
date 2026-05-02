import { useState } from "react";
import { useListCaisoNodeStats } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, Legend, ResponsiveContainer, Cell
} from "recharts";
import { Loader2 } from "lucide-react";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const C = {
  teal: "#14b8a6",
  amber: "#f59e0b",
  purple: "#8b5cf6",
  red: "#ef4444",
  green: "#22c55e",
  blue: "#3b82f6",
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

export default function CaisoHistorical() {
  const [node, setNode] = useState<string>("NP15");
  const [year, setYear] = useState<number>(2025);
  const [compareYear, setCompareYear] = useState<number>(2022);
  const [showCompare, setShowCompare] = useState(false);

  const { data: stats, isLoading } = useListCaisoNodeStats({ node, year });
  const { data: compareStats } = useListCaisoNodeStats(
    { node, year: compareYear },
    { enabled: showCompare }
  );

  const chartData = stats?.sort((a, b) => a.month - b.month).map(s => {
    const comp = compareStats?.find(c => c.month === s.month);
    return {
      month: MONTHS[s.month - 1],
      daPrice: Number(s.avgDaPrice.toFixed(2)),
      rtPrice: s.avgRtPrice ? Number(s.avgRtPrice.toFixed(2)) : null,
      volatility: s.volatility ? Number(s.volatility.toFixed(2)) : null,
      negPercent: s.negPricePercent ? Number(s.negPricePercent.toFixed(2)) : null,
      onPeak: s.onPeakAvg ? Number(s.onPeakAvg.toFixed(2)) : null,
      offPeak: s.offPeakAvg ? Number(s.offPeakAvg.toFixed(2)) : null,
      daComp: comp ? Number(comp.avgDaPrice.toFixed(2)) : undefined,
      rtComp: comp && comp.avgRtPrice ? Number(comp.avgRtPrice.toFixed(2)) : undefined,
    };
  }) || [];

  const empty = !isLoading && chartData.length === 0;

  const nodeLabels: Record<string, string> = {
    NP15: "NP15 (North)",
    SP15: "SP15 (South)",
    ZP26: "ZP26 (Central)",
  };

  return (
    <div className="p-8 h-full overflow-auto space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">CAISO Historical Analysis</h1>
          <p className="text-muted-foreground">Day-Ahead vs Real-Time pricing, volatility, and on/off-peak spreads for California.</p>
        </div>
        <div className="flex flex-wrap gap-3 items-center">
          <Select value={node} onValueChange={setNode}>
            <SelectTrigger className="w-[170px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="NP15">NP15 (North)</SelectItem>
              <SelectItem value="SP15">SP15 (South)</SelectItem>
              <SelectItem value="ZP26">ZP26 (Central)</SelectItem>
            </SelectContent>
          </Select>
          <Select value={year.toString()} onValueChange={(v) => setYear(parseInt(v))}>
            <SelectTrigger className="w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="2026">2026</SelectItem>
              <SelectItem value="2025">2025</SelectItem>
              <SelectItem value="2024">2024</SelectItem>
              <SelectItem value="2023">2023</SelectItem>
              <SelectItem value="2022">2022</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              id="yoy"
              checked={showCompare}
              onChange={e => setShowCompare(e.target.checked)}
              className="accent-teal-500 cursor-pointer"
            />
            <label htmlFor="yoy" className="cursor-pointer">YoY vs</label>
          </div>
          <Select value={compareYear.toString()} onValueChange={(v) => setCompareYear(parseInt(v))} disabled={!showCompare}>
            <SelectTrigger className="w-[100px]" disabled={!showCompare}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="2026">2026</SelectItem>
              <SelectItem value="2025">2025</SelectItem>
              <SelectItem value="2024">2024</SelectItem>
              <SelectItem value="2023">2023</SelectItem>
              <SelectItem value="2022">2022</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="h-[400px] flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : empty ? (
        <div className="h-[400px] flex items-center justify-center border rounded-md border-dashed">
          <p className="text-muted-foreground">No data available for this selection.</p>
        </div>
      ) : (
        <Tabs defaultValue="prices">
          <TabsList className="mb-4">
            <TabsTrigger value="prices">DA vs RT Prices</TabsTrigger>
            <TabsTrigger value="peak">On/Off-Peak Split</TabsTrigger>
            <TabsTrigger value="volatility">Volatility & Neg. Prices</TabsTrigger>
          </TabsList>

          <TabsContent value="prices">
            <Card>
              <CardHeader>
                <CardTitle>DA vs RT Average Prices ($/MWh)</CardTitle>
                <CardDescription>{nodeLabels[node] ?? node} — {year}{showCompare ? ` vs ${compareYear}` : ""}</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={400}>
                  <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                    <XAxis dataKey="month" stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                    <YAxis stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                    <RechartsTooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend />
                    <Line isAnimationActive={false} type="monotone" dataKey="daPrice" name={`DA ${year}`} stroke={C.teal} strokeWidth={2} dot={{ r: 3, fill: C.teal }} activeDot={{ r: 5 }} connectNulls />
                    <Line isAnimationActive={false} type="monotone" dataKey="rtPrice" name={`RT ${year}`} stroke={C.amber} strokeWidth={2} dot={{ r: 3, fill: C.amber }} activeDot={{ r: 5 }} connectNulls />
                    {showCompare && <Line isAnimationActive={false} type="monotone" dataKey="daComp" name={`DA ${compareYear}`} stroke={C.teal} strokeWidth={1.5} strokeDasharray="5 5" dot={false} connectNulls />}
                    {showCompare && <Line isAnimationActive={false} type="monotone" dataKey="rtComp" name={`RT ${compareYear}`} stroke={C.amber} strokeWidth={1.5} strokeDasharray="5 5" dot={false} connectNulls />}
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="peak">
            <Card>
              <CardHeader>
                <CardTitle>On-Peak vs Off-Peak Monthly Average ($/MWh)</CardTitle>
                <CardDescription>{nodeLabels[node] ?? node} — {year} — Peak hours (HE07–HE22) vs off-peak</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={400}>
                  <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                    <XAxis dataKey="month" stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                    <YAxis stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                    <RechartsTooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`$${v.toFixed(2)}/MWh`]} />
                    <Legend />
                    <Bar isAnimationActive={false} dataKey="onPeak" name="On-Peak Avg" fill={C.teal} radius={[3, 3, 0, 0]} />
                    <Bar isAnimationActive={false} dataKey="offPeak" name="Off-Peak Avg" fill={C.purple} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="volatility">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Price Volatility (StdDev)</CardTitle>
                  <CardDescription>Monthly price standard deviation</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                      <XAxis dataKey="month" stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                      <YAxis stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                      <RechartsTooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`$${v.toFixed(2)}`]} />
                      <Bar isAnimationActive={false} dataKey="volatility" name="Volatility" radius={[3, 3, 0, 0]}>
                        {chartData.map((entry, i) => (
                          <Cell key={i} fill={(entry.volatility || 0) > 10 ? C.red : (entry.volatility || 0) > 5 ? C.amber : C.teal} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Negative Price Frequency (%)</CardTitle>
                  <CardDescription>% of intervals with price below $0</CardDescription>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} vertical={false} />
                      <XAxis dataKey="month" stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                      <YAxis stroke={C.mutedFg} tick={{ fill: C.mutedFg, fontSize: 12 }} />
                      <RechartsTooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`${v.toFixed(1)}%`]} />
                      <Bar isAnimationActive={false} dataKey="negPercent" name="Neg. Price %" radius={[3, 3, 0, 0]}>
                        {chartData.map((entry, i) => (
                          <Cell key={i} fill={(entry.negPercent || 0) > 5 ? C.red : C.amber} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
