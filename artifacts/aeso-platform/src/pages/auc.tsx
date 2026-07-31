import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Scale, ExternalLink, FileText, RefreshCw, AlertCircle,
  ChevronRight, DollarSign, Zap, Building2, Shield,
  Sun, BookOpen, Gavel, Phone, Search,
} from "lucide-react";
import { ScrapeRefreshButton } from "@/components/scrape-refresh-button";

// ── Types ────────────────────────────────────────────────────────
interface AucFeedItem {
  title: string; link: string; pubDate: string;
  categories: string[]; excerpt: string;
}
interface AucFeedResponse { items: AucFeedItem[]; fetchedAt: string }

// ── Hardcoded reference data ─────────────────────────────────────
const AUC_RULES = [
  { rule: "001", title: "Rules of Practice",                                      url: "https://www.auc.ab.ca/rules/rules-home/" },
  { rule: "007", title: "Application for Power Plants, Substations & Tx Lines",   url: "https://www.auc.ab.ca/rules/rules-home/" },
  { rule: "012", title: "Criteria for Determining Utility Costs and Revenues",    url: "https://www.auc.ab.ca/rules/rules-home/" },
  { rule: "022", title: "Rules Respecting Electric Utilities Affiliate Relations", url: "https://www.auc.ab.ca/rules/rules-home/" },
  { rule: "025", title: "Compliance Program and Reporting",                        url: "https://www.auc.ab.ca/rules/rules-home/" },
  { rule: "026", title: "Return on Common Equity",                                 url: "https://www.auc.ab.ca/rules/rules-home/" },
  { rule: "027", title: "Schedule of Fees and Levies",                            url: "https://www.auc.ab.ca/rules/rules-home/" },
  { rule: "028", title: "Rules Respecting Micro-Generation",                       url: "https://www.auc.ab.ca/micro-generation/" },
  { rule: "033", title: "Application for Approval of Rates (Gas)",                url: "https://www.auc.ab.ca/rules/rules-home/" },
];

const ACTS_REGS = [
  { name: "Electric Utilities Act (EUA)",       desc: "Primary legislation governing Alberta's electricity market",          url: "https://www.auc.ab.ca/acts-and-regulations/" },
  { name: "Gas Utilities Act (GUA)",            desc: "Regulation of gas distribution and franchise utilities",              url: "https://www.auc.ab.ca/acts-and-regulations/" },
  { name: "Alberta Utilities Commission Act",   desc: "Establishes the AUC and its regulatory jurisdiction",               url: "https://www.auc.ab.ca/acts-and-regulations/" },
  { name: "Hydro and Electric Energy Act",      desc: "Governs hydro-electric power development",                           url: "https://www.auc.ab.ca/acts-and-regulations/" },
  { name: "Public Utilities Act",               desc: "Rate regulation and service obligations for public utilities",        url: "https://www.auc.ab.ca/acts-and-regulations/" },
  { name: "Micro-Generation Regulation",        desc: "Rules for small-scale renewable generation ≤5 MW",                  url: "https://www.auc.ab.ca/micro-generation/" },
  { name: "Performance-Based Regulation",       desc: "Incentive-based rate regulation framework for distribution utilities", url: "https://www.auc.ab.ca/rules/rules-home/" },
];

const RATE_SECTIONS = [
  {
    title: "Electric Distribution (ENMAX, EPCOR, FortisAlberta)",
    desc: "Regulated wires rates for 1M+ residential and commercial customers. Rate applications reviewed every 3-5 years under performance-based regulation (PBR) or cost-of-service.",
    url: "https://www.auc.ab.ca/current-rates-and-terms-and-conditions/",
    icon: <Zap size={16} className="text-amber-400" />,
  },
  {
    title: "Natural Gas Distribution (ATCO Gas, FortisBC)",
    desc: "Distribution tariffs for natural gas delivery to residential, commercial, and industrial customers across Alberta.",
    url: "https://www.auc.ab.ca/current-rates-and-terms-and-conditions/",
    icon: <Building2 size={16} className="text-sky-400" />,
  },
  {
    title: "Default Rate of Gas (DRG)",
    desc: "Regulated commodity rate for consumers without a gas retailer contract. Set quarterly based on AECO gas prices plus AUC-approved margin.",
    url: "https://www.auc.ab.ca/current-rates-and-terms-and-conditions/",
    icon: <DollarSign size={16} className="text-teal-400" />,
  },
  {
    title: "Rate Setting Process",
    desc: "Utilities file tariff applications → AUC review (written submissions or hearing) → decision → rates effective. Major applications take 12-24 months. PBR utilities file annual compliance filings.",
    url: "https://www.auc.ab.ca/how-rates-are-set/",
    icon: <Scale size={16} className="text-purple-400" />,
  },
];

const APPLICATIONS = [
  {
    title: "Power Plant Applications",
    desc: "New generation facilities ≥1 MW require AUC approval. Application includes site assessment, noise study, technical description, and stakeholder engagement. Timeline: 6-18 months.",
    url: "https://www.auc.ab.ca/power-generation-applications-overview/",
    badge: "Generation",
    badgeColor: "bg-teal-500/20 text-teal-300 border-teal-500/30",
  },
  {
    title: "Current Applications (eFiling)",
    desc: "Active applications being reviewed by the AUC. Search by applicant, utility type, or hearing status. All public documents filed electronically.",
    url: "https://www.auc.ab.ca/regulatory_documents/current-applications/",
    badge: "Live",
    badgeColor: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  },
  {
    title: "Micro-Generation (≤5 MW)",
    desc: "Simplified approval for wind, solar, and small hydro ≤5 MW under Rule 028. No hearing required. Connect to distribution grid and export surplus at credited rate.",
    url: "https://www.auc.ab.ca/micro-generation/",
    badge: "Simplified",
    badgeColor: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  },
  {
    title: "Wind & Solar Projects Map",
    desc: "Interactive ArcGIS map showing all approved and pending renewable power generation facilities in Alberta. Filter by status, technology, and region.",
    url: "https://abutilcomm.maps.arcgis.com/apps/webappviewer/index.html?id=818e4e75e7bf4d4bab0c43b4d8d44db0",
    badge: "Map",
    badgeColor: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  },
  {
    title: "24-Month Application Forecast",
    desc: "AESO publishes anticipated applications for power plants, transmission, and substations over the next 24 months. Useful for anticipating competitive dynamics.",
    url: "https://media.auc.ab.ca/prd-wp-uploads/regulatory_documents/Reference/",
    badge: "Forecast",
    badgeColor: "bg-sky-500/20 text-sky-300 border-sky-500/30",
  },
];

const COMPLIANCE = [
  {
    title: "Compliance & Enforcement",
    desc: "The AUC monitors regulated utilities for compliance with AUC rules, orders, and conditions of approval. Non-compliance may result in fines, audits, or enforcement proceedings.",
    url: "https://www.auc.ab.ca/compliance-enforcement/",
  },
  {
    title: "AUC ConfidenceLine",
    desc: "Independent, confidential reporting service for current and former utility employees and contractors to report potential compliance concerns.",
    url: "https://www.auc.ab.ca/auc-confidenceline/",
  },
  {
    title: "File a Complaint",
    desc: "Customers with billing disputes or concerns about regulated utilities can submit a formal complaint to the AUC for review.",
    url: "https://www.auc.ab.ca/auccomplaintform/",
  },
  {
    title: "Report Cards & Reviews",
    desc: "Annual performance data on AUC regulatory timeliness, application processing times, and service standards.",
    url: "https://www.auc.ab.ca/report-cards-and-reviews/",
  },
];

const MICRO_GEN_FACTS = [
  { label: "Maximum Capacity", value: "5 MW",        note: "Per Rule 028" },
  { label: "Technologies",     value: "Solar, Wind, Hydro, CHP", note: "Any renewable or co-gen" },
  { label: "Connection",       value: "Distribution grid",       note: "≤25kV feeder" },
  { label: "Surplus Credit",   value: "Net metering",            note: "At distribution rate" },
  { label: "No Hearing",       value: "Yes",                     note: "Simplified process" },
  { label: "Processing Time",  value: "4-8 weeks",               note: "Typical for solar" },
];

// ── Sub-tab definitions ──────────────────────────────────────────
const TABS = [
  { id: "overview",    label: "Overview",            icon: <Building2 size={13} /> },
  { id: "news",        label: "News & Decisions",    icon: <Gavel size={13} /> },
  { id: "rules",       label: "Rules",               icon: <BookOpen size={13} /> },
  { id: "rates",       label: "Rate Setting",        icon: <DollarSign size={13} /> },
  { id: "applications",label: "Applications",        icon: <Search size={13} /> },
  { id: "microgen",    label: "Micro-Generation",    icon: <Sun size={13} /> },
  { id: "acts",        label: "Acts & Regulations",  icon: <FileText size={13} /> },
  { id: "compliance",  label: "Compliance",          icon: <Shield size={13} /> },
];

function formatDate(rssDate: string) {
  try { return new Date(rssDate).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" }); }
  catch { return rssDate; }
}

function ExternalCard({ title, desc, url, badge, badgeColor }: {
  title: string; desc: string; url: string; badge?: string; badgeColor?: string;
}) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer"
       className="bg-white/3 border border-white/8 hover:border-teal-500/30 rounded-xl px-4 py-4 flex items-start gap-3 transition-colors group block">
      <ExternalLink size={14} className="mt-0.5 text-white/30 group-hover:text-teal-400 shrink-0 transition-colors" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="font-semibold text-white/85 text-sm group-hover:text-white transition-colors">{title}</span>
          {badge && <span className={`text-xs px-2 py-0.5 rounded border ${badgeColor}`}>{badge}</span>}
        </div>
        <p className="text-xs text-white/45 leading-relaxed">{desc}</p>
      </div>
    </a>
  );
}

export default function AUC() {
  const [tab, setTab] = useState("overview");

  const feedQ = useQuery<AucFeedResponse>({
    queryKey: ["auc-feed"],
    queryFn: () => fetch("/api/aeso/auc/feed").then(r => r.json()),
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });

  return (
    <div className="space-y-5 pb-8">
      {/* ── Header ── */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Scale size={22} className="text-teal-400" />
            Alberta Utilities Commission (AUC)
          </h1>
          <p className="text-sm text-white/50 mt-1">Alberta's independent utilities regulator — electricity, gas, and water utilities</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <a href="http://www2.auc.ab.ca/" target="_blank" rel="noopener noreferrer"
             className="flex items-center gap-1.5 px-3 py-2 bg-teal-600/20 hover:bg-teal-600/30 border border-teal-500/30 rounded-lg text-sm text-teal-300 transition-colors">
            <Search size={13} /> eFiling System
          </a>
          <a href="https://www.auc.ab.ca/" target="_blank" rel="noopener noreferrer"
             className="flex items-center gap-1.5 px-3 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm text-white/70 transition-colors">
            <ExternalLink size={13} /> auc.ab.ca
          </a>
          <ScrapeRefreshButton queryKeys={["auc-feed"]} />
        </div>
      </div>

      {/* ── Summary Cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Regulated Utilities", value: "50+",         sub: "Electric, gas, water",     icon: <Building2 size={15} className="text-teal-400" /> },
          { label: "AUC Rules",           value: "28+",         sub: "Current active rules",     icon: <BookOpen size={15} className="text-amber-400" /> },
          { label: "Since",               value: "1915",        sub: "110 years of regulation",  icon: <Scale size={15} className="text-purple-400" /> },
          { label: "Jurisdiction",        value: "Alberta",     sub: "Provincial, not federal",  icon: <Phone size={15} className="text-sky-400" /> },
        ].map(c => (
          <div key={c.label} className="bg-white/3 border border-white/8 rounded-xl px-4 py-3">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-white/45">{c.label}</span>{c.icon}
            </div>
            <div className="text-xl font-bold text-white">{c.value}</div>
            <div className="text-xs text-white/30 mt-0.5">{c.sub}</div>
          </div>
        ))}
      </div>

      {/* ── Tab bar ── */}
      <div className="flex gap-1 flex-wrap border-b border-white/8 pb-0">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-t transition-colors border-b-2 -mb-px ${
              tab === t.id
                ? "text-teal-400 border-teal-400 bg-teal-400/5"
                : "text-white/45 border-transparent hover:text-white/70"
            }`}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {/* ── Tab Content ── */}
      <div className="mt-2">

        {/* OVERVIEW */}
        {tab === "overview" && (
          <div className="space-y-4">
            <div className="bg-white/3 border border-white/8 rounded-xl px-5 py-4">
              <h3 className="font-semibold text-white/85 mb-2 text-sm">About the AUC</h3>
              <p className="text-sm text-white/65 leading-relaxed mb-3">
                The Alberta Utilities Commission (AUC) is an independent, quasi-judicial regulatory agency that regulates
                Alberta's electric, gas, and water utilities. Established in 1915, it ensures utilities provide safe, reliable
                service at just and reasonable rates, while approving new infrastructure and enforcing compliance.
              </p>
              <p className="text-sm text-white/65 leading-relaxed">
                The AUC does not regulate the competitive electricity <em>market</em> (that's the AESO's role) — it regulates
                the wires and pipes: transmission and distribution infrastructure, utility rates, and the approval of new
                generation and transmission projects.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {[
                { title: "Who the AUC Regulates", desc: "Electric distribution utilities (ENMAX, EPCOR, FortisAlberta), gas distributors (ATCO Gas, FortisBC), water utilities, and renewable power generators requiring approval.", url: "https://www.auc.ab.ca/who-we-regulate-directory/" },
                { title: "eFiling System", desc: "Electronic portal for submitting, tracking, and searching all AUC applications, proceedings, and regulatory documents. All public filings are searchable.", url: "http://www2.auc.ab.ca/" },
                { title: "AUC Engage", desc: "Public consultation platform for active proceedings. Submit interventions, view evidence, and participate in hearings on utility applications.", url: "https://engage.auc.ab.ca/" },
                { title: "Hearing & Events Calendar", desc: "Schedule of upcoming AUC hearings, consultations, and information sessions. Includes links to hearing materials and livestream access.", url: "https://www.auc.ab.ca/hearing-and-events-calendar/" },
              ].map(c => <ExternalCard key={c.title} {...c} />)}
            </div>
            {feedQ.data?.items && feedQ.data.items.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-2">Latest from AUC</h3>
                <div className="space-y-2">
                  {feedQ.data.items.slice(0, 4).map((item, i) => (
                    <a key={i} href={item.link} target="_blank" rel="noopener noreferrer"
                       className="bg-white/3 border border-white/8 hover:border-white/15 rounded-xl px-4 py-3 flex items-start gap-3 group transition-colors block">
                      <ChevronRight size={13} className="mt-0.5 text-teal-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-white/80 text-sm group-hover:text-white transition-colors">{item.title}</div>
                        <div className="text-xs text-white/35 mt-0.5">{formatDate(item.pubDate)} · {item.categories.join(", ") || "General"}</div>
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* NEWS & DECISIONS */}
        {tab === "news" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-xs text-white/40">Live AUC news feed — updated every hour</p>
              {feedQ.isFetching && <RefreshCw size={13} className="text-teal-400 animate-spin" />}
              {feedQ.data?.fetchedAt && (
                <span className="text-xs text-white/30">Fetched {formatDate(feedQ.data.fetchedAt)}</span>
              )}
            </div>

            {feedQ.isLoading && (
              <div className="flex items-center gap-2 text-sm text-white/50">
                <RefreshCw size={14} className="animate-spin" /> Loading AUC news feed...
              </div>
            )}
            {feedQ.isError && (
              <div className="flex items-center gap-2 text-sm text-red-400/80 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
                <AlertCircle size={14} />
                Unable to load AUC feed. <a href="https://www.auc.ab.ca/news/" target="_blank" rel="noopener noreferrer" className="underline ml-1">View on auc.ab.ca →</a>
              </div>
            )}

            {feedQ.data?.items && (
              <div className="space-y-3">
                {feedQ.data.items.map((item, i) => (
                  <a key={i} href={item.link} target="_blank" rel="noopener noreferrer"
                     className="bg-white/3 border border-white/8 hover:border-teal-500/20 rounded-xl px-5 py-4 block group transition-colors">
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <span className="font-semibold text-white/85 text-sm group-hover:text-white transition-colors">{item.title}</span>
                      <ExternalLink size={12} className="text-white/25 shrink-0 mt-0.5 group-hover:text-teal-400 transition-colors" />
                    </div>
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span className="text-xs text-white/35">{formatDate(item.pubDate)}</span>
                      {item.categories.map(c => (
                        <span key={c} className="text-xs px-1.5 py-0.5 rounded bg-white/8 text-white/40">{c}</span>
                      ))}
                    </div>
                    {item.excerpt && (
                      <p className="text-xs text-white/50 leading-relaxed">{item.excerpt}</p>
                    )}
                  </a>
                ))}
              </div>
            )}

            <div className="bg-white/3 border border-white/8 rounded-xl px-4 py-4">
              <h3 className="font-semibold text-white/80 text-sm mb-2">Full Decisions & Notices</h3>
              <p className="text-xs text-white/50 leading-relaxed mb-3">
                All AUC regulatory decisions, notices, and approvals are published in the eFiling System.
                The RSS feed above covers recent news and stories — formal regulatory documents require eFiling access.
              </p>
              <a href="https://www.auc.ab.ca/regulatory_documents/recent-updates/" target="_blank" rel="noopener noreferrer"
                 className="flex items-center gap-1.5 text-xs text-teal-400 hover:text-teal-300 transition-colors">
                <ExternalLink size={11} /> Recent decisions on auc.ab.ca
              </a>
            </div>
          </div>
        )}

        {/* RULES */}
        {tab === "rules" && (
          <div className="space-y-4">
            <div className="bg-white/3 border border-white/8 rounded-xl px-5 py-4">
              <p className="text-sm text-white/65 leading-relaxed">
                AUC Rules set out requirements and processes for all entities under the Commission's jurisdiction.
                Rules are developed through public consultation and may be amended by AUC order. All rules are published on auc.ab.ca.
              </p>
            </div>
            <div className="bg-white/3 border border-white/8 rounded-xl overflow-hidden">
              <div className="grid grid-cols-[auto,1fr,auto] text-xs font-semibold text-white/35 uppercase tracking-wider border-b border-white/5 px-5 py-2">
                <span className="pr-4">Rule</span><span>Title</span><span></span>
              </div>
              {AUC_RULES.map((r) => (
                <div key={r.rule} className="grid grid-cols-[auto,1fr,auto] items-center px-5 py-3 border-b border-white/5 last:border-0 hover:bg-white/2 transition-colors">
                  <span className="text-teal-400 font-bold text-sm pr-4 tabular-nums">{r.rule}</span>
                  <span className="text-white/75 text-sm">{r.title}</span>
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="ml-3">
                    <ExternalLink size={12} className="text-white/25 hover:text-teal-400 transition-colors" />
                  </a>
                </div>
              ))}
            </div>
            <a href="https://www.auc.ab.ca/rules/rules-home/" target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-1.5 text-xs text-teal-400 hover:text-teal-300 transition-colors">
              <ExternalLink size={11} /> View all AUC Rules on auc.ab.ca
            </a>
          </div>
        )}

        {/* RATE SETTING */}
        {tab === "rates" && (
          <div className="space-y-4">
            <div className="bg-white/3 border border-white/8 rounded-xl px-5 py-4">
              <p className="text-sm text-white/65 leading-relaxed">
                The AUC sets regulated utility rates to ensure customers receive safe and reliable service at
                just and reasonable rates. Rate applications are filed by utilities, reviewed by the AUC (with
                public participation), and decided by AUC order. Rates must allow utilities to recover prudent
                costs plus a reasonable return on equity.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {RATE_SECTIONS.map(r => (
                <a key={r.title} href={r.url} target="_blank" rel="noopener noreferrer"
                   className="bg-white/3 border border-white/8 hover:border-teal-500/25 rounded-xl px-4 py-4 block group transition-colors">
                  <div className="flex items-center gap-2 mb-2">
                    {r.icon}
                    <span className="font-semibold text-white/80 text-sm group-hover:text-white transition-colors">{r.title}</span>
                  </div>
                  <p className="text-xs text-white/50 leading-relaxed">{r.desc}</p>
                </a>
              ))}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <ExternalCard title="Current Rates & Terms" desc="Published electricity and gas distribution rates for all regulated utilities in Alberta." url="https://www.auc.ab.ca/current-rates-and-terms-and-conditions/" />
              <ExternalCard title="How Rates Are Set" desc="Explains the AUC's rate review process, from utility application through to final order." url="https://www.auc.ab.ca/how-rates-are-set/" />
            </div>
          </div>
        )}

        {/* APPLICATIONS */}
        {tab === "applications" && (
          <div className="space-y-4">
            <div className="bg-white/3 border border-white/8 rounded-xl px-5 py-4">
              <p className="text-sm text-white/65 leading-relaxed">
                Any person or company wishing to build generation, transmission, or distribution infrastructure in Alberta
                must apply to the AUC for approval. The AUC evaluates technical, environmental, and social impact — and may
                hold a hearing if there are substantive objections from landowners, municipalities, or interveners.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {APPLICATIONS.map(a => <ExternalCard key={a.title} {...a} />)}
            </div>
          </div>
        )}

        {/* MICRO-GENERATION */}
        {tab === "microgen" && (
          <div className="space-y-4">
            <div className="bg-white/3 border border-white/8 rounded-xl px-5 py-4">
              <h3 className="font-semibold text-white/85 mb-2 text-sm">Micro-Generation in Alberta</h3>
              <p className="text-sm text-white/65 leading-relaxed">
                AUC Rule 028 governs micro-generation — small-scale renewable or co-generation facilities up to 5 MW
                connected to the distribution network. Projects do not require a formal AUC hearing; approval is granted
                through a simplified checklist process. Owners can export surplus electricity and receive a credit at
                the distribution rate.
              </p>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {MICRO_GEN_FACTS.map(f => (
                <div key={f.label} className="bg-white/3 border border-white/8 rounded-xl px-4 py-3">
                  <div className="text-xs text-white/40 mb-1">{f.label}</div>
                  <div className="font-bold text-white/85 text-sm">{f.value}</div>
                  <div className="text-xs text-white/30 mt-0.5">{f.note}</div>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <ExternalCard title="Micro-Generation Rule 028" desc="Full text of AUC Rule 028 governing the micro-generation approval process and net metering credits." url="https://www.auc.ab.ca/micro-generation/" badge="Rule" badgeColor="bg-teal-500/20 text-teal-300 border-teal-500/30" />
              <ExternalCard title="Wind & Solar Projects Map" desc="Interactive map of all approved and pending renewable projects — useful for identifying concentration and opportunity zones." url="https://abutilcomm.maps.arcgis.com/apps/webappviewer/index.html?id=818e4e75e7bf4d4bab0c43b4d8d44db0" badge="Map" badgeColor="bg-purple-500/20 text-purple-300 border-purple-500/30" />
            </div>
            <div className="bg-amber-500/8 border border-amber-500/20 rounded-xl px-4 py-3">
              <p className="text-xs text-amber-300/80 leading-relaxed">
                <strong>For PPA origination:</strong> Micro-generation facilities ≤5 MW cannot directly participate in the AESO wholesale market — they settle via distribution net metering credits.
                For wholesale market participation (including VPPAs), facilities must be &gt;5 MW and file under the standard power plant application process.
              </p>
            </div>
          </div>
        )}

        {/* ACTS & REGULATIONS */}
        {tab === "acts" && (
          <div className="space-y-3">
            <div className="bg-white/3 border border-white/8 rounded-xl px-5 py-4">
              <p className="text-sm text-white/65 leading-relaxed">
                Alberta's electricity and gas sectors are governed by several Acts of the Legislature, administered by
                the AUC and the Minister of Affordability and Utilities. Key regulations are made under these Acts.
              </p>
            </div>
            {ACTS_REGS.map(a => (
              <a key={a.name} href={a.url} target="_blank" rel="noopener noreferrer"
                 className="bg-white/3 border border-white/8 hover:border-teal-500/25 rounded-xl px-5 py-4 flex items-center gap-3 group transition-colors block">
                <FileText size={15} className="text-white/30 group-hover:text-teal-400 shrink-0 transition-colors" />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-white/85 text-sm group-hover:text-white transition-colors">{a.name}</div>
                  <div className="text-xs text-white/45 mt-0.5">{a.desc}</div>
                </div>
                <ExternalLink size={12} className="text-white/20 shrink-0" />
              </a>
            ))}
            <a href="https://www.auc.ab.ca/acts-and-regulations/" target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-1.5 text-xs text-teal-400 hover:text-teal-300 transition-colors">
              <ExternalLink size={11} /> View full Acts & Regulations on auc.ab.ca
            </a>
          </div>
        )}

        {/* COMPLIANCE */}
        {tab === "compliance" && (
          <div className="space-y-4">
            <div className="bg-white/3 border border-white/8 rounded-xl px-5 py-4">
              <p className="text-sm text-white/65 leading-relaxed">
                The AUC monitors compliance with its rules, orders, and conditions of approval through ongoing reporting
                requirements, audits, and investigation. Non-compliance can result in enforcement proceedings, financial
                penalties, and public orders.
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {COMPLIANCE.map(c => <ExternalCard key={c.title} {...c} />)}
            </div>
            <div className="bg-white/3 border border-white/8 rounded-xl px-5 py-4">
              <h3 className="font-semibold text-white/80 text-sm mb-2">AUC Compliance Process</h3>
              <div className="space-y-2">
                {[
                  "Utilities file annual compliance filings under AUC Rules (rates, affiliate transactions, etc.)",
                  "AUC reviews filings and may request additional information or initiate an audit",
                  "If non-compliance is found, AUC may issue a show-cause order, directive, or penalty",
                  "Major violations may result in a formal AUC hearing with public participation",
                  "Decisions are publicly filed and searchable in the eFiling System",
                ].map((step, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-white/55">
                    <span className="font-bold text-teal-400 tabular-nums shrink-0">{i + 1}.</span>
                    {step}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

      </div>
      <div className="text-xs text-white/20 text-center pt-2">
        Source: www.auc.ab.ca — news feed updates hourly, static content verified July 2026
      </div>
    </div>
  );
}
