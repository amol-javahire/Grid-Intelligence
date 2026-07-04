import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Scale, AlertTriangle, CheckCircle2, Clock, FileText,
  ExternalLink, ChevronDown, ChevronUp, RefreshCw,
  Zap, DollarSign, Network, Leaf, ShieldCheck, BarChart3,
  Cpu, TrendingUp, BookOpen, Calendar, Star, Wind, Sun, Battery,
  XCircle, ArrowRight, Activity,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, Legend,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ── Types ──────────────────────────────────────────────────────────────────────

interface RegulatoryItem {
  id: number;
  market: string;
  category: string;
  title: string;
  summary: string;
  detail: string | null;
  effectiveDate: string | null;
  effective_date: string | null;
  announcedDate: string | null;
  announced_date: string | null;
  status: string;
  impactLevel: string;
  impact_level: string;
  sourceUrl: string | null;
  source_url: string | null;
  sourceName: string | null;
  source_name: string | null;
  tags: string[];
  modelImpact: string | null;
  model_impact: string | null;
}

type Market = "ERCOT" | "CAISO" | "FEDERAL";

const CATEGORIES = [
  { key: "all",            label: "All",             icon: Scale },
  { key: "interconnection",label: "Interconnection", icon: Network },
  { key: "market_rules",   label: "Market Rules",    icon: BarChart3 },
  { key: "tax_credits",    label: "Tax Credits",     icon: DollarSign },
  { key: "reliability",    label: "Reliability",     icon: ShieldCheck },
  { key: "transmission",   label: "Transmission",    icon: Zap },
  { key: "environmental",  label: "Environmental",   icon: Leaf },
  { key: "capacity",       label: "Capacity",        icon: TrendingUp },
] as const;

// ── Helpers ────────────────────────────────────────────────────────────────────

function field<T>(item: RegulatoryItem, a: keyof RegulatoryItem, b: keyof RegulatoryItem): T {
  return (item[a] ?? item[b]) as T;
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-US", { month: "short", year: "numeric" });
  } catch { return d; }
}

function statusColor(s: string) {
  switch (s) {
    case "active":   return "bg-emerald-500/20 text-emerald-300 border-emerald-500/30";
    case "pending":  return "bg-amber-500/20  text-amber-300  border-amber-500/30";
    case "proposed": return "bg-blue-500/20   text-blue-300   border-blue-500/30";
    case "final":    return "bg-teal-500/20   text-teal-300   border-teal-500/30";
    case "expired":  return "bg-gray-500/20   text-gray-400   border-gray-500/30";
    default:         return "bg-gray-500/20   text-gray-400   border-gray-500/30";
  }
}

function impactColor(lvl: string) {
  switch (lvl) {
    case "high":   return "bg-red-500/20   text-red-300   border-red-500/30";
    case "medium": return "bg-amber-500/20 text-amber-300 border-amber-500/30";
    case "low":    return "bg-gray-500/20  text-gray-400  border-gray-500/30";
    default:       return "bg-gray-500/20  text-gray-400  border-gray-500/30";
  }
}

function categoryIcon(cat: string) {
  const entry = CATEGORIES.find(c => c.key === cat);
  const Icon = entry?.icon ?? Scale;
  return <Icon className="h-3.5 w-3.5" />;
}

// ── Summary Cards ──────────────────────────────────────────────────────────────

function SummaryCards({ items }: { items: RegulatoryItem[] }) {
  const active  = items.filter(i => i.status === "active").length;
  const high    = items.filter(i => (i.impact_level ?? i.impactLevel) === "high").length;
  const pending = items.filter(i => i.status === "pending" || i.status === "proposed").length;
  const taxItems= items.filter(i => i.category === "tax_credits").length;

  const cards = [
    { label: "Active Rules",    value: active,  icon: CheckCircle2, color: "text-emerald-400" },
    { label: "High Impact",     value: high,    icon: AlertTriangle, color: "text-red-400" },
    { label: "Pending / Proposed",value: pending,icon: Clock,        color: "text-amber-400" },
    { label: "Tax Credit Items",value: taxItems,icon: DollarSign,    color: "text-teal-400" },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      {cards.map(c => (
        <div key={c.label} className="bg-slate-800/60 border border-white/10 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-1">
            <c.icon className={`h-4 w-4 ${c.color}`} />
            <span className="text-xs text-slate-400 uppercase tracking-wider">{c.label}</span>
          </div>
          <div className="text-2xl font-bold text-white">{c.value}</div>
        </div>
      ))}
    </div>
  );
}

// ── Tax Credit Quick-Reference Banner ─────────────────────────────────────────

function TaxCreditBanner({ market }: { market: Market }) {
  if (market === "ERCOT" || market === "CAISO") return null;

  return (
    <div className="mb-6 bg-teal-900/30 border border-teal-500/30 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-3">
        <DollarSign className="h-5 w-5 text-teal-400" />
        <h3 className="text-sm font-semibold text-teal-300 uppercase tracking-wider">IRA Quick-Reference — 2025 Credit Stack</h3>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
        <div className="bg-slate-900/60 rounded-lg p-3">
          <div className="text-xs text-slate-400 mb-1">Base ITC (Section 48E)</div>
          <div className="text-xl font-bold text-white">30%</div>
          <div className="text-xs text-slate-400 mt-1">of eligible project cost<br />+10% Energy Community<br />+10% Domestic Content<br />= up to 50% ITC</div>
        </div>
        <div className="bg-slate-900/60 rounded-lg p-3">
          <div className="text-xs text-slate-400 mb-1">Base PTC (Section 45Y)</div>
          <div className="text-xl font-bold text-white">$27.5/MWh</div>
          <div className="text-xs text-slate-400 mt-1">10-year term, inflation adjusted<br />+$2.75 Energy Community<br />+$2.75 Domestic Content<br />= up to $33/MWh PTC</div>
        </div>
        <div className="bg-slate-900/60 rounded-lg p-3">
          <div className="text-xs text-slate-400 mb-1">Standalone Storage ITC</div>
          <div className="text-xl font-bold text-white">30–40%</div>
          <div className="text-xs text-slate-400 mt-1">No solar pairing required<br />5 kWh minimum capacity<br />Direct Pay for tax-exempt<br />Transferable to any C-corp</div>
        </div>
      </div>
      <div className="mt-3 text-xs text-amber-300 flex items-center gap-1.5">
        <AlertTriangle className="h-3.5 w-3.5" />
        Prevailing Wage + Apprenticeship required for full credit (6% base without compliance)
      </div>
    </div>
  );
}

// ── OBBBA Navigator ─────────────────────────────────────────────────────────────
// "One Big Beautiful Bill Act" — signed July 4 2025. Key tax credit provisions.

const OBBBA_TIMELINE = [
  {
    date: "Jul 4, 2025",
    label: "OBBBA Signed",
    detail: "H.R. 1 (One Big Beautiful Bill Act) enacted. Accelerates phase-out of IRA-era ITC/PTC credits. New construction safe-harbor deadline set.",
    color: "#ef4444",
    icon: "⚡",
    passed: true,
  },
  {
    date: "Sep 30, 2025",
    label: "Construction Safe-Harbor Deadline",
    detail: "Last day to begin physical construction and incur 5% of project costs to qualify for IRA-rate ITC/PTC. Projects starting after this date are NOT eligible for grandfathered credits.",
    color: "#f59e0b",
    icon: "🏗️",
    passed: true,
  },
  {
    date: "Dec 31, 2026",
    label: "EV Credit Phase-Out Begins",
    detail: "Section 30D (consumer EV) and 25E (used EV) credits begin phasing out. Commercial EV (Section 45W) credits reduced by 50%. Affects Walmart fleet electrification economics.",
    color: "#8b5cf6",
    icon: "🚗",
    passed: false,
  },
  {
    date: "Dec 31, 2027",
    label: "45X Wind Component Credit Expires",
    detail: "Section 45X advanced manufacturing production credit for wind turbine components (nacelles, towers, blades) expires. Domestic wind supply chain economics change materially.",
    color: "#f97316",
    icon: "🌬️",
    passed: false,
  },
  {
    date: "Dec 31, 2028",
    label: "Placed-in-Service Deadline (Grandfathered)",
    detail: "Grandfathered projects (construction started ≤ Sep 30 2025) must be placed in service by this date to claim ITC/PTC. Projects missing this deadline forfeit the credits entirely.",
    color: "#14b8a6",
    icon: "✅",
    passed: false,
  },
  {
    date: "Jan 1, 2029",
    label: "No New ITC/PTC Available",
    detail: "After Dec 31 2028, no Investment Tax Credit or Production Tax Credit available for wind or solar under OBBBA. Storage ITC (Section 48E) limited to projects with 80%+ domestic content.",
    color: "#94a3b8",
    icon: "⛔",
    passed: false,
  },
];

const OBBBA_PROVISIONS = [
  { icon: ShieldCheck, label: "Safe Harbor", color: "#22c55e", text: "Start construction + 5% cost incurrence by Sep 30, 2025 → eligible for IRA-rate ITC/PTC" },
  { icon: DollarSign, label: "ITC Stack (Grandfathered)", color: "#14b8a6", text: "30% base + 10% Energy Community + 10% Domestic Content = up to 50% ITC" },
  { icon: Zap,         label: "PTC Stack (Grandfathered)", color: "#8b5cf6", text: "$27.5/MWh base + $2.75 EC + $2.75 DC = up to $33/MWh, 10-year term" },
  { icon: AlertTriangle, label: "FEOC Restriction", color: "#ef4444", text: "Components from China, Russia, Iran, or N. Korea → project disqualified from all credits" },
  { icon: Wind,        label: "45X Wind Component", color: "#f97316", text: "Nacelles, blades, towers: manufacturing credit expires Dec 31 2027 (2 years earlier than IRA)" },
  { icon: Battery,     label: "Storage ITC (Post-2028)", color: "#f59e0b", text: "Section 48E storage survives but requires ≥80% domestic content; BESS economics tighten" },
];

interface CreditEligibility {
  windPtc: { market: string; ptc_status: string; cnt: number; totalMw: number }[];
  windPtcYears: { market: string; ptc_yr_bucket: string; cnt: number; totalMw: number }[];
  solar: { market: string; era: string; cnt: number; totalMw: number }[];
  queueSafeHarbor: { status: string; cnt: number; totalMw: number }[];
}

function OBBBANavigator({ market }: { market: Market }) {
  const [activeTab, setActiveTab] = useState<"timeline" | "eligibility" | "credits">("timeline");

  const { data: elig } = useQuery<CreditEligibility>({
    queryKey: ["credit-eligibility"],
    queryFn: () => fetch("/api/regulatory/credit-eligibility").then(r => r.json()),
    staleTime: 60 * 60_000,
    enabled: market === "FEDERAL",
  });

  const TOOLTIP_STYLE = {
    backgroundColor: "#0f172a",
    border: "1px solid #1e293b",
    borderRadius: 8,
    color: "#f8fafc",
  };

  // Wind PTC chart data: by market + bucket
  const windPtcChart = useMemo(() => {
    if (!elig) return [];
    const markets = ["ERCOT", "CAISO", "PJM"];
    const buckets  = ["Expired", "1-2 yrs left", "3-5 yrs left", "6+ yrs left", "Unknown"];
    return buckets.map(b => {
      const row: Record<string, unknown> = { bucket: b };
      for (const m of markets) {
        const found = elig.windPtcYears.find(r => r.market === m && r.ptc_yr_bucket === b);
        row[m] = found ? Math.round(found.totalMw / 1000) : 0; // GW
      }
      return row;
    });
  }, [elig]);

  // Queue safe-harbor pie
  const queueChart = useMemo(() => {
    if (!elig) return [];
    return elig.queueSafeHarbor.map(r => ({
      name: r.status === "pre_obbba" ? "Pre-OBBBA (eligible)" : "Post-OBBBA (at risk)",
      mw:   Math.round(r.totalMw / 1000),
      cnt:  r.cnt,
      color: r.status === "pre_obbba" ? "#14b8a6" : "#ef4444",
    }));
  }, [elig]);

  return (
    <div className="mb-6 bg-slate-800/50 border border-orange-500/30 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-orange-900/40 to-slate-800/40 border-b border-orange-500/20 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="rounded-lg p-2 bg-orange-500/20">
            <Scale className="h-5 w-5 text-orange-400" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-orange-300 uppercase tracking-wider">
              OBBBA Navigator — One Big Beautiful Bill Act (H.R. 1)
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Signed July 4, 2025 · Accelerates ITC/PTC phase-out · Construction deadline Sep 30 2025 already passed
            </p>
          </div>
          <div className="ml-auto shrink-0 px-3 py-1 rounded-full bg-red-500/20 border border-red-500/30">
            <span className="text-xs font-semibold text-red-300">Safe Harbor CLOSED</span>
          </div>
        </div>

        {/* Tab selector */}
        <div className="flex gap-1 mt-3 bg-slate-900/50 p-0.5 rounded-lg w-fit">
          {(["timeline", "eligibility", "credits"] as const).map(t => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors capitalize ${
                activeTab === t ? "bg-orange-500/30 text-orange-200" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {t === "timeline" ? "📅 Timeline" : t === "eligibility" ? "✅ Eligibility" : "💰 Credit Stack"}
            </button>
          ))}
        </div>
      </div>

      {/* Timeline tab */}
      {activeTab === "timeline" && (
        <div className="p-5">
          <div className="relative">
            {/* Vertical line */}
            <div className="absolute left-5 top-2 bottom-2 w-px bg-slate-600/50" />
            <div className="space-y-4">
              {OBBBA_TIMELINE.map((item, i) => (
                <div key={i} className="flex gap-4 items-start relative">
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center text-base shrink-0 border-2 z-10"
                    style={{
                      borderColor: item.color,
                      backgroundColor: `${item.color}18`,
                      opacity: item.passed ? 1 : 0.7,
                    }}
                  >
                    {item.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-bold" style={{ color: item.color }}>{item.date}</span>
                      <span className="text-sm font-semibold text-slate-100">{item.label}</span>
                      {item.passed && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-700/80 text-slate-400 border border-slate-600/50">PASSED</span>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{item.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Eligibility tab */}
      {activeTab === "eligibility" && (
        <div className="p-5 space-y-5">
          {/* ERCOT queue safe harbor */}
          <div>
            <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5 text-teal-400" />
              ERCOT Queue — Safe Harbor Status (Active Projects)
            </h4>
            {queueChart.length > 0 ? (
              <div className="grid grid-cols-2 gap-3 mb-3">
                {queueChart.map(q => (
                  <div key={q.name} className="bg-slate-900/60 rounded-lg p-4 border border-white/5">
                    <div className="text-2xl font-bold mb-0.5" style={{ color: q.color }}>
                      {q.mw} GW
                    </div>
                    <div className="text-xs text-slate-300 font-medium">{q.name}</div>
                    <div className="text-xs text-slate-500">{q.cnt} projects</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-slate-500">Loading…</div>
            )}
            <p className="text-xs text-slate-500 leading-relaxed">
              ERCOT queue projects with <code className="text-teal-400/80">request_date ≤ Sep 30 2025</code> may have started construction
              before the OBBBA safe-harbor deadline. Projects filed after that date face higher development risk with no ITC/PTC backstop.
            </p>
          </div>

          {/* Wind PTC remaining window */}
          <div>
            <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <Wind className="h-3.5 w-3.5 text-teal-400" />
              Existing Wind Fleet — PTC Years Remaining (EIA 860 Operable Plants)
            </h4>
            {windPtcChart.length > 0 ? (
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={windPtcChart} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="bucket" tick={{ fill: "#94a3b8", fontSize: 10 }} />
                  <YAxis tick={{ fill: "#94a3b8", fontSize: 10 }} tickFormatter={v => `${v} GW`} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`${v} GW`, ""]} />
                  <Legend wrapperStyle={{ color: "#94a3b8", fontSize: 11 }} />
                  <Bar dataKey="ERCOT" fill="#14b8a6" radius={[2,2,0,0]} />
                  <Bar dataKey="CAISO" fill="#f59e0b" radius={[2,2,0,0]} />
                  <Bar dataKey="PJM"   fill="#8b5cf6" radius={[2,2,0,0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-32 flex items-center justify-center text-slate-500 text-xs">Loading…</div>
            )}
            <p className="text-xs text-slate-500 mt-2 leading-relaxed">
              Wind PTC (Section 45Y) runs 10 years from placed-in-service date. Plants with "6+ yrs left"
              (commissioned 2020+) still carry significant PTC value that sellers can share via indexed PPA structures.
              Plants with "Expired" PTC (commissioned ≤ 2015) are economically comparable to merchant generators.
            </p>
          </div>
        </div>
      )}

      {/* Credit Stack tab */}
      {activeTab === "credits" && (
        <div className="p-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {OBBBA_PROVISIONS.map((p, i) => (
              <div key={i} className="bg-slate-900/60 border border-white/8 rounded-lg p-3 flex items-start gap-3">
                <div className="rounded-md p-1.5 shrink-0" style={{ backgroundColor: `${p.color}22` }}>
                  <p.icon className="h-4 w-4" style={{ color: p.color }} />
                </div>
                <div>
                  <div className="text-xs font-semibold text-slate-200 mb-0.5">{p.label}</div>
                  <div className="text-xs text-slate-400 leading-relaxed">{p.text}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 bg-amber-900/20 border border-amber-500/20 rounded-lg p-3">
            <div className="flex items-center gap-1.5 mb-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
              <span className="text-xs font-semibold text-amber-300">Prevailing Wage + Apprenticeship Required</span>
            </div>
            <p className="text-xs text-slate-400">
              Without PWA compliance: ITC reduces to 6%, PTC reduces to $5.50/MWh. Projects claiming grandfathered rates
              must maintain PWA documentation for the full construction period. Spot audits enforced via IRS Form 3468.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Individual Regulatory Card ─────────────────────────────────────────────────

function RegCard({ item }: { item: RegulatoryItem }) {
  const [expanded, setExpanded] = useState(false);
  const effectiveDate = field<string | null>(item, "effective_date", "effectiveDate");
  const impactLevel   = field<string>(item, "impact_level", "impactLevel");
  const sourceUrl     = field<string | null>(item, "source_url", "sourceUrl");
  const sourceName    = field<string | null>(item, "source_name", "sourceName");
  const modelImpact   = field<string | null>(item, "model_impact", "modelImpact");

  return (
    <div className={`bg-slate-800/50 border rounded-xl overflow-hidden transition-all ${
      impactLevel === "high" ? "border-red-500/20" :
      impactLevel === "medium" ? "border-amber-500/20" :
      "border-white/10"
    }`}>
      {/* Header */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-3 mb-2">
          <h3 className="text-sm font-semibold text-white leading-snug flex-1">{item.title}</h3>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border ${impactColor(impactLevel)}`}>
              {impactLevel.toUpperCase()}
            </span>
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full border capitalize ${statusColor(item.status)}`}>
              {item.status}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3 mb-3 text-xs text-slate-400">
          <div className="flex items-center gap-1">{categoryIcon(item.category)}<span className="capitalize">{item.category.replace(/_/g, " ")}</span></div>
          {sourceName && <span className="text-slate-500">·</span>}
          {sourceName && <span>{sourceName}</span>}
          {effectiveDate && <span className="text-slate-500">·</span>}
          {effectiveDate && <span>Effective {fmtDate(effectiveDate)}</span>}
        </div>

        <p className="text-xs text-slate-300 leading-relaxed">{item.summary}</p>

        {/* Tags */}
        {item.tags && item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {item.tags.filter(t => !["scraped", "ercot", "caiso", "ferc", "press_release", "market_notice", "news"].includes(t)).slice(0, 6).map(tag => (
              <span key={tag} className="text-[10px] bg-slate-700/60 text-slate-400 px-1.5 py-0.5 rounded">
                {tag.replace(/_/g, " ")}
              </span>
            ))}
          </div>
        )}

        {/* Expand/collapse button */}
        {(item.detail || modelImpact) && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="mt-3 flex items-center gap-1 text-xs text-teal-400 hover:text-teal-300 transition-colors"
          >
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {expanded ? "Show less" : "View detail & model impact"}
          </button>
        )}
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-white/10 px-4 pb-4 pt-3 space-y-3">
          {item.detail && (
            <div>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5 flex items-center gap-1">
                <BookOpen className="h-3 w-3" /> Full Detail
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">{item.detail}</p>
            </div>
          )}
          {modelImpact && (
            <div className="bg-teal-900/20 border border-teal-500/20 rounded-lg p-3">
              <div className="text-[10px] text-teal-400 uppercase tracking-wider mb-1.5 flex items-center gap-1">
                <Cpu className="h-3 w-3" /> Model Impact
              </div>
              <p className="text-xs text-teal-100/80 leading-relaxed">{modelImpact}</p>
            </div>
          )}
          {sourceUrl && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
              {sourceName ?? "View source"}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function RegulatoryPage() {
  const [market, setMarket] = useState<Market>("ERCOT");
  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [impactFilter, setImpactFilter] = useState("all");

  const { data, isLoading, refetch, isFetching } = useQuery<RegulatoryItem[]>({
    queryKey: ["regulatory", market],
    queryFn: async () => {
      const res = await fetch(`/api/regulatory?market=${market}`);
      if (!res.ok) throw new Error("Failed to fetch regulatory data");
      return res.json();
    },
  });

  const items = useMemo(() => {
    if (!data) return [];
    let filtered = data;
    if (category !== "all") filtered = filtered.filter(i => i.category === category);
    if (impactFilter !== "all") {
      filtered = filtered.filter(i =>
        (i.impact_level ?? i.impactLevel) === impactFilter
      );
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter(i =>
        i.title.toLowerCase().includes(q) ||
        i.summary.toLowerCase().includes(q) ||
        (i.tags ?? []).some(t => t.toLowerCase().includes(q))
      );
    }
    return filtered;
  }, [data, category, impactFilter, search]);

  const MARKETS: { key: Market; label: string; description: string }[] = [
    { key: "ERCOT",   label: "ERCOT (Texas)",   description: "PUCT rules, market protocols, Texas legislature" },
    { key: "CAISO",   label: "CAISO (California)", description: "CPUC proceedings, CAISO tariff amendments" },
    { key: "FEDERAL", label: "Federal / IRA",    description: "ITC/PTC credits, FERC orders, DOE programs" },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Scale className="h-6 w-6 text-teal-400" />
          Regulatory & Tax Intelligence
        </h1>
        <p className="text-slate-400 text-sm mt-1">
          Active market rules, interconnection reforms, and federal tax credit guidance — curated for PPA origination.
          Sources: ERCOT, PUCT, CAISO, CPUC, FERC, IRS, DOE. Updated monthly.
        </p>
      </div>

      {/* Market Toggle */}
      <div className="flex flex-col sm:flex-row gap-3">
        {MARKETS.map(m => (
          <button
            key={m.key}
            onClick={() => { setMarket(m.key); setCategory("all"); setSearch(""); }}
            className={`flex-1 text-left px-4 py-3 rounded-xl border transition-all ${
              market === m.key
                ? "bg-teal-600/20 border-teal-500/50 text-teal-300"
                : "bg-slate-800/50 border-white/10 text-slate-400 hover:border-white/20"
            }`}
          >
            <div className="font-semibold text-sm">{m.label}</div>
            <div className="text-xs opacity-70 mt-0.5">{m.description}</div>
          </button>
        ))}
      </div>

      {/* OBBBA Navigator (Federal) or IRA Banner */}
      {market === "FEDERAL" ? (
        <OBBBANavigator market={market} />
      ) : (
        <TaxCreditBanner market={market} />
      )}

      {/* Summary Cards */}
      {data && <SummaryCards items={data} />}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
        {/* Category pills */}
        <div className="flex flex-wrap gap-1.5">
          {CATEGORIES.map(c => (
            <button
              key={c.key}
              onClick={() => setCategory(c.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                category === c.key
                  ? "bg-teal-600/30 border-teal-500/50 text-teal-300"
                  : "bg-slate-800/50 border-white/10 text-slate-400 hover:border-white/20"
              }`}
            >
              <c.icon className="h-3 w-3" />
              {c.label}
            </button>
          ))}
        </div>

        {/* Impact filter + search */}
        <div className="flex gap-2 sm:ml-auto">
          {["all", "high", "medium", "low"].map(lvl => (
            <button
              key={lvl}
              onClick={() => setImpactFilter(lvl)}
              className={`px-2.5 py-1 rounded text-xs font-medium border capitalize transition-all ${
                impactFilter === lvl
                  ? lvl === "high"   ? "bg-red-500/20 border-red-500/40 text-red-300"
                  : lvl === "medium" ? "bg-amber-500/20 border-amber-500/40 text-amber-300"
                  : lvl === "low"    ? "bg-gray-500/20 border-gray-500/40 text-gray-300"
                  :                    "bg-teal-600/20 border-teal-500/40 text-teal-300"
                  : "bg-slate-800/50 border-white/10 text-slate-500 hover:border-white/20"
              }`}
            >
              {lvl === "all" ? "All impact" : lvl}
            </button>
          ))}
        </div>
      </div>

      {/* Search */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Input
            placeholder="Search title, summary, or tags…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="bg-slate-800/60 border-white/10 text-slate-200 placeholder:text-slate-500 pl-3 pr-8 h-8 text-sm"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs">✕</button>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span>{items.length} item{items.length !== 1 ? "s" : ""}</span>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1 text-teal-400 hover:text-teal-300 transition-colors"
            title="Refresh data"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Items grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="bg-slate-800/40 border border-white/10 rounded-xl p-5 animate-pulse h-40" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-slate-500">
          <FileText className="h-10 w-10 mb-3 opacity-40" />
          <p className="text-sm">No regulatory items found</p>
          {search && <p className="text-xs mt-1">Try clearing your search filter</p>}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {items.map(item => (
            <RegCard key={item.id} item={item} />
          ))}
        </div>
      )}

      {/* Scraper note */}
      <div className="bg-slate-800/30 border border-white/8 rounded-xl p-4 flex items-start gap-3">
        <RefreshCw className="h-4 w-4 text-slate-500 mt-0.5 shrink-0" />
        <div>
          <p className="text-xs text-slate-400 font-medium mb-0.5">Monthly Regulatory Scraper</p>
          <p className="text-xs text-slate-500 leading-relaxed">
            Run{" "}
            <code className="text-teal-400/80 bg-slate-900/60 px-1 py-0.5 rounded text-[10px]">
              cd artifacts/pypsa-engine && .venv/bin/python3 ../../scripts/src/scrape-regulatory.py
            </code>{" "}
            to pull new press releases from ERCOT, CAISO, and FERC. New items are inserted;
            existing titles are skipped. Run the seed script to refresh curated content:
            {" "}
            <code className="text-teal-400/80 bg-slate-900/60 px-1 py-0.5 rounded text-[10px]">
              ...seed-regulatory.py
            </code>
          </p>
        </div>
      </div>
    </div>
  );
}
