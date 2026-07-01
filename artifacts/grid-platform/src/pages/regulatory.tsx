import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Scale, AlertTriangle, CheckCircle2, Clock, FileText,
  ExternalLink, ChevronDown, ChevronUp, RefreshCw,
  Zap, DollarSign, Network, Leaf, ShieldCheck, BarChart3,
  Cpu, TrendingUp, BookOpen,
} from "lucide-react";
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

      {/* IRA Banner (Federal only) */}
      <TaxCreditBanner market={market} />

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
