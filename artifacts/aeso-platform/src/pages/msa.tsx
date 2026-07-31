import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Eye, ExternalLink, FileText, RefreshCw, AlertCircle,
  Download, BarChart3, Bell, Shield, ShoppingCart, Database,
  Filter, Calendar,
} from "lucide-react";
import { ScrapeRefreshButton } from "@/components/scrape-refresh-button";

// ── Types ────────────────────────────────────────────────────────
interface MsaDoc {
  title: string; category: string; date: string;
  url: string; type: "PDF" | "XLSX" | "Other";
}
interface MsaDocsResponse { docs: MsaDoc[]; category: string; fetchedAt: string }

// ── Category metadata ─────────────────────────────────────────────
const CAT_COLORS: Record<string, string> = {
  "Quarterly Reports":                    "bg-teal-500/20 text-teal-300 border-teal-500/30",
  "Annual Report to the Minister":        "bg-purple-500/20 text-purple-300 border-purple-500/30",
  "Compliance Review":                    "bg-amber-500/20 text-amber-300 border-amber-500/30",
  "MSOC":                                 "bg-sky-500/20 text-sky-300 border-sky-500/30",
  "Other Reports":                        "bg-white/10 text-white/50 border-white/15",
  "Notices":                              "bg-orange-500/20 text-orange-300 border-orange-500/30",
  "Guidelines":                           "bg-indigo-500/20 text-indigo-300 border-indigo-500/30",
  "ISO Rules - Specified Penalties":      "bg-red-500/20 text-red-300 border-red-500/30",
  "ISO Rules - Forms":                    "bg-red-500/15 text-red-300/80 border-red-500/25",
  "Reliability Standards - Specified Penalties": "bg-red-500/20 text-red-300 border-red-500/30",
  "Reliability Standards - Forms":        "bg-red-500/15 text-red-300/80 border-red-500/25",
  "Compliance Process":                   "bg-amber-500/20 text-amber-300 border-amber-500/30",
  "Retail Statistics":                    "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  "Retail Billing Tool":                  "bg-emerald-500/15 text-emerald-300/80 border-emerald-500/25",
  "Deferral Account Statement Process":   "bg-emerald-500/15 text-emerald-300/80 border-emerald-500/25",
  "Approved DASs for Boards and Councils":"bg-emerald-500/10 text-emerald-300/70 border-emerald-500/20",
  "Approved DASs for Medicine Hat":       "bg-emerald-500/10 text-emerald-300/70 border-emerald-500/20",
  "Administrator Expenses Documents":     "bg-white/8 text-white/40 border-white/12",
  "Presentations":                        "bg-sky-500/15 text-sky-300/80 border-sky-500/25",
};

const DATA_PORTAL_DATASETS = [
  { name: "Market Power Data",    sub: "Pivotality, Lerner Index, SRMC, Counterfactual Price, Static Inefficiency", freq: "Quarterly" },
  { name: "Enforcement Data",     sub: "ISO Outcome, ARS Outcome, NSP outcomes",                                   freq: "Ongoing"   },
  { name: "Retail Data",          sub: "Fixed Rates, Risk-Free Expected Cost, Retail Statistics",                  freq: "Monthly"   },
  { name: "Carbon Emissions Data",sub: "HAEI and HMEI datasets",                                                   freq: "Annual"    },
];

const TABS = [
  { id: "overview",    label: "Overview",       icon: <Eye size={13} /> },
  { id: "reports",     label: "Reports",        icon: <BarChart3 size={13} /> },
  { id: "notices",     label: "Notices",        icon: <Bell size={13} /> },
  { id: "compliance",  label: "Compliance",     icon: <Shield size={13} /> },
  { id: "retail",      label: "Retail & Rates", icon: <ShoppingCart size={13} /> },
  { id: "portal",      label: "Data Portal",    icon: <Database size={13} /> },
];

function formatDate(d: string) {
  if (!d) return "";
  try { return new Date(d).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" }); }
  catch { return d; }
}

function DocRow({ doc }: { doc: MsaDoc }) {
  const catColor = CAT_COLORS[doc.category] ?? "bg-white/8 text-white/40 border-white/12";
  const baseUrl = "https://www.albertamsa.ca";
  const fullUrl = doc.url.startsWith("http") ? doc.url : `${baseUrl}${doc.url}`;
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5 last:border-0 hover:bg-white/2 transition-colors">
      <div className="shrink-0 text-white/25">
        {doc.type === "XLSX" ? <BarChart3 size={13} className="text-emerald-400/60" /> : <FileText size={13} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-white/80 font-medium truncate">{doc.title}</div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={`text-xs px-1.5 py-0.5 rounded border shrink-0 ${catColor}`}>{doc.category}</span>
          {doc.date && <span className="text-xs text-white/30 flex items-center gap-1"><Calendar size={10} />{doc.date}</span>}
        </div>
      </div>
      <a href={fullUrl} target="_blank" rel="noopener noreferrer"
         className="shrink-0 flex items-center gap-1 text-xs text-teal-400/80 hover:text-teal-300 transition-colors">
        <Download size={12} /> {doc.type}
      </a>
    </div>
  );
}

function DocsPanel({ category, title, filterCats }: { category: string; title: string; filterCats?: string[] }) {
  const [search, setSearch] = useState("");

  const q = useQuery<MsaDocsResponse>({
    queryKey: ["msa-docs", category],
    queryFn: () => fetch(`/api/aeso/msa/documents?category=${category}`).then(r => r.json()),
    staleTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });

  let docs = q.data?.docs ?? [];
  if (filterCats?.length) docs = docs.filter(d => filterCats.some(f => d.category.toLowerCase().includes(f.toLowerCase())));
  if (search) docs = docs.filter(d => d.title.toLowerCase().includes(search.toLowerCase()) || d.category.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-white/40">{docs.length} document{docs.length !== 1 ? "s" : ""}</p>
        <div className="flex items-center gap-2">
          {q.isFetching && <RefreshCw size={12} className="text-teal-400 animate-spin" />}
          {q.data?.fetchedAt && <span className="text-xs text-white/25">Cached {formatDate(q.data.fetchedAt)}</span>}
        </div>
      </div>

      <div className="relative">
        <Filter size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter documents..."
          className="w-full bg-white/4 border border-white/10 rounded-lg pl-8 pr-3 py-2 text-sm text-white/80 placeholder-white/30 focus:outline-none focus:border-teal-500/40" />
      </div>

      {q.isLoading && (
        <div className="flex items-center gap-2 text-sm text-white/50 py-4">
          <RefreshCw size={14} className="animate-spin" /> Loading MSA documents...
        </div>
      )}
      {q.isError && (
        <div className="flex items-center gap-2 text-sm text-red-400/80 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
          <AlertCircle size={14} />
          Failed to load. <a href="https://www.albertamsa.ca/documents" target="_blank" rel="noopener noreferrer" className="underline ml-1">View on albertamsa.ca →</a>
        </div>
      )}

      {docs.length > 0 && (
        <div className="bg-white/3 border border-white/8 rounded-xl overflow-hidden">
          {docs.map((doc, i) => <DocRow key={i} doc={doc} />)}
        </div>
      )}
      {q.data && docs.length === 0 && (
        <div className="text-sm text-white/40 text-center py-4">No documents match your filter.</div>
      )}
    </div>
  );
}

export default function MSA() {
  const [tab, setTab] = useState("overview");

  const allDocsQ = useQuery<MsaDocsResponse>({
    queryKey: ["msa-docs", "all"],
    queryFn: () => fetch("/api/aeso/msa/documents?category=all").then(r => r.json()),
    staleTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });

  return (
    <div className="space-y-5 pb-8">
      {/* ── Header ── */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Eye size={22} className="text-teal-400" />
            Market Surveillance Administrator (MSA)
          </h1>
          <p className="text-sm text-white/50 mt-1">Alberta's independent electricity & gas market monitor</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <a href="http://data.albertamsa.ca/" target="_blank" rel="noopener noreferrer"
             className="flex items-center gap-1.5 px-3 py-2 bg-teal-600/20 hover:bg-teal-600/30 border border-teal-500/30 rounded-lg text-sm text-teal-300 transition-colors">
            <Database size={13} /> Data Portal
          </a>
          <a href="https://www.albertamsa.ca/" target="_blank" rel="noopener noreferrer"
             className="flex items-center gap-1.5 px-3 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm text-white/70 transition-colors">
            <ExternalLink size={13} /> albertamsa.ca
          </a>
          <ScrapeRefreshButton queryKeys={["msa-docs", "msa-recent"]} />
        </div>
      </div>

      {/* ── Summary Cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Role",       value: "Monitor",    sub: "Independent market watchdog",       icon: <Eye size={15} className="text-teal-400" /> },
          { label: "Jurisdiction", value: "AB Market", sub: "Electricity & retail natural gas",  icon: <Shield size={15} className="text-amber-400" /> },
          { label: "Reports",    value: "Quarterly",  sub: "Wholesale market + enforcement",    icon: <BarChart3 size={15} className="text-purple-400" /> },
          { label: "Data Portal", value: "Free",      sub: "Public datasets, no auth required", icon: <Database size={15} className="text-sky-400" /> },
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
              <h3 className="font-semibold text-white/85 mb-2 text-sm">About the MSA</h3>
              <p className="text-sm text-white/65 leading-relaxed mb-3">
                The Market Surveillance Administrator (MSA) is an independent agency that monitors Alberta's
                electricity and retail natural gas markets for fair, efficient, and openly competitive operation.
                Unlike the AUC (which sets rates) or the AESO (which operates the grid), the MSA watches for
                anti-competitive behaviour, market power abuse, and ISO rule violations.
              </p>
              <p className="text-sm text-white/65 leading-relaxed">
                The MSA investigates potential violations, issues compliance notices (NSPs), and publishes quarterly
                wholesale market reports, enforcement activity reports, and an annual report to the Minister of
                Affordability and Utilities.
              </p>
            </div>

            {/* Recent documents */}
            {allDocsQ.isLoading && (
              <div className="flex items-center gap-2 text-sm text-white/50">
                <RefreshCw size={13} className="animate-spin" /> Loading recent MSA documents...
              </div>
            )}
            {allDocsQ.data?.docs && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider">Most Recent Documents</h3>
                  {allDocsQ.data.fetchedAt && (
                    <span className="text-xs text-white/25">Updated {formatDate(allDocsQ.data.fetchedAt)}</span>
                  )}
                </div>
                <div className="bg-white/3 border border-white/8 rounded-xl overflow-hidden">
                  {allDocsQ.data.docs.slice(0, 10).map((doc, i) => <DocRow key={i} doc={doc} />)}
                </div>
                <a href="https://www.albertamsa.ca/documents" target="_blank" rel="noopener noreferrer"
                   className="flex items-center gap-1.5 text-xs text-teal-400 hover:text-teal-300 transition-colors mt-2">
                  <ExternalLink size={11} /> View all documents on albertamsa.ca
                </a>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {[
                { title: "MSA Mandate", desc: "Taking action to promote effective competition and a culture of compliance and accountability in Alberta's electricity and retail natural gas markets.", url: "https://www.albertamsa.ca/documents/what-we-do/mandate-of-roles" },
                { title: "General Procedures & Process", desc: "How the MSA investigates potential market violations, from initial review through to compliance notice or formal enforcement action.", url: "https://www.albertamsa.ca/documents/what-we-do/general-procedures-and-process" },
                { title: "Code of Conduct", desc: "MSA's code of conduct governing confidentiality, conflicts of interest, and information handling in its surveillance role.", url: "https://www.albertamsa.ca/documents/what-we-do/code-of-conduct" },
                { title: "Process & Forms", desc: "Forms for submissions to the MSA, including ISO rule compliance filings and reliability standard notifications.", url: "https://www.albertamsa.ca/process-and-forms" },
              ].map(c => (
                <a key={c.title} href={c.url} target="_blank" rel="noopener noreferrer"
                   className="bg-white/3 border border-white/8 hover:border-teal-500/25 rounded-xl px-4 py-4 block group transition-colors">
                  <div className="font-semibold text-white/80 text-sm group-hover:text-white transition-colors mb-1">{c.title}</div>
                  <p className="text-xs text-white/45 leading-relaxed">{c.desc}</p>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* REPORTS */}
        {tab === "reports" && (
          <div className="space-y-4">
            <div className="bg-white/3 border border-white/8 rounded-xl px-5 py-4">
              <p className="text-sm text-white/65 leading-relaxed">
                MSA publishes quarterly reports covering wholesale market observations, price analysis, and enforcement
                activity — plus an annual report to the Minister. Each report includes a notice summarising key findings.
              </p>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-2">Quarterly Reports</h3>
              <DocsPanel category="reports" title="Quarterly Reports"
                filterCats={["Quarterly Reports", "Compliance Review", "MSOC", "Other Reports"]} />
            </div>

            <div className="mt-4">
              <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-2">Annual Reports to the Minister</h3>
              <DocsPanel category="annual" title="Annual Reports" filterCats={["Annual Report"]} />
            </div>
          </div>
        )}

        {/* NOTICES */}
        {tab === "notices" && (
          <div className="space-y-3">
            <div className="bg-white/3 border border-white/8 rounded-xl px-5 py-4">
              <p className="text-sm text-white/65 leading-relaxed">
                MSA Notices cover a range of topics including new reports, procedural changes, stakeholder consultations,
                and employment opportunities. Each notice is published with a PDF and an effective date.
              </p>
            </div>
            <DocsPanel category="notices" title="Notices" filterCats={["Notices"]} />
          </div>
        )}

        {/* COMPLIANCE */}
        {tab === "compliance" && (
          <div className="space-y-4">
            <div className="bg-white/3 border border-white/8 rounded-xl px-5 py-4">
              <h3 className="font-semibold text-white/85 mb-2 text-sm">MSA Compliance Activity</h3>
              <p className="text-sm text-white/65 leading-relaxed mb-2">
                The MSA enforces ISO Rules and Alberta Reliability Standards through a notice and specified-penalty
                regime. Non-Specified Penalty (NSP) notices are issued to market participants that violate specific
                ISO rules or reliability standards, with the outcome filed publicly.
              </p>
              <p className="text-sm text-white/65 leading-relaxed">
                The 2026 MSA Investigation and Enforcement Process was finalised in June 2026, replacing the prior
                process. The new process covers investigation triggers, evidence collection, settlement procedures,
                and formal hearing steps.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {[
                { title: "Compliance Process Overview", desc: "How the MSA identifies, investigates, and resolves potential ISO rule and reliability standard violations.", url: "https://www.albertamsa.ca/documents/compliance/compliance-process" },
                { title: "Investigation & Enforcement Process (2026)", desc: "The current formal MSA investigation and enforcement framework published June 2026.", url: "https://www.albertamsa.ca/assets/Documents/Investigation-and-Enforcement-Process-2026.pdf", badge: "PDF" },
                { title: "ISO Rules — Specified Penalties", desc: "Schedule of specified penalties for ISO rule violations, by rule section and severity.", url: "https://www.albertamsa.ca/documents/compliance/iso-rules-specified-penalties" },
                { title: "Reliability Standards — Specified Penalties", desc: "Penalties applicable to Alberta Reliability Standards violations.", url: "https://www.albertamsa.ca/documents/compliance/reliability-standards-specified-penalties" },
              ].map(c => (
                <a key={c.title} href={c.url} target="_blank" rel="noopener noreferrer"
                   className="bg-white/3 border border-white/8 hover:border-teal-500/25 rounded-xl px-4 py-4 flex items-start gap-3 group transition-colors block">
                  <FileText size={14} className="mt-0.5 text-white/30 group-hover:text-teal-400 shrink-0 transition-colors" />
                  <div>
                    <div className="font-semibold text-white/80 text-sm group-hover:text-white transition-colors mb-1">{c.title}</div>
                    <p className="text-xs text-white/45 leading-relaxed">{c.desc}</p>
                  </div>
                </a>
              ))}
            </div>

            <div>
              <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-2">Recent NSP Compliance Notices</h3>
              <DocsPanel category="all" title="Compliance"
                filterCats={["ISO Rules - Specified Penalties", "ISO Rules - Forms", "Reliability Standards - Specified Penalties", "Reliability Standards - Forms", "Compliance Process"]} />
            </div>
          </div>
        )}

        {/* RETAIL & RATES */}
        {tab === "retail" && (
          <div className="space-y-4">
            <div className="bg-white/3 border border-white/8 rounded-xl px-5 py-4">
              <h3 className="font-semibold text-white/85 mb-2 text-sm">Retail Market & Rate Cap Oversight</h3>
              <p className="text-sm text-white/65 leading-relaxed">
                The MSA monitors Alberta's retail electricity and natural gas markets, including activities under the
                Regulated Rate Tariff (RRT) and Rate of Last Resort (RoLR) regulation. The MSA publishes monthly retail
                statistics showing customer counts, switching rates, and retailer market shares.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {[
                { title: "Retail Statistics",        desc: "Monthly XLSX showing customer counts, market shares, switching activity, and rate comparisons across Alberta's retail electricity market.", url: "https://www.albertamsa.ca/assets/Documents/MSA-Retail-Statistics.xlsx", badge: "XLSX" },
                { title: "Rate of Last Resort (RoLR)", desc: "Information and MSA activities related to the RoLR regulation, which protects customers if their retailer exits the market.", url: "https://www.albertamsa.ca/documents/consultations/rate-of-last-resort-regulation-msa-activities" },
                { title: "Retail Billing Tool",      desc: "Tool for calculating and verifying retail electricity bills under various rate structures, used for compliance monitoring.", url: "https://www.albertamsa.ca/documents/retail-and-rate-cap/retail-billing-tool" },
              ].map(c => (
                <a key={c.title} href={c.url} target="_blank" rel="noopener noreferrer"
                   className="bg-white/3 border border-white/8 hover:border-teal-500/25 rounded-xl px-4 py-4 block group transition-colors">
                  <div className="font-semibold text-white/80 text-sm group-hover:text-white transition-colors mb-1">{c.title}</div>
                  <p className="text-xs text-white/45 leading-relaxed">{c.desc}</p>
                </a>
              ))}
            </div>

            <div>
              <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-2">Deferral Account Statements (DAS)</h3>
              <div className="bg-white/3 border border-white/8 rounded-xl px-5 py-4">
                <p className="text-sm text-white/60 leading-relaxed mb-2">
                  MSA publishes Deferral Account Statements for regulated electricity retailers (boards, councils,
                  and Medicine Hat). These reconcile the difference between actual RRT rates and the regulated cost of energy.
                </p>
                <div className="flex items-center gap-3 flex-wrap">
                  <a href="https://www.albertamsa.ca/documents/retail-and-rate-cap/dass" target="_blank" rel="noopener noreferrer"
                     className="text-xs text-teal-400 hover:text-teal-300 flex items-center gap-1 transition-colors">
                    <ExternalLink size={11} /> DAS Process
                  </a>
                  <a href="https://www.albertamsa.ca/documents/retail-and-rate-cap/test-of-dass" target="_blank" rel="noopener noreferrer"
                     className="text-xs text-teal-400 hover:text-teal-300 flex items-center gap-1 transition-colors">
                    <ExternalLink size={11} /> Approved DASs — Boards & Councils
                  </a>
                  <a href="https://www.albertamsa.ca/documents/retail-and-rate-cap/approved-dass-for-medicine-hat" target="_blank" rel="noopener noreferrer"
                     className="text-xs text-teal-400 hover:text-teal-300 flex items-center gap-1 transition-colors">
                    <ExternalLink size={11} /> Approved DASs — Medicine Hat
                  </a>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* DATA PORTAL */}
        {tab === "portal" && (
          <div className="space-y-4">
            <div className="bg-white/3 border border-white/8 rounded-xl px-5 py-4">
              <h3 className="font-semibold text-white/85 mb-2 text-sm">MSA Data Portal</h3>
              <p className="text-sm text-white/65 leading-relaxed mb-3">
                The MSA Data Portal (data.albertamsa.ca) provides free public access to structured datasets used
                in MSA reports and analyses. Each dataset includes methodology documentation. Available 24/7, no
                account required.
              </p>
              <a href="http://data.albertamsa.ca/" target="_blank" rel="noopener noreferrer"
                 className="inline-flex items-center gap-1.5 px-3 py-2 bg-teal-600/20 hover:bg-teal-600/30 border border-teal-500/30 rounded-lg text-sm text-teal-300 transition-colors">
                <Database size={13} /> Open Data Portal →
              </a>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {DATA_PORTAL_DATASETS.map(d => (
                <a key={d.name} href="http://data.albertamsa.ca/" target="_blank" rel="noopener noreferrer"
                   className="bg-white/3 border border-white/8 hover:border-teal-500/25 rounded-xl px-4 py-4 block group transition-colors">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-semibold text-white/80 text-sm group-hover:text-white transition-colors">{d.name}</span>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-white/8 text-white/40">{d.freq}</span>
                  </div>
                  <p className="text-xs text-white/45 leading-relaxed">{d.sub}</p>
                </a>
              ))}
            </div>

            <div className="bg-sky-500/8 border border-sky-500/20 rounded-xl px-4 py-3">
              <h3 className="font-semibold text-sky-300 text-sm mb-2 flex items-center gap-1.5">
                <Database size={14} /> Market Power Data — Relevance for Procurement
              </h3>
              <div className="space-y-1.5">
                {[
                  "Pivotality index shows which generators are 'must-have' in Alberta — key for PPA counterparty credit assessment.",
                  "Lerner Index measures market power gap between market price and competitive benchmark — indicates price manipulation risk.",
                  "SRMC (Short-Run Marginal Cost) counterfactual price is the MSA's estimate of competitive clearing price — useful for basis analysis.",
                  "Static Inefficiency measures welfare loss from market power — correlates with high price event frequency.",
                ].map((b, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-sky-300/70">
                    <span className="text-sky-400 font-bold shrink-0">·</span>{b}
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white/3 border border-white/8 rounded-xl px-5 py-4">
              <h3 className="font-semibold text-white/80 text-sm mb-2">Terms of Use</h3>
              <p className="text-xs text-white/50 leading-relaxed">
                By accessing the MSA Data Portal, users agree to the MSA User Agreement at albertamsa.ca/terms.
                Data is available for research and analysis; redistribution requires attribution. Contact
                AnalyticsandInfoTech@albertamsa.ca for questions.
              </p>
            </div>
          </div>
        )}

      </div>
      <div className="text-xs text-white/20 text-center pt-2">
        Source: albertamsa.ca — documents refreshed daily from live MSA website · Last verified July 2026
      </div>
    </div>
  );
}
