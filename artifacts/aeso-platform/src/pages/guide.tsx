import { Link } from "wouter";
import {
  LayoutDashboard, DollarSign, Factory, Scale, AlertTriangle,
  CalendarDays, ListOrdered, Route, BrainCircuit, TrendingUp,
  Workflow, Eye, BookOpen, CheckCircle2, Clock, AlertCircle,
  ArrowRight, Database,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const C = {
  teal: "#14b8a6",
  amber: "#f59e0b",
  purple: "#8b5cf6",
  blue: "#3b82f6",
  green: "#22c55e",
};

interface GuideItem {
  title: string;
  href: string;
  icon: any;
  color: string;
  status: "live";
  summary: string;
  dataSource: string;
}

interface GuideGroup {
  group: string;
  items: GuideItem[];
}

const GROUPS: GuideGroup[] = [
  {
    group: "Market Overview",
    items: [
      {
        title: "Dashboard",
        href: "/",
        icon: LayoutDashboard,
        color: C.teal,
        status: "live",
        summary:
          "Landing page with live stat cards — latest pool price, today's AIL, generation mix snapshot, and active queue project count. Gives a one-glance read on current Alberta market conditions before drilling into any specific tab.",
        dataSource: "aeso_hourly_pool_price, aeso_supply_demand, aeso_hourly_gen_output, aeso_queue_projects (latest hour)",
      },
      {
        title: "Historical Data",
        href: "/historical-prices",
        icon: DollarSign,
        color: C.teal,
        status: "live",
        summary:
          "Monthly Alberta pool price and natural gas reference price, most recent first, with a range slider and a combined power/gas chart. Pool price is Alberta's single system-wide clearing price (energy-only, no nodal LMPs yet). The gas series is the Government of Alberta monthly reference price (a royalty netback, not an AECO-C spot settle) back to 1994.",
        dataSource: "aeso_hourly_pool_price (real, AESO API) + GoA monthly gas reference price 1994–present",
      },
      {
        title: "CSD — Current Supply & Demand",
        href: "/csd",
        icon: Scale,
        color: C.blue,
        status: "live",
        summary:
          "Interchange flows on BC/SK sonic ties, plus generation broken down by ownership group (Merchant/MC, Transmission-Connected/TNG, Distribution-Connected/DCR). Expand any group to see individual asset-level output.",
        dataSource: "aeso_supply_demand — hourly AIL, reserve margin, and interchange, Jan 2024–May 2026",
      },
    ],
  },
  {
    group: "Reliability & Capacity",
    items: [
      {
        title: "Outages",
        href: "/outages",
        icon: AlertTriangle,
        color: C.amber,
        status: "live",
        summary:
          "Generation outage report — planned and forced outages by asset, with approved outage MW and outage type. Useful for spotting supply-side risk ahead of high-demand periods.",
        dataSource: "aeso_outages — real outage records, Jan 2024–May 2026",
      },
      {
        title: "7-Day Capacity",
        href: "/7day-capacity",
        icon: CalendarDays,
        color: C.blue,
        status: "live",
        summary:
          "Hourly available generation capability for the next 7 days — AESO's forward-looking adequacy signal. Compares available capability against forecast AIL to flag tight reserve-margin hours before they happen.",
        dataSource: "aeso_7day_capability — hourly forward capability, real from AESO API",
      },
      {
        title: "LTA Metrics",
        href: "/lta",
        icon: TrendingUp,
        color: C.teal,
        status: "live",
        summary:
          "Long-Term Adequacy Metrics — AESO's quarterly reliability outlook. Shows Total Energy Not Served (TENS) probability, worst-case shortfall probability, hours-in-shortfall estimates, and the project pipeline by development stage (Site Assessment/Application/Approved) split by fuel type.",
        dataSource: "Parsed from AESO's published quarterly LTA Report PDFs (pdfplumber extraction)",
      },
    ],
  },
  {
    group: "Interconnection & Congestion",
    items: [
      {
        title: "Interconnection Queue",
        href: "/queue",
        icon: ListOrdered,
        color: C.purple,
        status: "live",
        summary:
          "Alberta generation interconnection queue tracker — project name, fuel type, capacity, connection point, and queue stage. Mirrors the Grid Origination Platform's queue tab but for the Alberta market specifically.",
        dataSource: "aeso_queue_projects — queue records from AESO connection project list",
      },
      {
        title: "Congestion & Nodal Analysis",
        href: "/congestion",
        icon: Route,
        color: C.purple,
        status: "live",
        summary:
          "A 3-zone (South/Central/North) DC OPF model of the Alberta grid, built in PyPSA, showing where locational price separation would emerge under the future Restructured Energy Market (REM). At high wind output the South→Central export corridor congests, dropping the South zone's shadow price toward $0 while Central holds near $31.50/MWh. Also shows historical SMP vs. pool price spread as a proxy for congestion rent today, since Alberta doesn't yet have live nodal LMPs.",
        dataSource: "PyPSA 3-node OPF (/pypsa/aeso/*) calibrated to real AESO zone capacity + aeso_smp historical spread",
      },
    ],
  },
  {
    group: "Market Transition & Regulatory",
    items: [
      {
        title: "REM (Restructured Energy Market)",
        href: "/rem",
        icon: Workflow,
        color: C.teal,
        status: "live",
        summary:
          "Timeline and explainer for Alberta's transition from an energy-only market to a Restructured Energy Market with locational marginal pricing, expected mid-2027. Covers pre-REM studies, stakeholder engagement, final design publication, and ISO Rules approval milestones, plus links to AESO's REM design documents.",
        dataSource: "AESO public REM pages (aeso.ca/transition/rem, aesoengage.aeso.ca) — reference content, last verified July 2026",
      },
      {
        title: "AUC (Alberta Utilities Commission)",
        href: "/auc",
        icon: Scale,
        color: C.amber,
        status: "live",
        summary:
          "Reference hub for Alberta's utility regulator — key AUC Rules (Rules of Practice, Power Plant Applications, Compliance, Rate of Return, Micro-Generation, etc.), governing Acts & Regulations, and a live RSS feed of recent AUC filings/decisions.",
        dataSource: "AUC Rules/Acts: curated reference data. Filings feed: live RSS from auc.ab.ca",
      },
      {
        title: "MSA (Market Surveillance Administrator)",
        href: "/msa",
        icon: Eye,
        color: C.blue,
        status: "live",
        summary:
          "Alberta's independent market monitor — browse MSA document categories (Quarterly Reports, Annual Report to the Minister, Compliance Reviews, MSOC, ISO Rules penalties, Retail Statistics) and available Data Portal datasets (Market Power Data: Pivotality, Lerner Index, SRMC, Counterfactual Price).",
        dataSource: "Live document listing scraped from AESO MSA site, categorized by type",
      },
    ],
  },
  {
    group: "Assistance",
    items: [
      {
        title: "Market Copilot",
        href: "/qa",
        icon: BrainCircuit,
        color: C.green,
        status: "live",
        summary:
          "GPT-4o-powered chat interface for natural-language questions about Alberta market data — e.g. \"What was the average pool price in January 2026?\" or \"Show me generation outages this month.\" Has direct DB query tools scoped to the AESO tables.",
        dataSource: "GPT-4o with SQL tool access to all aeso_* tables",
      },
    ],
  },
];

export default function Guide() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <BookOpen className="h-6 w-6 text-teal-400" />
          Platform Guide
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          What every tab does, where its data comes from, and how it fits together — Alberta's energy-only
          market today and its transition to a nodal Restructured Energy Market.
        </p>
      </div>

      <Card className="border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">About this platform</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            This is a standalone analytics platform for the Alberta Electric System Operator (AESO)
            market — Canada's only competitive energy-only wholesale electricity market. It tracks
            pool price, generation mix, supply/demand, outages, forward capability, the interconnection
            queue, and reliability adequacy metrics, all from real AESO public data sources.
          </p>
          <p>
            A second focus is Alberta's market transition: AESO is moving from a single system-wide
            pool price to a Restructured Energy Market (REM) with locational marginal pricing, expected
            mid-2027. The Congestion &amp; Nodal Analysis and REM tabs model and explain that transition.
          </p>
        </CardContent>
      </Card>

      {GROUPS.map((group) => (
        <div key={group.group} className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            {group.group}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {group.items.map((item) => (
              <Card key={item.href} className="border-border">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <item.icon className="h-4 w-4" style={{ color: item.color }} />
                      {item.title}
                    </CardTitle>
                    <Badge variant="outline" className="text-[10px] border-green-500/50 text-green-400">
                      Live
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-xs text-muted-foreground leading-relaxed">{item.summary}</p>
                  <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground/80">
                    <Database className="h-3 w-3 mt-0.5 shrink-0" />
                    <span>{item.dataSource}</span>
                  </div>
                  <Link
                    href={item.href}
                    className="inline-flex items-center gap-1 text-xs font-medium text-teal-400 hover:text-teal-300 pt-1"
                  >
                    Open tab <ArrowRight className="h-3 w-3" />
                  </Link>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ))}

      <Card className="border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Data provenance and refresh cadence</CardTitle>
          <CardDescription className="text-xs">
            "Live" identifies an available feature, not a guaranteed ingestion schedule. No AESO cron or Replit scheduled job is configured in this repository.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Tabs / data</th>
                  <th className="py-2 pr-4 font-medium">Source and classification</th>
                  <th className="py-2 font-medium">Actual application refresh</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {[
                  ["Dashboard / Pool Price", "AESO Public API poolprice-api/v1.1 -> aeso_hourly_pool_price (real)", "Manual seed-aeso-real run; no scheduler."],
                  ["Generation Mix", "aeso_hourly_gen_output from seed-aeso-data (calibrated synthetic)", "Manual synthetic reseed; seed-aeso-real does not populate this table."],
                  ["Supply & Demand", "Live AESO ETS CSDReportServlet plus stored aeso_supply_demand history", "CSD polls every 5 minutes while open; stored history is not scheduled."],
                  ["Outages", "AESO ETS daily and monthly outage reports (live scrape)", "Fetched on tab load/revisit after the 5-minute client cache; no background poll."],
                  ["7-Day Capacity", "AESO ETS SevenDaysHourlyAvailableCapabilityReportServlet (real)", "Polled every 10 minutes while the tab is open."],
                  ["Queue / Transmission Corridors", "aeso_queue_projects and aeso_transmission_corridors from seed-aeso-data (synthetic)", "Manual reseed; no live AESO queue or corridor sync."],
                  ["Congestion history", "AESO SMP and interchange APIs -> aeso_smp / aeso_interchange (real); PyPSA result is modelled", "Historical tables update on manual seed-aeso-real; OPF runs on user input if the service is available."],
                  ["LTA Metrics", "AESO quarterly LTA PDFs parsed on demand (real)", "AESO publishes Feb/May/Aug/Nov; report URLs are maintained manually in code."],
                  ["AUC", "Curated rules plus auc.ab.ca WordPress RSS (partial feed)", "Fetched on demand; 1-hour client/memory cache and up to 7-day server disk cache."],
                  ["MSA", "albertamsa.ca document pages scraped by category (real)", "Fetched on demand; 24-hour client cache and up to 7-day server disk cache."],
                  ["REM", "Curated AESO REM and AESO Engage reference content", "Manual editorial update; last audited July 27, 2026."],
                  ["Market Copilot", "GPT-4o with SQL tools scoped to aeso_* tables", "Generated on demand; freshness follows the underlying dataset above."],
                ].map(([label, source, cadence]) => (
                  <tr key={label} className="align-top">
                    <td className="py-2.5 pr-4 font-medium text-foreground">{label}</td>
                    <td className="py-2.5 pr-4 text-muted-foreground">{source}</td>
                    <td className="py-2.5 text-muted-foreground">{cadence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
      <Card className="border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Data Status</CardTitle>
          <CardDescription className="text-xs">What's real, what's modelled, what's planned</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
            {[
              {
                label: "Pool Price / Generation / Supply-Demand",
                status: "partial",
                detail: "Pool price is real AESO API history. Generation mix and stored supply-demand history currently include calibrated synthetic seed data; the CSD panel is live.",
              },
              {
                label: "Outages / Queue / 7-Day Capability",
                status: "partial",
                detail: "Outage and 7-day panels scrape real AESO ETS reports. Queue records are currently synthetic seed data and do not have a live AESO sync.",
              },
              {
                label: "LTA Metrics",
                status: "real",
                detail: "Parsed directly from AESO's published quarterly LTA Report PDFs — TENS probability, shortfall hours, project pipeline by stage.",
              },
              {
                label: "3-Zone Alberta OPF",
                status: "modelled",
                detail: "Single-snapshot, three-zone academic PyPSA DC OPF. It is a REM scenario illustration, not a validated nodal forecast, SCED replica, or live market result.",
              },
              {
                label: "REM Timeline",
                status: "real",
                detail: "Milestones and design details sourced from AESO's public REM transition pages, last verified July 2026.",
              },
              {
                label: "AUC Rules & Filings",
                status: "partial",
                detail: "Rules and Acts are curated. The recent-items panel reads a partial WordPress RSS feed with an effective server cache of up to seven days; it is not a complete filings feed.",
              },
              {
                label: "MSA Documents",
                status: "real",
                detail: "Real MSA document listings scraped on demand, with a 24-hour client cache and an effective server disk cache of up to seven days.",
              },
              {
                label: "Market Copilot",
                status: "real",
                detail: "GPT-4o with direct SQL tool access scoped to AESO tables.",
              },
            ].map((item) => (
              <div key={item.label} className="flex gap-2 p-2.5 rounded-md bg-card border border-border">
                <div className="shrink-0 mt-0.5">
                  {item.status === "real" ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />
                  ) : item.status === "partial" ? (
                    <AlertCircle className="h-3.5 w-3.5 text-amber-400" />
                  ) : (
                    <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </div>
                <div>
                  <div className="font-semibold text-foreground">{item.label}</div>
                  <div className="text-muted-foreground mt-0.5">{item.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
