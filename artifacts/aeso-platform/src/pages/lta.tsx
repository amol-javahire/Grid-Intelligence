import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Sun, Wind, Zap, Flame, Droplets, BarChart3,
  Download, RefreshCw, ExternalLink, CheckCircle, AlertTriangle,
  ChevronDown, Database, TrendingUp,
} from "lucide-react";

const BASE = "/api";

interface LtaReport {
  year: number;
  quarter: number;
  label: string;
  posted: string;
  url: string;
}

interface StageRow {
  name: string;
  solar: number | null;
  wind: number | null;
  storage: number | null;
  gas: number | null;
  hydro: number | null;
  total: number | null;
}

interface LtaData {
  ailMw: number | null;
  tensMwh: number | null;
  thresholdMwh: number | null;
  stages: StageRow[];
  probability?: {
    worstShortfallProbability?: number;   // e.g. 0.025 = 2.5%
    shortfallHoursProbability?: number;   // e.g. 0.001 = 0.1%
    hoursInShortfall?: number;            // e.g. 7 hours
    tensMwh?: number;
  };
  projectChanges?: { section: string; projects: { name: string; fuel: string; mc: number }[] }[];
}

const FUEL_ICONS: Record<string, React.ReactNode> = {
  solar: <Sun size={14} className="text-amber-400" />,
  wind: <Wind size={14} className="text-sky-400" />,
  storage: <Zap size={14} className="text-purple-400" />,
  gas: <Flame size={14} className="text-orange-400" />,
  hydro: <Droplets size={14} className="text-teal-400" />,
};

const FUEL_COLORS: Record<string, string> = {
  Solar: "text-amber-400",
  Wind: "text-sky-400",
  Storage: "text-purple-400",
  Gas: "text-orange-400",
  Hydro: "text-teal-400",
};

const STAGE_COLORS: Record<string, string> = {
  Operational: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  "Met Project": "bg-sky-500/20 text-sky-300 border-sky-500/30",
  "Received AUC": "bg-amber-500/20 text-amber-300 border-amber-500/30",
  Announced: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  Total: "bg-white/5 text-white/80 border-white/10",
};

function fmt(v: number | null | undefined, decimals = 0): string {
  if (v == null) return "—";
  return v.toLocaleString("en-CA", { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

function stageColor(name: string): string {
  for (const [key, cls] of Object.entries(STAGE_COLORS)) {
    if (name.toLowerCase().includes(key.toLowerCase())) return cls;
  }
  return "bg-white/5 text-white/60 border-white/10";
}

function shortStageName(name: string): string {
  if (name.toLowerCase().includes("operational")) return "Operational";
  if (name.toLowerCase().includes("met project")) return "Met Project Inclusion";
  if (name.toLowerCase().includes("auc")) return "Received AUC Approval";
  if (name.toLowerCase().includes("announced")) return "Announced";
  if (name.toLowerCase().includes("total")) return "Total";
  return name;
}

function CapacityBar({ value, max }: { value: number | null; max: number }) {
  if (!value || !max) return <div className="w-full h-1 bg-white/5 rounded" />;
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="w-full h-1 bg-white/10 rounded overflow-hidden">
      <div className="h-full bg-teal-500/70 rounded" style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function LTA() {
  const [selectedUrl, setSelectedUrl] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const { data: reports = [] } = useQuery<LtaReport[]>({
    queryKey: ["aeso-lta-reports"],
    queryFn: () => fetch(`${BASE}/aeso/lta/reports`).then((r) => r.json()),
    staleTime: 24 * 60 * 60 * 1000,
  });

  const activeUrl = selectedUrl || reports[0]?.url || "";
  const activeReport = reports.find((r) => r.url === activeUrl) ?? reports[0];

  const {
    data: ltaData,
    isLoading,
    isFetching,
    refetch,
  } = useQuery<LtaData>({
    queryKey: ["aeso-lta-data", activeUrl],
    queryFn: () =>
      fetch(`${BASE}/aeso/lta/data?url=${encodeURIComponent(activeUrl)}`).then((r) => r.json()),
    enabled: !!activeUrl,
    staleTime: 30 * 60 * 1000,
  });

  const hasShortfall = ltaData?.tensMwh != null && ltaData.thresholdMwh != null;
  const isAdequate = hasShortfall && ltaData!.tensMwh! < ltaData!.thresholdMwh!;
  const maxTotal = Math.max(...(ltaData?.stages?.map((s) => s.total ?? 0) ?? [1]));

  const yearGroups = reports.reduce<Record<number, LtaReport[]>>((acc, r) => {
    (acc[r.year] ??= []).push(r);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <TrendingUp size={22} className="text-teal-400" />
            Long-Term Adequacy Metrics
          </h1>
          <p className="text-sm text-white/50 mt-1">
            Quarterly supply adequacy assessment — Alberta Interconnected Electric System
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Report picker */}
          <div className="relative">
            <button
              onClick={() => setDropdownOpen((o) => !o)}
              className="flex items-center gap-2 px-3 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm text-white/80 transition-colors"
            >
              <Database size={14} className="text-teal-400" />
              {activeReport?.label ?? "Select report"}
              <ChevronDown size={14} />
            </button>
            {dropdownOpen && (
              <div className="absolute right-0 top-10 z-50 w-64 bg-[#0f1923] border border-white/10 rounded-lg shadow-xl overflow-y-auto max-h-80">
                {Object.entries(yearGroups)
                  .sort(([a], [b]) => Number(b) - Number(a))
                  .map(([year, reps]) => (
                    <div key={year}>
                      <div className="px-3 py-1.5 text-xs text-white/30 font-semibold border-b border-white/5">
                        {year}
                      </div>
                      {reps.map((r) => (
                        <button
                          key={r.url}
                          onClick={() => { setSelectedUrl(r.url); setDropdownOpen(false); }}
                          className={`w-full text-left px-3 py-2 text-sm transition-colors hover:bg-white/5 ${
                            r.url === activeUrl ? "text-teal-400" : "text-white/70"
                          }`}
                        >
                          {r.label}
                          <span className="ml-2 text-white/30 text-xs">
                            {new Date(r.posted).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}
                          </span>
                        </button>
                      ))}
                    </div>
                  ))}
              </div>
            )}
          </div>

          {activeReport && (
            <a
              href={activeReport.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3 py-2 bg-teal-600/20 hover:bg-teal-600/30 border border-teal-500/30 rounded-lg text-sm text-teal-300 transition-colors"
            >
              <Download size={14} />
              PDF
            </a>
          )}

          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 px-3 py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm text-white/60 transition-colors disabled:opacity-40"
          >
            <RefreshCw size={14} className={isFetching ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-64 text-white/40">
          <RefreshCw size={24} className="animate-spin mr-3" />
          Downloading &amp; parsing PDF…
        </div>
      ) : !ltaData ? null : (
        <>
          {/* ── Key metrics row ── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <MetricCard
              label="2-Year AIL Forecast"
              value={fmt(ltaData.ailMw)}
              unit="MW"
              icon={<BarChart3 size={18} className="text-teal-400" />}
              sub="Average internal load"
            />
            <MetricCard
              label="Total Energy Not Served"
              value={fmt(ltaData.tensMwh ?? ltaData.probability?.tensMwh, 2)}
              unit="MWh"
              icon={
                isAdequate
                  ? <CheckCircle size={18} className="text-emerald-400" />
                  : <AlertTriangle size={18} className="text-red-400" />
              }
              sub={`Threshold: ${fmt(ltaData.thresholdMwh)} MWh`}
              highlight={isAdequate ? "emerald" : "red"}
            />
            <MetricCard
              label="Prob. of Shortfall Hour"
              value={
                ltaData.probability?.worstShortfallProbability != null
                  ? `${(ltaData.probability.worstShortfallProbability * 100).toFixed(1)}%`
                  : "—"
              }
              unit=""
              icon={<AlertTriangle size={18} className="text-amber-400" />}
              sub="Worst hour exceedance"
            />
            <MetricCard
              label="Hours in Shortfall"
              value={ltaData.probability?.hoursInShortfall != null ? String(ltaData.probability.hoursInShortfall) : "—"}
              unit="hrs"
              icon={<Zap size={18} className="text-purple-400" />}
              sub={
                ltaData.probability?.shortfallHoursProbability != null
                  ? `${(ltaData.probability.shortfallHoursProbability * 100).toFixed(1)}% probability`
                  : "Over 2-year window"
              }
            />
          </div>

          {/* ── Supply adequacy status banner ── */}
          {hasShortfall && (
            <div
              className={`flex items-center gap-3 px-4 py-3 rounded-lg border text-sm ${
                isAdequate
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                  : "bg-red-500/10 border-red-500/30 text-red-300"
              }`}
            >
              {isAdequate
                ? <CheckCircle size={16} />
                : <AlertTriangle size={16} />}
              <span>
                {isAdequate
                  ? `Supply is ADEQUATE — TENS (${fmt(ltaData.tensMwh ?? ltaData.probability?.tensMwh, 2)} MWh) is below the ${fmt(ltaData.thresholdMwh)} MWh threshold.`
                  : `Supply SHORTFALL RISK — TENS (${fmt(ltaData.tensMwh ?? ltaData.probability?.tensMwh, 2)} MWh) exceeds the ${fmt(ltaData.thresholdMwh)} MWh threshold.`}
              </span>
              <span className="ml-auto text-white/30 text-xs">{activeReport?.label}</span>
            </div>
          )}

          {/* ── Table 1: Capacity by stage ── */}
          {ltaData.stages && ltaData.stages.length > 0 && (
            <div className="bg-white/3 border border-white/8 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-white/8 flex items-center justify-between">
                <h2 className="font-semibold text-white/90 text-sm">
                  Table 1 — Capacity of Generation &amp; Storage Projects (MW)
                </h2>
                <div className="flex items-center gap-4 text-xs text-white/40">
                  {[
                    { icon: <Sun size={11} />, label: "Solar" },
                    { icon: <Wind size={11} />, label: "Wind" },
                    { icon: <Zap size={11} />, label: "Storage" },
                    { icon: <Flame size={11} />, label: "Gas" },
                    { icon: <Droplets size={11} />, label: "Hydro & Other" },
                  ].map(({ icon, label }) => (
                    <span key={label} className="flex items-center gap-1">{icon} {label}</span>
                  ))}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/5 text-white/40">
                      <th className="text-left px-5 py-3 font-medium w-52">Stage</th>
                      <th className="text-right px-4 py-3 font-medium">
                        <span className="flex items-center justify-end gap-1"><Sun size={12} className="text-amber-400" /> Solar</span>
                      </th>
                      <th className="text-right px-4 py-3 font-medium">
                        <span className="flex items-center justify-end gap-1"><Wind size={12} className="text-sky-400" /> Wind</span>
                      </th>
                      <th className="text-right px-4 py-3 font-medium">
                        <span className="flex items-center justify-end gap-1"><Zap size={12} className="text-purple-400" /> Storage</span>
                      </th>
                      <th className="text-right px-4 py-3 font-medium">
                        <span className="flex items-center justify-end gap-1"><Flame size={12} className="text-orange-400" /> Gas</span>
                      </th>
                      <th className="text-right px-4 py-3 font-medium">
                        <span className="flex items-center justify-end gap-1"><Droplets size={12} className="text-teal-400" /> Hydro & Other</span>
                      </th>
                      <th className="text-right px-5 py-3 font-medium text-white/60">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ltaData.stages.map((stage, i) => {
                      const isTotal = stage.name.toLowerCase().includes("total");
                      const cls = stageColor(stage.name);
                      return (
                        <tr
                          key={i}
                          className={`border-b border-white/5 ${isTotal ? "font-semibold" : "hover:bg-white/2"}`}
                        >
                          <td className="px-5 py-3">
                            <span className={`inline-block px-2 py-0.5 rounded text-xs border ${cls}`}>
                              {shortStageName(stage.name)}
                            </span>
                          </td>
                          <td className="text-right px-4 py-3 tabular-nums text-amber-300/80">
                            {fmt(stage.solar)}
                          </td>
                          <td className="text-right px-4 py-3 tabular-nums text-sky-300/80">
                            {fmt(stage.wind)}
                          </td>
                          <td className="text-right px-4 py-3 tabular-nums text-purple-300/80">
                            {fmt(stage.storage)}
                          </td>
                          <td className="text-right px-4 py-3 tabular-nums text-orange-300/80">
                            {fmt(stage.gas)}
                          </td>
                          <td className="text-right px-4 py-3 tabular-nums text-teal-300/80">
                            {fmt(stage.hydro)}
                          </td>
                          <td className="text-right px-5 py-3 tabular-nums text-white/90 font-semibold">
                            <div className="flex flex-col items-end gap-1">
                              {fmt(stage.total)}
                              {!isTotal && <CapacityBar value={stage.total} max={maxTotal} />}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Reserve margin note ── */}
          <div className="bg-white/3 border border-white/8 rounded-xl px-5 py-4 flex items-start gap-4">
            <BarChart3 size={20} className="text-teal-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="font-semibold text-white/90 text-sm mb-1">Reserve Margin &amp; Supply Cushion</h3>
              <p className="text-xs text-white/50 leading-relaxed">
                The quarterly LTA report includes a reserve margin chart (Figure 1) showing historical values from 2016
                to present and a 5-year forecast through 2030 across three scenarios: projects that have met AUC
                criteria, received AUC approval, or been announced. Download the full PDF to view these charts.
              </p>
            </div>
            {activeReport && (
              <a
                href={activeReport.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-2 bg-teal-600/20 hover:bg-teal-600/30 border border-teal-500/30 rounded-lg text-xs text-teal-300 shrink-0 transition-colors"
              >
                <ExternalLink size={12} />
                View Charts
              </a>
            )}
          </div>

          {/* ── Project changes ── */}
          {ltaData.projectChanges && ltaData.projectChanges.length > 0 && (
            <div className="bg-white/3 border border-white/8 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-white/8">
                <h2 className="font-semibold text-white/90 text-sm">Summary of Changes Since Previous Report</h2>
              </div>
              <div className="divide-y divide-white/5">
                {ltaData.projectChanges.slice(0, 6).map((section, si) => (
                  <div key={si} className="px-5 py-4">
                    <h3 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3">
                      {section.section}
                    </h3>
                    <div className="space-y-2">
                      {section.projects.map((p, pi) => (
                        <div key={pi} className="flex items-center gap-3 text-sm">
                          <span className={`text-xs font-medium ${FUEL_COLORS[p.fuel] ?? "text-white/60"}`}>
                            {p.fuel}
                          </span>
                          <span className="text-white/70 flex-1 truncate">{p.name}</span>
                          <span className="tabular-nums text-white/50 text-xs">{fmt(p.mc)} MW</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── All quarterly reports ── */}
      <div className="bg-white/3 border border-white/8 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-white/8">
          <h2 className="font-semibold text-white/90 text-sm flex items-center gap-2">
            <Database size={15} className="text-teal-400" />
            All Quarterly Reports
          </h2>
        </div>
        <div className="divide-y divide-white/5">
          {Object.entries(yearGroups)
            .sort(([a], [b]) => Number(b) - Number(a))
            .map(([year, reps]) => (
              <div key={year}>
                <div className="px-5 py-2 bg-white/2">
                  <span className="text-xs font-semibold text-white/30 uppercase tracking-wider">{year}</span>
                </div>
                {reps.map((r) => (
                  <div
                    key={r.url}
                    className="flex items-center justify-between px-5 py-3 hover:bg-white/3 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => { setSelectedUrl(r.url); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                        className={`text-sm font-medium transition-colors ${
                          r.url === activeUrl ? "text-teal-400" : "text-white/70 hover:text-white"
                        }`}
                      >
                        {r.label}
                      </button>
                      <span className="text-xs text-white/25">
                        Posted {new Date(r.posted).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" })}
                      </span>
                    </div>
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 px-2.5 py-1 text-xs text-white/50 hover:text-teal-300 border border-white/10 hover:border-teal-500/30 rounded-md transition-colors"
                    >
                      <Download size={11} />
                      PDF
                    </a>
                  </div>
                ))}
              </div>
            ))}
        </div>
        <div className="px-5 py-3 border-t border-white/5 flex items-center justify-between">
          <span className="text-xs text-white/30">
            Source: AESO — ISO Rule 202.6 — Updated quarterly (Feb / May / Aug / Nov)
          </span>
          <a
            href="https://www.aeso.ca/market/market-and-system-reporting/long-term-adequacy-metrics/"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-teal-400 hover:text-teal-300 transition-colors"
          >
            <ExternalLink size={11} />
            AESO LTA page
          </a>
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  unit,
  icon,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  unit: string;
  icon: React.ReactNode;
  sub?: string;
  highlight?: "emerald" | "red";
}) {
  const borderCls =
    highlight === "emerald"
      ? "border-emerald-500/30"
      : highlight === "red"
      ? "border-red-500/30"
      : "border-white/8";

  return (
    <div className={`bg-white/3 border ${borderCls} rounded-xl px-4 py-4`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-white/50">{label}</span>
        {icon}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold text-white tabular-nums">{value}</span>
        <span className="text-xs text-white/40">{unit}</span>
      </div>
      {sub && <div className="text-xs text-white/30 mt-1">{sub}</div>}
    </div>
  );
}
