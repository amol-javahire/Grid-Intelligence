import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Loader2, Zap, Network, TrendingUp, Info } from "lucide-react";
import { useState, useMemo, useEffect } from "react";
import { MapContainer, TileLayer, CircleMarker, Polyline, Tooltip, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, ResponsiveContainer,
  Tooltip as RechartsTooltip, Cell,
} from "recharts";

const BASE = "/pypsa";
const TS = { backgroundColor: "#0f172a", borderColor: "#1e293b", color: "#f8fafc", fontSize: 11 };

// ── Colour helpers ────────────────────────────────────────────────────────────
function lmpColor(lmp: number, min: number, max: number): string {
  if (max === min) return "#14b8a6";
  const t = Math.max(0, Math.min(1, (lmp - min) / (max - min)));
  if (t < 0.33) return "#14b8a6";
  if (t < 0.66) return "#f59e0b";
  return "#ef4444";
}

function lineColor(pct: number): string {
  if (pct >= 95) return "#ef4444";
  if (pct >= 70) return "#f59e0b";
  if (pct >= 30) return "#22c55e";
  return "#1e3a5f";
}

function lineOpacity(pct: number): number {
  if (pct >= 70) return 0.9;
  if (pct >= 30) return 0.55;
  return 0.2;
}

function lineWeight(pct: number): number {
  if (pct >= 95) return 2.5;
  if (pct >= 70) return 1.8;
  if (pct >= 30) return 1.2;
  return 0.6;
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface OPFBus {
  id: string; hub: string; label: string; zone: string | null;
  lat: number; lon: number;
  lmp: number; load_mw: number; gen_mw: number; net_export_mw: number;
}

interface OPFLine {
  name: string; bus0: string; bus1: string;
  flow_mw: number; capacity_mw: number; loading_pct: number;
  congestion_rent_k$: number; is_congested: boolean;
}

interface OPFGen {
  name: string; carrier: string;
  dispatch_mw: number; capacity_mw: number; cf: number; marginal_cost: number;
}

interface OPFResult {
  status: string;
  tier: number;
  bus_count: number;
  line_count: number;
  model_version: string;
  system_load_mw: number;
  avg_lmp: number; max_lmp: number; min_lmp: number; lmp_spread: number;
  wind_mw: number; solar_mw: number; nuclear_mw: number; gas_mw: number;
  renewable_pct: number;
  total_cost_per_hour: number;
  congested_lines: number;
  buses: OPFBus[];
  lines: OPFLine[];
  generators: OPFGen[];
}

// ── Map bounds fitter ─────────────────────────────────────────────────────────
function BoundsFitter({ buses }: { buses: OPFBus[] }) {
  const map = useMap();
  useEffect(() => {
    if (buses.length === 0) return;
    const lats = buses.map(b => b.lat);
    const lons = buses.map(b => b.lon);
    const pad = 0.5;
    map.fitBounds([
      [Math.min(...lats) - pad, Math.min(...lons) - pad],
      [Math.max(...lats) + pad, Math.max(...lons) + pad],
    ]);
  }, [buses.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// ── Zone label → short label ──────────────────────────────────────────────────
const ZONE_SHORT: Record<string, string> = {
  LZ_HOUSTON: "HOU", LZ_NORTH: "NTH", LZ_SOUTH: "STH",
  LZ_WEST: "WST", LZ_AEN: "AEN", LZ_CPS: "CPS", LZ_LCRA: "LCR",
};
const ZONE_COLORS: Record<string, string> = {
  LZ_HOUSTON: "#f59e0b", LZ_NORTH: "#14b8a6", LZ_SOUTH: "#8b5cf6",
  LZ_WEST: "#22c55e", LZ_AEN: "#06b6d4", LZ_CPS: "#f97316", LZ_LCRA: "#ec4899",
};
const CARRIER_COLORS: Record<string, string> = {
  gas_cc: "#f59e0b", gas_ct: "#fb923c", wind: "#14b8a6", solar: "#fbbf24",
  nuclear: "#8b5cf6", hydro: "#06b6d4", biomass: "#84cc16", storage: "#94a3b8",
};

// ── Main page ─────────────────────────────────────────────────────────────────
export default function PypsaNetwork() {
  const [windCf,   setWindCf]   = useState(55);
  const [solarCf,  setSolarCf]  = useState(25);
  const [gasPrice, setGasPrice] = useState(350);
  const [loadMw,   setLoadMw]   = useState(55000);
  const [dirty,    setDirty]    = useState(false);
  const [selectedBus, setSelectedBus] = useState<OPFBus | null>(null);

  // ── Load default OPF (cached on engine startup) ───────────────────────────
  const defaultQ = useQuery<OPFResult>({
    queryKey: ["pypsa-opf-default"],
    queryFn: () => fetch(`${BASE}/opf/default`).then(r => r.json()),
    staleTime: 60_000,
  });

  const [customResult, setCustomResult] = useState<OPFResult | null>(null);
  const opfMut = useMutation({
    mutationFn: (params: object) =>
      fetch(`${BASE}/opf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      }).then(r => r.json()),
    onSuccess: (data) => { setCustomResult(data); setDirty(false); },
  });

  const result: OPFResult | undefined = customResult ?? defaultQ.data;
  const loading = defaultQ.isLoading || opfMut.isPending;

  // ── Pre-compute for map ───────────────────────────────────────────────────
  const lmpMin = result ? Math.min(...result.buses.map(b => b.lmp)) : 0;
  const lmpMax = result ? Math.max(...result.buses.map(b => b.lmp)) : 1;

  // Bus lookup for line endpoint coords
  const busCoords = useMemo(() => {
    const m: Record<string, { lat: number; lon: number }> = {};
    (result?.buses ?? []).forEach(b => { m[b.id] = { lat: b.lat, lon: b.lon }; });
    return m;
  }, [result]);

  // Zone stats aggregation
  const zoneStats = useMemo(() => {
    const m: Record<string, { gen: number; load: number; lmps: number[]; buses: number }> = {};
    (result?.buses ?? []).forEach(b => {
      const z = b.zone ?? "Other";
      if (!m[z]) m[z] = { gen: 0, load: 0, lmps: [], buses: 0 };
      m[z].gen  += b.gen_mw;
      m[z].load += b.load_mw;
      m[z].lmps.push(b.lmp);
      m[z].buses++;
    });
    return Object.entries(m).map(([zone, v]) => ({
      zone,
      short: ZONE_SHORT[zone] ?? zone,
      gen:   Math.round(v.gen),
      load:  Math.round(v.load),
      buses: v.buses,
      avg_lmp: Math.round((v.lmps.reduce((a, b) => a + b, 0) / v.lmps.length) * 100) / 100,
      net_export: Math.round(v.gen - v.load),
    })).sort((a, b) => b.load - a.load);
  }, [result]);

  // Top congested lines for bar chart
  const topLines = useMemo(() => {
    if (!result) return [];
    return [...result.lines]
      .sort((a, b) => b.loading_pct - a.loading_pct)
      .slice(0, 12);
  }, [result]);

  // Generator dispatch by carrier
  const genByCarrier = useMemo(() => {
    if (!result) return [];
    return result.generators
      .filter(g => g.capacity_mw > 0)
      .sort((a, b) => b.dispatch_mw - a.dispatch_mw)
      .slice(0, 8);
  }, [result]);

  return (
    <div className="p-6 space-y-5 max-w-[1500px] mx-auto">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Zap className="h-6 w-6 text-amber-400" />
            PyPSA Network — ERCOT Tier 2
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {result
              ? `${result.bus_count} real 345kV buses · ${result.line_count} transmission corridors · DC OPF via HiGHS`
              : "340 real ERCOT buses from CDR 10008 · k-NN topology · DC OPF via HiGHS"}
          </p>
        </div>
        <div className="flex gap-2">
          <Badge variant="outline" className="border-teal-500/40 text-teal-400 text-xs">
            {result ? `Tier ${result.tier}` : "Tier 2"}
          </Badge>
          <Badge variant="outline" className="border-amber-500/40 text-amber-400 text-xs">DC OPF</Badge>
        </div>
      </div>

      {/* Scenario controls */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Scenario Parameters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">System Load</span>
                <span className="font-mono text-teal-400">{(loadMw/1000).toFixed(0)} GW</span>
              </div>
              <Slider min={30000} max={75000} step={1000} value={[loadMw]}
                onValueChange={([v]) => { setLoadMw(v); setDirty(true); }} />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Wind CF</span>
                <span className="font-mono text-teal-400">{windCf}%</span>
              </div>
              <Slider min={5} max={65} step={1} value={[windCf]}
                onValueChange={([v]) => { setWindCf(v); setDirty(true); }} />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Solar CF</span>
                <span className="font-mono text-amber-400">{solarCf}%</span>
              </div>
              <Slider min={0} max={35} step={1} value={[solarCf]}
                onValueChange={([v]) => { setSolarCf(v); setDirty(true); }} />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Gas Price</span>
                <span className="font-mono text-orange-400">${(gasPrice/100).toFixed(2)}/MMBtu</span>
              </div>
              <Slider min={200} max={800} step={10} value={[gasPrice]}
                onValueChange={([v]) => { setGasPrice(v); setDirty(true); }} />
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button size="sm"
              variant={dirty ? "default" : "outline"}
              className={dirty ? "bg-teal-600 hover:bg-teal-700" : ""}
              disabled={opfMut.isPending}
              onClick={() => opfMut.mutate({
                system_load_mw: loadMw,
                wind_cf:         windCf  / 100,
                solar_cf:        solarCf / 100,
                gas_price_mmbtu: gasPrice / 100,
              })}>
              {opfMut.isPending
                ? <><Loader2 className="h-3 w-3 animate-spin mr-1" />Running OPF…</>
                : "Run OPF"}
            </Button>
            {dirty && (
              <span className="text-xs text-muted-foreground">
                Parameters changed — click Run OPF to update
              </span>
            )}
            {result && (
              <span className="text-xs text-muted-foreground ml-auto font-mono">
                v: {result.model_version}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Running DC optimal power flow on {result?.bus_count ?? 340} buses…</span>
        </div>
      )}

      {result && !loading && (
        <>
          {/* KPI strip */}
          <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
            {[
              { label: "Avg LMP",    value: `$${result.avg_lmp.toFixed(2)}`,           sub: "/MWh",   color: "text-teal-400" },
              { label: "LMP Spread", value: `$${result.lmp_spread.toFixed(2)}`,         sub: "/MWh",   color: result.lmp_spread > 5 ? "text-amber-400" : "text-teal-400" },
              { label: "Renewable",  value: `${result.renewable_pct.toFixed(1)}%`,      sub: "of gen", color: "text-emerald-400" },
              { label: "Wind",       value: `${(result.wind_mw/1000).toFixed(1)} GW`,   sub: "dispatch", color: "text-teal-400" },
              { label: "Total Cost", value: `$${(result.total_cost_per_hour/1000).toFixed(0)}k`, sub: "/hour", color: "text-amber-400" },
              { label: "Congested",  value: String(result.congested_lines),             sub: "lines",  color: result.congested_lines > 0 ? "text-red-400" : "text-emerald-400" },
            ].map(kpi => (
              <Card key={kpi.label} className="bg-card border-border">
                <CardContent className="pt-3 pb-2 px-3">
                  <div className="text-xs text-muted-foreground">{kpi.label}</div>
                  <div className={`text-xl font-bold font-mono ${kpi.color}`}>{kpi.value}</div>
                  <div className="text-xs text-muted-foreground">{kpi.sub}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Map + Zone stats */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

            {/* Leaflet Network Map */}
            <Card className="lg:col-span-2 bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Network className="h-4 w-4 text-teal-400" />
                  ERCOT Transmission Network — Nodal LMPs
                </CardTitle>
                <CardDescription className="text-xs">
                  {result.bus_count} buses · {result.line_count} corridors ·
                  Node color = LMP (teal→amber→red) · Line color = loading % · Click bus for details
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0 rounded-b-lg overflow-hidden">
                <div style={{ height: 480 }}>
                  <MapContainer
                    center={[31.5, -99.0]}
                    zoom={6}
                    style={{ height: "100%", width: "100%", background: "#0a1628" }}
                    zoomControl
                  >
                    <TileLayer
                      url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                      attribution='&copy; <a href="https://carto.com/">CARTO</a>'
                      maxZoom={18}
                    />
                    <BoundsFitter buses={result.buses} />

                    {/* Transmission lines — rendered first (behind buses) */}
                    {result.lines.map((line) => {
                      const a = busCoords[line.bus0];
                      const b = busCoords[line.bus1];
                      if (!a || !b) return null;
                      const pct = line.loading_pct;
                      return (
                        <Polyline
                          key={line.name}
                          positions={[[a.lat, a.lon], [b.lat, b.lon]]}
                          pathOptions={{
                            color:   lineColor(pct),
                            weight:  lineWeight(pct),
                            opacity: lineOpacity(pct),
                          }}
                        >
                          {pct >= 30 && (
                            <Tooltip sticky>
                              <div className="text-xs">
                                <div className="font-mono font-bold">{line.bus0} → {line.bus1}</div>
                                <div>Flow: <b>{line.flow_mw.toFixed(0)} MW</b></div>
                                <div>Loading: <b>{pct.toFixed(1)}%</b></div>
                                <div>Cap: {line.capacity_mw.toFixed(0)} MW</div>
                              </div>
                            </Tooltip>
                          )}
                        </Polyline>
                      );
                    })}

                    {/* Bus markers */}
                    {result.buses.map((bus) => {
                      const color = lmpColor(bus.lmp, lmpMin, lmpMax);
                      const radius = Math.max(3, Math.min(10, 3 + bus.gen_mw / 5000));
                      return (
                        <CircleMarker
                          key={bus.id}
                          center={[bus.lat, bus.lon]}
                          radius={radius}
                          pathOptions={{
                            color, fillColor: color,
                            fillOpacity: 0.85, weight: 1,
                          }}
                          eventHandlers={{ click: () => setSelectedBus(bus) }}
                        >
                          <Tooltip>
                            <div className="text-xs">
                              <div className="font-mono font-bold">{bus.id}</div>
                              <div className="text-gray-300">{bus.zone}</div>
                              <div>LMP: <b>${bus.lmp.toFixed(2)}/MWh</b></div>
                              <div>Gen: {(bus.gen_mw/1000).toFixed(1)} GW</div>
                              <div>Load: {(bus.load_mw/1000).toFixed(1)} GW</div>
                            </div>
                          </Tooltip>
                        </CircleMarker>
                      );
                    })}
                  </MapContainer>
                </div>

                {/* Map legend */}
                <div className="flex items-center gap-4 px-4 py-2 border-t border-border text-xs text-muted-foreground">
                  <span className="font-medium">LMP:</span>
                  {[["#14b8a6","Low"],["#f59e0b","Mid"],["#ef4444","High"]].map(([c,l]) => (
                    <span key={l} className="flex items-center gap-1">
                      <span className="inline-block w-3 h-3 rounded-full" style={{ background: c }} />
                      {l}
                    </span>
                  ))}
                  <span className="ml-4 font-medium">Lines:</span>
                  {[["#1e3a5f","<30%"],["#22c55e","30–70%"],["#f59e0b","70–95%"],["#ef4444","≥95%"]].map(([c,l]) => (
                    <span key={l} className="flex items-center gap-1">
                      <span className="inline-block w-4 h-0.5 rounded" style={{ background: c }} />
                      {l}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Right column: bus detail + zone stats */}
            <div className="space-y-4">
              {/* Bus detail panel */}
              {selectedBus ? (
                <Card className="bg-card border-teal-500/30 border">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Info className="h-3.5 w-3.5 text-teal-400" />
                      Bus Detail
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    <div className="font-mono text-teal-400 text-base font-bold">{selectedBus.id}</div>
                    <div className="text-muted-foreground">{selectedBus.zone} · {selectedBus.hub}</div>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      {[
                        ["LMP",        `$${selectedBus.lmp.toFixed(2)}/MWh`],
                        ["Gen",        `${(selectedBus.gen_mw/1000).toFixed(2)} GW`],
                        ["Load",       `${(selectedBus.load_mw/1000).toFixed(2)} GW`],
                        ["Net Export", `${selectedBus.net_export_mw > 0 ? "+" : ""}${(selectedBus.net_export_mw/1000).toFixed(2)} GW`],
                      ].map(([label, value]) => (
                        <div key={label} className="bg-background/40 rounded p-2">
                          <div className="text-muted-foreground text-[10px]">{label}</div>
                          <div className="font-mono font-bold text-foreground">{value}</div>
                        </div>
                      ))}
                    </div>
                    <button
                      className="text-[10px] text-muted-foreground hover:text-foreground mt-1"
                      onClick={() => setSelectedBus(null)}>
                      × Close
                    </button>
                  </CardContent>
                </Card>
              ) : (
                <Card className="bg-card border-border">
                  <CardContent className="pt-4 pb-3 px-4">
                    <div className="text-xs text-muted-foreground text-center py-2">
                      Click any bus on the map to see details
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Zone summary */}
              <Card className="bg-card border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Zone Summary</CardTitle>
                  <CardDescription className="text-xs">Aggregated across all buses per zone</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground border-b border-border">
                          <th className="text-left pb-1 font-normal">Zone</th>
                          <th className="text-right pb-1 font-normal">Avg LMP</th>
                          <th className="text-right pb-1 font-normal">Net Export</th>
                          <th className="text-right pb-1 font-normal">Buses</th>
                        </tr>
                      </thead>
                      <tbody>
                        {zoneStats.map(z => (
                          <tr key={z.zone} className="border-b border-border/40">
                            <td className="py-1">
                              <span className="inline-flex items-center gap-1">
                                <span className="w-2 h-2 rounded-full inline-block"
                                  style={{ background: ZONE_COLORS[z.zone] ?? "#94a3b8" }} />
                                <span className="font-mono">{z.short}</span>
                              </span>
                            </td>
                            <td className="text-right font-mono">${z.avg_lmp.toFixed(2)}</td>
                            <td className={`text-right font-mono ${z.net_export > 0 ? "text-emerald-400" : "text-rose-400"}`}>
                              {z.net_export > 0 ? "+" : ""}{(z.net_export/1000).toFixed(1)}GW
                            </td>
                            <td className="text-right text-muted-foreground">{z.buses}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Bottom row: Dispatch + Top congested lines */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

            {/* Generation dispatch by carrier */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-amber-400" />
                  Generation Dispatch by Carrier
                </CardTitle>
                <CardDescription className="text-xs">
                  MW dispatched — {result.generators.length} carrier groups
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[210px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={genByCarrier} margin={{ top: 4, right: 8, left: -20, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="carrier" tick={{ fontSize: 10, fill: "#94a3b8" }} />
                      <YAxis tick={{ fontSize: 10, fill: "#94a3b8" }}
                        tickFormatter={v => `${(v/1000).toFixed(0)}GW`} />
                      <RechartsTooltip contentStyle={TS}
                        formatter={(v: number, name: string) => [
                          `${(v/1000).toFixed(2)} GW`,
                          name === "dispatch_mw" ? "Dispatched" : "Capacity",
                        ]} />
                      <Bar dataKey="capacity_mw" name="capacity_mw" fill="#1e293b" radius={[2,2,0,0]} />
                      <Bar dataKey="dispatch_mw" name="dispatch_mw" radius={[2,2,0,0]}>
                        {genByCarrier.map(g => (
                          <Cell key={g.carrier} fill={CARRIER_COLORS[g.carrier] ?? "#14b8a6"} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-x-4 text-xs">
                  {genByCarrier.slice(0, 6).map(g => (
                    <div key={g.carrier} className="flex justify-between py-0.5">
                      <span className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-sm inline-block"
                          style={{ background: CARRIER_COLORS[g.carrier] ?? "#14b8a6" }} />
                        {g.carrier}
                      </span>
                      <span className="font-mono text-muted-foreground">
                        {(g.dispatch_mw/1000).toFixed(1)} GW
                        <span className="text-[10px] ml-1 opacity-60">
                          ({(g.cf*100).toFixed(0)}% CF)
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Top congested lines */}
            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Top Loaded Transmission Corridors</CardTitle>
                <CardDescription className="text-xs">
                  Top {topLines.length} by loading % · {result.congested_lines} at ≥ 95%
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[210px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={topLines} layout="vertical"
                      margin={{ top: 4, right: 40, left: 10, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
                      <XAxis type="number" domain={[0, 100]}
                        tick={{ fontSize: 9, fill: "#94a3b8" }} tickFormatter={v => `${v}%`} />
                      <YAxis type="category" dataKey="name" width={90}
                        tick={{ fontSize: 8, fill: "#94a3b8" }}
                        tickFormatter={v => v.length > 14 ? v.slice(0, 14) + "…" : v} />
                      <RechartsTooltip contentStyle={TS}
                        formatter={(v: number) => [`${v.toFixed(1)}%`, "Loading"]} />
                      <Bar dataKey="loading_pct" radius={[0,2,2,0]}>
                        {topLines.map(l => (
                          <Cell key={l.name} fill={lineColor(l.loading_pct)} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                {/* Congestion rent summary */}
                <div className="mt-2 text-xs text-muted-foreground">
                  {topLines.filter(l => l.is_congested).length > 0 ? (
                    <span>
                      Congestion rents: {topLines.filter(l => l.is_congested).map(l => (
                        <span key={l.name} className="inline-block mr-2 font-mono">
                          <span className="text-amber-400">${l["congestion_rent_k$"].toFixed(1)}k/hr</span>
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="text-emerald-400">No congested lines in this scenario</span>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
