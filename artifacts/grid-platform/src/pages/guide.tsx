import { Link } from "wouter";
import {
  BarChart3, Map as MapIcon, List, Activity, Zap, Layers,
  GitBranch, Database, MessageSquare, Download, Bookmark,
  Target, Wrench, ArrowRight, CheckCircle2, Clock, AlertCircle,
  Building2, Bolt, TrendingUp, ShieldCheck, Cpu, Network,
  Brain, Flame, MapPin, FlaskConical, BookMarked, Leaf,
  BookOpen, Thermometer, Car, Server, Globe, Calculator,
  FileText, TrendingDown, Fuel, Battery, Gauge, Wind, Sun,
  Search,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const C = {
  teal:   "#14b8a6",
  amber:  "#f59e0b",
  purple: "#8b5cf6",
  green:  "#22c55e",
  blue:   "#3b82f6",
  red:    "#ef4444",
  orange: "#f97316",
  indigo: "#6366f1",
};

// ── Use Case definitions ──────────────────────────────────────────────────────
const USE_CASES = [
  {
    id: "origination",
    icon: Building2,
    color: C.teal,
    badge: "Use Case 1",
    title: "PPA / Offtake Origination",
    subtitle: "Source existing projects for energy offtake",
    description:
      "Identify renewable energy projects (wind, solar, storage) that can enter into Power Purchase Agreements or offtake contracts to hedge a portion of an electricity portfolio across ERCOT and CAISO.",
    steps: [
      "Pull all operating projects from EIA 860 onto the Map Workspace",
      "Screen projects by capacity, technology, ISO, COD, and sponsor quality",
      "Score each project across 10 risk dimensions: congestion, curtailment, basis, tax credit, etc.",
      "Drill into Congestion Intelligence for node-level basis history at each candidate's delivery point",
      "Rank and export the top candidates for deal team review",
    ],
    primaryTabs: ["Map Workspace", "Rankings", "Export Center"],
    supportTabs: ["Congestion Intelligence", "Nodal Analysis", "ERCOT/CAISO Historical"],
  },
  {
    id: "siting",
    icon: Bolt,
    color: C.amber,
    badge: "Use Case 2",
    title: "New Project Siting via Queue Analysis",
    subtitle: "Identify where a greenfield project can be commissioned",
    description:
      "Analyze the interconnection queue to find regions where a new project could be sited with acceptable queue position, limited congestion/curtailment competition, and favorable basis. Some areas already have heavy pipeline; others represent opportunity.",
    steps: [
      "Review interconnection queue depth by region, fuel type, and ISO",
      "Use PyPSA OPF to model which transmission corridors are binding",
      "Check CI Heat Map for nodes with low historical congestion and stable basis",
      "Cross-reference existing EIA 860 project density in the same zone",
      "Run ML Model prediction for basis/congestion at candidate nodes for the target horizon",
      "Rank candidate zones by queue risk, curtailment exposure, and price upside",
    ],
    primaryTabs: ["Interconnection Queue", "Congestion Intelligence", "PyPSA Engine"],
    supportTabs: ["Congestion Analysis", "Nodal Analysis", "Map Workspace"],
  },
];

// ── Tab reference ─────────────────────────────────────────────────────────────
const TABS = [
  {
    group: "Core Origination",
    items: [
      {
        title: "Dashboard",
        href: "/",
        icon: BarChart3,
        color: C.teal,
        status: "live",
        summary: "Top-level KPIs: total candidates screened, average scores by ISO, market activity snapshot. Entry point to both use cases.",
        dataSource: "Candidate DB + queue projects",
        useCases: ["origination"],
      },
      {
        title: "Map Workspace",
        href: "/map",
        icon: MapIcon,
        color: C.teal,
        status: "live",
        summary:
          "Interactive Leaflet map showing 3,875 operational plants from EIA Form 860 (2024) and interconnection queue projects. Filter by market, fuel type, and capacity range (1 MW–3 GW). Click any plant to see its COD, capacity, owner, and operational status.",
        dataSource: "EIA Form 860 2024 — Operable units >1 MW, ERCO/CISO balancing authority codes",
        useCases: ["origination", "siting"],
      },
      {
        title: "Rankings",
        href: "/rankings",
        icon: List,
        color: C.teal,
        status: "live",
        summary:
          "Sorted project ranking table with all 10 dimension scores: congestion risk, curtailment risk, basis risk, tax credit eligibility, sponsor quality, contract structure, market type, capacity available, delivery profile, and confidence score.",
        dataSource: "Candidates DB (3,875 EIA 860 plants scored on all 10 dimensions)",
        useCases: ["origination"],
        roadmap: "Auto-score candidates from EIA 860 using real nodal + queue data signals",
      },
      {
        title: "Export Center",
        href: "/export",
        icon: Download,
        color: C.teal,
        status: "live",
        summary:
          "Generate deal-ready candidate summary cards and export CSV files for the deal team. Filter by score threshold, ISO, or technology before exporting.",
        dataSource: "Candidates DB",
        useCases: ["origination"],
      },
      {
        title: "Saved Screenings",
        href: "/screenings",
        icon: Bookmark,
        color: C.purple,
        status: "live",
        summary:
          "Save and reload screening sessions — preserve filter combinations, scoring weights, and candidate shortlists for re-use across meetings and team members.",
        dataSource: "Screenings DB",
        useCases: ["origination"],
      },
    ],
  },
  {
    group: "Queue & Siting Intelligence",
    items: [
      {
        title: "Interconnection Queue",
        href: "/queue",
        icon: Database,
        color: C.amber,
        status: "live",
        summary:
          "Browse the active interconnection queue across ERCOT and CAISO. Filter by ISO, fuel type, capacity, and status. Identify how crowded a given transmission zone is — queue depth signals congestion risk for new projects in that corridor.",
        dataSource: "CAISO queue from public ISO data (2,433 real projects); ERCOT: 1,793 real projects",
        useCases: ["siting"],
        roadmap: "Live queue data pull from ISO APIs + geographic clustering by substation",
      },
    ],
  },
  {
    group: "Price Risk Analysis",
    items: [
      {
        title: "ERCOT Historical",
        href: "/ercot",
        icon: Activity,
        color: C.green,
        status: "live",
        summary:
          "Monthly DA and RT price trends for all 15 ERCOT hub/zone nodes: HB_HOUSTON, HB_NORTH, HB_SOUTH, HB_WEST, HB_PAN, HB_BUSAVG, HB_HUBAVG and the 8 load zones. Use to understand basis risk and price seasonality for a candidate's delivery point.",
        dataSource: "Real ERCOT CDR 13060 (DA) + 13061 (RT) — Jan 2024–Apr 2026, 420 monthly rows",
        useCases: ["origination", "siting"],
      },
      {
        title: "CAISO Historical",
        href: "/caiso",
        icon: Zap,
        color: C.green,
        status: "live",
        summary:
          "Monthly DA and RT LMP trends for CAISO's three pricing zones: NP15 (Northern CA), SP15 (Southern CA), and ZP26 (Central Valley). Price seasonality, summer peak risk, and hydro-driven volatility analysis.",
        dataSource: "Real CAISO OASIS PRC_LMP — NP15/SP15: 28 months; ZP26: 14 months",
        useCases: ["origination", "siting"],
      },
      {
        title: "Nodal Analysis",
        href: "/nodal",
        icon: Layers,
        color: C.blue,
        status: "live",
        summary:
          "Side-by-side comparison of any two ERCOT or CAISO settlement points (zones, hubs, or resource nodes). Toggle between DA, RT, or DA-RT spread mode. Critical for understanding basis risk at the specific delivery point of a candidate project.",
        dataSource: "ERCOT: real CDR Jan 2024–Apr 2026 (1,123 nodes); CAISO: real OASIS",
        useCases: ["origination", "siting"],
      },
      {
        title: "Congestion Analysis",
        href: "/congestion",
        icon: GitBranch,
        color: C.red,
        status: "live",
        summary:
          "Ranked view of DA–RT basis spread across all ERCOT settlement points — a direct proxy for transmission congestion and generation curtailment. Annual bar chart ranks ~804 resource nodes by congestion severity. Selecting any node drills into its monthly DA/RT area chart and a heatmap of spreads across all months. West Texas wind (WTG_*) and solar (SUN_*) nodes consistently show the highest spreads, flagging transmission-constrained corridors.",
        dataSource: "Real ERCOT CDR 13060/13061 + API bundles np6-905-cd/np4-190-cd — 1,123 nodes, Jan 2024–Apr 2026",
        useCases: ["origination", "siting"],
      },
    ],
  },
  {
    group: "Congestion Intelligence",
    items: [
      {
        title: "CI Overview",
        href: "/ci",
        icon: Flame,
        color: C.orange,
        status: "live",
        summary:
          "Portfolio-level dashboard summarising congestion events across the full 1,123-node ERCOT footprint. Shows counts of total nodes analysed, congestion/severe/extreme events, and negative-price months. A stacked monthly bar chart lets you see how congestion severity has evolved from Jan 2024 through Apr 2026. Threshold sliders (default: Congestion >$5, Severe >$15, Extreme >$30) are configurable.",
        dataSource: "ERCOT CDR 13060/13061 + API bundles np6-905-cd/np4-190-cd — 1,123 nodes, 28 months",
        useCases: ["origination", "siting"],
      },
      {
        title: "Heat Map",
        href: "/ci-heatmap",
        icon: MapPin,
        color: C.orange,
        status: "live",
        summary:
          "Sortable, filterable table ranking all 1,123 nodes by a composite 0–100 Risk Score built from |Avg Basis|, basis standard deviation, Max |Basis|, congestion-month %, and negative-price %. Search by node name, filter by node type (Resource / Hub / Load Zone), and sort by any column. Clicking a row navigates directly to that node's detail view.",
        dataSource: "Composite metrics derived from 28 months of real ERCOT node data",
        useCases: ["origination", "siting"],
      },
      {
        title: "Node Detail",
        href: "/ci-node",
        icon: Activity,
        color: C.orange,
        status: "live",
        summary:
          "Full time-series drill-down for any individual node. Shows a dual-axis area chart of monthly DA vs RT prices, a monthly basis bar chart, and a statistical summary panel (Mean, Median, P5, P95, congestion months, negative-price months). Select any of the 1,123 nodes via searchable dropdown.",
        dataSource: "ERCOT monthly node series — real CDR data Jan 2024–Apr 2026",
        useCases: ["origination", "siting"],
      },
      {
        title: "Basis Analyzer",
        href: "/ci-basis",
        icon: GitBranch,
        color: C.orange,
        status: "live",
        summary:
          "Compares any two nodes to evaluate hedging relationships or proxy suitability. Computes Pearson correlation, aligned months, and hedge effectiveness (R²). Side-by-side stats show mean basis, P5/P95, and volatility for both nodes. A line chart overlays their monthly basis profiles. Quick-select presets cover common hub/zone pairs.",
        dataSource: "Aligned historical ERCOT monthly series for selected node pairs",
        useCases: ["origination", "siting"],
      },
      {
        title: "2026 Backtest",
        href: "/ci-backtest",
        icon: FlaskConical,
        color: C.orange,
        status: "live",
        summary:
          "Evaluates a seasonal mean model (trained on 2024–2025 data) against the held-out Jan–Apr 2026 actuals. Reports MAE, RMSE, directional accuracy, F1 score, and a full confusion matrix (TP/FP/FN/TN) for congestion-event detection. A scatter plot of predicted vs actual basis and a per-month MAE bar chart show where the model performs well and where it breaks down.",
        dataSource: "2024–2025 training set vs Jan–Apr 2026 held-out ERCOT actuals",
        useCases: ["origination", "siting"],
      },
      {
        title: "Data Quality",
        href: "/ci-quality",
        icon: ShieldCheck,
        color: C.orange,
        status: "live",
        summary:
          "Monitors record completeness and data provenance across the full node universe. Shows total records, RT completeness %, coverage periods (min/max date), and breakdown by year and node type. Use this to identify any gaps before relying on a node's statistics for deal decisions.",
        dataSource: "Database metadata from ercot_node_stats table",
        useCases: ["origination", "siting"],
      },
      {
        title: "Methodology",
        href: "/ci-methodology",
        icon: BookMarked,
        color: C.orange,
        status: "live",
        summary:
          "Documentation page explaining the full technical architecture of the Congestion Intelligence engine: data pipeline (Python → PostgreSQL), node coverage, basis calculation methodology, Risk Score formula, how the seasonal mean backtest model works, and the business case for each metric.",
        dataSource: "Reference documentation",
        useCases: ["origination", "siting"],
      },
    ],
  },
  {
    group: "PyPSA Engine",
    items: [
      {
        title: "OPF Network",
        href: "/pypsa-network",
        icon: Network,
        color: C.indigo,
        status: "live",
        summary:
          "Interactive DC Optimal Power Flow simulator using a 340-bus ERCOT network (real bus/node topology from ERCOT shift-factor data). Adjust System Load, Wind/Solar Capacity Factors, and Gas Price via sliders, then click Run OPF to dispatch a new optimisation. Results show nodal LMPs, line loading %, generation dispatch by fuel type (Gas, Wind, Solar, Nuclear), and congestion rent. The network diagram colour-codes nodes green/amber/red by LMP level and shows line utilisation.",
        dataSource: "PyPSA + HiGHS LP solver — generators from EIA 860 aggregated by zone; synthetic load profiles",
        useCases: ["siting"],
      },
      {
        title: "ML Model",
        href: "/pypsa-ml",
        icon: Brain,
        color: C.indigo,
        status: "live",
        summary:
          "XGBoost model for predicting basis magnitude (regression) and congestion event probability (classification) at any ERCOT node. Train button re-fits the model on historical ERCOT features (hour-of-day, day-of-week, month, season, rolling basis, node type, historical congestion %). Feature Importance bar chart shows which signals drive predictions. Predicted vs Actual scatter plot visualises fit quality. Forward prediction tool lets you estimate basis and congestion probability for any node/month/year combination.",
        dataSource: "XGBoost trained on ERCOT monthly node features — ercot_node_stats",
        useCases: ["origination", "siting"],
      },
      {
        title: "Hourly Data",
        href: "/pypsa-hourly",
        icon: Clock,
        color: C.indigo,
        status: "live",
        summary:
          "High-resolution hourly price explorer for all 15 ERCOT hub/zone nodes. Select any node, year (2024–2025), and month, and the page shows 7 summary stats (Avg DA, Avg RT, Avg Basis, P5, P95, Peak RT, Peak Hour) plus three charts: DA vs RT line overlay, hourly basis bar chart (colour-coded teal/amber/red), and a grouped bar showing both prices for all 24 hours. Data is averaged across all days in the selected month.",
        dataSource: "Real ERCOT CDR 13060 (DA) + 13061 (RT) — 263,130 rows, 15 nodes, Jan 2024–Dec 2025",
        useCases: ["origination", "siting"],
      },
    ],
  },
  {
    group: "PyPSA Scenarios",
    items: [
      {
        title: "Curtailment Analysis",
        href: "/pypsa-curtailment",
        icon: Wind,
        color: C.indigo,
        status: "live",
        summary:
          "Curtailment risk scoring for ERCOT and CAISO candidates. Combines zone-level historical curtailment rates from real CDR and OASIS data with asset-type adjustments (wind/solar/storage) and a penalty multiplier for high-congestion nodes. Output is a 0–100 score displayed alongside all other scoring dimensions in Rankings.",
        dataSource: "Real ERCOT CDR + CAISO OASIS monthly data; zone curtailment rates derived from DA–RT spreads",
        useCases: ["origination", "siting"],
      },
      {
        title: "TX Relief Simulator",
        href: "/pypsa-tx-relief",
        icon: Network,
        color: C.indigo,
        status: "live",
        summary:
          "Simulates the LMP impact of upgrading a specific ERCOT transmission line. Choose a target corridor, set its thermal limit uplift, then run OPF to see before/after nodal prices and congestion rent. Useful for evaluating whether a proposed transmission upgrade would materially change basis for a candidate node.",
        dataSource: "PyPSA 340-bus ERCOT network; HiGHS LP solver",
        useCases: ["siting"],
      },
      {
        title: "Scarcity Events",
        href: "/pypsa-scarcity",
        icon: Flame,
        color: C.indigo,
        status: "live",
        summary:
          "Models supply-shock scenarios: gas derate %, renewable CF drop, load surge. The OPF solver dispatches the stressed network and returns total load shed (MW), zone-level scarcity risk scores, and scarcity adder prices. Useful for stress-testing PPA delivery reliability assumptions.",
        dataSource: "PyPSA 340-bus ERCOT network; EIA 860 generator fleet",
        useCases: ["origination", "siting"],
      },
      {
        title: "Battery Storage",
        href: "/pypsa-battery",
        icon: Battery,
        color: C.indigo,
        status: "live",
        summary:
          "Simulates adding a utility-scale battery at any ERCOT bus. Configure capacity (MW/MWh), round-trip efficiency, and charging/discharging hours, then run OPF to see how storage arbitrages basis and reduces peak congestion. Shows dispatch schedule and LMP delta versus baseline.",
        dataSource: "PyPSA 340-bus ERCOT network; synthetic storage parameters",
        useCases: ["origination", "siting"],
      },
    ],
  },
  {
    group: "Market Intelligence",
    items: [
      {
        title: "Generator Stack",
        href: "/generators",
        icon: Fuel,
        color: C.green,
        status: "live",
        summary:
          "Merit-order dispatch model for ERCOT's thermal fleet (31 CCGT, CT, and steam units). Set system demand (5–30 GW thermal-only) and gas price, then view the resulting dispatch stack and system marginal price. Includes real heat rates, capacities, and start costs from EIA 860 / EIA 923. Useful for understanding when gas price changes push wind/solar into the money.",
        dataSource: "EIA 860/923 generator data; generators + thermal_params DB tables (31 ERCOT thermal units)",
        useCases: ["origination", "siting"],
      },
      {
        title: "ERCOT Gas Prices",
        href: "/ercot-gas",
        icon: TrendingDown,
        color: C.green,
        status: "live",
        summary:
          "Henry Hub natural gas spot price history (2024–2026) sourced from FRED (St. Louis Fed). Monthly and daily views, YoY comparison, and correlation with ERCOT hub prices. Since gas sets the marginal clearing price in most ERCOT hours, gas price trends are a leading indicator of renewable capture value.",
        dataSource: "FRED DHHNGSP — Henry Hub daily spot prices, 651 rows, public (no key required)",
        useCases: ["origination", "siting"],
      },
      {
        title: "ERCOT Dispatch (SCED)",
        href: "/ercot-dispatch",
        icon: Gauge,
        color: C.green,
        status: "live",
        summary:
          "Real ERCOT 5-minute SCED dispatch and offer curves from NP3-965-ER 60-day disclosure data, aggregated to hourly. Browse dispatch by resource, zone, and time period. Shows dispatch quantity, offer price, and offer curve shape (with sentinel removal for [-250, 5000] MW extremes). 1,215 resources, Jan 2024–May 2026.",
        dataSource: "Real ERCOT NP3-965-ER SCED disclosure — ~13M rows, 1,215 resources, Jan 2024–May 2026",
        useCases: ["origination", "siting"],
      },
      {
        title: "CAISO Hourly",
        href: "/caiso-hourly",
        icon: Activity,
        color: C.green,
        status: "live",
        summary:
          "Hourly DA and RT LMP explorer for CAISO hubs (NP15, SP15, ZP26). Select node, year, and month to view 24-hour price profiles, hourly basis bar chart, and monthly summary stats. Includes HASP (Hour-Ahead Scheduling Process) RT prices alongside DAM prices for intra-day spread analysis.",
        dataSource: "Real CAISO OASIS PRC_LMP (DAM) + PRC_HASP_LMP (HASP) — 63,495 rows, 3 nodes, 29 months",
        useCases: ["origination", "siting"],
      },
    ],
  },
  {
    group: "Load & Infrastructure",
    items: [
      {
        title: "Temperature & Load Forecast",
        href: "/weather",
        icon: Thermometer,
        color: C.blue,
        status: "live",
        summary:
          "Three-year (Jul 2026–Jun 2029) temperature and load forecasts for all 8 ERCOT zones and 3 CAISO zones. Historical hourly temperature data (232k+ rows) feeds an OLS regression model (R²=0.88–0.92 in major zones) to project daily peak load. Includes EV adoption increments and datacenter load growth layered on base. Toggle between zones and view CDDs/HDDs by year.",
        dataSource: "Historical: NOAA climate baselines (11 zones). Forecast: OLS Load~Temp+Temp²+seasonality. EV/DC increments layered.",
        useCases: ["origination", "siting"],
      },
      {
        title: "EV Charging",
        href: "/ev-charging",
        icon: Car,
        color: C.blue,
        status: "live",
        summary:
          "Models EV fleet growth impact on ERCOT load by zone (2024–2029). Shows base ERCOT load profile from real EIA-930 hourly data alongside projected EV charging curves at different adoption scenarios. Peak shifting analysis shows how managed charging (TOU rates) vs unmanaged charging changes evening demand ramps by zone.",
        dataSource: "Real EIA-930 ERCOT load (174k rows, 8 zones). EV curves: S-curve adoption model by zone.",
        useCases: ["siting"],
      },
      {
        title: "AI & Datacenters",
        href: "/datacenters",
        icon: Server,
        color: C.blue,
        status: "live",
        summary:
          "Database of 55 hyperscaler and colocation facilities across ERCOT, CAISO, and PJM. Each record shows operator, capacity (MW), zone, commissioning year, and status. The page aggregates total load by zone and operator, showing where AI infrastructure buildout is concentrating grid demand. NCEN (North Central Texas) is the fastest-growing zone.",
        dataSource: "55 curated datacenter records from public announcements (Microsoft, Meta, Google, Oracle, Amazon, etc.)",
        useCases: ["siting"],
      },
    ],
  },
  {
    group: "Financial & ESG",
    items: [
      {
        title: "REC Analysis",
        href: "/recs",
        icon: Leaf,
        color: C.green,
        status: "live",
        summary:
          "Renewable Energy Certificate portfolio analysis across ERCOT, CAISO, and PJM. Calculates gross annual REC production from EIA 860 capacity and technology-specific capacity factors. Uses assumed market prices (TRC $2.50/MWh ERCOT, WREGIS $3.00/MWh CAISO, SREC/ERC $4.00/MWh PJM) to show gross REC value by project, zone, and technology. Filter by market or technology to build a targeted REC procurement shortlist.",
        dataSource: "EIA 860 2024 capacity × assumed capacity factors. REC prices: assumed market levels (not live quotes).",
        useCases: ["origination"],
      },
      {
        title: "PPA / NPV Calculator",
        href: "/ppa",
        icon: Calculator,
        color: C.green,
        status: "live",
        summary:
          "Virtual PPA (VPPA) net-present-value calculator with P10/P50/P90 price distributions. Configure strike price, contract term (years), hedge volume (MWh/yr), discount rate, and price escalator. Cashflow model uses real nodal price distributions from 28 months of ERCOT/CAISO data to simulate forward price uncertainty. Output shows annual cashflows, NPV by percentile, and breakeven strike price.",
        dataSource: "Real nodal price distributions from ercot_node_stats + caiso_node_stats. User-configured assumptions.",
        useCases: ["origination"],
      },
      {
        title: "Regulatory Tracker",
        href: "/regulatory",
        icon: FileText,
        color: C.purple,
        status: "live",
        summary:
          "Curated database of 30 regulatory and policy items across ERCOT (10), CAISO (8), and Federal/IRA (12). Each item shows status (Active/Proposed/Enacted/Under Review), effective date, and impact description. Covers IRA ITC/PTC adders, ERCOT RTCO reform, CAISO PTB interconnection changes, and key FERC orders. Filtered view by market. Monthly scraper maintains currency.",
        dataSource: "30 manually curated items. Covers IRA (Aug 2022+), FERC, ERCOT, and CAISO rulemaking through mid-2026.",
        useCases: ["origination", "siting"],
      },
    ],
  },
  {
    group: "Assistance",
    items: [
      {
        title: "Q&A Copilot",
        href: "/qa",
        icon: MessageSquare,
        color: C.purple,
        status: "live",
        summary:
          "AI assistant with four capabilities: (1) SQL queries against the full platform database — ask 'Which ERCOT wind projects have the lowest congestion risk?' and it writes and runs the SQL; (2) PyPSA simulation — 'Run a high-wind OPF for ERCOT' triggers the live solver and renders LMP results inline; (3) Web search — 'What are current TRC REC prices?' fetches live data via web; (4) Deep-link navigation — responses embed clickable buttons that jump you to the relevant tab with filters pre-applied. Full context across all platform tabs and DB schemas.",
        dataSource: "All platform DB tables + PyPSA engine + DuckDuckGo web search. OpenAI GPT-4o.",
        useCases: ["origination", "siting"],
      },
    ],
  },
];

// ── Status badge ──────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  if (status === "live") return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-green-400">
      <CheckCircle2 className="h-3 w-3" /> Live
    </span>
  );
  if (status === "planned") return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-400">
      <Clock className="h-3 w-3" /> Planned
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <AlertCircle className="h-3 w-3" /> Partial
    </span>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function PlatformGuide() {
  return (
    <div className="p-8 h-full overflow-auto space-y-10">

      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck className="h-6 w-6 text-primary" />
          <span className="text-xs font-semibold text-primary uppercase tracking-widest">Platform Guide</span>
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Grid Origination Intelligence Platform</h1>
        <p className="text-muted-foreground mt-1 max-w-3xl">
          A power market siting and PPA origination intelligence tool for energy procurement teams.
          Identify, screen, and rank renewable energy projects as potential offtake candidates — and assess where
          new greenfield projects can be sited with favorable queue position and manageable risk.
        </p>
      </div>

      {/* Use Case Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {USE_CASES.map(uc => (
          <Card key={uc.id} className="border-border relative overflow-hidden">
            <div className="absolute top-0 left-0 right-0 h-0.5" style={{ backgroundColor: uc.color }} />
            <CardHeader className="pb-3">
              <div className="flex items-start gap-3">
                <div className="rounded-lg p-2.5" style={{ backgroundColor: `${uc.color}22` }}>
                  <uc.icon className="h-5 w-5" style={{ color: uc.color }} />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: uc.color }}>{uc.badge}</span>
                  </div>
                  <CardTitle className="text-base">{uc.title}</CardTitle>
                  <CardDescription className="text-xs mt-0.5">{uc.subtitle}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">{uc.description}</p>
              <div>
                <div className="text-xs font-semibold text-foreground mb-2">Workflow Steps</div>
                <ol className="space-y-1.5">
                  {uc.steps.map((s, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                      <span className="font-semibold shrink-0 mt-0.5" style={{ color: uc.color }}>{i + 1}.</span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="flex flex-wrap gap-3 pt-1">
                <div>
                  <div className="text-xs font-semibold text-foreground mb-1.5">Primary Tabs</div>
                  <div className="flex flex-wrap gap-1.5">
                    {uc.primaryTabs.map(t => (
                      <span key={t} className="px-2 py-0.5 rounded text-xs font-medium border"
                        style={{ borderColor: uc.color, color: uc.color, backgroundColor: `${uc.color}12` }}>{t}</span>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold text-foreground mb-1.5">Supporting Tabs</div>
                  <div className="flex flex-wrap gap-1.5">
                    {uc.supportTabs.map(t => (
                      <span key={t} className="px-2 py-0.5 rounded text-xs font-medium text-muted-foreground border border-border">{t}</span>
                    ))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Workflow Arrow */}
      <div className="flex items-center gap-2 flex-wrap text-sm text-muted-foreground">
        <TrendingUp className="h-4 w-4 text-primary shrink-0" />
        <span className="font-medium text-foreground">Suggested Workflow:</span>
        {["Map Workspace", "Rankings", "Congestion Intelligence", "Nodal Analysis", "PyPSA Engine", "Queue", "PPA Calculator", "Export", "Q&A Copilot"].map((step, i, arr) => (
          <span key={step} className="flex items-center gap-2">
            <span className="px-2 py-0.5 rounded bg-card border border-border text-xs">{step}</span>
            {i < arr.length - 1 && <ArrowRight className="h-3 w-3 shrink-0" />}
          </span>
        ))}
      </div>

      {/* Tab Reference */}
      {TABS.map(group => (
        <div key={group.group} className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground px-3">{group.group}</span>
            <div className="h-px flex-1 bg-border" />
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {group.items.map(tab => (
              <Card key={tab.href} className="hover:border-primary/40 transition-colors">
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start gap-3">
                    <div className="rounded-md p-2 shrink-0" style={{ backgroundColor: `${tab.color}18` }}>
                      <tab.icon className="h-4 w-4" style={{ color: tab.color }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <Link href={tab.href}>
                          <span className="font-semibold text-sm hover:text-primary transition-colors cursor-pointer">{tab.title}</span>
                        </Link>
                        <StatusBadge status={tab.status} />
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed mb-2">{tab.summary}</p>
                      <div className="flex flex-wrap gap-2 text-xs">
                        <span className="text-muted-foreground">
                          <span className="font-medium text-foreground/70">Data: </span>
                          {tab.dataSource}
                        </span>
                      </div>
                      {(tab as any).roadmap && (
                        <div className="mt-2 px-2.5 py-1.5 rounded bg-amber-500/8 border border-amber-500/20 text-xs text-amber-400">
                          <span className="font-semibold">Roadmap: </span>{(tab as any).roadmap}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {tab.useCases.map(uc => {
                          const ucDef = USE_CASES.find(u => u.id === uc);
                          return (
                            <span key={uc} className="px-1.5 py-0.5 rounded text-xs"
                              style={{ backgroundColor: `${ucDef!.color}15`, color: ucDef!.color }}>
                              {ucDef!.badge}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ))}

      {/* Data Status */}
      <Card className="border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Data Status</CardTitle>
          <CardDescription className="text-xs">What's real, what's modelled, what's planned</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
            {[
              {
                label: "ERCOT Hub/Zone Prices — Monthly",
                status: "real",
                detail: "420 rows. Real CDR 13060 (DA) + 13061 (RT). All 15 hub/zone nodes, Jan 2024–Apr 2026.",
              },
              {
                label: "ERCOT Hub/Zone Prices — Hourly",
                status: "real",
                detail: "263,130 rows. Real CDR 13060/13061. 15 nodes × hourly DA+RT, Jan 2024–Dec 2025. Python XML parser.",
              },
              {
                label: "ERCOT Resource Nodes (~1,108)",
                status: "real",
                detail: "27,193 rows. Real from ERCOT API bundles np6-905-cd (RT) + np4-190-cd (DA). Jan 2024–Apr 2026.",
              },
              {
                label: "CAISO Prices (DA)",
                status: "real",
                detail: "Real from CAISO OASIS PRC_LMP. NP15 + SP15: 28 months; ZP26: 14 months. RT modelled.",
              },
              {
                label: "Interconnection Queue",
                status: "real",
                detail: "CAISO: 2,433 real projects from public ISO data. ERCOT: 1,793 real projects from GIS Report.",
              },
              {
                label: "EIA 860 Project Database",
                status: "real",
                detail: "3,875 operable generators >1 MW from EIA Form 860 2024. Filtered by ERCO/CISO BA codes.",
              },
              {
                label: "PyPSA OPF Engine",
                status: "real",
                detail: "Live Python FastAPI microservice. HiGHS LP solver. 340-bus ERCOT network. Runs on-demand.",
              },
              {
                label: "XGBoost ML Model",
                status: "real",
                detail: "Live XGBoost basis regression + congestion classifier. Trained on 1,123-node ERCOT monthly features.",
              },
              {
                label: "Candidate Scoring",
                status: "partial",
                detail: "Scoring engine live on all 3,875 EIA 860 plants. Real signal scoring from nodal + queue data planned.",
              },
              {
                label: "Q&A Copilot",
                status: "real",
                detail: "Live: SQL query tool, PyPSA simulation tool, web search (DuckDuckGo), deep-link navigation. GPT-4o with full platform DB context.",
              },
              {
                label: "REC Analysis",
                status: "partial",
                detail: "EIA 860 capacity × assumed CFs → gross REC production. Prices assumed (TRC $2.50, WREGIS $3.00, SREC $4.00). Not live market quotes.",
              },
              {
                label: "PPA / NPV Calculator",
                status: "real",
                detail: "P10/P50/P90 VPPA NPV using real nodal price distributions from 28 months ERCOT/CAISO data. User-configured assumptions.",
              },
              {
                label: "Temperature & Load Forecast",
                status: "real",
                detail: "232k+ hourly temp rows (11 zones). 3yr load forecast (8,768 rows). OLS R²=0.88–0.92. EV/DC increments layered.",
              },
              {
                label: "ERCOT Gas Prices",
                status: "real",
                detail: "651 rows Henry Hub daily spot from FRED DHHNGSP. Public, no API key. Gaps forward-filled from prior trading day.",
              },
              {
                label: "Generator Stack (Thermal)",
                status: "real",
                detail: "31 ERCOT thermal units with real heat rates/capacities from EIA 860/923. Merit-order dispatch model.",
              },
              {
                label: "ERCOT Dispatch (SCED)",
                status: "real",
                detail: "Real 5-min SCED dispatch from NP3-965-ER. ~13M rows, 1,215 resources, Jan 2024–May 2026.",
              },
              {
                label: "AI & Datacenters",
                status: "seeded",
                detail: "55 curated hyperscaler/colo facilities (ERCOT/CAISO/PJM) from public announcements. No live feed.",
              },
              {
                label: "Regulatory Tracker",
                status: "seeded",
                detail: "30 manually curated policy items (ERCOT ×10, CAISO ×8, Federal/IRA ×12). Monthly scraper maintains currency.",
              },
              {
                label: "CAISO Hourly Prices",
                status: "real",
                detail: "63,495 rows. Real OASIS PRC_LMP (DAM) + PRC_HASP_LMP (HASP). NP15/SP15/ZP26 × 29 months.",
              },
            ].map(item => (
              <div key={item.label} className="flex gap-2 p-2.5 rounded-md bg-card border border-border">
                <div className="shrink-0 mt-0.5">
                  {item.status === "real"    ? <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />  :
                   item.status === "seeded"  ? <CheckCircle2 className="h-3.5 w-3.5 text-teal-400" />   :
                   item.status === "partial" ? <AlertCircle  className="h-3.5 w-3.5 text-amber-400" />  :
                   item.status === "modelled"? <Clock        className="h-3.5 w-3.5 text-blue-400" />   :
                                               <Clock        className="h-3.5 w-3.5 text-muted-foreground" />}
                </div>
                <div>
                  <div className="font-semibold text-foreground">{item.label}</div>
                  <div className="text-muted-foreground mt-0.5">{item.detail}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3 w-3 text-green-400" /> Real data</span>
            <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3 w-3 text-teal-400" /> Seeded from public sources</span>
            <span className="flex items-center gap-1.5"><AlertCircle  className="h-3 w-3 text-amber-400" /> Partial (real + modelled)</span>
            <span className="flex items-center gap-1.5"><Clock        className="h-3 w-3 text-blue-400"  /> Modelled / calibrated</span>
            <span className="flex items-center gap-1.5"><Clock        className="h-3 w-3 text-muted-foreground" /> Planned</span>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}
