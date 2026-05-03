import { Link } from "wouter";
import {
  BarChart3, Map as MapIcon, List, Activity, Zap, Layers,
  GitBranch, Database, MessageSquare, Download, Bookmark,
  Target, Wrench, ArrowRight, CheckCircle2, Clock, AlertCircle,
  Building2, Bolt, TrendingUp, ShieldCheck,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const C = {
  teal: "#14b8a6", amber: "#f59e0b", purple: "#8b5cf6",
  green: "#22c55e", blue: "#3b82f6", red: "#ef4444",
};

// ── Use Case definitions ──────────────────────────────────────────────────────
const USE_CASES = [
  {
    id: "origination",
    icon: Building2,
    color: C.teal,
    badge: "Use Case 1",
    title: "PPA / Offtake Origination",
    subtitle: "Source existing projects for Walmart energy hedging",
    description:
      "Identify renewable energy projects (wind, solar, storage) that can enter into Power Purchase Agreements or offtake contracts with Walmart to hedge a portion of their electricity portfolio across ERCOT, CAISO, and PJM.",
    steps: [
      "Pull all operating and under-construction projects from EIA 860 onto the Map Workspace",
      "Screen projects by capacity, technology, ISO, COD, and sponsor quality",
      "Score each project across 10 risk dimensions: congestion, curtailment, basis, tax credit, etc.",
      "Rank and export the top candidates for deal team review",
    ],
    primaryTabs: ["Map Workspace", "Rankings", "Export Center"],
    supportTabs: ["Nodal Analysis", "Congestion Analysis", "ERCOT/CAISO Historical"],
  },
  {
    id: "siting",
    icon: Bolt,
    color: C.amber,
    badge: "Use Case 2",
    title: "New Project Siting via Queue Analysis",
    subtitle: "Identify where Walmart can commission a greenfield project",
    description:
      "Analyze the interconnection queue to find regions where a new project could be sited with acceptable queue position, limited congestion/curtailment competition, and favorable basis. Some areas already have heavy pipeline; others represent opportunity.",
    steps: [
      "Review interconnection queue depth by region, fuel type, and ISO",
      "Overlay congestion analysis — heavy DA-RT spreads signal saturated corridors",
      "Cross-reference existing EIA 860 project density in the same transmission zone",
      "Assess basis risk using nodal price history for target settlement points",
      "Rank candidate zones by queue risk, curtailment exposure, and price upside",
    ],
    primaryTabs: ["Interconnection Queue", "Congestion Analysis", "Map Workspace"],
    supportTabs: ["Nodal Analysis", "PJM / ERCOT / CAISO Historical"],
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
        summary: "Top-level KPIs: total candidates screened, average scores by ISO, market activity snapshot.",
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
          "Interactive Leaflet map showing candidate project pins (from EIA 860) and interconnection queue projects. Visually identify geographic clusters, transmission corridors, and candidate density by zone.",
        dataSource: "EIA 860 projects (target) + queue DB",
        useCases: ["origination", "siting"],
        roadmap: "EIA 860 bulk import (Form 860 plant-level data for ERCOT/CAISO/PJM)",
      },
      {
        title: "Rankings",
        href: "/rankings",
        icon: List,
        color: C.teal,
        status: "live",
        summary:
          "Sorted project ranking table with all 10 dimension scores: congestion risk, curtailment risk, basis risk, tax credit eligibility, sponsor quality, contract structure, market type, capacity available, delivery profile, and confidence score.",
        dataSource: "Candidates DB (scored on all 10 dimensions)",
        useCases: ["origination"],
        roadmap: "Auto-score candidates from EIA 860 using real nodal + queue data",
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
        dataSource: "Queue DB (seeded from ERCOT, CAISO, PJM queue reports)",
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
          "Monthly DA and RT price trends for all ERCOT hubs (HB_HOUSTON, HB_NORTH, HB_SOUTH, HB_WEST, HB_PAN, etc.) and load zones (LZ_NORTH, LZ_SOUTH, LZ_WEST, LZ_HOUSTON, LZ_AEN, LZ_CPS, LZ_LCRA, LZ_RAYBN). Use to understand basis risk and price seasonality for a potential delivery point.",
        dataSource: "Real CDR prices Jun 2024–Apr 2025; synthetic 2022–May 2024",
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
        dataSource: "Modeled from EIA CAISO benchmarks 2022–2026",
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
        dataSource: "Modeled from published PJM/EIA benchmarks 2022–2026",
        useCases: ["origination", "siting"],
      },
      {
        title: "Nodal Analysis",
        href: "/nodal",
        icon: Layers,
        color: C.blue,
        status: "live",
        summary:
          "Side-by-side comparison of any two ERCOT or CAISO settlement points (zones, hubs, or resource nodes). Toggle between DA, RT, or DA-RT spread mode. Critical for understanding basis risk at the specific delivery point of a candidate project — if a project delivers into a node with high DA-RT spread, the offtaker or generator bears that basis risk.",
        dataSource: "ERCOT: real Jun 2024+; CAISO: modeled",
        useCases: ["origination", "siting"],
      },
      {
        title: "Congestion Analysis",
        href: "/congestion",
        icon: GitBranch,
        color: C.red,
        status: "live",
        summary:
          "Ranked view of DA-RT basis spread across all ERCOT settlement points — a direct proxy for transmission congestion and generation curtailment. West Texas wind nodes (WTG_*) and solar nodes (SUN_*) consistently show the highest spreads, indicating those corridors are transmission-constrained. Use this to assess curtailment risk for any candidate project in those zones.",
        dataSource: "ERCOT nodal stats (modeled RT basis by node type)",
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
          "AI assistant that can answer natural-language questions about projects, price history, queue depth, and risk scores. Ask things like 'Which ERCOT wind projects have the lowest congestion risk?' or 'What is the average DA-RT spread at LZ_WEST in 2024?' Will use the full platform database as context.",
        dataSource: "All platform data via RAG/structured SQL",
        useCases: ["origination", "siting"],
        roadmap: "Connect OpenAI to the platform DB for structured Q&A",
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
          A power market siting and PPA origination tool purpose-built to help Walmart identify, screen, and rank
          renewable energy projects as potential offtake candidates — and assess where new greenfield projects can be
          sited with favorable queue position and manageable risk.
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
                      <span key={t} className="px-2 py-0.5 rounded text-xs font-medium border" style={{ borderColor: uc.color, color: uc.color, backgroundColor: `${uc.color}12` }}>{t}</span>
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
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <TrendingUp className="h-4 w-4 text-primary shrink-0" />
        <span className="font-medium text-foreground">Suggested Workflow:</span>
        {["Map Workspace", "Rankings", "Congestion / Nodal", "Interconnection Queue", "Export Center"].map((step, i, arr) => (
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
                      {tab.roadmap && (
                        <div className="mt-2 px-2.5 py-1.5 rounded bg-amber-500/8 border border-amber-500/20 text-xs text-amber-400">
                          <span className="font-semibold">Roadmap: </span>{tab.roadmap}
                        </div>
                      )}
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {tab.useCases.map(uc => {
                          const ucDef = USE_CASES.find(u => u.id === uc);
                          return (
                            <span key={uc} className="px-1.5 py-0.5 rounded text-xs" style={{ backgroundColor: `${ucDef!.color}15`, color: ucDef!.color }}>
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
          <CardTitle className="text-sm">Data Status & Roadmap</CardTitle>
          <CardDescription className="text-xs">What's real vs. modeled, and what's coming next</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
            {[
              { label: "ERCOT Hub/Zone Prices", status: "partial", detail: "Real: Jun 2024 – Apr 2025 (CDR scraped). Synthetic: 2022–May 2024, May 2025+. All 15 hubs/zones." },
              { label: "ERCOT Resource Nodes (~947)", status: "modeled", detail: "Synthetic basis model (17 settlement points seeded). Real data needs ERCOT API client_id." },
              { label: "CAISO Prices", status: "modeled", detail: "NP15/SP15/ZP26 modeled from EIA benchmarks 2022–2026." },
              { label: "PJM Hub/Zone Prices", status: "modeled", detail: "8 hubs/zones modeled from published PJM/EIA benchmarks 2022–2026." },
              { label: "Interconnection Queue", status: "seeded", detail: "ERCOT/CAISO/PJM queue data seeded. Real API pull planned." },
              { label: "EIA 860 Project Database", status: "planned", detail: "All Form 860 operating/planned projects for ERCOT, CAISO, PJM. Needs EIA bulk import." },
              { label: "Candidate Scoring", status: "partial", detail: "Scoring engine live with mock candidates. Real scoring from EIA 860 + nodal data planned." },
              { label: "Q&A Copilot", status: "planned", detail: "OpenAI integration planned. Will answer questions from platform DB." },
            ].map(item => (
              <div key={item.label} className="flex gap-2 p-2.5 rounded-md bg-card border border-border">
                <div className="shrink-0 mt-0.5">
                  {item.status === "partial" ? <AlertCircle className="h-3.5 w-3.5 text-amber-400" /> :
                   item.status === "modeled" ? <Clock className="h-3.5 w-3.5 text-blue-400" /> :
                   item.status === "seeded" ? <CheckCircle2 className="h-3.5 w-3.5 text-teal-400" /> :
                   <Clock className="h-3.5 w-3.5 text-muted-foreground" />}
                </div>
                <div>
                  <div className="font-semibold text-foreground">{item.label}</div>
                  <div className="text-muted-foreground mt-0.5">{item.detail}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3 w-3 text-teal-400" /> Seeded / Live</span>
            <span className="flex items-center gap-1.5"><AlertCircle className="h-3 w-3 text-amber-400" /> Partial (real + modeled)</span>
            <span className="flex items-center gap-1.5"><Clock className="h-3 w-3 text-blue-400" /> Modeled / Synthetic</span>
            <span className="flex items-center gap-1.5"><Clock className="h-3 w-3 text-muted-foreground" /> Planned</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
