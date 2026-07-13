import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, ShieldCheck, CheckCircle, AlertCircle, Info, Clock } from "lucide-react";

type Market = "ERCOT" | "CAISO" | "PJM";

type ERCOTRow = {
  year: number; nodeType: string;
  uniqueNodes: number; totalRecords: number; rtRecords: number;
  volRecords: number; negRecords: number; rtPct: number;
};

type ERCOTData = {
  market: "ERCOT";
  totalNodes: number; totalRecords: number; rtRecords: number;
  minPeriod: string; maxPeriod: string; rtCompleteness: number;
  byYearAndType: ERCOTRow[];
};

type HubRow = {
  year: number; node: string;
  totalRecords: number; daRecords: number; rtRecords: number;
  volRecords: number; negRecords: number;
  avgDa: number | null; daPct: number;
};

type HubData = {
  market: "CAISO" | "PJM";
  totalNodes: number; totalRecords: number;
  daRecords: number; rtRecords: number;
  minPeriod: string; maxPeriod: string; daCompleteness: number;
  byYearAndNode: HubRow[];
};

type QualityData = ERCOTData | HubData;

const NODE_TYPE_LABELS: Record<string, string> = {
  resource_node: "Resource Nodes",
  hub: "Hubs",
  load_zone: "Load Zones",
};

const pct = (v: number) => {
  if (v >= 95) return "text-emerald-400";
  if (v >= 80) return "text-teal-400";
  if (v >= 60) return "text-amber-400";
  return "text-red-400";
};

const fmt = (n: number) => n.toLocaleString();

// ── Comprehensive data sources ────────────────────────────────────────────────
type Source = {
  label: string;
  category: string;
  icon: typeof CheckCircle;
  color: string;
  desc: string;
  coverage: string;
  tabs: string[];
  realData: boolean;
};

const ALL_SOURCES: Source[] = [
  {
    label: "ERCOT CDR Report 13061 — RTM Hub & Zone Prices",
    category: "ERCOT",
    icon: CheckCircle,
    color: "text-emerald-400",
    realData: true,
    desc: "Real-time market settlement point prices for 15 hub/zone nodes (HB_*, LZ_*). Annual XLSX via public ERCOT MIS download. 15-min intervals averaged monthly.",
    coverage: "Jan 2024 – Apr 2026 · 15 nodes",
    tabs: ["ERCOT Historical", "Nodal Analysis", "Congestion Analysis", "CI Engine", "Data Quality"],
  },
  {
    label: "ERCOT CDR Report 13060 — DAM Hub & Zone Prices",
    category: "ERCOT",
    icon: CheckCircle,
    color: "text-emerald-400",
    realData: true,
    desc: "Day-ahead market hub & load zone settlement point prices. Hourly intervals averaged monthly.",
    coverage: "Jan 2024 – Apr 2026 · 15 nodes",
    tabs: ["ERCOT Historical", "Nodal Analysis", "Congestion Analysis", "PPA / NPV Calculator", "Generator Stack"],
  },
  {
    label: "ERCOT CDR 13060/13061 — Hourly Hub & Zone Prices",
    category: "ERCOT",
    icon: CheckCircle,
    color: "text-emerald-400",
    realData: true,
    desc: "Full hourly DA and RT prices for 15 ERCOT hub/zone nodes. Parsed via custom Python XML parser — CDR files are too large for standard XLSX libraries.",
    coverage: "Jan 2024 – Dec 2025 · 263,130 rows",
    tabs: ["ERCOT Hourly", "PyPSA OPF Network", "PPA / NPV Calculator", "Congestion Intelligence (capture ratios)"],
  },
  {
    label: "ERCOT API np6-905-cd — RT Resource Node Prices",
    category: "ERCOT",
    icon: CheckCircle,
    color: "text-emerald-400",
    realData: true,
    desc: "Real-time prices for 1,108 ERCOT resource nodes. Monthly ZIP bundles from ERCOT developer API. Python seeder parses and upserts all nodes monthly.",
    coverage: "Jan 2024 – Apr 2026 · 28 months · 1,108 nodes",
    tabs: ["Congestion Intelligence", "CI Heatmap", "CI Node Detail", "CI Basis Analyzer", "Data Quality"],
  },
  {
    label: "ERCOT API np4-190-cd — DA Resource Node Prices",
    category: "ERCOT",
    icon: CheckCircle,
    color: "text-teal-400",
    realData: true,
    desc: "Day-ahead prices for 1,108 ERCOT resource nodes. DA coverage begins April 2024 — 20 months available vs 28 for RT.",
    coverage: "Apr 2024 – Apr 2026 · 20 months · 1,108 nodes",
    tabs: ["Congestion Intelligence", "CI Backtest", "Data Quality"],
  },
  {
    label: "ERCOT GIS Report pg7-200-er — Interconnection Queue",
    category: "ERCOT",
    icon: CheckCircle,
    color: "text-emerald-400",
    realData: true,
    desc: "1,793 real interconnection queue projects from ERCOT public EMIL portal. Parsed via gridstatus Python library — no authentication required.",
    coverage: "1,793 projects",
    tabs: ["Interconnection Queue", "Rankings (Interconnect Risk)", "Map Workspace"],
  },
  {
    label: "ERCOT SCED NP3-965-ER — 5-Min Dispatch & Offer Curves",
    category: "ERCOT",
    icon: CheckCircle,
    color: "text-emerald-400",
    realData: true,
    desc: "5-minute Security-Constrained Economic Dispatch data and generator offer curves from ERCOT 60-day disclosure. 1,215 resources aggregated hourly.",
    coverage: "Jan 2024 – May 2026 · ~26K rows/day",
    tabs: ["ERCOT Dispatch / SCED"],
  },
  {
    label: "ERCOT CDR 10008 — Bus Topology & Node Coordinates",
    category: "ERCOT",
    icon: CheckCircle,
    color: "text-emerald-400",
    realData: true,
    desc: "340-bus 345kV ERCOT transmission topology with bus coordinates. Used to build the PyPSA OPF network and geocode resource nodes. 819 resource node locations.",
    coverage: "819 node locations · 340 buses",
    tabs: ["PyPSA OPF Network", "Map Workspace (Node Locations)", "Congestion Intelligence"],
  },
  {
    label: "CAISO OASIS PRC_LMP DAM — Monthly Hub Prices",
    category: "CAISO",
    icon: CheckCircle,
    color: "text-emerald-400",
    realData: true,
    desc: "Day-ahead LMPs for NP15, SP15, ZP26 trading hubs. Public CAISO OASIS API, no authentication required. Some months return empty responses and are skipped.",
    coverage: "Jan 2024 – Apr 2026 · 70 rows",
    tabs: ["CAISO Historical", "Nodal Analysis", "Rankings (Basis Risk)", "Data Quality"],
  },
  {
    label: "CAISO OASIS PRC_LMP + PRC_HASP_LMP — Hourly Prices",
    category: "CAISO",
    icon: CheckCircle,
    color: "text-emerald-400",
    realData: true,
    desc: "Hourly DAM and HASP (hour-ahead) LMPs for NP15, SP15, ZP26. Idempotent seeder skips DA+RT-complete months; patches RT-only gaps.",
    coverage: "Jan 2024 – May 2026 · 63,495 rows",
    tabs: ["CAISO Hourly Price Data"],
  },
  {
    label: "CAISO OASIS ATL_PNODE_MAP — Pricing Node Locations",
    category: "CAISO",
    icon: CheckCircle,
    color: "text-emerald-400",
    realData: true,
    desc: "1,771 CAISO pricing node coordinates and zone assignments from OASIS ATL endpoint. Zone derived from APNODE_ID prefix (NP15 / SP15 / ZP26).",
    coverage: "1,774 rows · 1,771 exact coordinates",
    tabs: ["Map Workspace (Node Layer)"],
  },
  {
    label: "CAISO Public ISO Queue — Interconnection Projects",
    category: "CAISO",
    icon: CheckCircle,
    color: "text-emerald-400",
    realData: true,
    desc: "2,433 real CAISO interconnection queue projects from public ISO data. Includes technology, capacity, status, and estimated in-service date.",
    coverage: "2,433 projects",
    tabs: ["Interconnection Queue", "Rankings (Interconnect Risk)", "Map Workspace"],
  },
  {
    label: "PJM Published Hub Averages — Calibrated Model",
    category: "PJM",
    icon: AlertCircle,
    color: "text-amber-400",
    realData: false,
    desc: "8 PJM hub/zone monthly prices calibrated to published PJM hub averages. Real-time PJM node API requires a paid PJM account — not publicly accessible.",
    coverage: "14,336 rows (calibrated)",
    tabs: ["Rankings", "Interconnection Queue (PJM)", "Data Quality"],
  },
  {
    label: "PJM Interconnection Queue — Synthetic",
    category: "PJM",
    icon: AlertCircle,
    color: "text-amber-400",
    realData: false,
    desc: "580 synthetic PJM queue projects. PJM public queue access requires account credentials not available in this environment.",
    coverage: "580 synthetic projects",
    tabs: ["Interconnection Queue (PJM)"],
  },
  {
    label: "EIA Form 860 — Generator Registry",
    category: "EIA",
    icon: CheckCircle,
    color: "text-emerald-400",
    realData: true,
    desc: "3,875 operable generators >1 MW across ERCOT/CAISO/PJM from EIA 2024 Annual Survey. Includes technology, nameplate capacity, operating year, county, and BA code.",
    coverage: "2024 Annual Survey · 3,875 plants",
    tabs: ["Rankings", "Map Workspace", "PPA / NPV Calculator", "REC Analysis", "Load Forecast Stress Test"],
  },
  {
    label: "EIA Form 923 — Generation & Heat Rates",
    category: "EIA",
    icon: CheckCircle,
    color: "text-emerald-400",
    realData: true,
    desc: "Design heat rates and actual CO₂ rates for 31 ERCOT thermal plants from EIA 923 reported actuals.",
    coverage: "31 ERCOT thermal units",
    tabs: ["Generator Stack Intelligence"],
  },
  {
    label: "EIA-930 Region Sub-BA Data — Load by Zone",
    category: "EIA",
    icon: CheckCircle,
    color: "text-emerald-400",
    realData: true,
    desc: "Real hourly electricity demand for 8 ERCOT sub-BA zones (COAS, EAST, FWES, NCEN, NRTH, SCEN, SOUT, WEST) from EIA-930 API.",
    coverage: "Jan 2024 – Jun 2026 · 174,282 rows",
    tabs: ["Temperature & Load Forecast", "Load Forecast Stress Test"],
  },
  {
    label: "EIA-930 Fuel Type Data — ERCOT Fuel Mix",
    category: "EIA",
    icon: CheckCircle,
    color: "text-emerald-400",
    realData: true,
    desc: "Real hourly ERCOT generation by fuel type: gas, wind, solar, nuclear, coal, hydro, storage, other. Gas ~22 GW avg, wind ~13 GW, solar ~7 GW.",
    coverage: "Jan 2024 – Jun 2026 · 167,190 rows",
    tabs: ["Temperature & Load Forecast", "Load Forecast Stress Test"],
  },
  {
    label: "FRED DHHNGSP — Henry Hub Natural Gas Prices",
    category: "Market Data",
    icon: CheckCircle,
    color: "text-emerald-400",
    realData: true,
    desc: "Henry Hub daily spot prices from the St. Louis Fed FRED API. Public, no key required. Holiday gaps forward-filled from the prior trading day.",
    coverage: "651 rows",
    tabs: ["ERCOT Gas & Power Fundamentals", "PPA / NPV Calculator", "Generator Stack Intelligence"],
  },
  {
    label: "Open-Meteo Archive — Historical Temperatures",
    category: "Weather",
    icon: CheckCircle,
    color: "text-emerald-400",
    realData: true,
    desc: "Historical hourly temperatures for 11 zones (8 ERCOT + 3 CAISO) plus 3-year climatological projections via CMIP6. Used to build OLS load regression models (R²=0.88–0.92).",
    coverage: "232K+ hourly rows · 11 zones · 3-yr forecast",
    tabs: ["Temperature & Load Forecast", "Load Forecast Stress Test"],
  },
  {
    label: "HIFLD — Transmission Line Geometry",
    category: "Infrastructure",
    icon: CheckCircle,
    color: "text-emerald-400",
    realData: true,
    desc: "115kV+ ERCOT/CAISO/PJM and 345kV+ national transmission line GeoJSON geometry from the Homeland Infrastructure Foundation-Level Data set. Lazy-loaded to reduce initial map payload.",
    coverage: "23,674 line segments",
    tabs: ["Map Workspace (Transmission Layer)"],
  },
  {
    label: "NERC GADS — Forced Outage Rates",
    category: "Reliability",
    icon: CheckCircle,
    color: "text-teal-400",
    realData: true,
    desc: "Generator forced outage rates by unit type from NERC Generating Availability Data System 2023 ERCOT region summary.",
    coverage: "31 ERCOT thermal plants",
    tabs: ["Generator Stack Intelligence"],
  },
  {
    label: "EPA CAMPD CEMS — CO₂ Emission Rates",
    category: "Reliability",
    icon: CheckCircle,
    color: "text-teal-400",
    realData: true,
    desc: "Actual CO₂ emission rates (lb/MWh) for ERCOT thermal units from EPA Clean Air Markets Program Data CEMS 2023 actuals.",
    coverage: "31 ERCOT thermal plants",
    tabs: ["Generator Stack Intelligence"],
  },
];

const CATEGORY_ORDER = ["ERCOT", "CAISO", "PJM", "EIA", "Market Data", "Weather", "Infrastructure", "Reliability"];
const CATEGORY_COLORS: Record<string, string> = {
  ERCOT: "bg-teal-500/10 text-teal-300 border-teal-500/20",
  CAISO: "bg-blue-500/10 text-blue-300 border-blue-500/20",
  PJM: "bg-purple-500/10 text-purple-300 border-purple-500/20",
  EIA: "bg-amber-500/10 text-amber-300 border-amber-500/20",
  "Market Data": "bg-orange-500/10 text-orange-300 border-orange-500/20",
  Weather: "bg-sky-500/10 text-sky-300 border-sky-500/20",
  Infrastructure: "bg-slate-500/10 text-slate-300 border-slate-500/20",
  Reliability: "bg-rose-500/10 text-rose-300 border-rose-500/20",
};

export default function CIQuality() {
  const [market, setMarket] = useState<Market>("ERCOT");

  const { data, isLoading } = useQuery<QualityData>({
    queryKey: ["data-quality", market],
    queryFn: () =>
      fetch(`/api/congestion-intel/data-quality?market=${market}`).then(r => r.json()),
    staleTime: 600_000,
  });

  const groupedSources = CATEGORY_ORDER.map(cat => ({
    cat,
    items: ALL_SOURCES.filter(s => s.category === cat),
  })).filter(g => g.items.length > 0);

  return (
    <div className="p-6 h-full overflow-auto">
      <div className="max-w-6xl mx-auto space-y-6">

        {/* Header */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="h-5 w-5 text-emerald-400" />
            <h1 className="text-2xl font-bold">Data Quality Dashboard</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            Record completeness, coverage, and source provenance for all markets
          </p>
        </div>

        {/* Market selector */}
        <div className="flex gap-2">
          {(["ERCOT", "CAISO", "PJM"] as Market[]).map(m => (
            <button
              key={m}
              onClick={() => setMarket(m)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                market === m
                  ? "bg-teal-600 text-white border-teal-600"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* KPI cards */}
        {data && (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <Card>
                <CardHeader className="pb-1 pt-4 px-4">
                  <CardDescription className="text-xs">Total Nodes</CardDescription>
                </CardHeader>
                <CardContent className="pb-4 px-4">
                  <div className="text-3xl font-bold text-teal-400">{fmt(data.totalNodes)}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {market === "ERCOT" ? "Resource + hub/zone nodes" : `${market} pricing hubs`}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-1 pt-4 px-4">
                  <CardDescription className="text-xs">Total Records</CardDescription>
                </CardHeader>
                <CardContent className="pb-4 px-4">
                  <div className="text-3xl font-bold text-blue-400">{fmt(data.totalRecords)}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">Monthly node-stats rows</div>
                </CardContent>
              </Card>

              {data.market === "ERCOT" ? (
                <Card>
                  <CardHeader className="pb-1 pt-4 px-4">
                    <CardDescription className="text-xs">RT Completeness</CardDescription>
                  </CardHeader>
                  <CardContent className="pb-4 px-4">
                    <div className={`text-3xl font-bold ${pct(data.rtCompleteness)}`}>
                      {data.rtCompleteness}%
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {fmt(data.rtRecords)} / {fmt(data.totalRecords)} rows with RT price
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardHeader className="pb-1 pt-4 px-4">
                    <CardDescription className="text-xs">DA Completeness</CardDescription>
                  </CardHeader>
                  <CardContent className="pb-4 px-4">
                    <div className={`text-3xl font-bold ${pct((data as HubData).daCompleteness)}`}>
                      {(data as HubData).daCompleteness}%
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {fmt((data as HubData).daRecords)} / {fmt(data.totalRecords)} rows with DA price
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader className="pb-1 pt-4 px-4">
                  <CardDescription className="text-xs">Coverage Period</CardDescription>
                </CardHeader>
                <CardContent className="pb-4 px-4">
                  <div className="text-lg font-bold text-purple-400">
                    {data.minPeriod} → {data.maxPeriod}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {market === "ERCOT"
                      ? "28 mo RT · 20 mo DA (resource nodes)"
                      : market === "CAISO"
                      ? "Real OASIS data (NP15 / SP15 / ZP26)"
                      : "Calibrated to published PJM hub averages"}
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* ERCOT table */}
            {data.market === "ERCOT" && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                    ERCOT Node Stats — By Year & Node Type
                  </CardTitle>
                  <Badge variant="outline" className="text-xs text-emerald-400 border-emerald-400/30">Real Data</Badge>
                </div>
                <div className="border rounded-md overflow-auto bg-card">
                  <table className="w-full text-xs">
                    <thead className="bg-card sticky top-0 shadow-sm">
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="px-3 py-2 text-left">Year</th>
                        <th className="px-3 py-2 text-left">Node Type</th>
                        <th className="px-3 py-2 text-right">Unique Nodes</th>
                        <th className="px-3 py-2 text-right">Total Records</th>
                        <th className="px-3 py-2 text-right">RT Records</th>
                        <th className="px-3 py-2 text-right">RT %</th>
                        <th className="px-3 py-2 text-right">w/ Volatility</th>
                        <th className="px-3 py-2 text-right">w/ Neg Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byYearAndType.map(r => (
                        <tr key={`${r.year}-${r.nodeType}`} className="border-b border-border/40 hover:bg-muted/20">
                          <td className="px-3 py-1.5 font-medium">{r.year}</td>
                          <td className="px-3 py-1.5">
                            <Badge variant="outline" className="text-xs">
                              {NODE_TYPE_LABELS[r.nodeType] ?? r.nodeType}
                            </Badge>
                          </td>
                          <td className="px-3 py-1.5 text-right">{fmt(r.uniqueNodes)}</td>
                          <td className="px-3 py-1.5 text-right">{fmt(r.totalRecords)}</td>
                          <td className="px-3 py-1.5 text-right">{fmt(r.rtRecords)}</td>
                          <td className="px-3 py-1.5 text-right">
                            <span className={pct(r.rtPct)}>{r.rtPct}%</span>
                          </td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground">{fmt(r.volRecords)}</td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground">{fmt(r.negRecords)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-muted-foreground mt-1.5">
                  2026 partial (Jan–Apr). DA resource node coverage begins Apr 2024 (np4-190-cd bundle availability).
                </p>
              </div>
            )}

            {/* CAISO / PJM table */}
            {(data.market === "CAISO" || data.market === "PJM") && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                    {data.market} Node Stats — By Year & Hub
                  </CardTitle>
                  <Badge
                    variant="outline"
                    className={`text-xs ${data.market === "CAISO" ? "text-emerald-400 border-emerald-400/30" : "text-amber-400 border-amber-400/30"}`}
                  >
                    {data.market === "CAISO" ? "Real OASIS Data" : "Calibrated Model"}
                  </Badge>
                </div>
                <div className="border rounded-md overflow-auto bg-card">
                  <table className="w-full text-xs">
                    <thead className="bg-card sticky top-0 shadow-sm">
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="px-3 py-2 text-left">Year</th>
                        <th className="px-3 py-2 text-left">Node / Hub</th>
                        <th className="px-3 py-2 text-right">Total Records</th>
                        <th className="px-3 py-2 text-right">DA Records</th>
                        <th className="px-3 py-2 text-right">RT Records</th>
                        <th className="px-3 py-2 text-right">DA %</th>
                        <th className="px-3 py-2 text-right">w/ Volatility</th>
                        <th className="px-3 py-2 text-right">w/ Neg Price</th>
                        <th className="px-3 py-2 text-right">Avg DA $/MWh</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data as HubData).byYearAndNode.map(r => (
                        <tr key={`${r.year}-${r.node}`} className="border-b border-border/40 hover:bg-muted/20">
                          <td className="px-3 py-1.5 font-medium">{r.year}</td>
                          <td className="px-3 py-1.5">
                            <Badge variant="outline" className="text-xs font-mono">{r.node}</Badge>
                          </td>
                          <td className="px-3 py-1.5 text-right">{fmt(r.totalRecords)}</td>
                          <td className="px-3 py-1.5 text-right">{fmt(r.daRecords)}</td>
                          <td className="px-3 py-1.5 text-right">{fmt(r.rtRecords)}</td>
                          <td className="px-3 py-1.5 text-right">
                            <span className={pct(r.daPct)}>{r.daPct}%</span>
                          </td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground">{fmt(r.volRecords)}</td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground">{fmt(r.negRecords)}</td>
                          <td className="px-3 py-1.5 text-right text-teal-400">
                            {r.avgDa !== null ? `$${r.avgDa.toFixed(2)}` : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {data.market === "PJM" && (
                  <p className="text-xs text-amber-400/80 mt-1.5">
                    PJM prices are calibrated to published hub averages — real-time PJM node API requires a paid account.
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {/* Data Sources */}
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">
            All Data Sources & Platform Coverage
          </h2>
          <div className="space-y-6">
            {groupedSources.map(({ cat, items }) => (
              <div key={cat}>
                <div className="flex items-center gap-2 mb-2">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${CATEGORY_COLORS[cat] ?? "bg-muted/30 text-muted-foreground border-border"}`}>
                    {cat}
                  </span>
                  <div className="flex-1 h-px bg-border" />
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {items.map(s => (
                    <div
                      key={s.label}
                      className="bg-card border border-border rounded-md px-4 py-3 flex items-start gap-3"
                    >
                      <s.icon className={`h-4 w-4 mt-0.5 shrink-0 ${s.color}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-2 flex-wrap">
                          <span className="text-sm font-semibold leading-snug">{s.label}</span>
                          {!s.realData && (
                            <Badge variant="outline" className="text-xs text-amber-400 border-amber-400/30 shrink-0">
                              Calibrated
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{s.desc}</p>
                        <div className="flex items-center gap-1 mt-1.5">
                          <Clock className="h-3 w-3 text-muted-foreground/60 shrink-0" />
                          <span className="text-xs text-muted-foreground/80">{s.coverage}</span>
                        </div>
                        <div className="flex flex-wrap gap-1 mt-2">
                          {s.tabs.map(tab => (
                            <span
                              key={tab}
                              className="inline-flex items-center text-xs px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground border border-border/60"
                            >
                              {tab}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
