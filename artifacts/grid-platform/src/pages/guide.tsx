import { Link } from "wouter";
import {
  BarChart3, Map as MapIcon, List, Activity, Zap, Layers,
  GitBranch, Database, MessageSquare, Download, Bookmark,
  Target, Wrench, ArrowRight, CheckCircle2, Clock, AlertCircle,
  Building2, Bolt, TrendingUp, ShieldCheck, Cpu, Network,
  Brain, Flame, MapPin, FlaskConical, BookMarked, Leaf,
  BookOpen,
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
      "Identify renewable energy projects (wind, solar, storage) that can enter into Power Purchase Agreements or offtake contracts to hedge a portion of an electricity portfolio across ERCOT, CAISO, and PJM.",
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
        dataSource: "EIA Form 860 2024 — Operable units >1 MW, ERCO/CISO/PJM balancing authority codes",
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
          "Browse the active interconnection queue across ERCOT, CAISO, and PJM. Filter by ISO, fuel type, capacity, and status. Identify how crowded a given transmission zone is — queue depth signals congestion risk for new projects in that corridor.",
        dataSource: "CAISO queue from public ISO data (2,433 real projects); ERCOT/PJM seeded",
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
        title: "PJM Historical",
        href: "/pjm",
        icon: Activity,
        color: C.green,
        status: "live",
        summary:
          "Monthly DA and RT analysis for PJM's 8 major hubs/zones: Western Hub, Eastern Hub, AEP-Dayton, NI Hub, PSEG, PPL, DOM, BGE. On/off-peak split, volatility metrics, zone spread analysis, and YoY comparison.",
        dataSource: "Calibrated model from published PJM/EIA benchmarks — 14,336 rows",
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
    group: "Assistance",
    items: [
      {
        title: "Q&A Copilot",
        href: "/qa",
        icon: MessageSquare,
        color: C.purple,
        status: "planned",
        summary:
          "AI assistant that answers natural-language questions about projects, price history, queue depth, and risk scores. Ask things like 'Which ERCOT wind projects have the lowest congestion risk?' or 'What is the average DA–RT spread at LZ_WEST in 2024?' Will use the full platform database as context via structured SQL + RAG.",
        dataSource: "All platform data — planned OpenAI integration",
        useCases: ["origination", "siting"],
        roadmap: "Connect OpenAI to the platform DB for structured Q&A against all tables",
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
        {["Map Workspace", "Rankings", "Congestion Intelligence", "PyPSA Engine", "Queue", "Export"].map((step, i, arr) => (
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
                label: "PJM Hub/Zone Prices",
                status: "modelled",
                detail: "14,336 rows. Calibrated model from published PJM/EIA monthly hub averages. No public real-time API.",
              },
              {
                label: "Interconnection Queue",
                status: "seeded",
                detail: "CAISO: 2,433 real projects from public ISO data. ERCOT/PJM: synthetic seeded data.",
              },
              {
                label: "EIA 860 Project Database",
                status: "real",
                detail: "3,875 operable generators >1 MW from EIA Form 860 2024. Filtered by ERCO/CISO/PJM BA codes.",
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
                status: "planned",
                detail: "OpenAI integration planned. Will answer questions from platform DB via SQL + RAG.",
              },
              {
                label: "REC Analysis",
                status: "planned",
                detail: "Renewable Energy Certificate pricing, vintage analysis, and buyer-seller matching. Roadmap item.",
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
